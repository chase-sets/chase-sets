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

  it("releases the seller's Order Capacity claim and reports it on dispatch (m127)", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("UPDATE ordering_fulfillment_cancellation_inputs")) {
          return { rows: [{ order_id: "ord_1" }] };
        }
        if (sql.includes("UPDATE ordering_seller_open_order_claims")) {
          return { rows: [{ seller_account_id: "acc_seller" }] };
        }
        return { rows: [] };
      }),
    };
    const onOrderCapacityReleased = vi.fn(async () => {});
    const handlers = buildOrderingFulfillmentCancellationProjectionHandlers(db as never, {
      onOrderCapacityReleased,
    });

    await handlers["fulfillment.shipment.dispatched"]?.({
      type: "fulfillment.shipment.dispatched",
      tenantId: "tnt_1",
      audit: { performedByUserId: "usr_1", forAccountId: "acc_buyer" },
      trace: {},
      data: {
        shipmentId: "shp_1",
        dispatchedAt: "2026-04-02T00:05:00.000Z",
      },
    } as never);

    expect(onOrderCapacityReleased).toHaveBeenCalledWith({
      sellerAccountId: "acc_seller",
      context: { tenantId: "tnt_1", audit: { performedByUserId: "usr_1", forAccountId: "acc_buyer" }, trace: {} },
    });
  });

  it("does not report a capacity release when the shipment has no open claim", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("UPDATE ordering_fulfillment_cancellation_inputs")) {
          return { rows: [{ order_id: "ord_1" }] };
        }
        return { rows: [] };
      }),
    };
    const onOrderCapacityReleased = vi.fn(async () => {});
    const handlers = buildOrderingFulfillmentCancellationProjectionHandlers(db as never, {
      onOrderCapacityReleased,
    });

    await handlers["fulfillment.shipment.dispatched"]?.({
      type: "fulfillment.shipment.dispatched",
      tenantId: "tnt_1",
      audit: { performedByUserId: "usr_1", forAccountId: "acc_buyer" },
      trace: {},
      data: {
        shipmentId: "shp_1",
        dispatchedAt: "2026-04-02T00:05:00.000Z",
      },
    } as never);

    expect(onOrderCapacityReleased).not.toHaveBeenCalled();
  });
});
