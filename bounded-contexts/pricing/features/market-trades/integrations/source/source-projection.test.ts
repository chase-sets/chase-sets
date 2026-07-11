import { describe, expect, it } from "vitest";
import { buildPricingMarketTradesProjectionHandlers } from "./source-projection";

type QueryCall = Readonly<{ sql: string; params: readonly unknown[] }>;

function createRecordingDb() {
  const calls: QueryCall[] = [];
  return {
    calls,
    db: {
      query: async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] };
      },
    },
  };
}

describe("pricing market-trades source projection", () => {
  it("prints a pending trade row per order line, channel-attributed from order sourceType", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesProjectionHandlers(db);

    await handlers["ordering.order.created"]?.({
      type: "ordering.order.created",
      streamId: "ordering.order-ord_1",
      streamVersion: 1,
      data: {
        orderId: "ord_1",
        sourceType: "cart-checkout",
        buyerAccountId: "buyer_1",
        sellerAccountId: "seller_1",
        lines: [
          {
            lineId: "line_1",
            catalogItemId: "cat_1",
            productId: "prod_1",
            unitPriceAmount: "12.50",
            quantity: 2,
          },
        ],
      },
      timing: { recordedAt: "2026-07-01T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("DELETE FROM pricing_market_trades");
    expect(calls[1]?.sql).toContain("INSERT INTO pricing_market_trades");
    expect(calls[1]?.params).toEqual([
      "ord_1",
      "line_1",
      "seller_1",
      "buyer_1",
      "cat_1",
      "prod_1",
      "12.50",
      2,
      "listing",
      "2026-07-01T00:00:00.000Z",
    ]);
  });

  it("maps every order sourceType to the tape's own sale-channel vocabulary", async () => {
    const cases: Array<[string, string]> = [
      ["cart-checkout", "listing"],
      ["buy-now", "buy-now"],
      ["offer-acceptance", "offer-accepted"],
    ];

    for (const [sourceType, expectedChannel] of cases) {
      const { calls, db } = createRecordingDb();
      const handlers = buildPricingMarketTradesProjectionHandlers(db);

      await handlers["ordering.order.created"]?.({
        type: "ordering.order.created",
        streamId: "ordering.order-ord_1",
        streamVersion: 1,
        data: {
          orderId: "ord_1",
          sourceType,
          buyerAccountId: "buyer_1",
          sellerAccountId: "seller_1",
          lines: [
            { lineId: "line_1", catalogItemId: "cat_1", productId: "prod_1", unitPriceAmount: "10.00", quantity: 1 },
          ],
        },
        timing: { recordedAt: "2026-07-01T00:00:00.000Z" },
      } as never);

      expect(calls[1]?.params?.[8]).toBe(expectedChannel);
    }
  });

  it("marks a trade sold when payment capture records the order ready for fulfillment", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesProjectionHandlers(db);

    await handlers["ordering.order.ready-for-fulfillment-recorded"]?.({
      type: "ordering.order.ready-for-fulfillment-recorded",
      streamId: "ordering.order-ord_1",
      streamVersion: 2,
      data: { orderId: "ord_1", readyForFulfillmentAt: "2026-07-02T00:00:00.000Z" },
      timing: { recordedAt: "2026-07-02T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("SET sold_at = $2");
    expect(calls[0]?.sql).toContain("WHERE order_id = $1");
    expect(calls[0]?.sql).toContain("AND sold_at IS NULL");
    expect(calls[0]?.params).toEqual(["ord_1", "2026-07-02T00:00:00.000Z"]);
  });

  it("excludes a trade with reason cancelled when the order is cancelled", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesProjectionHandlers(db);

    await handlers["ordering.order.cancelled"]?.({
      type: "ordering.order.cancelled",
      streamId: "ordering.order-ord_1",
      streamVersion: 2,
      data: { orderId: "ord_1", cancelledAt: "2026-07-02T00:00:00.000Z" },
      timing: { recordedAt: "2026-07-02T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("exclusion_reason = 'cancelled'");
    expect(calls[0]?.sql).toContain("AND excluded = false");
    expect(calls[0]?.params).toEqual(["ord_1", "2026-07-02T00:00:00.000Z"]);
  });

  it("links a trade to its shipment via the order line id, not the shipment's own line id", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesProjectionHandlers(db);

    await handlers["fulfillment.shipment.created"]?.({
      type: "fulfillment.shipment.created",
      streamId: "fulfillment.shipment-ship_1",
      streamVersion: 1,
      data: {
        shipmentId: "ship_1",
        orderId: "ord_1",
        lines: [{ lineId: "shipline_1", orderLineId: "line_1" }],
        createdAt: "2026-07-03T00:00:00.000Z",
      },
      timing: { recordedAt: "2026-07-03T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("SET shipment_id = $3");
    expect(calls[0]?.params).toEqual(["ord_1", "line_1", "ship_1", "2026-07-03T00:00:00.000Z"]);
  });

  it("settles every trade under a shipment once delivered", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesProjectionHandlers(db);

    await handlers["fulfillment.shipment.delivered"]?.({
      type: "fulfillment.shipment.delivered",
      streamId: "fulfillment.shipment-ship_1",
      streamVersion: 2,
      data: { shipmentId: "ship_1", deliveredAt: "2026-07-04T00:00:00.000Z" },
      timing: { recordedAt: "2026-07-04T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("SET settled_at = $2");
    expect(calls[0]?.sql).toContain("WHERE shipment_id = $1");
    expect(calls[0]?.params).toEqual(["ship_1", "2026-07-04T00:00:00.000Z"]);
  });

  it("excludes every trade under a shipment with reason refunded once returned", async () => {
    const { calls, db } = createRecordingDb();
    const handlers = buildPricingMarketTradesProjectionHandlers(db);

    await handlers["fulfillment.shipment.returned"]?.({
      type: "fulfillment.shipment.returned",
      streamId: "fulfillment.shipment-ship_1",
      streamVersion: 3,
      data: { shipmentId: "ship_1", returnedAt: "2026-07-05T00:00:00.000Z" },
      timing: { recordedAt: "2026-07-05T00:00:00.000Z" },
    } as never);

    expect(calls[0]?.sql).toContain("exclusion_reason = 'refunded'");
    expect(calls[0]?.sql).toContain("AND excluded = false");
    expect(calls[0]?.params).toEqual(["ship_1", "2026-07-05T00:00:00.000Z"]);
  });
});
