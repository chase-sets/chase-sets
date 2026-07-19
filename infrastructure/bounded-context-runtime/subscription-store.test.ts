import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres/schema";
import { describe, expect, it } from "vitest";
import {
  areSubscribedReceiptEventsApplied,
  createCheckpointKey,
  loadSubscriptionCheckpointRecoveryState,
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
