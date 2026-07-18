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

function cancellationEvent(data: Readonly<{ orderId: string; reason?: string }> = { orderId: "ord_1" }) {
  return {
    tenantId: "tnt_test",
    streamId: `ordering.order-${data.orderId}`,
    streamVersion: 4,
    eventId: "evt_1",
    globalPosition: "1",
    type: "ordering.order.cancelled",
    data: {
      orderId: data.orderId,
      cancelledAt: "2026-04-02T00:02:00.000Z",
      reason: data.reason ?? "buyer-cancelled",
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
  } as never;
}

function paymentCapturedEvent() {
  return {
    tenantId: "tnt_test",
    streamId: "payments.payment-pay_1",
    streamVersion: 2,
    eventId: "evt_capture",
    globalPosition: "2",
    type: "payments.payment-captured",
    data: {
      paymentId: "pay_1",
      orderIds: ["ord_1", "ord_2"],
      marketplaceCheckoutFeeAmount: "0.99",
      capturedAt: "2026-04-02T00:03:00.000Z",
    },
    timing: {
      occurredAt: "2026-04-02T00:03:00.000Z",
      recordedAt: "2026-04-02T00:03:00.000Z",
    },
    audit: {
      performedByUserId: "usr_system",
      forAccountId: "acc_buyer",
    },
    trace: null,
  } as never;
}

describe("payments order cancellation refund effect projection", () => {
  it("refunds a seller-cannot-fulfill cancellation plus its allocated checkout fee once", async () => {
    const issueRefund = vi.fn(async () => ({ outcome: "requested", refundId: "rfd_1", version: 2, amount: "10.33" }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [paymentRow] };
        }
        if (sql.includes("WHERE order_id = ANY($1)")) {
          return {
            rows: [
              { order_id: "ord_1", total_amount: "10.00", status: "cancelled" },
              { order_id: "ord_2", total_amount: "20.00", status: "pending-payment" },
            ],
          };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "10.00" }] };
        }
        if (sql.includes("INSERT INTO payments_order_cancellation_refund_effects")) {
          return { rowCount: 1, rows: [{ order_id: "ord_1", refund_id: "rfd_claimed" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildPaymentsOrderCancellationRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["ordering.order.cancelled"]?.(
      cancellationEvent({ orderId: "ord_1", reason: "seller-cannot-fulfill" }),
    );

    expect(issueRefund).toHaveBeenCalledWith(
      {
        refundId: "rfd_claimed",
        paymentId: "pay_1",
        orderIds: ["ord_1"],
        amount: "10.33",
        reason: "Self-service purchase cancellation for order ord_1.",
        capToRemainingRefundable: true,
      },
      expect.objectContaining({
        tenantId: "tnt_test",
      }),
    );
  });

  it("keeps pre-payment cancellation as a skipped no-refund claim", async () => {
    const issueRefund = vi.fn(async () => ({ outcome: "requested", refundId: "rfd_1", version: 2, amount: "10.33" }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [] };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "10.00" }] };
        }
        if (sql.includes("INSERT INTO payments_order_cancellation_refund_effects")) {
          return { rowCount: 1, rows: [{ order_id: "ord_1", refund_id: null }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildPaymentsOrderCancellationRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["ordering.order.cancelled"]?.(cancellationEvent());

    expect(issueRefund).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO payments_order_cancellation_refund_effects"),
      expect.arrayContaining(["ord_1", null, null, null, "skipped"]),
    );
  });

  it("upgrades a skipped cancellation claim when capture later arrives", async () => {
    const issueRefund = vi.fn(async () => ({ outcome: "requested", refundId: "rfd_1", version: 2, amount: "10.33" }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("WHERE order_id = ANY($1)")) {
          return {
            rows: [
              { order_id: "ord_1", total_amount: "10.00", status: "cancelled" },
              { order_id: "ord_2", total_amount: "20.00", status: "pending-payment" },
            ],
          };
        }
        if (sql.includes("INSERT INTO payments_order_cancellation_refund_effects")) {
          return { rowCount: 1, rows: [{ order_id: "ord_1", refund_id: "rfd_capture_later" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildPaymentsOrderCancellationRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["payments.payment-captured"]?.(paymentCapturedEvent());

    expect(issueRefund).toHaveBeenCalledTimes(1);
    expect(issueRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        refundId: "rfd_capture_later",
        paymentId: "pay_1",
        orderIds: ["ord_1"],
        amount: "10.33",
      }),
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("payments_order_cancellation_refund_effects.status IN ('skipped', 'failed')"),
      expect.arrayContaining(["ord_1", "pay_1", expect.any(String), "10.33", "processing"]),
    );
  });

  it("does not double-refund duplicate capture events after the claim is no longer skipped", async () => {
    const issueRefund = vi.fn(async () => ({ outcome: "requested", refundId: "rfd_1", version: 2, amount: "10.33" }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("WHERE order_id = ANY($1)")) {
          return {
            rows: [{ order_id: "ord_1", total_amount: "10.00", status: "cancelled" }],
          };
        }
        if (sql.includes("INSERT INTO payments_order_cancellation_refund_effects")) {
          return { rowCount: 0, rows: [] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildPaymentsOrderCancellationRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["payments.payment-captured"]?.(paymentCapturedEvent());

    expect(issueRefund).not.toHaveBeenCalled();
  });

  it("uses the same capture-later refund path for seller-cancelled orders", async () => {
    const issueRefund = vi.fn(async () => ({ outcome: "requested", refundId: "rfd_1", version: 2, amount: "10.33" }));
    let insertCalls = 0;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [] };
        }
        if (sql.includes("WHERE order_id = ANY($1)")) {
          return {
            rows: [
              { order_id: "ord_1", total_amount: "10.00", status: "cancelled" },
              { order_id: "ord_2", total_amount: "20.00", status: "pending-payment" },
            ],
          };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "10.00" }] };
        }
        if (sql.includes("INSERT INTO payments_order_cancellation_refund_effects")) {
          insertCalls += 1;
          return { rowCount: 1, rows: [{ order_id: "ord_1", refund_id: "rfd_reclaimed" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildPaymentsOrderCancellationRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["ordering.order.cancelled"]?.(cancellationEvent({ orderId: "ord_1", reason: "seller-cancelled" }));
    await handlers["payments.payment-captured"]?.(paymentCapturedEvent());

    expect(issueRefund).toHaveBeenCalledTimes(1);
    expect(insertCalls).toBe(2);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO payments_order_cancellation_refund_effects"),
      expect.arrayContaining(["ord_1", null, null, null, "skipped"]),
    );
  });

  it("reuses a claimed refund id when a failed cancellation effect is retried", async () => {
    const issueRefund = vi.fn(async () => ({
      outcome: "requested",
      refundId: "rfd_retry",
      version: 2,
      amount: "10.33",
    }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [paymentRow] };
        }
        if (sql.includes("WHERE order_id = ANY($1)")) {
          return {
            rows: [
              { order_id: "ord_1", total_amount: "10.00", status: "cancelled" },
              { order_id: "ord_2", total_amount: "20.00", status: "pending-payment" },
            ],
          };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "10.00" }] };
        }
        if (sql.includes("INSERT INTO payments_order_cancellation_refund_effects")) {
          return { rowCount: 1, rows: [{ order_id: "ord_1", refund_id: "rfd_retry" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildPaymentsOrderCancellationRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["ordering.order.cancelled"]?.(cancellationEvent());

    expect(issueRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        refundId: "rfd_retry",
        paymentId: "pay_1",
      }),
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("payments_order_cancellation_refund_effects.status IN ('skipped', 'failed')"),
      expect.arrayContaining(["ord_1", "pay_1", expect.any(String), "10.33", "processing"]),
    );
  });

  it("records a retryable failure and rethrows a transient error when the gateway fails", async () => {
    const issueRefund = vi.fn(async () => ({
      outcome: "gateway-failed",
      refundId: "rfd_claimed",
      version: 2,
      amount: "10.33",
      failureMessage: "processor timeout",
    }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [paymentRow] };
        }
        if (sql.includes("WHERE order_id = ANY($1)")) {
          return { rows: [{ order_id: "ord_1", total_amount: "10.00", status: "cancelled" }] };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "10.00" }] };
        }
        if (sql.includes("INSERT INTO payments_order_cancellation_refund_effects")) {
          return { rowCount: 1, rows: [{ order_id: "ord_1", refund_id: "rfd_claimed" }] };
        }
        if (sql.includes("attempts = attempts + 1")) {
          return { rows: [{ status: "failed" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildPaymentsOrderCancellationRefundEffectHandlers(db as never, { issueRefund } as never);

    await expect(handlers["ordering.order.cancelled"]?.(cancellationEvent())).rejects.toThrow(/retried/i);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("attempts = attempts + 1"),
      expect.arrayContaining(["ord_1", "processor timeout"]),
    );
    // The effect is never marked refund-requested when the gateway failed.
    const requestedCall = db.query.mock.calls.find(([sql]) => String(sql).includes("status = 'refund-requested'"));
    expect(requestedCall).toBeUndefined();
  });

  it("parks the effect in manual-review once the retry bound is exhausted, without rethrowing", async () => {
    const issueRefund = vi.fn(async () => ({
      outcome: "gateway-failed",
      refundId: "rfd_claimed",
      version: 2,
      amount: "10.33",
      failureMessage: "processor down",
    }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [paymentRow] };
        }
        if (sql.includes("WHERE order_id = ANY($1)")) {
          return { rows: [{ order_id: "ord_1", total_amount: "10.00", status: "cancelled" }] };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "10.00" }] };
        }
        if (sql.includes("INSERT INTO payments_order_cancellation_refund_effects")) {
          return { rowCount: 1, rows: [{ order_id: "ord_1", refund_id: "rfd_claimed" }] };
        }
        if (sql.includes("attempts = attempts + 1")) {
          return { rows: [{ status: "manual-review" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildPaymentsOrderCancellationRefundEffectHandlers(db as never, { issueRefund } as never);

    await expect(handlers["ordering.order.cancelled"]?.(cancellationEvent())).resolves.toBeUndefined();
  });

  it("skips the cancellation refund when the order has no remaining refundable amount", async () => {
    const issueRefund = vi.fn(async () => ({
      outcome: "not-refundable",
      refundId: "rfd_claimed",
      reason: "Order has no remaining refundable amount.",
    }));
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM payments_payment_pages")) {
          return { rows: [paymentRow] };
        }
        if (sql.includes("WHERE order_id = ANY($1)")) {
          return { rows: [{ order_id: "ord_1", total_amount: "10.00", status: "cancelled" }] };
        }
        if (sql.includes("FROM payments_order_inputs")) {
          return { rows: [{ order_id: "ord_1", total_amount: "10.00" }] };
        }
        if (sql.includes("INSERT INTO payments_order_cancellation_refund_effects")) {
          return { rowCount: 1, rows: [{ order_id: "ord_1", refund_id: "rfd_claimed" }] };
        }
        return { rows: [] };
      }),
    };
    const handlers = buildPaymentsOrderCancellationRefundEffectHandlers(db as never, { issueRefund } as never);

    await handlers["ordering.order.cancelled"]?.(cancellationEvent());

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'skipped'"),
      expect.arrayContaining(["ord_1", "Order has no remaining refundable amount."]),
    );
  });
});
