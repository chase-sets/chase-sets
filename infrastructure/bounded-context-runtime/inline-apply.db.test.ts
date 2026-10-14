import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defineBoundedContextModule, type BcApiEntry } from "@chase-sets/bounded-context-module";
import {
  getEventCommitMetadata,
  recordCommittedEvents,
  runWithEventCommitMetadata,
  toTransportEvent,
  type StoredEvent,
} from "@chase-sets/event-core";
import { createProjectionHandlerSet } from "@chase-sets/event-core/projector";
import {
  createPostgresEventStore,
  type PgPoolClient,
  type PgQueryResult,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { applyCommittedProjectionEventsInline } from "./inline-apply";
import { ProjectionFreshnessTimeoutError, waitForProjectionFreshness } from "./api-mounts";
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

const NO_API_ENTRIES: readonly BcApiEntry[] = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const RECEIPT_FIXTURE_BUDGET_MS = 360_000;
const INLINE_APPLY_LIVENESS_MS = 30_000;

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
  buildApis: () => NO_API_ENTRIES,
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

  it("returns fresh from the applied ledger on the first check while the checkpoint remains behind", async () => {
    const runtime = createRuntime(withConnectDelay(pool, 150));
    const runner = runtime.subscriptionRunners[0]!;
    const event = (await appendEvents(pool, "inline.item-fresh", [{ itemId: "fresh" }]))[0]!;

    await expect(applyInline(runtime, [event])).resolves.toEqual({ applied: 1, deferred: 0, failed: 0 });
    await expect(runner.refreshStatus()).resolves.toMatchObject({ lastGlobalPosition: "0", state: "behind" });

    await expect(
      waitForProjectionFreshness({
        projectionGroups: runtime.projectionGroups,
        targetContextNames: ["inline"],
        receipt: {
          observedAtMs: Date.now(),
          sources: [
            {
              sourceContextName: "inline",
              maxGlobalPosition: event.globalPosition,
              eventIds: [String(event.eventId)],
            },
          ],
        },
        timeoutMs: 0,
      }),
    ).resolves.toEqual({ wakeRequestCount: 0, workSignalErrorPresent: false });
  });

  it("ignores real non-subscribed receipt events once the subscribed subset is applied", async () => {
    const runtime = createRuntime(withConnectDelay(pool, 150));
    const events = await appendTypedEvents(pool, "inline.item-mixed", [
      { eventType: "inline.item-recorded", payload: { itemId: "mixed" } },
      { eventType: "inline.audit-recorded", payload: { itemId: "ignored" } },
    ]);

    await expect(applyInline(runtime, events)).resolves.toEqual({ applied: 1, deferred: 0, failed: 0 });
    await expect(
      waitForProjectionFreshness({
        projectionGroups: runtime.projectionGroups,
        targetContextNames: ["inline"],
        receipt: {
          observedAtMs: Date.now(),
          sources: [
            {
              sourceContextName: "inline",
              maxGlobalPosition: events[1]!.globalPosition,
              eventIds: events.map((event) => String(event.eventId)),
            },
          ],
        },
        timeoutMs: 0,
      }),
    ).resolves.toEqual({ wakeRequestCount: 0, workSignalErrorPresent: false });
  });

  it("does not report an applied receipt event fresh while its stream is blocked", async () => {
    const runtime = createRuntime(pool);
    const runner = runtime.subscriptionRunners[0]!;
    const event = (await appendEvents(pool, "inline.item-poisoned", [{ itemId: "poisoned" }]))[0]!;
    await expect(applyInline(runtime, [event])).resolves.toEqual({ applied: 1, deferred: 0, failed: 0 });
    await pool.query(
      `INSERT INTO event_projection_blocked_streams (
         projection_key, stream_id, first_blocked_global_position, first_blocked_stream_version,
         last_seen_global_position, deferred_event_count, state, updated_at
       ) VALUES ($1, $2, $3::bigint, 1, $3::bigint, 0, 'blocked', now())`,
      [runner.checkpointKey, event.streamId, event.globalPosition],
    );

    await expect(
      waitForProjectionFreshness({
        projectionGroups: runtime.projectionGroups,
        targetContextNames: ["inline"],
        receipt: {
          observedAtMs: Date.now(),
          sources: [
            {
              sourceContextName: "inline",
              maxGlobalPosition: event.globalPosition,
              eventIds: [String(event.eventId)],
            },
          ],
        },
        timeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(ProjectionFreshnessTimeoutError);
  });

  it("does not report an applied receipt event fresh while it has an active poison record", async () => {
    const runtime = createRuntime(pool);
    const runner = runtime.subscriptionRunners[0]!;
    const event = (await appendEvents(pool, "inline.item-active-poison", [{ itemId: "active-poison" }]))[0]!;
    await expect(applyInline(runtime, [event])).resolves.toEqual({ applied: 1, deferred: 0, failed: 0 });
    await pool.query(
      `INSERT INTO event_projection_poison_events (
         projection_key, event_id, projection_name, projection_kind,
         target_context_name, source_context_name, projection_revision, subscription_version,
         stream_id, stream_version, event_type, global_position, failure_kind,
         error_message, error_stack, state, retry_count, first_seen_at, last_seen_at, resolved_at
       ) VALUES (
         $1, $2, 'inline.items', 'subscription',
         'inline', 'inline', 1, 1,
         $3, 1, 'inline.item-recorded', $4::bigint, 'poison',
         'test poison', NULL, 'blocked', 0, now(), now(), NULL
       )`,
      [runner.checkpointKey, String(event.eventId), event.streamId, event.globalPosition],
    );

    await expect(waitForEventFreshness(runtime, event)).rejects.toBeInstanceOf(ProjectionFreshnessTimeoutError);
  });

  it("does not let an unknown receipt event id bypass the checkpoint predicate", async () => {
    const runtime = createRuntime(pool);
    const event = (await appendEvents(pool, "inline.item-forged", [{ itemId: "forged" }]))[0]!;
    await expect(applyInline(runtime, [event])).resolves.toEqual({ applied: 1, deferred: 0, failed: 0 });

    await expect(
      waitForProjectionFreshness({
        projectionGroups: runtime.projectionGroups,
        targetContextNames: ["inline"],
        receipt: {
          observedAtMs: Date.now(),
          sources: [
            {
              sourceContextName: "inline",
              maxGlobalPosition: event.globalPosition,
              eventIds: ["evt_unknown"],
            },
          ],
        },
        timeoutMs: 0,
      }),
    ).rejects.toBeInstanceOf(ProjectionFreshnessTimeoutError);
  });

  it("defers without blocking or stealing an in-flight runner claim", async () => {
    const runtime = createRuntime(pool);
    const runner = runtime.subscriptionRunners[0]!;
    const event = (await appendEvents(pool, "inline.item-2", [{ itemId: "item-2" }]))[0]!;
    const transportEvent = toTransportEvent(event);
    const client = await pool.connect();
    let inlineAttempt: ReturnType<typeof applyInline> | undefined;
    try {
      await client.query("BEGIN");
      await expect(
        claimSubscriptionApplication(client, runner.checkpointKey, transportEvent, {
          ownerId: "async-runner",
          fencingToken: "7",
        }),
      ).resolves.toBe("claimed");

      // The holder transaction stays open, so only the inline claim's own lock
      // budget can let this apply settle. The liveness timer is not a latency
      // claim; it turns a held-lock wait into a fast, named failure.
      inlineAttempt = applyInline(runtime, [event]);
      let livenessTimer: ReturnType<typeof setTimeout> | undefined;
      const liveness = new Promise<never>((_, reject) => {
        livenessTimer = realSetTimeout(
          () => reject(new Error("inline apply blocked on the held runner claim")),
          INLINE_APPLY_LIVENESS_MS,
        );
      });
      try {
        await expect(Promise.race([inlineAttempt, liveness])).resolves.toEqual({ applied: 0, deferred: 1, failed: 0 });
      } finally {
        realClearTimeout(livenessTimer);
      }
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
      // A losing apply is unblocked by the rollback; drain it before cleanup.
      await inlineAttempt?.catch(() => undefined);
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

  it("settles without starting the handler when connect outlasts the hard budget", async () => {
    const runtime = createRuntime(withConnectDelay(pool, 100));
    const runner = runtime.subscriptionRunners[0]!;
    const event = (await appendEvents(pool, "inline.item-delayed-connect", [{ itemId: "delayed-connect" }]))[0]!;
    let markHandlerStarted: () => void = () => undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    let releaseHandler: () => void = () => undefined;
    const handlerWait = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    testState.handlerGate = { started: markHandlerStarted, wait: handlerWait };

    try {
      await expect(applyInline(runtime, [event], 25)).resolves.toEqual({ applied: 0, deferred: 0, failed: 1 });
      expect(testState.handlerCalls).toBe(0);
      await expect(Promise.race([handlerStarted, Promise.resolve("pending")])).resolves.toBe("pending");
      await expect(readLedger(pool, runner.checkpointKey)).resolves.toEqual([]);
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
      }
    } finally {
      releaseHandler();
      testState.handlerGate = null;
    }
  });

  it.each([0, 100])(
    "aborts and releases the ledger claim before returning when the hard budget expires (connect delay %i ms)",
    async (connectDelayMs) => {
      const statementClock = withStatementClock(withConnectDelay(pool, connectDelayMs));
      const statementDelay = withActiveStatementDelay(statementClock.pool);
      const runtime = createRuntime(statementDelay.pool);
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

      let diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
      let inlineAttempt: ReturnType<typeof applyInline> | undefined;
      const diagnosticBound = new Promise<Readonly<{ kind: "diagnostic-bound" }>>((resolve) => {
        diagnosticTimer = realSetTimeout(() => resolve({ kind: "diagnostic-bound" }), 30_000);
      });
      try {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        inlineAttempt = applyInline(runtime, [event], 25);
        const settlement = inlineAttempt.then((summary) => ({ kind: "settled" as const, summary }));
        const first = await Promise.race([
          handlerStarted.then(() => ({ kind: "handler-started" as const })),
          settlement,
          diagnosticBound,
        ]);
        if (first.kind === "settled") {
          throw new Error(`attempt settled before handler start: ${JSON.stringify(first.summary)}`);
        }
        if (first.kind === "diagnostic-bound") {
          throw new Error("neither handler start nor settlement");
        }

        expect(testState.handlerCalls).toBe(1);
        expect(statementClock.requests).toEqual(["25ms"]);
        expect(statementDelay.observations).toEqual([expect.objectContaining({ fakeAdvancement: 0, code: null })]);
        await expect(Promise.race([settlement, Promise.resolve("pending")])).resolves.toBe("pending");

        vi.advanceTimersByTime(25);
        const result = await Promise.race([settlement, diagnosticBound]);
        if (result.kind === "diagnostic-bound") {
          throw new Error("handler started but attempt did not settle");
        }
        expect(result.summary).toEqual({ applied: 0, deferred: 0, failed: 1 });
        expect(statementClock.closedClients).toBe(1);
        expect(statementClock.releasedClients).toBe(1);
        expect(statementClock.pendingTimers).toBe(0);
        vi.useRealTimers();
        await expect(readLedger(pool, runner.checkpointKey)).resolves.toEqual([]);

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
        }
      } finally {
        releaseHandler();
        testState.handlerGate = null;
        await inlineAttempt?.catch(() => undefined);
        await statementClock.drain();
        vi.useRealTimers();
        realClearTimeout(diagnosticTimer);
      }
    },
  );

  it("settles before handler start when a real statement outlasts the unchanged hard budget", async () => {
    const statementDelay = withActiveStatementDelay(pool);
    const runtime = createRuntime(statementDelay.pool);
    const runner = runtime.subscriptionRunners[0]!;
    const event = (await appendEvents(pool, "inline.item-native-budget", [{ itemId: "native-budget" }]))[0]!;
    const outcomes: string[] = [];
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const startedAt = Date.now();
      const metadata = await runWithEventCommitMetadata(async () => {
        recordCommittedEvents([event], "inline");
        return getEventCommitMetadata();
      });
      await expect(
        applyCommittedProjectionEventsInline({
          committedEvents: metadata.committedEvents,
          commitSources: metadata.sources,
          projectionGroups: runtime.projectionGroups,
          budgetMs: 25,
          recordOutcome: ({ outcome, reason }) => outcomes.push(`${outcome}/${reason}`),
        }),
      ).resolves.toEqual({ applied: 0, deferred: 0, failed: 1 });
      expect(Date.now() - startedAt).toBe(0);
      expect(testState.handlerCalls).toBe(0);
      expect(outcomes).toEqual(["failed/budget-exceeded"]);
      expect(statementDelay.observations).toEqual([
        { timeout: "25ms", pid: expect.any(Number), code: "57014", fakeAdvancement: 0 },
      ]);
      vi.useRealTimers();
      await expect(readLedger(pool, runner.checkpointKey)).resolves.toEqual([]);
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
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers the unchanged statement deadline and clears transaction-local timers at fixture boundaries", async () => {
    const statementClock = withStatementClock(pool);
    const client = await statementClock.pool.connect();
    const blocker = await pool.connect();
    let released = false;
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      await client.query("BEGIN");
      await client.query("SELECT set_config('statement_timeout', $1, true)", ["25ms"]);
      await expect(client.query("SELECT 1 AS value")).resolves.toMatchObject({ rows: [{ value: 1 }] });
      expect(statementClock.pendingTimers).toBe(0);
      await blocker.query("SELECT pg_advisory_lock(9602)");
      const heldQuery = client.query("SELECT pg_advisory_xact_lock(9602)");
      const settlement = heldQuery.then(
        () => "completed",
        (error: unknown) => error,
      );
      expect(statementClock.pendingTimers).toBe(1);
      await vi.advanceTimersByTimeAsync(24);
      await expect(Promise.race([settlement, Promise.resolve("pending")])).resolves.toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      await expect(Promise.race([settlement, Promise.resolve("pending")])).resolves.toMatchObject({ code: "57014" });
      await blocker.query("SELECT pg_advisory_unlock(9602)");
      await statementClock.drain();
      expect(statementClock.pendingTimers).toBe(0);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      const withoutPolicy = client.query("SELECT 1 AS value");
      expect(statementClock.pendingTimers).toBe(0);
      await withoutPolicy;
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SELECT set_config('statement_timeout', $1, true)", ["25ms"]);
      client.release(new Error("boundary fixture releases its active transaction"));
      released = true;
      expect(statementClock.pendingTimers).toBe(0);
      expect(statementClock.activePolicies).toBe(0);
      const closingClient = await statementClock.pool.connect();
      try {
        await closingClient.query("ROLLBACK");
        await closingClient.query("BEGIN");
        await closingClient.query("SELECT set_config('statement_timeout', $1, true)", ["25ms"]);
        await closingClient.end();
        expect(statementClock.activePolicies).toBe(0);
        expect(statementClock.closedClients).toBe(1);
      } finally {
        closingClient.release(new Error("boundary fixture closed its client"));
      }
      expect(statementClock.requests).toEqual(["25ms", "25ms", "25ms"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      blocker.release();
      await statementClock.drain();
      if (!released) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      vi.useRealTimers();
    }
  });
});

function withStatementClock(pool: PgTransactionalPool) {
  const requests: string[] = [];
  const queries = new Set<Promise<unknown>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const policies = new Set<PgPoolClient>();
  let closedClients = 0;
  let releasedClients = 0;
  return {
    requests,
    get pendingTimers() {
      return timers.size;
    },
    get activePolicies() {
      return policies.size;
    },
    get closedClients() {
      return closedClients;
    },
    get releasedClients() {
      return releasedClients;
    },
    drain: () => Promise.allSettled([...queries]),
    pool: {
      query: pool.query.bind(pool),
      idleInTransactionSessionTimeoutMillis: pool.idleInTransactionSessionTimeoutMillis,
      connect: async () => {
        const client = await pool.connect();
        const originalQuery = client.query.bind(client);
        const clientTimers = new Set<ReturnType<typeof setTimeout>>();
        let timeoutMs: number | undefined;
        const reset = () => {
          timeoutMs = undefined;
          policies.delete(client);
          for (const timer of clientTimers) {
            clearTimeout(timer);
            timers.delete(timer);
          }
          clientTimers.clear();
        };
        return {
          query: async <Row = Record<string, unknown>>(
            text: string,
            values?: readonly unknown[],
          ): Promise<PgQueryResult<Row>> => {
            if (text === "SELECT set_config('statement_timeout', $1, true)") {
              expect(values).toEqual(["25ms"]);
              requests.push(String(values![0]));
              timeoutMs = 25;
              policies.add(client);
              // Substitute only the deadline's clock; PostgreSQL still executes the query.
              return originalQuery<Row>("SELECT $1::text AS set_config", values);
            }
            if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") reset();
            const query = originalQuery<Row>(text, values);
            queries.add(query);
            void query.finally(() => queries.delete(query)).catch(() => undefined);
            if (timeoutMs === undefined) return query;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(Object.assign(new Error("statement timeout"), { code: "57014" })),
                timeoutMs,
              );
              clientTimers.add(timer);
              timers.add(timer);
            });
            try {
              return await Promise.race([query, deadline]);
            } finally {
              clearTimeout(timer);
              timers.delete(timer!);
              clientTimers.delete(timer!);
            }
          },
          end: async () => {
            reset();
            await (client as PgPoolClient & { end: () => Promise<void> }).end();
            closedClients += 1;
          },
          release: (error?: unknown) => {
            reset();
            client.release(error);
            releasedClients += 1;
          },
        };
      },
    },
  };
}

function withActiveStatementDelay(pool: PgTransactionalPool) {
  const observations: { timeout: string; pid: number; code: string | null; fakeAdvancement: number }[] = [];
  return {
    observations,
    pool: {
      query: pool.query.bind(pool),
      idleInTransactionSessionTimeoutMillis: pool.idleInTransactionSessionTimeoutMillis,
      connect: async () => {
        const client = await pool.connect();
        const query = client.query.bind(client);
        return {
          query: async <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
            if (text.startsWith("WITH lock_budget AS MATERIALIZED")) {
              const setting = await query<{ timeout: string; pid: number }>(
                "SELECT current_setting('statement_timeout') AS timeout, pg_backend_pid() AS pid",
              );
              const startedAt = Date.now();
              const observation = { ...setting.rows[0]!, code: null as string | null, fakeAdvancement: 0 };
              observations.push(observation);
              try {
                await query("SELECT pg_sleep(0.1)");
              } catch (error) {
                observation.code = String((error as { code?: unknown }).code);
                throw error;
              } finally {
                observation.fakeAdvancement = Date.now() - startedAt;
              }
            }
            return query<Row>(text, values);
          },
          release: client.release.bind(client),
          end: () => (client as PgPoolClient & { end: () => Promise<void> }).end(),
        };
      },
    },
  };
}

function withConnectDelay(pool: PgTransactionalPool, delayMs: number): PgTransactionalPool {
  return {
    query: pool.query.bind(pool),
    idleInTransactionSessionTimeoutMillis: pool.idleInTransactionSessionTimeoutMillis,
    connect: async () => {
      await new Promise<void>((resolve) => realSetTimeout(resolve, delayMs));
      return pool.connect();
    },
  };
}

function createRuntime(pool: PgTransactionalPool) {
  return createMountedContextTestRuntime([{ contextName: "inline", module: inlineModule, pool, ports: {} }]);
}

async function appendEvents(
  pool: PgTransactionalPool,
  streamId: string,
  payloads: readonly Readonly<{ itemId: string }>[],
): Promise<readonly StoredEvent[]> {
  return appendTypedEvents(
    pool,
    streamId,
    payloads.map((payload) => ({ eventType: "inline.item-recorded", payload })),
  );
}

async function appendTypedEvents(
  pool: PgTransactionalPool,
  streamId: string,
  eventsToAppend: readonly Readonly<{ eventType: string; payload: Readonly<{ itemId: string }> }>[],
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
      events: eventsToAppend,
    });
    return events;
  });
}

async function applyInline(
  runtime: ReturnType<typeof createRuntime>,
  events: readonly StoredEvent[],
  budgetMs = RECEIPT_FIXTURE_BUDGET_MS,
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

function waitForEventFreshness(runtime: ReturnType<typeof createRuntime>, event: StoredEvent) {
  return waitForProjectionFreshness({
    projectionGroups: runtime.projectionGroups,
    targetContextNames: ["inline"],
    receipt: {
      observedAtMs: Date.now(),
      sources: [
        {
          sourceContextName: "inline",
          maxGlobalPosition: event.globalPosition,
          eventIds: [String(event.eventId)],
        },
      ],
    },
    timeoutMs: 0,
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
