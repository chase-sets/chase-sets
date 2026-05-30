import { describe, expect, it, vi } from "vitest";
import { buildOrderingFulfillmentCancellationProjectionHandlers } from "./fulfillment-projection";

describe("ordering fulfillment cancellation inputs", () => {
  it("records packing start as fulfillment-started input", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildOrderingFulfillmentCancellationProjectionHandlers(db as never);

    await handlers["fulfillment.shipment.packing-started"]?.({
      type: "fulfillment.shipment.packing-started",
      data: {
        shipmentId: "shp_1",
        orderId: "ord_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        startedAt: "2026-04-02T00:03:00.000Z",
      },
    } as never);

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("shipment_status = 'packing'"), [
      "shp_1",
      "2026-04-02T00:03:00.000Z",
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("package_status = 'packing'"), [
      "shp_1",
      "2026-04-02T00:03:00.000Z",
    ]);
  });
});
