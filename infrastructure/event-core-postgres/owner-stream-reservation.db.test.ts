import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RequestTerminalBinding, ReserveOwnerStreamInput } from "@chase-sets/event-core/owner-stream-reservation";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import { createPgPool } from "./pool";
import { eventCorePostgresSchemaSql } from "./schema";
import { createPostgresEventStore } from "./event-store";
import { initializeConfigurationConsumer } from "./configuration-epoch";
import { withPgTransaction, type PgTransactionalPool, type PgPoolClient } from "./types";
import {
  applyOwnerStreamInvalidationInTransaction,
  beginOwnerStreamInvalidationInTransaction,
  createPostgresOwnerStreamReservationStore,
  type PostgresOwnerStreamReservationStoreConfig,
} from "./owner-stream-reservation";

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for owner-stream DB proof.");
const describeDb = adminUrl ? describe : describe.skip;
const consumer = { storeId: "consumer", incarnation: "consumer-incarnation" };
const reservation = (
  id = "reservation-1",
  overrides: Partial<ReserveOwnerStreamInput> = {},
): ReserveOwnerStreamInput => ({
  reservationId: id,
  operationId: "operation-1",
  ownerStreamId: "owner-1",
  purpose: "activation",
  resourceKey: "stock-1",
  consumer: { ...consumer, requestId: "request-1" },
  seal: { version: 7, storeIncarnation: "owner-incarnation" },
  target: { listingId: "listing-1" },
  commandFingerprint: "full-command",
  ...overrides,
});
function binding(r = reservation()): RequestTerminalBinding {
  return {
    consumerStoreId: r.consumer.storeId,
    consumerIncarnation: r.consumer.incarnation,
    requestId: r.consumer.requestId,
    commandFingerprint: r.commandFingerprint,
    target: r.target,
    reservations: [r],
    preparationDeadline: "2000-01-01T00:00:00.000Z",
  };
}
function append(b?: RequestTerminalBinding, streamId = "test.consumer-1"): AppendToStreamInput {
  return {
    streamId,
    expectedVersion: "no_stream",
    events: [{ eventId: "event-1" as never, eventType: "test.committed", payload: {} }],
    context: {
      tenantId: "tenant" as never,
      audit: { performedByUserId: "user" as never, forAccountId: "account" as never },
    },
    ...(b ? { requestTerminal: b } : {}),
  };
}
async function close(pool: PgTransactionalPool | undefined) {
  if (pool && "end" in pool && typeof pool.end === "function") await pool.end();
}
function wrap(pool: PgTransactionalPool, transform: (client: PgPoolClient) => PgPoolClient): PgTransactionalPool {
  return { query: pool.query.bind(pool), connect: async () => transform(await pool.connect()) };
}

describeDb("owner-stream reservations across separate real owner and consumer databases", () => {
  let ownerPool: PgTransactionalPool;
  let consumerPool: PgTransactionalPool;
  let ownerUrl: string;
  let consumerUrl: string;
  const names: string[] = [];
  const applyInvalidation: PostgresOwnerStreamReservationStoreConfig["applyInvalidation"] = async (client, intent) => {
    await client.query("UPDATE event_store_streams SET current_version = current_version + 1 WHERE stream_id = $1", [
      intent.ownerStreamId,
    ]);
  };
  function store(consumerOverride = consumerPool, extra: Partial<PostgresOwnerStreamReservationStoreConfig> = {}) {
    return createPostgresOwnerStreamReservationStore({
      ownerPool,
      consumerPool: consumerOverride,
      applyInvalidation,
      applyInboundEvidence: async (client, evidence) => {
        await client.query("INSERT INTO reservation_applied_evidence (evidence_id, payload) VALUES ($1,$2)", [
          evidence.evidenceId,
          evidence.payload,
        ]);
      },
      ...extra,
    });
  }
  beforeAll(async () => {
    const admin = createPgPool(adminUrl!, { connectionTimeoutMillis: 1000 });
    try {
      for (const role of ["owner", "consumer"]) {
        const name = `reservation_${role}_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE DATABASE ${name}`);
        names.push(name);
      }
    } finally {
      await close(admin);
    }
    const owner = new URL(adminUrl!);
    owner.pathname = `/${names[0]}`;
    ownerUrl = owner.href;
    const consumerDb = new URL(adminUrl!);
    consumerDb.pathname = `/${names[1]}`;
    consumerUrl = consumerDb.href;
    ownerPool = createPgPool(ownerUrl, { max: 6, connectionTimeoutMillis: 1000 });
    consumerPool = createPgPool(consumerUrl, { max: 6, connectionTimeoutMillis: 1000 });
    await ownerPool.query(eventCorePostgresSchemaSql);
    await consumerPool.query(eventCorePostgresSchemaSql);
    await ownerPool.query(
      "CREATE TABLE reservation_applied_evidence (evidence_id text PRIMARY KEY, payload jsonb NOT NULL)",
    );
    expect((await ownerPool.query("SELECT current_database() AS name")).rows).not.toEqual(
      (await consumerPool.query("SELECT current_database() AS name")).rows,
    );
  });
  beforeEach(async () => {
    for (const pool of [ownerPool, consumerPool])
      await pool.query(
        "TRUNCATE event_owner_stream_reservations, event_owner_stream_invalidations, event_request_terminals, event_owner_stream_inbound_evidence, event_configuration_store_identity, event_store_events, event_store_streams RESTART IDENTITY CASCADE",
      );
    await ownerPool.query("TRUNCATE reservation_applied_evidence");
    await initializeConfigurationConsumer(ownerPool, { storeId: "owner", incarnation: "owner-incarnation" });
    await initializeConfigurationConsumer(consumerPool, consumer);
    await ownerPool.query(
      "INSERT INTO event_store_streams (stream_id, current_version, updated_at) SELECT 'owner-' || i, 7, now() FROM generate_series(1, 140) i",
    );
  });
  afterAll(async () => {
    await close(ownerPool);
    await close(consumerPool);
    if (names.length) {
      const admin = createPgPool(adminUrl!, { connectionTimeoutMillis: 1000 });
      try {
        for (const name of names) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally {
        await close(admin);
      }
    }
  });
  async function version() {
    return (
      await ownerPool.query<{ version: string }>(
        "SELECT current_version::text AS version FROM event_store_streams WHERE stream_id = 'owner-1'",
      )
    ).rows[0]!.version;
  }
  async function events() {
    return (await consumerPool.query<{ count: string }>("SELECT count(*)::text AS count FROM event_store_events"))
      .rows[0]!.count;
  }
  async function terminalStatus() {
    return (
      await consumerPool.query<{ status: string }>(
        "SELECT status FROM event_request_terminals WHERE request_id = 'request-1'",
      )
    ).rows[0]?.status;
  }
  async function prepare(s = store()) {
    const r = reservation();
    await s.reserve(r);
    await s.openRequestTerminal(binding(r));
    return binding(r);
  }

  async function abortFirstScenario(mutant = process.env.OWNER_RESERVATION_MUTANT) {
    let abortObserved = false;
    const observed = wrap(consumerPool, (client) => ({
      release: client.release.bind(client),
      query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        if (sql.includes("UPDATE event_request_terminals") && values?.[2] === "ABORTED") {
          const lock = await ownerPool.connect();
          try {
            await lock.query("BEGIN");
            expect(
              (
                await lock.query<{ held: boolean }>(
                  "SELECT pg_try_advisory_xact_lock(hashtextextended('owner_stream:owner-1', 0)) AS held",
                )
              ).rows[0]?.held,
            ).toBe(true);
          } finally {
            await lock.query("ROLLBACK");
            lock.release();
          }
          abortObserved = true;
          // Named DB mutant: only the governing consumer CAS is removed.
          if (mutant === "REMOVE_ABORT_CAS") return { rows: [] as Row[], rowCount: 0 };
        }
        return client.query<Row>(sql, values);
      },
    }));
    const s = store(observed);
    const b = await prepare(s);
    await s.beginInvalidation("owner-1");
    expect(await version()).toBe("7");
    expect((await s.driveInvalidation("owner-1")).status).toBe("APPLIED");
    expect(abortObserved).toBe(true);
    expect(await terminalStatus()).toBe("ABORTED");
    expect(await version()).toBe("8");
    await expect(createPostgresEventStore({ pool: consumerPool }).appendToStreams!([append(b)])).rejects.toThrow(
      "final",
    );
    expect(await events()).toBe("0");
    await expect(
      s.reserve(reservation("next", { seal: { version: 8, storeIncarnation: "owner-incarnation" } })),
    ).resolves.toMatchObject({ status: "OPEN" });
  }
  it("AC1 abort-first uses the durable consumer abort CAS outside owner locks and refuses zero events", () =>
    abortFirstScenario());
  it("AC1 named REMOVE_ABORT_CAS mutant fails the same durable ordering oracle", async () => {
    await expect(abortFirstScenario("REMOVE_ABORT_CAS")).rejects.toThrow("ABORTED");
  });
  it("AC1 terminal-first commits all events before the owner change and never reads the owner at COMMIT", async () => {
    const s = store();
    const b = await prepare(s);
    const ownerLock = await ownerPool.connect();
    try {
      await ownerLock.query("BEGIN");
      await ownerLock.query("LOCK TABLE event_owner_stream_reservations IN ACCESS EXCLUSIVE MODE");
      await createPostgresEventStore({ pool: consumerPool }).appendToStreams!([append(b)]);
    } finally {
      await ownerLock.query("ROLLBACK");
      ownerLock.release();
    }
    expect(await events()).toBe("1");
    expect(await version()).toBe("7");
    await s.beginInvalidation("owner-1");
    await s.driveInvalidation("owner-1");
    expect((await s.getReservation("reservation-1"))?.releaseStatus).toBe("COMMITTED");
    expect(await version()).toBe("8");
  });
  it("rolls terminal CAS and all events back on an atomic append failure", async () => {
    const s = store();
    const b = await prepare(s);
    const es = createPostgresEventStore({ pool: consumerPool });
    await es.appendToStream(append(undefined, "test.existing"));
    await expect(es.appendToStreams!([append(b, "test.new")])).rejects.toThrow();
    expect(await terminalStatus()).toBe("OPEN");
    expect(await events()).toBe("1");
    await es.appendToStreams!([
      { ...append(b, "test.new"), events: [{ eventId: "event-2" as never, eventType: "test.committed", payload: {} }] },
    ]);
    expect(await terminalStatus()).toBe("COMMITTED");
    expect(await events()).toBe("2");
  });
  it.each(["consumer", "command", "target", "owner", "manifest", "deadline"])(
    "refuses complete terminal %s identity drift with zero writes",
    async (field) => {
      const s = store();
      const b = await prepare(s);
      const changed = structuredClone(b) as {
        -readonly [K in keyof RequestTerminalBinding]: RequestTerminalBinding[K];
      };
      if (field === "consumer") changed.consumerIncarnation = "other";
      if (field === "command") {
        changed.commandFingerprint = "other";
        changed.reservations = [{ ...b.reservations[0]!, commandFingerprint: "other" }];
      }
      if (field === "target") {
        changed.target = { listingId: "other" };
        changed.reservations = [{ ...b.reservations[0]!, target: changed.target }];
      }
      if (field === "owner")
        changed.reservations = [{ ...b.reservations[0]!, seal: { version: 7, storeIncarnation: "other" } }];
      if (field === "manifest") changed.reservations = [{ ...b.reservations[0]!, reservationId: "other" }];
      if (field === "deadline") changed.preparationDeadline = "2030-01-01T00:00:00Z";
      await expect(
        createPostgresEventStore({ pool: consumerPool }).appendToStreams!([append(changed)]),
      ).rejects.toThrow();
      await expect(s.abortRequestTerminal(changed)).rejects.toThrow();
      expect(await terminalStatus()).toBe("OPEN");
      expect(await events()).toBe("0");
    },
  );
  it("fences stale invalidation generations and rolls back failed writer application", async () => {
    const s = store();
    const first = await s.beginInvalidation("owner-1");
    await s.driveInvalidation("owner-1");
    const second = await s.beginInvalidation("owner-1");
    await expect(
      withPgTransaction(ownerPool, (client) =>
        applyOwnerStreamInvalidationInTransaction(client, first, applyInvalidation),
      ),
    ).rejects.toThrow("generation changed");
    expect(await version()).toBe("8");
    await expect(
      withPgTransaction(ownerPool, (client) =>
        applyOwnerStreamInvalidationInTransaction(client, second, async (db, intent) => {
          await applyInvalidation(db, intent);
          throw new Error("synthetic writer failure");
        }),
      ),
    ).rejects.toThrow("writer failure");
    expect(await version()).toBe("8");
    await s.driveInvalidation("owner-1");
    expect(await version()).toBe("9");
  });
  it("rejects single-stream, independent and duplicate-terminal bypasses even for zero events", async () => {
    const s = store();
    const b = await prepare(s);
    const es = createPostgresEventStore({ pool: consumerPool });
    const empty = { ...append(b), events: [] };
    await expect(es.appendToStream(empty)).rejects.toThrow("require appendToStreams");
    await expect(
      withPgTransaction(consumerPool, (client) => es.appendToStreamInTransaction(client, empty)),
    ).rejects.toThrow("require appendToStreams");
    await expect(es.appendToStreamsIndependently!([empty])).rejects.toThrow("require appendToStreams");
    await expect(es.appendToStreams!([empty, { ...empty, streamId: "test.second" }])).rejects.toThrow(
      "participate once",
    );
    expect(await terminalStatus()).toBe("OPEN");
    expect(await events()).toBe("0");
    await s.abortRequestTerminal(b);
    await expect(es.appendToStreams!([empty])).rejects.toThrow("final");
    expect(await events()).toBe("0");
  });
  it("fails closed when the actual consumer store incarnation changes", async () => {
    const s = store();
    const b = await prepare(s);
    await consumerPool.query(
      "UPDATE event_configuration_store_identity SET incarnation = 'replacement-incarnation' WHERE singleton = true",
    );
    await expect(createPostgresEventStore({ pool: consumerPool }).appendToStreams!([append(b)])).rejects.toThrow(
      "incarnation",
    );
    await s.beginInvalidation("owner-1");
    expect((await s.driveInvalidation("owner-1")).status).toBe("ABORT-REQUESTED");
    expect((await s.getReservation("reservation-1"))?.status).toBe("OPEN");
    expect(await version()).toBe("7");
    expect(await events()).toBe("0");
  });
  it.each(["prepare-failure", "lost-abort-reply"])(
    "AC2 injects %s and keeps the original reservation until a durable terminal is recovered",
    async (fault) => {
      const r = reservation();
      let injected = false;
      const faulty = wrap(consumerPool, (client) => ({
        release: client.release.bind(client),
        query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
          if (!injected && fault === "prepare-failure" && sql.includes("INSERT INTO event_request_terminals")) {
            injected = true;
            throw new Error("synthetic prepare failure");
          }
          const result = await client.query<Row>(sql, values);
          if (!injected && fault === "lost-abort-reply" && sql === "COMMIT") {
            injected = true;
            throw new Error("synthetic lost abort reply");
          }
          return result;
        },
      }));
      await store().reserve(r);
      if (fault === "prepare-failure")
        await expect(store(faulty).openRequestTerminal(binding(r))).rejects.toThrow("prepare failure");
      else await store().openRequestTerminal(binding(r));
      await store().beginInvalidation("owner-1");
      expect((await store(faulty).driveInvalidation("owner-1")).status).toBe("ABORT-REQUESTED");
      expect((await store().getReservation(r.reservationId))?.status).toBe("OPEN");
      expect(await version()).toBe("7");
      if (fault === "prepare-failure") await store().abortPreparationDeadline(binding(r));
      await store().driveInvalidation("owner-1");
      expect(await version()).toBe("8");
      expect(injected).toBe(true);
    },
  );
  it("AC2 preparation deadline uses the abort CAS, never time-based owner release", async () => {
    const s = store();
    const r = reservation();
    await s.reserve(r);
    await s.beginInvalidation("owner-1");
    expect((await s.driveInvalidation("owner-1")).status).toBe("ABORT-REQUESTED");
    expect(await version()).toBe("7");
    await s.abortPreparationDeadline(binding(r));
    expect(await terminalStatus()).toBe("ABORTED");
    expect((await s.getReservation(r.reservationId))?.status).toBe("OPEN");
    await s.driveInvalidation("owner-1");
    expect(await version()).toBe("8");
  });
  it.each(["owner", "consumer"])("AC2 resumes canonical state after an actual %s process boundary", async (role) => {
    const s = store();
    const b = await prepare(s);
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
      import { createPgPool } from './pool.ts';
      import { createPostgresOwnerStreamReservationStore } from './owner-stream-reservation.ts';
      import { createPostgresEventStore } from './event-store.ts';
      const ownerPool = createPgPool(process.env.RESERVATION_OWNER_URL, {connectionTimeoutMillis:1000});
      const consumerPool = createPgPool(process.env.RESERVATION_CONSUMER_URL, {connectionTimeoutMillis:1000});
      const s = createPostgresOwnerStreamReservationStore({ownerPool,consumerPool,applyInvalidation:async()=>{},applyInboundEvidence:async()=>{}});
      if (process.env.RESERVATION_ROLE === 'owner') await s.beginInvalidation('owner-1');
      else await createPostgresEventStore({pool:consumerPool}).appendToStreams([JSON.parse(process.env.RESERVATION_APPEND)]);
      await ownerPool.end(); await consumerPool.end();
    `,
      ],
      {
        cwd: import.meta.dirname,
        env: {
          ...process.env,
          RESERVATION_OWNER_URL: ownerUrl,
          RESERVATION_CONSUMER_URL: consumerUrl,
          RESERVATION_ROLE: role,
          RESERVATION_APPEND: JSON.stringify(append(b)),
        },
        timeout: 15000,
        stdio: "pipe",
      },
    );
    const restarted = store();
    if (role === "consumer") {
      expect(await terminalStatus()).toBe("COMMITTED");
      await restarted.beginInvalidation("owner-1");
    } else {
      await expect(restarted.reserve(reservation("late"))).rejects.toThrow("pending");
    }
    expect((await restarted.driveInvalidation("owner-1")).status).toBe("APPLIED");
    expect(await version()).toBe("8");
    expect((await restarted.getReservation("reservation-1"))?.releaseStatus).toBe(
      role === "consumer" ? "COMMITTED" : "ABORTED",
    );
  });
  it.each(["resource", "purpose", "live"])(
    "AC2 accepts the exact %s bound and serializes concurrent excess attempts across streams",
    async (kind) => {
      const s = store();
      const limit = kind === "resource" ? 32 : kind === "purpose" ? 8 : 128;
      const row = (i: number) =>
        reservation(`r-${i}`, {
          ownerStreamId: `owner-${i + 1}`,
          resourceKey: kind === "resource" ? `stock-${i}` : "stock-1",
          purpose: kind === "purpose" ? `purpose-${i}` : "activation",
          operationId: kind === "live" ? `operation-${i}` : "operation-1",
        });
      for (let i = 0; i < limit - 1; i += 1) await s.reserve(row(i));
      const results = await Promise.allSettled([s.reserve(row(limit - 1)), s.reserve(row(limit))]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const before = await ownerPool.query("SELECT * FROM event_owner_stream_reservations ORDER BY reservation_id");
      await expect(s.reserve(row(limit + 1))).rejects.toThrow("bound exceeded");
      expect(await ownerPool.query("SELECT * FROM event_owner_stream_reservations ORDER BY reservation_id")).toEqual(
        before,
      );
      expect(before.rows).toHaveLength(limit);
    },
  );
  it("AC3 records the inbound payload, survives recovery and applies exactly once only after original-terminal settlement", async () => {
    const s = store();
    const r = reservation();
    await s.reserve(r);
    const evidence = {
      evidenceId: "sale-1",
      resourceKey: "stock-1",
      payload: { quantity: 2, receipt: "inbound-sale" },
    };
    expect(await s.recordInboundEvidence(evidence)).toEqual({ ...evidence, status: "PENDING" });
    expect((await store().settleInboundEvidence(evidence.evidenceId)).status).toBe("BLOCKED");
    expect((await ownerPool.query("SELECT * FROM reservation_applied_evidence")).rows).toHaveLength(0);
    expect((await ownerPool.query("SELECT payload FROM event_owner_stream_inbound_evidence")).rows).toEqual([
      { payload: evidence.payload },
    ]);
    await store().openRequestTerminal(binding(r));
    const failed = store(consumerPool, {
      applyInboundEvidence: async (client) => {
        await client.query("INSERT INTO reservation_applied_evidence VALUES ('rolled-back','{}')");
        throw new Error("synthetic evidence application failure");
      },
    });
    await expect(failed.settleInboundEvidence(evidence.evidenceId)).rejects.toThrow("application failure");
    expect((await ownerPool.query("SELECT * FROM reservation_applied_evidence")).rows).toHaveLength(0);
    expect((await store().settleInboundEvidence(evidence.evidenceId)).status).toBe("APPLIED");
    await store().settleInboundEvidence(evidence.evidenceId);
    expect((await ownerPool.query("SELECT evidence_id, payload FROM reservation_applied_evidence")).rows).toEqual([
      { evidence_id: evidence.evidenceId, payload: evidence.payload },
    ]);
  });
});
