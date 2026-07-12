import { describe, expect, it, vi } from "vitest";
import { buildSupportAffectedLineAmountProjectionHandlers } from "./affected-line-amount-projection";

function event(type: string, data: unknown) {
  return { type, data } as never;
}

describe("support affected line-item amount projection", () => {
  it("stores line totals and joins payment currency regardless of source event order", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const paymentHandlers = buildSupportAffectedLineAmountProjectionHandlers(db as never, "payments");
    const orderingHandlers = buildSupportAffectedLineAmountProjectionHandlers(db as never, "ordering");

    await paymentHandlers["payments.payment-created"]?.(
      event("payments.payment-created", {
        orderIds: ["ord_1"],
        currencyCode: "USD",
      }),
    );
    await orderingHandlers["ordering.order.line-item-amounts-published"]?.(
      event("ordering.order.line-item-amounts-published", {
        orderId: "ord_1",
        lineItems: [{ lineId: "line_1", amount: "0.30" }],
      }),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("support_order_payment_currencies"), [
      "ord_1",
      "usd",
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("FROM support_order_payment_currencies"), [
      "ord_1",
      "line_1",
      "0.30",
    ]);
  });

  it("backfills currency onto already-projected line totals", async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const handlers = buildSupportAffectedLineAmountProjectionHandlers(db as never, "payments");

    await handlers["payments.payment-created"]?.(
      event("payments.payment-created", {
        orderIds: ["ord_1", "ord_2"],
        currencyCode: "eur",
      }),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE support_order_affected_line_amounts"), [
      "ord_1",
      "eur",
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE support_order_affected_line_amounts"), [
      "ord_2",
      "eur",
    ]);
  });
});
