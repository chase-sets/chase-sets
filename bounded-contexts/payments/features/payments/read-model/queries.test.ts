import { describe, expect, it, vi } from "vitest";
import { getCapturedPaymentByOrderId } from "./queries";

describe("payment read-model queries", () => {
  it("looks up captured payments through indexed payment-order rows", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };

    await getCapturedPaymentByOrderId(db as never, "ord_1");

    const [sql, values] = db.query.mock.calls[0] as unknown as [string, readonly unknown[]];
    expect(sql).toContain("FROM payments_payment_orders");
    expect(sql).toContain("WHERE order_id = $1");
    expect(sql).not.toContain("order_ids @>");
    expect(values).toEqual(["ord_1"]);
  });
});
