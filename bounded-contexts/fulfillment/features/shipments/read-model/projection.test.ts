import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { buildFulfillmentShipmentProjectionHandlers } from "./projection";

describe("Fulfillment postage subject tenant projection", () => {
  it("records Channel Fulfillment Record identity and quarantines a mismatched replay", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [], rowCount: 1 }));
    const db = { query };
    const handlers = buildFulfillmentShipmentProjectionHandlers(db as never);

    await handlers["fulfillment.channel-fulfillment-record.created"]!({
      type: "fulfillment.channel-fulfillment-record.created",
      tenantId: "tnt_1",
      data: {
        channelFulfillmentRecordId: "cfr_1",
        sellerAccountId: "acc_seller",
        createdAt: "2026-09-10T00:00:00.000Z",
      },
    } as never);

    expect(db.query).toHaveBeenCalledOnce();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("fulfillment_channel_fulfillment_record_tenant_resolutions"),
      ["cfr_1", "tnt_1", "acc_seller", "2026-09-10T00:00:00.000Z"],
    );
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("fulfillment_channel_fulfillment_record_tenant_resolutions.status = 'resolved'");
    expect(sql).not.toMatch(/SET\s+(?:tenant_id|seller_account_id)\s*=/);
    expect(sql).toContain("THEN 'resolved' ELSE 'quarantined' END");
    expect(sql).toContain("THEN 'authoritative-history' ELSE 'projection-identity-mismatch' END");
  });
});

describe("fulfillment shipment conflict projection", () => {
  it("inserts a keyed cancellation conflict without overwriting another origin", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const handler = buildFulfillmentShipmentProjectionHandlers({ query } as never)[
      "fulfillment.shipment.cancellation-conflict-recorded"
    ];
    const event = (origin: "order-cancelled" | "payment-fraud-warning", reason: string | null) =>
      buildTransportEvent(
        "fulfillment.shipment.cancellation-conflict-recorded",
        { shipmentId: "shp_race", orderId: "ord_race", reason, shipmentStatus: "packing", origin },
        {
          streamId: "fulfillment.shipment-shp_race",
          timing: {
            occurredAt: "2026-08-02T12:00:00.000Z",
            recordedAt: "2026-08-02T12:00:01.000Z",
          },
        },
      );
    await handler?.(event("order-cancelled", "   "));
    await handler?.(event("payment-fraud-warning", null));
    await handler?.(event("order-cancelled", "   "));
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (shipment_id, order_id, conflict_kind, origin) DO NOTHING"),
      ["shp_race", "ord_race", "order-cancelled", "   ", "packing", "2026-08-02T12:00:00.000Z"],
    );
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      "shp_race",
      "ord_race",
      "payment-fraud-warning",
      null,
      "packing",
      "2026-08-02T12:00:00.000Z",
    ]);
  });
});
