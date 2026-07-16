import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildSettlementFulfillmentSourceProjectionHandlers } from "./fulfillment-source-projection";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${streamVersion}`,
    streamId: "fulfillment.shipment-shp_1",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_seller" },
    timing: { occurredAt: "2026-05-01T00:00:00.000Z", recordedAt: "2026-05-01T00:00:00.000Z" },
  });
}

describe("settlement fulfillment source projection", () => {
  it("projects shipment creation and delivery as payout release inputs", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildSettlementFulfillmentSourceProjectionHandlers(db as never);

    await handlers["fulfillment.shipment.created"]!(
      event("fulfillment.shipment.created", {
        shipmentId: "shp_1",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        createdAt: "2026-05-01T00:00:00.000Z",
      }),
    );
    await handlers["fulfillment.shipment.delivered"]!(
      event(
        "fulfillment.shipment.delivered",
        {
          shipmentId: "shp_1",
          trackingIdentifier: "trk_1",
          deliveredAt: "2026-05-04T00:00:00.000Z",
        },
        2,
      ),
    );

    expect(db.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO settlement_order_fulfillment_sources"),
      ["shp_1", "ord_1", "acc_buyer", "acc_seller", null, "2026-05-01T00:00:00.000Z", 1],
    );
    expect(db.query).toHaveBeenNthCalledWith(2, expect.stringContaining("SET status = 'delivered'"), [
      "shp_1",
      "trk_1",
      "2026-05-04T00:00:00.000Z",
      2,
    ]);
  });
});
