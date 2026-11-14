import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIGURATION_EPOCH_STEP_TIMEOUT_MS,
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
const EXCLUSIVE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('configuration_epoch:' || $1::text, 0))";
// Ungranted EXCLUSIVE requests on one configuration key in the caller's own database,
// matched with the lock-key expressions of the held-lock check in configuration-epoch.ts.
const EXCLUSIVE_WAITERS_SQL = `SELECT count(*)::text AS waiting FROM pg_locks
  WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock'
    AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND classid::bigint = ((hashtextextended('configuration_epoch:' || $1::text, 0) >> 32) & 4294967295)
    AND objid::bigint = (hashtextextended('configuration_epoch:' || $1::text, 0) & 4294967295)
    AND objsubid = 1`;
/** Polls until a waiter appears or the closure's own lock bound has passed; returns the last scoped count. */
async function exclusiveWaiters(client: PgPoolClient, lockKey: string): Promise<string | undefined> {
  const deadline = Date.now() + CONFIGURATION_EPOCH_STEP_TIMEOUT_MS;
  for (;;) {
    const waiting = (await client.query<{ waiting: string }>(EXCLUSIVE_WAITERS_SQL, [lockKey])).rows[0]?.waiting;
    if (waiting !== "0" || Date.now() >= deadline) return waiting;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
/** Parks a second session behind an EXCLUSIVE hold on `lockKey`; returns the release. */
async function parkExclusiveWaiter(pool: PgTransactionalPool, lockKey: string): Promise<() => Promise<void>> {
  const holder = await pool.connect();
  const waiter = await pool.connect();
  let parked: Promise<unknown> = Promise.resolve();
  const release = async () => {
    try {
      await holder.query("ROLLBACK");
      await parked;
    } finally {
      holder.release();
      waiter.release();
    }
  };
  try {
    await holder.query("BEGIN");
    await holder.query(EXCLUSIVE_LOCK_SQL, [lockKey]);
    parked = waiter.query(EXCLUSIVE_LOCK_SQL, [lockKey]);
    expect(await exclusiveWaiters(holder, lockKey), `parked waiter on ${lockKey}`).toBe("1");
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
describeDb("A-S separate owner and consumer database protocol", () => {
  let ownerPool: PgTransactionalPool;
  let consumerPool: PgTransactionalPool;
  let foreignPool: PgTransactionalPool;
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
      for (const role of ["owner", "consumer", "foreign"]) {
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
    const foreign = new URL(adminUrl!);
    foreign.pathname = `/${names[2]}`;
    ownerPool = createPgPool(ownerUrl, { max: 6, connectionTimeoutMillis: 1000 });
    consumerPool = createPgPool(consumerUrl, { max: 6, connectionTimeoutMillis: 1000 });
    foreignPool = createPgPool(foreign.href, { max: 2, connectionTimeoutMillis: 1000 });
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
    if (foreignPool) await end(foreignPool);
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
    const foreignWaiters: (() => Promise<void>)[] = [];
    let committed = false;
    let closure: ReturnType<typeof source.driveClosure> | undefined;
    try {
      // Fixed waiters the probe must ignore: this key in a foreign database, and a foreign key here.
      foreignWaiters.push(await parkExclusiveWaiter(foreignPool, key));
      foreignWaiters.push(await parkExclusiveWaiter(consumerPool, "foreign/configuration/key"));
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
      // Observe a real PostgreSQL wait on this database's key; the deadline only bounds the poll.
      expect(await exclusiveWaiters(observer, key), "closure must wait on the terminal's held SHARED lock").toBe("1");
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
      for (const release of foreignWaiters) await release();
      if (!committed) await terminal.query("ROLLBACK");
      terminal.release();
      observer.release();
      await closure;
    }
  }
  it("AC1 terminal COMMIT precedes CLOSED-THROUGH and installation; next epoch commits", () =>
    orderingScenario("none"));
  it("AC1 REMOVE_SHARED_LOCK oracle control fails the closure-wait oracle", async () => {
    await expect(orderingScenario("REMOVE_SHARED_LOCK")).rejects.toThrow(
      "closure must wait on the terminal's held SHARED lock",
    );
  });
  it("AC1 REMOVE_CLOSED_THROUGH_WAIT oracle control fails the receipt-gated install oracle", async () => {
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
