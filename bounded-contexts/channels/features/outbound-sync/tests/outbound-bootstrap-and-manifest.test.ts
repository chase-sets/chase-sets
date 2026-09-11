import { describe, expect, it } from "vitest";
import { outboundSyncSchemaMigrations, outboundSyncSchemaSql } from "../read-model/schema";

describe("outbound-bootstrap-and-manifest", () => {
  it("keeps all four tables and both lane uniqueness fences in boot and migration SQL", () => {
    const migrationSql = outboundSyncSchemaMigrations.flatMap((migration) => migration.statements).join("\n");
    for (const expected of [
      "channel_outbound_operations",
      "channel_outbound_reservation_settlements",
      "channel_provider_rate_state",
      "channel_outbound_lanes",
      "channel_outbound_operations_one_pending_per_lane_uidx",
      "channel_outbound_operations_one_inflight_per_lane_uidx",
      "channel_outbound_operations_connection_claim_idx",
      "channel_outbound_operations_inline_expiry_idx",
      "source_desired_state_sequence",
      "source_desired_state_hash",
      "payload_digest",
    ]) {
      expect(outboundSyncSchemaSql).toContain(expected);
      expect(migrationSql).toContain(expected);
    }
    expect(outboundSyncSchemaMigrations.map((migration) => migration.migrationId)).toEqual([
      "20260907_channels_outbound_sync",
      "20260910_channels_outbound_reservation_settlements",
    ]);
    expect(outboundSyncSchemaMigrations[0]?.statements.join("\n")).not.toContain(
      "channel_outbound_reservation_settlements",
    );
    expect(outboundSyncSchemaMigrations[1]?.statements.join("\n")).toContain(
      "channel_outbound_reservation_settlements",
    );
  });
});
