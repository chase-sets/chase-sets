import { describe, expect, it, vi } from "vitest";
import { buildPaymentsOrderInputProjectionHandlers } from "./order-input-projection";

function storedEvent(eventType: string, data: Record<string, unknown>) {
  return {
    type: eventType,
    eventType,
    data,
    timing: {
      recordedAt: "2026-04-01T00:00:00.000Z",
    },
  } as never;
}

describe("payments order input projection", () => {
  it("stores Ordering sales tax for Payments-owned account order overlays", async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const handlers = buildPaymentsOrderInputProjectionHandlers(db);

    await handlers["ordering.order.created"]!(
      storedEvent("ordering.order.created", {
        orderId: "ord_1",
        sourceType: "checkout",
        sourceReferenceId: "chk_1",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        shippingDestinationSnapshot: { email: "buyer@example.com" },
        salesTaxAmount: "1.57",
        totalAmount: "20.81",
        commercialTermsSnapshot: {
          marketplaceSalesFeeAmount: "1.00",
          marketplaceSalesFeeLines: [
            {
              lineId: "oli_1",
              unitPriceAmount: "20.00",
              quantity: 1,
              marketplaceSalesFeePercentageBps: 500,
              marketplaceSalesFeeFixedAmount: "0.00",
              marketplaceSalesFeeCapAmount: "25.00",
              marketplaceSalesFeeUnitAmount: "1.00",
              marketplaceSalesFeeTotalAmount: "1.00",
            },
          ],
          sellerNetAmount: "15.00",
          termsScheduleId: null,
          termsAgreementId: null,
          termsResolvedAt: "2026-04-01T00:00:00.000Z",
        },
      }),
    );

    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("sales_tax_amount"), [
      "ord_1",
      "checkout",
      "chk_1",
      "acc_buyer",
      "buyer@example.com",
      "acc_seller",
      "1.57",
      "20.81",
      "1.00",
      JSON.stringify([
        {
          lineId: "oli_1",
          unitPriceAmount: "20.00",
          quantity: 1,
          marketplaceSalesFeePercentageBps: 500,
          marketplaceSalesFeeFixedAmount: "0.00",
          marketplaceSalesFeeCapAmount: "25.00",
          marketplaceSalesFeeUnitAmount: "1.00",
          marketplaceSalesFeeTotalAmount: "1.00",
        },
      ]),
      "0.00",
      "0.00",
      "15.00",
      "15.00",
      "0.00",
      "0.00",
      "0.00",
      "0.00",
      "0.00",
      "0.00",
      "15.00",
      500,
      null,
      null,
      "2026-04-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
    ]);
  });

  it("relays the frozen authenticity-check fee amount (m109 #4275) into the order-input mirror", async () => {
    const db = {
      query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] })),
    };
    const handlers = buildPaymentsOrderInputProjectionHandlers(db);

    await handlers["ordering.order.created"]!(
      storedEvent("ordering.order.created", {
        orderId: "ord_2",
        sourceType: "checkout",
        sourceReferenceId: "chk_2",
        buyerAccountId: "acc_buyer",
        sellerAccountId: "acc_seller",
        shippingDestinationSnapshot: { email: "buyer@example.com" },
        salesTaxAmount: "1.57",
        totalAmount: "161.00",
        commercialTermsSnapshot: {
          marketplaceSalesFeeAmount: "1.00",
          sellerNetAmount: "15.00",
          termsScheduleId: null,
          termsAgreementId: null,
          termsResolvedAt: "2026-04-01T00:00:00.000Z",
        },
        authenticityPlanSnapshot: {
          feeAmount: "11.00",
          payer: "buyer",
          policyVersion: "authenticity-check-fee-v1",
        },
      }),
    );

    const [, params] = db.query.mock.calls[0]!;
    expect(params![8]).toBe("1.00");
    expect(params![9]).toBe("[]");
    expect(params![10]).toBe("11.00");
  });
});
