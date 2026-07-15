import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { describe, expect, it, vi } from "vitest";
import { buildInventoryRecoveredItemProjectionHandlers } from "./projection";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${streamVersion}`,
    streamId: "inventory.recovered-item-rcv_1",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_1",
    audit: { performedByUserId: "usr_1", forAccountId: null },
    timing: { occurredAt: "2026-07-15T00:00:00.000Z", recordedAt: "2026-07-15T00:00:00.000Z" },
  });
}

describe("recovered item projection", () => {
  it("rebuilds a quarantined row with a stream-version replay guard and custody audit", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildInventoryRecoveredItemProjectionHandlers(db);

    await handlers["inventory.recovered-item.created.v1"]!(
      event("inventory.recovered-item.created.v1", {
        recoveredItemId: "rcv_1",
        returnShipmentId: "rsh_1",
        remedyId: "rmd_1",
        custodyLocationId: "facility-1:station-2",
        custodyIdentifier: "CUST-1",
        evidenceReferences: ["att_1"],
        observedItemReference: "line-1",
        hasDiscrepancy: false,
        receivedAt: "2026-07-15T00:00:00.000Z",
      }),
    );

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("inventory_recovered_items.last_stream_version < EXCLUDED.last_stream_version"),
      expect.arrayContaining(["rcv_1", "rsh_1", "rmd_1", "quarantined"]),
    );
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("ON CONFLICT (event_id) DO NOTHING"),
      expect.arrayContaining(["evt_1", "rcv_1", "inventory.recovered-item.created.v1"]),
    );
  });

  it("records gross and cost values idempotently without collapsing margin evidence", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildInventoryRecoveredItemProjectionHandlers(db);

    await handlers["inventory.recovered-item.value-reported.v1"]!(
      event(
        "inventory.recovered-item.value-reported.v1",
        {
          factSchemaVersion: 1,
          recoveredItemId: "rcv_1",
          returnShipmentId: "rsh_1",
          remedyId: "rmd_1",
          recoveryId: "recovery-1",
          recoveryType: "liquidation-proceeds",
          grossAmount: "35.00",
          costAmount: "7.00",
          currencyCode: "USD",
          policyVersion: "returns-2026-07",
          evidenceReferences: ["sale-1"],
          recordedAt: "2026-07-15T00:00:00.000Z",
        },
        8,
      ),
    );

    expect(db.query).toHaveBeenNthCalledWith(1, expect.stringContaining("ON CONFLICT (recovery_id) DO NOTHING"), [
      "recovery-1",
      "rcv_1",
      "rmd_1",
      "liquidation-proceeds",
      "35.00",
      "7.00",
      "USD",
      "returns-2026-07",
      JSON.stringify(["sale-1"]),
      "2026-07-15T00:00:00.000Z",
    ]);
  });
});
