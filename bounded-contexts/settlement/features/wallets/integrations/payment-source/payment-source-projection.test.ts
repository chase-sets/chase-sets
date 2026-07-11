import { describe, expect, it, vi } from "vitest";
import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import { buildSettlementPaymentInputProjectionHandlers } from "./payment-source-projection";

function createDb() {
  const queryMock = vi.fn<(text: string, values?: readonly unknown[]) => Promise<PgQueryResult<never>>>(async () => ({
    rows: [],
  }));
  const db: PgQueryable = {
    query: async <Row = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ): Promise<PgQueryResult<Row>> => {
      return queryMock(text, values);
    },
  };

  return { db, queryMock };
}

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
  it("records trust-signal eligibility only for fee-bearing external payment orders", async () => {
    const { db, queryMock } = createDb();
    const handlers = buildSettlementPaymentInputProjectionHandlers(db);

    await handlers["payments.payment-created"]!(
      transportEvent("payments.payment-created", {
        paymentId: "pay_card",
        buyerAccountId: "acc_buyer",
        orderIds: ["ord_fee_bearing"],
        sellerPayouts: [
          {
            orderId: "ord_fee_bearing",
            sellerAccountId: "acc_seller",
            sellerItemNetAmount: "19.00",
            shippingAllowanceAmount: "1.00",
            sellerShippingPayoutAmount: "1.00",
            sellerPayoutAmount: "20.00",
          },
        ],
        amount: "21.00",
        balanceCreditAmount: "0.00",
        processorAmount: "21.00",
        marketplaceSalesFeeAmount: "1.00",
        currencyCode: "usd",
        processorName: "stripe",
        processorPaymentReference: "pi_1",
        processorStatus: "requires_capture",
        createdAt: "2026-05-01T00:00:00.000Z",
      }),
    );
    await handlers["payments.payment-created"]!(
      transportEvent("payments.payment-created", {
        paymentId: "pay_balance",
        buyerAccountId: "acc_buyer",
        orderIds: ["ord_balance"],
        sellerPayouts: [
          {
            orderId: "ord_balance",
            sellerAccountId: "acc_seller",
            sellerItemNetAmount: "19.00",
            shippingAllowanceAmount: "1.00",
            sellerShippingPayoutAmount: "1.00",
            sellerPayoutAmount: "20.00",
          },
        ],
        amount: "20.00",
        balanceCreditAmount: "20.00",
        processorAmount: "0.00",
        marketplaceSalesFeeAmount: "1.00",
        currencyCode: "usd",
        processorName: "stripe",
        processorPaymentReference: "balance-credit",
        processorStatus: "captured",
        createdAt: "2026-05-01T00:00:00.000Z",
      }),
    );
    await handlers["payments.payment-created"]!(
      transportEvent("payments.payment-created", {
        paymentId: "pay_fee_locked",
        buyerAccountId: "acc_buyer",
        orderIds: ["ord_fee_locked"],
        sellerPayouts: [
          {
            orderId: "ord_fee_locked",
            sellerAccountId: "acc_seller",
            sellerItemNetAmount: "20.00",
            shippingAllowanceAmount: "0.00",
            sellerShippingPayoutAmount: "0.00",
            sellerPayoutAmount: "20.00",
          },
        ],
        amount: "20.00",
        balanceCreditAmount: "0.00",
        processorAmount: "20.00",
        marketplaceSalesFeeAmount: "0.00",
        currencyCode: "usd",
        processorName: "stripe",
        processorPaymentReference: "pi_2",
        processorStatus: "requires_capture",
        createdAt: "2026-05-01T00:00:00.000Z",
      }),
    );

    const trustSourceCalls = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO settlement_order_trust_signal_sources"),
    );
    expect(trustSourceCalls.map(([, values]) => values)).toEqual([
      ["ord_fee_bearing", "acc_seller", true, "2026-05-01T00:00:00.000Z"],
      ["ord_balance", "acc_seller", false, "2026-05-01T00:00:00.000Z"],
      ["ord_fee_locked", "acc_seller", false, "2026-05-01T00:00:00.000Z"],
    ]);
  });

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

  it("credits the platform revenue account for the authenticity check fee (m109 #4275) on capture", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const wallets = {
      postEntry: vi.fn(async () => ({ accountId: "acc_platform_authenticity_fee_revenue", version: 1 })),
    };
    const handlers = buildSettlementPaymentInputProjectionHandlers(db as never, wallets as never);

    await handlers["payments.payment-captured"]!(
      transportEvent("payments.payment-captured", {
        paymentId: "pay_authenticity_1",
        buyerAccountId: "acc_buyer",
        balanceCreditAmount: "0.00",
        currencyCode: "usd",
        processorStatus: "succeeded",
        capturedAt: "2026-05-01T00:00:00.000Z",
        authenticityFeeAmount: "11.00",
        sellerPayouts: [],
      }),
    );

    expect(wallets.postEntry).toHaveBeenCalledTimes(1);
    expect(wallets.postEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_platform_authenticity_fee_revenue",
        ledgerEntryId: "led_authenticity_fee_pay_authenticity_1",
        kind: "authenticity-fee",
        direction: "credit",
        amount: "11.00",
        currencyCode: "usd",
        fundsStatus: "available",
        paymentId: "pay_authenticity_1",
      }),
      expect.objectContaining({
        tenantId: "tnt_test",
      }),
    );
  });

  it("does not post an authenticity check fee ledger entry when the buyer did not opt in", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const wallets = {
      postEntry: vi.fn(async () => ({ accountId: "acc_platform_authenticity_fee_revenue", version: 1 })),
    };
    const handlers = buildSettlementPaymentInputProjectionHandlers(db as never, wallets as never);

    await handlers["payments.payment-captured"]!(
      transportEvent("payments.payment-captured", {
        paymentId: "pay_no_authenticity",
        buyerAccountId: "acc_buyer",
        balanceCreditAmount: "0.00",
        currencyCode: "usd",
        processorStatus: "succeeded",
        capturedAt: "2026-05-01T00:00:00.000Z",
        sellerPayouts: [],
      }),
    );

    expect(wallets.postEntry).not.toHaveBeenCalled();
  });

  it("applies new sale credits to a negative balance before leaving excess funds pending", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const wallets = {
      getWallet: vi.fn(async () => ({
        available_balance_amount: "-15.00",
      })),
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
            sellerItemNetAmount: "20.00",
            shippingAllowanceAmount: "3.00",
            sellerShippingPayoutAmount: "3.00",
            sellerPayoutAmount: "23.00",
          },
        ],
      }),
    );

    expect(wallets.postEntry).toHaveBeenCalledTimes(3);
    expect(wallets.postEntry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ledgerEntryId: "led_sale_pay_1_ord_1_pending",
        amount: "5.00",
        fundsStatus: "pending",
      }),
      expect.anything(),
    );
    expect(wallets.postEntry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        ledgerEntryId: "led_sale_pay_1_ord_1",
        amount: "15.00",
        fundsStatus: "available",
        description: "Negative balance offset from item sale proceeds for order ord_1",
      }),
      expect.anything(),
    );
    expect(wallets.postEntry).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        ledgerEntryId: "led_shipping_allowance_pay_1_ord_1",
        amount: "3.00",
        fundsStatus: "pending",
      }),
      expect.anything(),
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

  it("allocates refund debit pennies by largest remainder across seller payouts", async () => {
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT amount::text AS amount")) {
          return {
            rows: [
              {
                amount: "0.03",
                seller_payouts: [
                  {
                    orderId: "ord_1",
                    sellerAccountId: "acc_seller_1",
                    sellerItemNetAmount: "0.01",
                    shippingAllowanceAmount: "0.00",
                    sellerShippingPayoutAmount: "0.00",
                    sellerPayoutAmount: "0.01",
                  },
                  {
                    orderId: "ord_2",
                    sellerAccountId: "acc_seller_2",
                    sellerItemNetAmount: "0.01",
                    shippingAllowanceAmount: "0.00",
                    sellerShippingPayoutAmount: "0.00",
                    sellerPayoutAmount: "0.01",
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
        amount: "0.01",
        currencyCode: "usd",
        processorStatus: "succeeded",
        refundedAt: "2026-05-01T00:10:00.000Z",
      }),
    );

    expect(wallets.postEntry).toHaveBeenCalledTimes(1);
    expect(wallets.postEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc_seller_1",
        ledgerEntryId: "led_refund_pay_1_ord_1_1",
        amount: "0.01",
      }),
      expect.objectContaining({
        tenantId: "tnt_test",
      }),
    );
  });

  it("posts chargeback clawbacks and releases won disputes against seller payout exposure", async () => {
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
        providerDisputeId: "dp_123",
        amount: "10.00",
        currencyCode: "usd",
        processorStatus: "won",
        disputeStatus: "charge.dispute.closed",
        disputeMessage: "won",
        disputeLifecycleState: "won",
        disputedAt: "2026-05-01T00:15:00.000Z",
      }),
    );

    expect(wallets.postEntry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountId: "acc_seller",
        ledgerEntryId: "led_chargeback_dp_123_ord_1",
        kind: "adjustment",
        direction: "debit",
        amount: "8.00",
        fundsStatus: "available",
        orderId: "ord_1",
        paymentId: "pay_1",
        allowNegativeBalance: true,
      }),
      expect.objectContaining({
        tenantId: "tnt_test",
      }),
    );
    expect(wallets.postEntry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        accountId: "acc_seller",
        ledgerEntryId: "led_chargeback_release_dp_123_ord_1",
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

  it("keeps lost chargebacks as clawbacks without release credits", async () => {
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
        providerDisputeId: "dp_123",
        amount: "10.00",
        currencyCode: "usd",
        processorStatus: "lost",
        disputeStatus: "charge.dispute.closed",
        disputeMessage: "lost",
        disputeLifecycleState: "lost",
        disputedAt: "2026-05-01T00:15:00.000Z",
      }),
    );

    expect(wallets.postEntry).toHaveBeenCalledTimes(1);
    expect(wallets.postEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerEntryId: "led_chargeback_dp_123_ord_1",
        direction: "debit",
        amount: "8.00",
        allowNegativeBalance: true,
      }),
      expect.objectContaining({ tenantId: "tnt_test" }),
    );
  });
});
