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
});
