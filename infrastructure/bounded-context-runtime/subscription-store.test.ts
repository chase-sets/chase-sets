import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import { describe, expect, it } from "vitest";
import {
  areSubscribedReceiptEventsApplied,
  createCheckpointKey,
  loadSubscriptionCheckpointRecoveryState,
  saveSubscriptionCheckpoint,
} from "./subscription-store";

const tenantShardingTrap =
  "Checkpoint keys are durable single-tenant row identities. If the event store becomes tenant-partitioned, " +
  "tenant-qualify the checkpoint key and migrate existing checkpoint rows in the same change; " +
  "otherwise two tenants' projections for the same source+version share one checkpoint row and corrupt each other's read position.";

describe("createCheckpointKey", () => {
  it("pins the single-tenant checkpoint identity", () => {
    expect(
      createCheckpointKey({
        projectionName: "catalog-item-projection",
        sourceContextName: "catalog",
        subscriptionVersion: 3,
      }),
      tenantShardingTrap,
    ).toBe("catalog-item-projection:catalog:v3");
  });

  it("trips when the event store introduces per-tenant sharding without tenant-qualified checkpoints", () => {
    // These are the schema shapes the tenant-free checkpoint key depends on. Each assertion
    // failing means the event store is being tenant-partitioned: stop and apply the migration
    // path described above rather than loosening this test.
    expect(eventCorePostgresSchemaSql, tenantShardingTrap).not.toMatch(/PARTITION BY/i);
    expect(eventCorePostgresSchemaSql, tenantShardingTrap).toContain("global_position bigserial PRIMARY KEY");

    const checkpointsTable = eventCorePostgresSchemaSql.match(
      /CREATE TABLE IF NOT EXISTS event_projection_checkpoints \(([^;]*)\);/,
    )?.[1];
    expect(checkpointsTable, "event_projection_checkpoints DDL not found in event-core schema").toBeDefined();
    expect(checkpointsTable, tenantShardingTrap).toContain("projector_name text PRIMARY KEY");
    expect(checkpointsTable, tenantShardingTrap).not.toContain("tenant");
    expect(eventCorePostgresSchemaSql).not.toContain(
      "CREATE UNLOGGED TABLE IF NOT EXISTS event_projection_checkpoints",
    );
    expect(eventCorePostgresSchemaSql).toContain(
      "CREATE UNLOGGED TABLE IF NOT EXISTS event_projection_recovery_markers",
    );
  });
});

describe("loadSubscriptionCheckpointRecoveryState", () => {
  it.each([
    { recoveryPosition: null, recoveryRequired: true },
    { recoveryPosition: "9", recoveryRequired: true },
    { recoveryPosition: "10", recoveryRequired: false },
    { recoveryPosition: "11", recoveryRequired: false },
  ])("compares the unlogged marker against the durable checkpoint", async ({ recoveryPosition, recoveryRequired }) => {
    const db = {
      query: async () => ({
        rows: [{ last_global_position: "10", recovery_global_position: recoveryPosition }],
      }),
    };

    await expect(loadSubscriptionCheckpointRecoveryState(db as never, "catalog.items:catalog:v1")).resolves.toEqual({
      checkpoint: "10",
      recoveryRequired,
    });
  });
});

describe("saveSubscriptionCheckpoint", () => {
  const subscription = {
    projectionName: "catalog.items",
    sourceContextName: "catalog",
    subscriptionVersion: 3,
  };

  it("locks the canonical checkpoint before saving it in one bounded transaction", async () => {
    const fixture = createSavePool();

    await expect(
      saveSubscriptionCheckpoint(fixture.pool, subscription, parseGlobalPosition("42"), {
        ownerId: "worker-a",
        fencingToken: "7",
      }),
    ).resolves.toBeUndefined();

    expect(fixture.queries.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
      "SELECT set_config('statement_timeout', $1, true)",
      "SELECT pg_advisory_xact_lock(hashtextextended('event_subscription_checkpoints:' || $1::text, 0))",
      expect.stringContaining("WITH saved_checkpoint AS"),
      "COMMIT",
    ]);
    expect(fixture.queries[3]?.params).toEqual(["catalog.items:catalog:v3"]);
    expect(fixture.queries[4]?.params).toEqual([
      "catalog.items:catalog:v3",
      "catalog.items",
      "catalog",
      3,
      "42",
      "worker-a",
      "7",
    ]);
    expect(fixture.releases).toEqual([undefined]);
  });

  it("omits disabled timeout settings without changing the lock and save boundary", async () => {
    const fixture = createSavePool();

    await saveSubscriptionCheckpoint(fixture.pool, subscription, parseGlobalPosition("42"), {
      idleInTransactionSessionTimeoutMs: 0,
      transactionTimeoutMs: 0,
    });

    expect(fixture.queries.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtextextended('event_subscription_checkpoints:' || $1::text, 0))",
      expect.stringContaining("WITH saved_checkpoint AS"),
      "COMMIT",
    ]);
  });

  it.each([
    { label: "absent", fencingToken: undefined, expected: null },
    { label: "empty", fencingToken: "", expected: null },
    { label: "invalid", fencingToken: "7x", expected: null },
    { label: "zero", fencingToken: "0", expected: "0" },
    { label: "numeric", fencingToken: "12", expected: "12" },
  ])("preserves $label fencing-token normalization", async ({ fencingToken, expected }) => {
    const fixture = createSavePool();

    await saveSubscriptionCheckpoint(
      fixture.pool,
      subscription,
      parseGlobalPosition("5"),
      fencingToken === undefined ? undefined : { ownerId: "worker-b", fencingToken },
    );

    const save = fixture.queries.find(({ sql }) => sql.includes("WITH saved_checkpoint AS"));
    expect(save?.params?.[5]).toBe(fencingToken === undefined ? null : "worker-b");
    expect(save?.params?.[6]).toBe(expected);
  });

  it("rolls back when the existing fence rejects the save", async () => {
    const fixture = createSavePool({ saveRowCount: 0 });

    await expect(
      saveSubscriptionCheckpoint(fixture.pool, subscription, parseGlobalPosition("5"), {
        ownerId: "stale-worker",
        fencingToken: "4",
      }),
    ).rejects.toThrow("Subscription checkpoint 'catalog.items:catalog:v3' rejected stale lease fencing token.");

    expect(fixture.queries.map(({ sql }) => sql).slice(-2)).toEqual([
      expect.stringContaining("WITH saved_checkpoint AS"),
      "ROLLBACK",
    ]);
    expect(fixture.queries.some(({ sql }) => sql === "COMMIT")).toBe(false);
    expect(fixture.releases).toEqual([undefined]);
  });

  it.each(["lock", "save", "commit"] as const)("propagates a %s failure and releases the client", async (step) => {
    const failure = Object.assign(new Error(`${step} failed`), { code: "XX999" });
    const fixture = createSavePool({ failure: { step, error: failure } });

    await expect(saveSubscriptionCheckpoint(fixture.pool, subscription, parseGlobalPosition("5"))).rejects.toBe(
      failure,
    );

    expect(fixture.queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(fixture.releases).toEqual([undefined]);
  });
});

describe("areSubscribedReceiptEventsApplied", () => {
  it("uses one indexed statement for the subscribed receipt subset without COUNT(*) backlog reads", async () => {
    const queries: Readonly<{ sql: string; params: readonly unknown[] }>[] = [];
    const db = {
      query: async (sql: string, params: readonly unknown[]) => {
        queries.push({ sql, params });
        return { rows: [{ fresh: true }] };
      },
    };

    await expect(
      areSubscribedReceiptEventsApplied(
        db as never,
        "inline.items:inline:v1",
        ["evt_subscribed", "evt_ignored", "evt_subscribed"],
        ["inline.item-recorded"],
        ["inline.item-"],
      ),
    ).resolves.toBe(true);

    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toContain("WHERE event_id = ANY($2::text[])");
    expect(queries[0]!.sql).toContain("event_type = ANY($3::text[])");
    expect(queries[0]!.sql).toContain("application.status IS DISTINCT FROM 'applied'");
    expect(queries[0]!.sql).toContain("blocked_stream.state IN ('blocked', 'retrying')");
    expect(queries[0]!.sql).toContain("poison_event.state IN ('blocked', 'retrying')");
    expect(queries[0]!.sql).not.toContain("COUNT(*)");
    expect(queries[0]!.params.slice(0, 3)).toEqual([
      "inline.items:inline:v1",
      ["evt_subscribed", "evt_ignored"],
      ["inline.item-recorded"],
    ]);
  });
});

function createSavePool(
  options: {
    saveRowCount?: number;
    failure?: Readonly<{ step: "lock" | "save" | "commit"; error: Error }>;
  } = {},
) {
  const queries: Array<Readonly<{ sql: string; params?: readonly unknown[] }>> = [];
  const releases: unknown[] = [];
  const query = async (sql: string, params?: readonly unknown[]) => {
    queries.push({ sql, ...(params ? { params } : {}) });
    const step = sql.includes("pg_advisory_xact_lock")
      ? "lock"
      : sql.includes("WITH saved_checkpoint AS")
        ? "save"
        : sql === "COMMIT"
          ? "commit"
          : undefined;
    if (step && options.failure?.step === step) {
      throw options.failure.error;
    }
    return {
      rows: [],
      rowCount: step === "save" ? (options.saveRowCount ?? 1) : 0,
    };
  };
  const pool = {
    query,
    connect: async () => ({
      query,
      release: (error?: unknown) => releases.push(error),
    }),
  };

  return { pool: pool as never, queries, releases };
}
