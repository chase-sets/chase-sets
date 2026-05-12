import { describe, expect, it, vi } from "vitest";
import { buildPaymentsOrderCancellationRefundEffectHandlers } from "./order-cancellation-refund-effect-projection";

const paymentRow = {
  payment_id: "pay_1",
  buyer_account_id: "acc_buyer",
  order_ids: ["ord_1", "ord_2"],
  amount: "30.99",
  balance_credit_amount: "0.00",
  processor_amount: "30.99",
  marketplace_sales_fee_amount: "0.00",
  marketplace_checkout_fee_amount: "0.99",
  marketplace_checkout_fee_policy_version: "checkout-fee-v1",
  marketplace_checkout_fee_quote_fingerprint: "fee_quote",
  payment_method_category: "card",
  seller_net_amount: "28.00",
  seller_payout_amount: "28.00",
  seller_payouts: [],
  currency_code: "USD",
  processor_name: "fake",
  processor_payment_kind: "payment-intent",
  processor_payment_reference: "pi_1",
  processor_client_secret: null,
  processor_redirect_url: null,
  processor_status: "succeeded",
  source_context: null,
  source_reference_id: null,
  status: "captured",
  failure_code: null,
  failure_message: null,
  created_at: "2026-04-02T00:00:00.000Z",
  updated_at: "2026-04-02T00:01:00.000Z",
  captured_at: "2026-04-02T00:01:00.000Z",
  failed_at: null,
  cancelled_at: null,
};

describe("payments order cancellation refund effect projection", () => {
  it("refunds the cancelled order total plus allocated checkout fee once", async () => {
    const issueRefund = vi.fn(async () => ({ refundId: "rfd_1", version: 2 }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [paymentRow] };
        }
        if (sql.includes("ROUND(total_amount * 100)")) {
          return {
            rows: [
              { order_id: "ord_1", total_cents: "1000" },
              { order_id: "ord_2", total_cents: "2000" },
            ],
          };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "10.00" }] };
        }
        if (sql.includes("INSERT INTO payments_order_cancellation_refund_effects")) {
          return { rowCount: 1, rows: [{ order_id: "ord_1" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildPaymentsOrderCancellationRefundEffectHandlers(
      db as never,
      { issueRefund } as never,
    );

    await handlers["ordering.order.cancelled"]?.({
      tenantId: "tnt_test",
      streamId: "ordering.order-ord_1",
      streamVersion: 4,
      eventId: "evt_1",
      globalPosition: "1",
      type: "ordering.order.cancelled",
      data: {
        orderId: "ord_1",
        cancelledAt: "2026-04-02T00:02:00.000Z",
      },
      timing: {
        occurredAt: "2026-04-02T00:02:00.000Z",
        recordedAt: "2026-04-02T00:02:00.000Z",
      },
      audit: {
        performedByUserId: "usr_buyer",
        forAccountId: "acc_buyer",
      },
      trace: null,
    } as never);

    expect(issueRefund).toHaveBeenCalledWith(
      {
        paymentId: "pay_1",
        orderIds: ["ord_1"],
        amount: "10.33",
        reason: "Self-service purchase cancellation for order ord_1.",
      },
      expect.objectContaining({
        tenantId: "tnt_test",
      }),
    );
  });
});
