import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPostgresConfigurationEpochStore,
  initializeConfigurationConsumer,
  validateConfigurationGrantVectorInTransaction,
} from "./configuration-epoch";
import { createPostgresEventStore } from "./event-store";
import { createPgPool } from "./pool";
import { eventCorePostgresSchemaSql } from "./schema";
import { withPgTransaction, type PgTransactionalPool, type PgPoolClient } from "./types";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";

const adminUrl = process.env.TEST_DATABASE_URL;
if (process.env.CI && !adminUrl) throw new Error("TEST_DATABASE_URL is required for configuration epoch DB proof.");
const describeDb = adminUrl ? describe : describe.skip;
const identity = { storeId: "consumer", incarnation: "consumer-incarnation-1" };
const key = "owner/configuration/key";
const context = {
  tenantId: "tenant" as never,
  audit: { performedByUserId: "user" as never, forAccountId: "account" as never },
};
function input(streamId: string): AppendToStreamInput {
  return { streamId, expectedVersion: "no_stream", context, events: [{ eventType: "test.committed", payload: {} }] };
}
async function end(pool: PgTransactionalPool) {
  if ("end" in pool && typeof pool.end === "function") await pool.end();
}
describeDb("A-S separate owner and consumer database protocol", () => {
  let ownerPool: PgTransactionalPool;
  let consumerPool: PgTransactionalPool;
  let ownerUrl: string;
  let consumerUrl: string;
  const names: string[] = [];
  function owner(pool = consumerPool) {
    return createPostgresConfigurationEpochStore({
      pool: ownerPool,
      sourceIncarnation: "owner-incarnation-1",
      consumers: [{ identity, pool }],
    });
  }
  beforeAll(async () => {
    const admin = createPgPool(adminUrl!, { connectionTimeoutMillis: 1000 });
    try {
      for (const role of ["owner", "consumer"]) {
        const name = `epoch_${role}_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE DATABASE ${name}`);
        names.push(name);
      }
    } finally {
      await end(admin);
    }
    const source = new URL(adminUrl!);
    source.pathname = `/${names[0]}`;
    ownerUrl = source.href;
    const consumer = new URL(adminUrl!);
    consumer.pathname = `/${names[1]}`;
    consumerUrl = consumer.href;
    ownerPool = createPgPool(ownerUrl, { max: 6, connectionTimeoutMillis: 1000 });
    consumerPool = createPgPool(consumerUrl, { max: 6, connectionTimeoutMillis: 1000 });
    await ownerPool.query(eventCorePostgresSchemaSql);
    await consumerPool.query(eventCorePostgresSchemaSql);
  });
  beforeEach(async () => {
    for (const pool of [ownerPool, consumerPool])
      await pool.query(
        "TRUNCATE event_configuration_guard_history, event_configuration_journal_heads, event_configuration_store_identity, event_store_events, event_store_streams CASCADE",
      );
    await initializeConfigurationConsumer(consumerPool, identity);
    await owner().open(key, 3);
    await owner().registerConsumer(key, identity);
  });
  afterAll(async () => {
    if (ownerPool) await end(ownerPool);
    if (consumerPool) await end(consumerPool);
    if (names.length) {
      const admin = createPgPool(adminUrl!, { connectionTimeoutMillis: 1000 });
      try {
        for (const name of names) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      } finally {
        await end(admin);
      }
    }
  });

  async function orderingScenario(mutant: "none" | "REMOVE_SHARED_LOCK" | "REMOVE_CLOSED_THROUGH_WAIT") {
    const source = owner();
    const grant = await source.captureGrant(key, identity);
    const terminal = await consumerPool.connect();
    const observer = await consumerPool.connect();
    let committed = false;
    let closure: ReturnType<typeof source.driveClosure> | undefined;
    try {
      await terminal.query("BEGIN");
      // The named lock mutant bypasses the production grant path, so closure
      // must not observe a waiter on the consumer key.
      if (mutant === "REMOVE_SHARED_LOCK")
        await createPostgresEventStore({ pool: consumerPool }).appendToStreamInTransaction(terminal, input("terminal"));
      else
        await createPostgresEventStore({ pool: consumerPool }).appendToStreamsInTransaction(terminal, [
          { ...input("terminal"), configurationGrants: [grant] },
        ]);
      await source.beginClosure(key);
      closure = source.driveClosure(key);
      if (mutant === "REMOVE_CLOSED_THROUGH_WAIT") {
        // A production install attempt must remain receipt-gated before COMMIT.
        await source.installClosure(key);
      }
      let observedWait =
        (
          await observer.query<{ waiting: string }>(
            "SELECT count(*)::text AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
          )
        ).rows[0]?.waiting !== "0";
      // Observe a real PostgreSQL wait, not wall-clock timing.
      for (let n = 0; n < 100 && !observedWait; n++) {
        const next = await observer.query<{ waiting: string }>(
          "SELECT count(*)::text AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
        );
        observedWait = next.rows[0]?.waiting !== "0";
      }
      expect(observedWait, "closure must wait on the terminal's held SHARED lock").toBe(true);
      const consumerHistoryBeforeCommit = await observer.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM event_configuration_guard_history WHERE role = 'consumer' AND key = $1",
        [key],
      );
      expect(consumerHistoryBeforeCommit.rows[0]?.count, "CLOSED-THROUGH cannot publish before terminal COMMIT").toBe(
        "0",
      );
      const before = await source.status(key);
      expect(before.status).not.toBe("OPEN");
      expect(before.pendingConsumers).toEqual([identity]);
      await terminal.query("COMMIT");
      committed = true;
      const status = await closure;
      expect(status.pendingConsumers).toEqual([]);
      const consumerHistoryAfterCommit = await observer.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM event_configuration_guard_history WHERE role = 'consumer' AND key = $1",
        [key],
      );
      expect(consumerHistoryAfterCommit.rows[0]?.count, "exactly one CLOSED-THROUGH receipt follows COMMIT").toBe("1");
      await source.installClosure(key);
      const next = await source.captureGrant(key, identity);
      const store = createPostgresEventStore({ pool: consumerPool });
      await expect(store.appendToStreams!([{ ...input("stale"), configurationGrants: [grant] }])).rejects.toThrow();
      await store.appendToStreams!([{ ...input("new"), configurationGrants: [next] }]);
      expect(await store.readStream({ streamId: "terminal" })).toHaveLength(1);
    } finally {
      if (!committed) await terminal.query("ROLLBACK");
      terminal.release();
      observer.release();
      await closure;
    }
  }
  it("AC1 terminal COMMIT precedes CLOSED-THROUGH and installation; next epoch commits", () =>
    orderingScenario("none"));
  it("AC1 named REMOVE_SHARED_LOCK mutant fails the ordering oracle", async () => {
    await expect(orderingScenario("REMOVE_SHARED_LOCK")).rejects.toThrow();
  });
  it("AC1 named REMOVE_CLOSED_THROUGH_WAIT mutant fails the ordering oracle", async () => {
    await expect(orderingScenario("REMOVE_CLOSED_THROUGH_WAIT")).rejects.toThrow("every CLOSED-THROUGH");
  });
  it("AC2(a,e) pending refuses new grants, registration and retirement", async () => {
    const source = owner();
    await source.beginClosure(key);
    await expect(source.captureGrant(key, identity)).rejects.toThrow();
    await expect(source.registerConsumer(key, { storeId: "late", incarnation: "late-1" })).rejects.toThrow();
    await expect(source.retireConsumer(key, identity)).rejects.toThrow();
  });
  it("AC2(b,c,h) absent creation admits; later absent, old incarnation, corrupt, partial and expired refuse", async () => {
    const grant = await owner().captureGrant(key, identity);
    const store = createPostgresEventStore({ pool: consumerPool });
    await store.appendToStreams!([{ ...input("creation"), configurationGrants: [grant] }]);
    for (const candidate of [
      { ...grant, epoch: 4 },
      { ...grant, consumer: { ...identity, incarnation: "old" } },
      { ...grant, validUntil: "2000-01-01" },
    ]) {
      await expect(
        store.appendToStreams!([{ ...input("reject"), configurationGrants: [candidate] }]),
      ).rejects.toThrow();
    }
    await owner().beginClosure(key);
    await owner().driveClosure(key);
    await consumerPool.query("DELETE FROM event_configuration_guard_history WHERE role = 'consumer'");
    await expect(store.appendToStreams!([{ ...input("partial"), configurationGrants: [grant] }])).rejects.toThrow();
    await ownerPool.query(
      "UPDATE event_configuration_guard_history SET record = '{}'::json WHERE role = 'source' AND sequence = 1",
    );
    await expect(owner().captureGrant(key, identity)).rejects.toThrow();
    expect(await store.readStream({ streamId: "reject" })).toHaveLength(0);
  });
  it("AC2(d) unavailable store stays durably blocked without releasing unrelated keys", async () => {
    const unavailable: PgTransactionalPool = {
      query: consumerPool.query.bind(consumerPool),
      connect: async () => {
        throw new Error("synthetic store unavailable");
      },
    };
    const source = owner(unavailable);
    await source.beginClosure(key);
    expect((await source.driveClosure(key)).status).toBe("BLOCKED");
    await expect(owner().installClosure(key)).rejects.toThrow();
    await owner().open("other/key");
    await owner().registerConsumer("other/key", identity);
    await expect(owner().captureGrant("other/key", identity)).resolves.toMatchObject({ epoch: 0 });
    expect((await owner().status(key)).status).toBe("BLOCKED");
  });
  it("AC2(f) process-boundary restart resumes durable CLOSING", async () => {
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
      import { createPgPool } from './pool.ts';
      import { createPostgresConfigurationEpochStore } from './configuration-epoch.ts';
      const pool = createPgPool(process.env.EPOCH_OWNER_URL, { connectionTimeoutMillis: 1000 });
      await createPostgresConfigurationEpochStore({pool, sourceIncarnation:'owner-incarnation-1', consumers:[]}).beginClosure('owner/configuration/key');
      await pool.end();
    `,
      ],
      { cwd: import.meta.dirname, env: { ...process.env, EPOCH_OWNER_URL: ownerUrl }, timeout: 15000, stdio: "pipe" },
    );
    expect((await owner().status(key)).status).toBe("PENDING");
    await owner().driveClosure(key);
    await owner().installClosure(key);
    expect((await owner().captureGrant(key, identity)).epoch).toBe(4);
  });
  it("AC2(f) lost consumer COMMIT reply recovers idempotently", async () => {
    let lost = false;
    const lostReply: PgTransactionalPool = {
      query: consumerPool.query.bind(consumerPool),
      connect: async () => {
        const client = await consumerPool.connect();
        return {
          release: client.release.bind(client),
          query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
            const result = await client.query<Row>(sql, values);
            if (sql === "COMMIT" && !lost) {
              lost = true;
              throw new Error("synthetic lost reply");
            }
            return result;
          },
        } satisfies PgPoolClient;
      },
    };
    await owner().beginClosure(key);
    expect((await owner(lostReply).driveClosure(key)).status).toBe("BLOCKED");
    await owner().driveClosure(key);
    await owner().installClosure(key);
    expect((await owner().status(key)).status).toBe("OPEN");
  });
  it("AC2(g) transaction validation refuses a class-C key without its actual guard lock", async () => {
    const grant = await owner().captureGrant(key, identity);
    await expect(
      withPgTransaction(consumerPool, (client) => validateConfigurationGrantVectorInTransaction(client, [grant])),
    ).rejects.toThrow("no held guard lock");
  });
  it("owner writer rollback cannot publish CLOSING or APPLIED ahead of business state", async () => {
    const source = owner();
    await expect(
      withPgTransaction(ownerPool, async (client) => {
        await source.beginClosureInTransaction(client, key);
        throw new Error("business write refused");
      }),
    ).rejects.toThrow("business write");
    expect((await source.status(key)).status).toBe("OPEN");
    await source.beginClosure(key);
    await source.driveClosure(key);
    await expect(
      withPgTransaction(ownerPool, async (client) => {
        await source.installClosureInTransaction(client, key);
        throw new Error("business write refused");
      }),
    ).rejects.toThrow("business write");
    expect((await source.status(key)).status).not.toBe("OPEN");
  });
  it("retirement fences outstanding grants before topology removal", async () => {
    const source = owner();
    const grant = await source.captureGrant(key, identity);
    await source.retireConsumer(key, identity);
    await expect(
      createPostgresEventStore({ pool: consumerPool }).appendToStreams!([
        { ...input("retired"), configurationGrants: [grant] },
      ]),
    ).rejects.toThrow();
    await source.beginClosure(key);
    await source.driveClosure(key);
    await source.installClosure(key);
  });
});
