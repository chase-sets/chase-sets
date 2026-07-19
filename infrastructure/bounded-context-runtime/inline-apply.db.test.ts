import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import {
  getEventCommitMetadata,
  recordCommittedEvents,
  runWithEventCommitMetadata,
  toTransportEvent,
  type StoredEvent,
} from "@chase-sets/event-core";
import { createProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { applyCommittedProjectionEventsInline } from "./inline-apply";
import { bootstrapContextDatabase } from "./schema";
import { claimSubscriptionApplication, recordSubscriptionApplicationCompleted } from "./subscription-store";
import {
  closeMultiContextTestPools,
  createMountedContextTestRuntime,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "./test-support";

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

const testState = {
  handlerCalls: 0,
  failNextHandler: false,
  handlerGate: null as Readonly<{ started: () => void; wait: Promise<void> }> | null,
};

const inlineModule = defineBoundedContextModule({
  manifest: {
    contextName: "inline",
    apiBasePath: "/api/inline",
    streamPrefix: "inline.",
    projectionGroups: [
      {
        projectionName: "inline.items",
        sourceContextNames: ["inline"],
        ownedTables: ["inline_items"],
        resetStrategy: "truncate-owned-tables",
      },
    ],
  },
  schemaSql: `
    CREATE TABLE IF NOT EXISTS inline_items (
      item_id text PRIMARY KEY,
      seen_count integer NOT NULL
    );
  `,
  createServices: () => ({
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inline.items",
        inlineApply: true,
        checkpointBatchSize: 10,
        handlers: {
          "inline.item-recorded": async (event, context) => {
            testState.handlerCalls += 1;
            const gate = testState.handlerGate;
            gate?.started();
            await gate?.wait;
            if (testState.failNextHandler) {
              testState.failNextHandler = false;
              throw new Error("inline handler failed");
            }
            if (!context?.db) {
              throw new Error("projection db is required");
            }
            await context.db.query(
              `INSERT INTO inline_items (item_id, seen_count)
               VALUES ($1, 1)
               ON CONFLICT (item_id)
               DO UPDATE SET seen_count = inline_items.seen_count + 1`,
              [String(event.data.itemId)],
            );
          },
        },
      }),
    ],
  }),
  buildApis: () => [],
  projectionHandlerSets: (services) => services.projectors,
});

describeDb("projection inline apply Postgres integration", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(adminDatabaseUrl!, ["inline"], "projection_inline_apply");
    await ensureMultiContextTestDatabases(adminDatabaseUrl!, urls);
    pool = createMultiContextTestPools(urls).inline;
  });

  beforeEach(async () => {
    testState.handlerCalls = 0;
    testState.failNextHandler = false;
    testState.handlerGate = null;
    await resetMultiContextTestSchemas({ inline: pool });
    await bootstrapContextDatabase(inlineModule, pool);
  });

  afterAll(async () => {
    await closeMultiContextTestPools({ inline: pool });
  });

  it("writes the runner ledger row and makes the asynchronous runner skip handler re-execution", async () => {
    const runtime = createRuntime(pool);
    const events = await appendEvents(pool, "inline.item-1", [{ itemId: "item-1" }]);

    await expect(applyInline(runtime, events)).resolves.toEqual({ applied: 1, deferred: 0, failed: 0 });
    await expect(readLedger(pool, runtime.subscriptionRunners[0]!.checkpointKey)).resolves.toEqual([
      expect.objectContaining({ event_id: String(events[0]!.eventId), status: "applied", lease_owner_id: null }),
    ]);
    expect(testState.handlerCalls).toBe(1);

    await runtime.subscriptionRunners[0]!.runOnce();
    expect(testState.handlerCalls).toBe(1);
    await expect(readItems(pool)).resolves.toEqual([{ item_id: "item-1", seen_count: 1 }]);
  });

  it("defers without blocking or stealing an in-flight runner claim", async () => {
    const runtime = createRuntime(pool);
    const runner = runtime.subscriptionRunners[0]!;
    const event = (await appendEvents(pool, "inline.item-2", [{ itemId: "item-2" }]))[0]!;
    const transportEvent = toTransportEvent(event);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        claimSubscriptionApplication(client, runner.checkpointKey, transportEvent, {
          ownerId: "async-runner",
          fencingToken: "7",
        }),
      ).resolves.toBe("claimed");

      const startedAt = Date.now();
      await expect(applyInline(runtime, [event])).resolves.toEqual({ applied: 0, deferred: 1, failed: 0 });
      expect(Date.now() - startedAt).toBeLessThan(250);
      expect(testState.handlerCalls).toBe(0);

      await client.query(`INSERT INTO inline_items (item_id, seen_count) VALUES ('item-2', 1)`);
      await recordSubscriptionApplicationCompleted(
        client,
        runner.checkpointKey,
        String(event.eventId),
        "applied",
        null,
        { ownerId: "async-runner", fencingToken: "7" },
      );
      await client.query("COMMIT");
      await expect(readLedger(pool, runner.checkpointKey)).resolves.toEqual([
        expect.objectContaining({ status: "applied", lease_owner_id: "async-runner", lease_fencing_token: "7" }),
      ]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("defers predecessor gaps and blocked streams without creating ledger rows", async () => {
    const runtime = createRuntime(pool);
    const runner = runtime.subscriptionRunners[0]!;
    const events = await appendEvents(pool, "inline.item-gap", [{ itemId: "gap-1" }, { itemId: "gap-2" }]);

    await expect(applyInline(runtime, [events[1]!])).resolves.toEqual({ applied: 0, deferred: 1, failed: 0 });
    await expect(readLedger(pool, runner.checkpointKey)).resolves.toEqual([]);

    const blocked = (await appendEvents(pool, "inline.item-blocked", [{ itemId: "blocked" }]))[0]!;
    await pool.query(
      `INSERT INTO event_projection_blocked_streams (
         projection_key, stream_id, first_blocked_global_position, first_blocked_stream_version,
         last_seen_global_position, deferred_event_count, state, updated_at
       ) VALUES ($1, $2, $3::bigint, 1, $3::bigint, 0, 'blocked', now())`,
      [runner.checkpointKey, blocked.streamId, blocked.globalPosition],
    );

    await expect(applyInline(runtime, [blocked])).resolves.toEqual({ applied: 0, deferred: 1, failed: 0 });
    await expect(readLedger(pool, runner.checkpointKey)).resolves.toEqual([]);
    expect(testState.handlerCalls).toBe(0);
  });

  it("rolls back handler failures so the asynchronous runner can apply the event", async () => {
    const runtime = createRuntime(pool);
    const event = (await appendEvents(pool, "inline.item-retry", [{ itemId: "retry" }]))[0]!;
    testState.failNextHandler = true;

    await expect(applyInline(runtime, [event])).resolves.toEqual({ applied: 0, deferred: 0, failed: 1 });
    await expect(readLedger(pool, runtime.subscriptionRunners[0]!.checkpointKey)).resolves.toEqual([]);

    await runtime.subscriptionRunners[0]!.runOnce();
    expect(testState.handlerCalls).toBe(2);
    await expect(readItems(pool)).resolves.toEqual([{ item_id: "retry", seen_count: 1 }]);
    await expect(readLedger(pool, runtime.subscriptionRunners[0]!.checkpointKey)).resolves.toEqual([
      expect.objectContaining({ event_id: String(event.eventId), status: "applied" }),
    ]);
  });

  it("aborts and releases the ledger claim before returning when the hard budget expires", async () => {
    const runtime = createRuntime(pool);
    const runner = runtime.subscriptionRunners[0]!;
    const event = (await appendEvents(pool, "inline.item-budget", [{ itemId: "budget" }]))[0]!;
    let markHandlerStarted: () => void = () => undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    let releaseHandler: () => void = () => undefined;
    const handlerWait = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    testState.handlerGate = { started: markHandlerStarted, wait: handlerWait };

    const inlineAttempt = applyInline(runtime, [event], 25);
    await handlerStarted;
    await expect(inlineAttempt).resolves.toEqual({ applied: 0, deferred: 0, failed: 1 });

    const claimant = await pool.connect();
    try {
      await claimant.query("BEGIN");
      await claimant.query("SET LOCAL lock_timeout = '250ms'");
      await expect(
        claimSubscriptionApplication(claimant, runner.checkpointKey, toTransportEvent(event), {
          ownerId: "async-runner",
          fencingToken: "11",
        }),
      ).resolves.toBe("claimed");
    } finally {
      await claimant.query("ROLLBACK").catch(() => undefined);
      claimant.release();
      releaseHandler();
      testState.handlerGate = null;
    }
  });
});

function createRuntime(pool: PgTransactionalPool) {
  return createMountedContextTestRuntime([{ contextName: "inline", module: inlineModule, pool, ports: {} }]);
}

async function appendEvents(
  pool: PgTransactionalPool,
  streamId: string,
  payloads: readonly Readonly<{ itemId: string }>[],
): Promise<readonly StoredEvent[]> {
  return runWithEventCommitMetadata(async () => {
    const eventStore = createPostgresEventStore({ pool });
    const events = await eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context: {
        tenantId: "tnt_test" as StoredEvent["tenantId"],
        audit: {
          performedByUserId: "usr_test" as StoredEvent["performedByUserId"],
          forAccountId: "acc_test" as StoredEvent["forAccountId"],
        },
      },
      events: payloads.map((payload) => ({ eventType: "inline.item-recorded", payload })),
    });
    return events;
  });
}

async function applyInline(
  runtime: ReturnType<typeof createRuntime>,
  events: readonly StoredEvent[],
  budgetMs?: number,
) {
  const metadata = await runWithEventCommitMetadata(async () => {
    recordCommittedEvents(events, "inline");
    return getEventCommitMetadata();
  });
  return applyCommittedProjectionEventsInline({
    committedEvents: metadata.committedEvents,
    commitSources: metadata.sources,
    projectionGroups: runtime.projectionGroups,
    budgetMs,
  });
}

async function readLedger(pool: PgTransactionalPool, projectionKey: string) {
  const result = await pool.query<{
    event_id: string;
    status: string;
    lease_owner_id: string | null;
    lease_fencing_token: string | null;
  }>(
    `SELECT event_id, status, lease_owner_id, lease_fencing_token::text
     FROM event_subscription_applications
     WHERE projection_key = $1
     ORDER BY global_position`,
    [projectionKey],
  );
  return result.rows;
}

async function readItems(pool: PgTransactionalPool) {
  return (await pool.query<{ item_id: string; seen_count: number }>(`SELECT * FROM inline_items ORDER BY item_id`))
    .rows;
}
