import { describe, expect, it, vi } from "vitest";
import { buildSettlementPaymentInputProjectionHandlers } from "./payment-source-projection";

function transportEvent(type: string, data: Record<string, unknown>) {
  return {
    id: "evt_1",
    type,
    streamId: "payments.payment-pay_1",
    streamVersion: 1,
    globalPosition: "1",
    tenantId: "tnt_test",
    data,
    metadata: {},
    audit: {
      performedByUserId: "usr_test",
      forAccountId: "acc_buyer",
    },
    trace: {},
    timing: {
      occurredAt: "2026-05-01T00:00:00.000Z",
      recordedAt: "2026-05-01T00:00:00.000Z",
    },
  } as never;
}

describe("settlement payment source projection", () => {
  it("does not credit seller wallets when a payment is only authorized", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const wallets = {
      postEntry: vi.fn(async () => ({ accountId: "acc_seller", version: 1 })),
    };
    const handlers = buildSettlementPaymentInputProjectionHandlers(db as never, wallets as never);

    await handlers["payments.payment-authorized"]!(
      transportEvent("payments.payment-authorized", {
        paymentId: "pay_1",
        processorStatus: "unpaid",
        authorizedAt: "2026-05-01T00:00:00.000Z",
      }),
    );

    expect(wallets.postEntry).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE settlement_payment_sources"), [
      "pay_1",
      "unpaid",
      "2026-05-01T00:00:00.000Z",
      1,
    ]);
  });

  it("credits item proceeds and shipping allowance separately when a payment captures", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const wallets = {
      postEntry: vi.fn(async () => ({ accountId: "acc_seller", version: 1 })),
    };
    const handlers = buildSettlementPaymentInputProjectionHandlers(db as never, wallets as never);

    await handlers["payments.payment-captured"]!(
      transportEvent("payments.payment-captured", {
        paymentId: "pay_1",
        buyerAccountId: "acc_buyer",
        balanceCreditAmount: "0.00",
        currencyCode: "usd",
        processorStatus: "succeeded",
        capturedAt: "2026-05-01T00:00:00.000Z",
        sellerPayouts: [
          {
            orderId: "ord_1",
            sellerAccountId: "acc_seller",
            sellerItemNetAmount: "19.00",
            shippingAllowanceAmount: "1.00",
            sellerShippingPayoutAmount: "1.00",
            sellerPayoutAmount: "20.00",
          },
        ],
      }),
    );

    expect(wallets.postEntry).toHaveBeenCalledTimes(2);
    expect(wallets.postEntry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountId: "acc_seller",
        ledgerEntryId: "led_sale_pay_1_ord_1",
        kind: "sale",
        direction: "credit",
        amount: "19.00",
        fundsStatus: "pending",
        orderId: "ord_1",
        paymentId: "pay_1",
      }),
      expect.objectContaining({
        tenantId: "tnt_test",
      }),
    );
    expect(wallets.postEntry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountId: "acc_seller",
        ledgerEntryId: "led_shipping_allowance_pay_1_ord_1",
        kind: "rebate",
        direction: "credit",
        amount: "1.00",
        fundsStatus: "pending",
        orderId: "ord_1",
        paymentId: "pay_1",
      }),
      expect.objectContaining({
        tenantId: "tnt_test",
      }),
    );
  });

  it("posts idempotent seller refund debits when a payment refund webhook is projected", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT amount::text AS amount")) {
          return {
            rows: [
              {
                amount: "20.00",
                seller_payouts: [
                  {
                    orderId: "ord_1",
                    sellerAccountId: "acc_seller",
                    sellerItemNetAmount: "15.00",
                    shippingAllowanceAmount: "1.00",
                    sellerShippingPayoutAmount: "1.00",
                    sellerPayoutAmount: "16.00",
                  },
                ],
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const wallets = {
      postEntry: vi.fn(async () => ({ accountId: "acc_seller", version: 1 })),
    };
    const handlers = buildSettlementPaymentInputProjectionHandlers(db as never, wallets as never);

    await handlers["payments.payment-refunded"]!(
      transportEvent("payments.payment-refunded", {
        paymentId: "pay_1",
        amount: "10.00",
        currencyCode: "usd",
        processorStatus: "succeeded",
        refundedAt: "2026-05-01T00:10:00.000Z",
      }),
    );

    expect(wallets.postEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller",
        ledgerEntryId: "led_refund_pay_1_ord_1_1",
        kind: "refund",
        direction: "debit",
        amount: "8.00",
        fundsStatus: "available",
        orderId: "ord_1",
        paymentId: "pay_1",
      }),
      expect.objectContaining({
        tenantId: "tnt_test",
      }),
    );
  });

  it("posts dispute holds and releases won disputes against seller payout exposure", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT amount::text AS amount")) {
          return {
            rows: [
              {
                amount: "20.00",
                seller_payouts: [
                  {
                    orderId: "ord_1",
                    sellerAccountId: "acc_seller",
                    sellerItemNetAmount: "15.00",
                    shippingAllowanceAmount: "1.00",
                    sellerShippingPayoutAmount: "1.00",
                    sellerPayoutAmount: "16.00",
                  },
                ],
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const wallets = {
      postEntry: vi.fn(async () => ({ accountId: "acc_seller", version: 1 })),
    };
    const handlers = buildSettlementPaymentInputProjectionHandlers(db as never, wallets as never);

    await handlers["payments.payment-disputed"]!(
      transportEvent("payments.payment-disputed", {
        paymentId: "pay_1",
        amount: "10.00",
        currencyCode: "usd",
        processorStatus: "won",
        disputeStatus: "charge.dispute.closed",
        disputeMessage: "won",
        disputedAt: "2026-05-01T00:15:00.000Z",
      }),
    );

    expect(wallets.postEntry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountId: "acc_seller",
        ledgerEntryId: "led_dispute_hold_pay_1_ord_1",
        kind: "adjustment",
        direction: "debit",
        amount: "8.00",
        fundsStatus: "available",
        orderId: "ord_1",
        paymentId: "pay_1",
      }),
      expect.objectContaining({
        tenantId: "tnt_test",
      }),
    );
    expect(wallets.postEntry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountId: "acc_seller",
        ledgerEntryId: "led_dispute_release_pay_1_ord_1",
        kind: "adjustment",
        direction: "credit",
        amount: "8.00",
        fundsStatus: "available",
        orderId: "ord_1",
        paymentId: "pay_1",
      }),
      expect.objectContaining({
        tenantId: "tnt_test",
      }),
    );
  });
});
