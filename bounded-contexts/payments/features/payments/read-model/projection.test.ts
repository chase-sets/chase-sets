import { describe, expect, it, vi } from "vitest";
import { buildPaymentProjectionHandlers } from "./projection";

function paymentCreatedEvent(
  overrides: Partial<{
    paymentId: string;
    orderIds: string[];
    processorPaymentReference: string;
    sourceContext: string | null;
    sourceReferenceId: string | null;
    streamVersion: number;
  }> = {},
) {
  return {
    streamVersion: overrides.streamVersion ?? 7,
    data: {
      paymentId: overrides.paymentId ?? "pay_1",
      buyerAccountId: "acc_buyer",
      orderIds: overrides.orderIds ?? ["ord_1", "ord_2"],
      amount: "30.00",
      balanceCreditAmount: "0.00",
      processorAmount: "30.00",
      marketplaceSalesFeeAmount: "1.00",
      marketplaceCheckoutFeeAmount: "0.99",
      sellerNetAmount: "28.00",
      currencyCode: "USD",
      processorName: "fake",
      processorPaymentReference: overrides.processorPaymentReference ?? "pi_1",
      processorClientSecret: null,
      processorStatus: "requires_capture",
      sourceContext: overrides.sourceContext ?? null,
      sourceReferenceId: overrides.sourceReferenceId ?? null,
      createdAt: "2026-07-03T12:00:00.000Z",
    },
  } as never;
}

describe("payment page projection", () => {
  it("maintains indexed payment order lookup rows with the payment page upsert", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildPaymentProjectionHandlers(db as never);

    await handlers["payments.payment-created"]?.(paymentCreatedEvent());

    const [sql, values] = db.query.mock.calls[0] as unknown as [string, readonly unknown[]];
    expect(sql).toContain("WITH source_conflict AS");
    expect(sql).toContain("upserted_payment AS");
    expect(sql).toContain("DELETE FROM payments_payment_orders");
    expect(sql).toContain("INSERT INTO payments_payment_orders (payment_id, order_id)");
    expect(sql).toContain("jsonb_array_elements_text($3::jsonb)");
    expect(values).toEqual(expect.arrayContaining(["pay_1", "acc_buyer", JSON.stringify(["ord_1", "ord_2"]), 7]));
  });

  it("ignores duplicate source create events instead of poisoning the payment page projection", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildPaymentProjectionHandlers(db as never);

    await handlers["payments.payment-created"]?.(
      paymentCreatedEvent({
        paymentId: "pay_duplicate",
        processorPaymentReference: "pi_duplicate",
        sourceContext: "checkout",
        sourceReferenceId: "chk_1",
        streamVersion: 3,
      }),
    );

    const [sql, values] = db.query.mock.calls[0] as unknown as [string, readonly unknown[]];
    expect(sql).toContain("WITH source_conflict AS");
    expect(sql).toContain("AND payment_id <> $1");
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM source_conflict)");
    expect(sql).toContain("DELETE FROM payments_payment_orders");
    expect(values).toEqual(expect.arrayContaining(["pay_duplicate", "pi_duplicate", "checkout", "chk_1", 3]));
  });
});
