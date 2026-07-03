import { describe, expect, it, vi } from "vitest";
import { getActivePaymentByOrderSet, getCapturedPaymentByOrderId, paymentCreationOrderSetKey } from "./queries";

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

  it("uses a canonical order-set key for payment creation reservations", () => {
    expect(paymentCreationOrderSetKey(["ord_2", "ord_1", "ord_1"])).toBe(JSON.stringify(["ord_1", "ord_2"]));
  });

  it("looks up active payments by exact order set through payment-order rows", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };

    await getActivePaymentByOrderSet(db as never, ["ord_2", "ord_1"], "acc_buyer");

    const [sql, values] = db.query.mock.calls[0] as unknown as [string, readonly unknown[]];
    expect(sql).toContain("WITH requested_order_ids AS");
    expect(sql).toContain("FROM payments_payment_orders");
    expect(sql).toContain("COUNT(*) = (SELECT COUNT(*) FROM requested_order_ids)");
    expect(sql).toContain("status = ANY($3::text[])");
    expect(values).toEqual([
      JSON.stringify(["ord_2", "ord_1"]),
      "acc_buyer",
      ["pending-confirmation", "captured", "partially-refunded", "refunded", "disputed"],
    ]);
  });
});
