import { describe, expect, it } from "vitest";
import {
  createPostgresWorkSignalStore,
  platformWorkSignalStoreSchemaSql,
  type WorkSignalPriorityLane,
  type WorkSignalWakeOrigin,
} from "./work-signal-store";

const NOW = new Date("2026-06-10T12:00:00.000Z");

describe("work signal store", () => {
  it("defines durable wake, readiness, and waiter tables in the control database", () => {
    expect(platformWorkSignalStoreSchemaSql).toContain("CREATE TABLE IF NOT EXISTS platform_projection_wake_intents");
    expect(platformWorkSignalStoreSchemaSql).toContain("coalescing_key text NOT NULL UNIQUE");
    expect(platformWorkSignalStoreSchemaSql).toContain("source_context_name text NOT NULL");
    expect(platformWorkSignalStoreSchemaSql).toContain("target_context_name text NOT NULL");
    expect(platformWorkSignalStoreSchemaSql).toContain("claim_fencing_token bigint");
    expect(platformWorkSignalStoreSchemaSql).toContain("claimed_required_position bigint");
    expect(platformWorkSignalStoreSchemaSql).toContain(
      "CHECK (origin IN ('relay', 'api-wait', 'reconciliation', 'operator'))",
    );
    expect(platformWorkSignalStoreSchemaSql).toContain("idx_platform_projection_wake_intents_claim_due");
    expect(platformWorkSignalStoreSchemaSql).not.toContain("event_payload");

    expect(platformWorkSignalStoreSchemaSql).toContain(
      "CREATE TABLE IF NOT EXISTS platform_projection_checkpoint_readiness",
    );
    expect(platformWorkSignalStoreSchemaSql).toContain("PRIMARY KEY (checkpoint_key, source_context_name)");
    expect(platformWorkSignalStoreSchemaSql).toContain(
      "CREATE TABLE IF NOT EXISTS platform_projection_checkpoint_waiters",
    );
    expect(platformWorkSignalStoreSchemaSql).toContain("idx_platform_projection_checkpoint_waiters_ready");
  });

  it("enqueues projection wake intents with hot-path coalescing semantics", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresWorkSignalStore(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return {
            rows: [
              wakeIntentRow({
                coalescing_key: String(values[1]),
                required_position: String(values[6]),
                required_cursor: String(values[7]),
                priority_lane: values[8] as WorkSignalPriorityLane,
                origin: values[9] as WorkSignalWakeOrigin,
              }),
            ],
            rowCount: 1,
          };
        },
      },
      { now: () => NOW },
    );

    await expect(
      store.enqueueProjectionWakeIntent({
        sourceContextName: "catalog",
        targetContextName: "checkout",
        projectionName: "checkout-session-projection",
        checkpointKey: "checkout.checkout-session-projection:catalog",
        requiredPosition: 12,
        requiredCursor: "catalog:12",
        priorityLane: "hot",
        origin: "api-wait",
        correlationId: "corr_1",
        metadata: { sourceEventId: "evt_1" },
      }),
    ).resolves.toMatchObject({
      sourceContextName: "catalog",
      targetContextName: "checkout",
      requiredPosition: 12n,
      priorityLane: "hot",
      origin: "api-wait",
    });

    expect(calls[0].sql).toContain("ON CONFLICT (coalescing_key)");
    expect(calls[0].sql).toContain("required_position = GREATEST");
    expect(calls[0].sql).toContain("next_eligible_at = LEAST");
    expect(calls[0].sql).toContain("metadata = platform_projection_wake_intents.metadata || EXCLUDED.metadata");
    expect(calls[0].sql).toContain(
      "WHEN platform_projection_wake_intents.state IN ('completed', 'expired') THEN 'queued'",
    );
    expect(String(calls[0].values[1])).toBe(
      "projection-wake:catalog:checkout:checkout-session-projection:checkout.checkout-session-projection:catalog:hot",
    );
    expect(calls[0].values[6]).toBe("12");
    expect(calls[0].values[8]).toBe("hot");
    expect(calls[0].values[9]).toBe("api-wait");
    expect(calls[0].values[13]).toBe(JSON.stringify({ sourceEventId: "evt_1" }));
  });

  it("claims due and stale projection wake intents with deterministic priority and fencing", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresWorkSignalStore(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return {
            rows: [
              wakeIntentRow({
                state: "claimed",
                claim_owner_id: String(values[0]),
                claim_fencing_token: "7",
                claimed_until: String(values[1]),
                priority_lane: "hot",
              }),
            ],
            rowCount: 1,
          };
        },
      },
      { now: () => NOW },
    );

    await expect(
      store.claimNextProjectionWakeIntent({
        claimOwnerId: "projection-worker-a",
        claimTtlMs: 60_000,
        priorityLanes: ["hot"],
      }),
    ).resolves.toMatchObject({
      state: "claimed",
      claimOwnerId: "projection-worker-a",
      claimFencingToken: 7n,
    });

    expect(calls[0].sql).toContain("(state IN ('queued', 'failed') AND next_eligible_at <= now())");
    expect(calls[0].sql).toContain("(state = 'claimed' AND claimed_until <= now())");
    expect(calls[0].sql).toContain("ORDER BY");
    expect(calls[0].sql).toContain("WHEN 'hot' THEN 0");
    expect(calls[0].sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(calls[0].sql).toContain("claim_fencing_token = COALESCE(wake.claim_fencing_token, 0) + 1");
    expect(calls[0].sql).toContain("claimed_required_position = wake.required_position");
    expect(calls[0].sql).toContain("attempt_count = wake.attempt_count + 1");
    expect(calls[0].sql).toContain("($4::text[] IS NULL OR target_context_name = ANY($4::text[]))");
    expect(calls[0].values[2]).toEqual(["hot"]);
    expect(calls[0].values[3]).toBeNull();
  });

  it("claims only hosted target contexts when a target filter is provided", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresWorkSignalStore(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return {
            rows: [
              wakeIntentRow({
                state: "claimed",
                claim_owner_id: String(values[0]),
                claim_fencing_token: "1",
                claimed_until: String(values[1]),
              }),
            ],
            rowCount: 1,
          };
        },
      },
      { now: () => NOW },
    );

    await expect(
      store.claimNextProjectionWakeIntent({
        claimOwnerId: "projection-worker-a",
        claimTtlMs: 60_000,
        targetContextNames: ["checkout", "ordering"],
      }),
    ).resolves.toMatchObject({ state: "claimed" });

    expect(calls[0].values[2]).toEqual(["hot", "standard", "bulk"]);
    expect(calls[0].values[3]).toEqual(["checkout", "ordering"]);
  });

  it("completes and retries only the live fenced claim owner", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresWorkSignalStore(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return sql.includes("RETURNING state")
            ? { rows: [{ state: "completed" }], rowCount: 1 }
            : { rows: [], rowCount: 1 };
        },
      },
      { now: () => NOW },
    );

    await expect(
      store.completeProjectionWakeIntent({
        wakeIntentId: "projection-wake-1",
        claimOwnerId: "projection-worker-a",
        claimFencingToken: 3n,
      }),
    ).resolves.toBe("completed");
    await expect(
      store.failProjectionWakeIntent({
        wakeIntentId: "projection-wake-2",
        claimOwnerId: "projection-worker-a",
        claimFencingToken: 4n,
        retryAfterMs: 250,
        error: { code: "projection_conflict" },
      }),
    ).resolves.toBe(true);

    expect(calls[0].sql).toContain("WHEN required_position > COALESCE(claimed_required_position, required_position)");
    expect(calls[0].sql).toContain("THEN 'queued'");
    expect(calls[0].sql).toContain("claim_owner_id = $2");
    expect(calls[0].sql).toContain("claim_fencing_token = $3::bigint");
    expect(calls[0].sql).toContain("claimed_until > now()");
    expect(calls[0].sql).toContain("claimed_required_position = NULL");
    expect(calls[0].sql).toContain("RETURNING state");
    expect(calls[1].sql).toContain("state = 'failed'");
    expect(calls[1].sql).toContain("next_eligible_at = $4::timestamptz");
    expect(calls[1].values[4]).toBe(JSON.stringify({ code: "projection_conflict" }));
  });

  it("rejects sensitive metadata keys on every durable wake-store write path", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresWorkSignalStore(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return { rows: [wakeIntentRow()], rowCount: 1 };
        },
      },
      { now: () => NOW },
    );
    const target = {
      sourceContextName: "catalog",
      targetContextName: "checkout",
      projectionName: "checkout-session-projection",
      checkpointKey: "checkout.checkout-session-projection:catalog",
    };

    // ADR 0010 / #1235: wake intents, readiness rows, and waiter rows are a
    // privacy boundary for every origin, not just relay-guarded metadata.
    await expect(
      store.enqueueProjectionWakeIntent({
        ...target,
        requiredPosition: 12,
        origin: "operator",
        metadata: { guestEmail: "guest@example.com" },
      }),
    ).rejects.toThrow(/metadata key 'metadata.guestEmail' is not allowed/);
    await expect(
      store.enqueueProjectionWakeIntent({
        ...target,
        requiredPosition: 12,
        origin: "api-wait",
        metadata: { request: { context: { sessionId: "sess_1" } } },
      }),
    ).rejects.toThrow(/metadata key 'metadata.request.context.sessionId' is not allowed/);
    await expect(
      store.recordCheckpointReady({
        ...target,
        readyPosition: 42,
        metadata: { streamId: "checkout.checkout-session-cs_1" },
      }),
    ).rejects.toThrow(/metadata key 'metadata.streamId' is not allowed/);
    await expect(
      store.addCheckpointWaiter({
        ...target,
        requiredPosition: 40,
        origin: "api-wait",
        metadata: { entries: [{ paymentIntentId: "pi_1" }] },
      }),
    ).rejects.toThrow(/metadata key 'metadata.entries.0.payment/);
    // Separator variants cannot slip past key normalization either.
    await expect(
      store.enqueueProjectionWakeIntent({
        ...target,
        requiredPosition: 12,
        origin: "reconciliation",
        metadata: { "guest-email": "guest@example.com" },
      }),
    ).rejects.toThrow(/metadata key 'metadata.guest-email' is not allowed/);

    // Rejection happens before any SQL is issued, so no partial row exists.
    expect(calls).toHaveLength(0);
  });

  it("accepts the metadata keys the relay, scheduler, and api-wait gateway write today", async () => {
    const store = createPostgresWorkSignalStore(
      {
        query: async () => ({ rows: [wakeIntentRow()], rowCount: 1 }),
      },
      { now: () => NOW },
    );

    await expect(
      store.enqueueProjectionWakeIntent({
        sourceContextName: "catalog",
        targetContextName: "checkout",
        projectionName: "checkout-session-projection",
        checkpointKey: "checkout.checkout-session-projection:catalog",
        requiredPosition: 12,
        origin: "relay",
        metadata: {
          // Relay catch-up fan-out metadata (projection-wake-relay.ts).
          projectionWakeRelayCatchUpReason: "notification",
          projectionWakeRelayLeaseName: "projection-wake-relay:active",
          projectionWakeRelayOwnerId: "platform-worker-1",
          projectionWakeRelayFencingToken: "7",
          eventStoreWakeStreamCategory: "checkout.checkout-session",
          eventStoreWakeEventTypes: ["checkout.session.created"],
          eventStoreWakePayloadVersion: 1,
          sourceContextWakeRolloutState: "staging-enabled",
          // Scheduler readiness metadata (projection-wake-scheduler.ts).
          recordedBy: "projection-wake-scheduler",
          wakeIntentId: "projection-wake-1",
          // api-wait gateway metadata (read-consistency-work-signals.ts).
          requestedBy: "read-consistency",
          mountPath: "/api/marketplace",
          routePaths: ["/orders/:orderId"],
        },
      }),
    ).resolves.toBeDefined();
  });

  it("redacts sensitive failure-detail keys instead of throwing while recording a failure", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresWorkSignalStore(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return { rows: [], rowCount: 1 };
        },
      },
      { now: () => NOW },
    );

    await expect(
      store.failProjectionWakeIntent({
        wakeIntentId: "projection-wake-2",
        claimOwnerId: "projection-worker-a",
        claimFencingToken: 4n,
        retryAfterMs: 250,
        error: {
          reason: "projection-run-failed",
          message: "handler failed",
          guestEmail: "guest@example.com",
          details: { streamId: "checkout.checkout-session-cs_1" },
        },
      }),
    ).resolves.toBe(true);

    expect(calls[0].values[4]).toBe(
      JSON.stringify({
        reason: "projection-run-failed",
        message: "handler failed",
        guestEmail: "[redacted]",
        details: { streamId: "[redacted]" },
      }),
    );
  });

  it("reports requeued and lost completion outcomes distinctly", async () => {
    const requeuedStore = createPostgresWorkSignalStore(
      {
        query: async () => ({ rows: [{ state: "queued" }], rowCount: 1 }),
      },
      { now: () => NOW },
    );
    await expect(
      requeuedStore.completeProjectionWakeIntent({
        wakeIntentId: "projection-wake-1",
        claimOwnerId: "projection-worker-a",
        claimFencingToken: 3n,
      }),
    ).resolves.toBe("requeued");

    const lostStore = createPostgresWorkSignalStore(
      {
        query: async () => ({ rows: [], rowCount: 0 }),
      },
      { now: () => NOW },
    );
    await expect(
      lostStore.completeProjectionWakeIntent({
        wakeIntentId: "projection-wake-1",
        claimOwnerId: "projection-worker-b",
        claimFencingToken: 4n,
      }),
    ).resolves.toBe("lost");
  });

  it("clears checkpoint readiness rows for reset checkpoints", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresWorkSignalStore(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          return { rows: [], rowCount: 2 };
        },
      },
      { now: () => NOW },
    );

    await expect(
      store.clearCheckpointReadiness({
        checkpointKeys: ["checkout-session-pages:checkout:v1", "checkout-session-pages:marketplace:v1"],
      }),
    ).resolves.toBe(2);
    expect(calls[0].sql).toContain("DELETE FROM platform_projection_checkpoint_readiness");
    expect(calls[0].sql).toContain("checkpoint_key = ANY($1::text[])");

    await expect(store.clearCheckpointReadiness({ checkpointKeys: [] })).resolves.toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("claims nothing when an empty target filter is provided", async () => {
    const calls: string[] = [];
    const store = createPostgresWorkSignalStore(
      {
        query: async (sql: string) => {
          calls.push(sql);
          return { rows: [], rowCount: 0 };
        },
      },
      { now: () => NOW },
    );

    await expect(
      store.claimNextProjectionWakeIntent({
        claimOwnerId: "projection-worker-a",
        claimTtlMs: 60_000,
        targetContextNames: [],
      }),
    ).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("records checkpoint readiness and satisfies matching waiters atomically", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresWorkSignalStore(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.includes("RETURNING") && sql.includes("platform_projection_checkpoint_readiness")) {
            return {
              rows: [
                checkpointReadinessRow({
                  checkpoint_key: String(values[0]),
                  source_context_name: String(values[1]),
                  target_context_name: String(values[2]),
                  projection_name: String(values[3]),
                  ready_position: String(values[4]),
                  ready_cursor: values[5] as string | null,
                }),
              ],
              rowCount: 1,
            };
          }
          if (sql.includes("SELECT") && sql.includes("platform_projection_checkpoint_waiters")) {
            return {
              rows: [
                checkpointWaiterRow({
                  waiter_id: String(values[0]),
                  satisfied_at: "2026-06-10T12:00:01.000Z",
                }),
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 1 };
        },
      },
      { now: () => NOW },
    );

    await expect(
      store.recordCheckpointReady({
        checkpointKey: "checkout.checkout-session-projection:catalog",
        sourceContextName: "catalog",
        targetContextName: "checkout",
        projectionName: "checkout-session-projection",
        readyPosition: 42,
        readyCursor: "catalog:42",
      }),
    ).resolves.toMatchObject({ checkpointKey: "checkout.checkout-session-projection:catalog", readyPosition: 42n });

    await expect(
      store.addCheckpointWaiter({
        waiterId: "waiter_1",
        checkpointKey: "checkout.checkout-session-projection:catalog",
        sourceContextName: "catalog",
        targetContextName: "checkout",
        projectionName: "checkout-session-projection",
        requiredPosition: 40,
        requiredCursor: "catalog:40",
        origin: "api-wait",
      }),
    ).resolves.toMatchObject({ waiterId: "waiter_1", satisfiedAt: new Date("2026-06-10T12:00:01.000Z") });

    expect(calls[0].sql).toContain("ON CONFLICT (checkpoint_key, source_context_name)");
    expect(calls[0].sql).toContain("ready_position = GREATEST");
    expect(calls[1].sql).toContain("UPDATE platform_projection_checkpoint_waiters");
    expect(calls[1].sql).toContain("required_position <= $3::bigint");
    expect(calls[2].sql).toContain("INSERT INTO platform_projection_checkpoint_waiters");
    expect(calls[3].sql).toContain("FROM platform_projection_checkpoint_readiness readiness");
    expect(calls[3].sql).toContain("readiness.ready_position >= waiters.required_position");
  });

  it("never late-satisfies expired waiters and never satisfies new waiters from expired readiness", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresWorkSignalStore(
      {
        query: async (sql: string, values: readonly unknown[] = []) => {
          calls.push({ sql, values });
          if (sql.includes("INSERT INTO platform_projection_checkpoint_readiness")) {
            return { rows: [checkpointReadinessRow()], rowCount: 1 };
          }
          if (sql.includes("SELECT") && sql.includes("platform_projection_checkpoint_waiters")) {
            return { rows: [checkpointWaiterRow()], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      },
      { now: () => NOW },
    );

    await store.recordCheckpointReady({
      checkpointKey: "checkout.checkout-session-projection:catalog",
      sourceContextName: "catalog",
      targetContextName: "checkout",
      projectionName: "checkout-session-projection",
      readyPosition: 42,
    });
    await store.addCheckpointWaiter({
      waiterId: "waiter_1",
      checkpointKey: "checkout.checkout-session-projection:catalog",
      sourceContextName: "catalog",
      targetContextName: "checkout",
      projectionName: "checkout-session-projection",
      requiredPosition: 40,
      origin: "api-wait",
    });
    await store.cleanupExpiredWorkSignals({ before: NOW, limit: 10 });

    // Readiness recording must not resurrect waiters that already expired
    // (their callers have already timed out fail-closed) or re-satisfy
    // already-satisfied waiters.
    const satisfyOnReadiness = calls.find(
      (call) =>
        call.sql.includes("UPDATE platform_projection_checkpoint_waiters") &&
        call.sql.includes("required_position <= $3::bigint"),
    );
    expect(satisfyOnReadiness?.sql).toContain("expires_at > now()");
    expect(satisfyOnReadiness?.sql).toContain("satisfied_at IS NULL");

    // Late waiter registration must not be satisfied by readiness rows that
    // already expired, so stale readiness can never unblock a fresh wait.
    const satisfyOnRegistration = calls.find((call) =>
      call.sql.includes("FROM platform_projection_checkpoint_readiness readiness"),
    );
    expect(satisfyOnRegistration?.sql).toContain("readiness.ready_position >= waiters.required_position");
    expect(satisfyOnRegistration?.sql).toContain("readiness.expires_at > now()");

    // Cleanup may only prune waiters that expired or were already satisfied;
    // a live unsatisfied waiter is never deleted out from under its caller.
    const waiterPrune = calls.find((call) => call.sql.includes("DELETE FROM platform_projection_checkpoint_waiters"));
    expect(waiterPrune?.sql).toContain("expires_at <= $1::timestamptz");
    expect(waiterPrune?.sql).toContain("satisfied_at <= $1::timestamptz");
  });

  it("exposes bounded cleanup and queue summary queries", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
    const store = createPostgresWorkSignalStore({
      query: async (sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql, values });
        if (sql.includes("COUNT(*) FILTER")) {
          return {
            rows: [
              {
                queued_count: 2,
                claimed_count: 1,
                failed_count: 1,
                expired_count: 3,
                stale_claim_count: 1,
                oldest_queued_at: "2026-06-10T11:59:00.000Z",
                oldest_claimed_at: "2026-06-10T11:59:30.000Z",
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 2 };
      },
    });

    await expect(
      store.cleanupExpiredWorkSignals({
        before: "2026-06-10T12:00:00.000Z",
        limit: 25,
      }),
    ).resolves.toEqual({
      expiredWakeIntents: 2,
      prunedWakeIntents: 2,
      prunedCheckpointReadiness: 2,
      prunedCheckpointWaiters: 2,
    });
    await expect(store.summarizeProjectionWakeIntents()).resolves.toEqual({
      queuedCount: 2,
      claimedCount: 1,
      failedCount: 1,
      expiredCount: 3,
      staleClaimCount: 1,
      oldestQueuedAt: new Date("2026-06-10T11:59:00.000Z"),
      oldestClaimedAt: new Date("2026-06-10T11:59:30.000Z"),
    });

    expect(calls[0].sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(calls[0].values[1]).toBe(25);
    expect(calls[3].sql).toContain("satisfied_at <= $1::timestamptz");
    expect(calls[4].sql).toContain("stale_claim_count");
  });
});

function wakeIntentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    wake_intent_id: "projection-wake-1",
    coalescing_key: "projection-wake:catalog:checkout:checkout-session-projection:checkpoint:hot:catalog:1",
    source_context_name: "catalog",
    target_context_name: "checkout",
    projection_name: "checkout-session-projection",
    checkpoint_key: "checkout.checkout-session-projection:catalog",
    required_position: "1",
    required_cursor: "catalog:1",
    priority_lane: "standard",
    origin: "relay",
    schema_version: 1,
    payload_version: 1,
    correlation_id: "corr_1",
    metadata: {},
    state: "queued",
    claim_owner_id: null,
    claim_fencing_token: null,
    claimed_required_position: null,
    claimed_required_cursor: null,
    claimed_until: null,
    next_eligible_at: "2026-06-10T12:00:00.000Z",
    attempt_count: 0,
    last_error: null,
    created_at: "2026-06-10T12:00:00.000Z",
    updated_at: "2026-06-10T12:00:00.000Z",
    expires_at: "2026-06-10T12:05:00.000Z",
    completed_at: null,
    ...overrides,
  };
}

function checkpointReadinessRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    checkpoint_key: "checkout.checkout-session-projection:catalog",
    source_context_name: "catalog",
    target_context_name: "checkout",
    projection_name: "checkout-session-projection",
    ready_position: "42",
    ready_cursor: "catalog:42",
    schema_version: 1,
    payload_version: 1,
    correlation_id: "corr_1",
    metadata: {},
    recorded_at: "2026-06-10T12:00:00.000Z",
    expires_at: "2026-06-10T12:10:00.000Z",
    ...overrides,
  };
}

function checkpointWaiterRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    waiter_id: "waiter_1",
    checkpoint_key: "checkout.checkout-session-projection:catalog",
    source_context_name: "catalog",
    target_context_name: "checkout",
    projection_name: "checkout-session-projection",
    required_position: "40",
    required_cursor: "catalog:40",
    origin: "api-wait",
    correlation_id: "corr_1",
    metadata: {},
    created_at: "2026-06-10T12:00:00.000Z",
    expires_at: "2026-06-10T12:05:00.000Z",
    satisfied_at: null,
    ...overrides,
  };
}
