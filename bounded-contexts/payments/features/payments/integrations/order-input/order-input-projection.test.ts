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
  it("order input projection never persists a non-money seller payout amount", async () => {
    const rejected = ["1.001", "-1.00", "10000000000.00", "", "not-money", "1e2", "+1.00"];
    const cases = rejected.flatMap((amount) => [
      { sellerNetAmount: amount, sellerShippingPayoutAmount: "0.00" },
      { sellerNetAmount: "0.00", sellerShippingPayoutAmount: amount },
      { sellerNetAmount: "0.00", sellerPayoutAmount: amount },
    ]);
    cases.push({ sellerNetAmount: "9999999999.99", sellerShippingPayoutAmount: "0.01" });
    for (const commercialTermsSnapshot of cases) {
      const db = { query: vi.fn(async () => ({ rows: [] })) };
      const handler = buildPaymentsOrderInputProjectionHandlers(db)["ordering.order.created"]!;
      await expect(
        handler(
          storedEvent("ordering.order.created", {
            orderId: "ord_synthetic_money",
            commercialTermsSnapshot,
          }),
        ),
      ).rejects.toThrow();
      expect(db.query).not.toHaveBeenCalled();
    }
    for (const [net, shipping, payout, expected] of [
      ["12.99", "0.01", undefined, "13.00"],
      ["01.00", "00.10", undefined, "1.10"],
      ["1.00", "0.00", "01.00", "1.00"],
      ["9999999999.99", "0.00", undefined, "9999999999.99"],
    ]) {
      const db = { query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] })) };
      await buildPaymentsOrderInputProjectionHandlers(db)["ordering.order.created"]!(
        storedEvent("ordering.order.created", {
          orderId: "ord_synthetic_money",
          commercialTermsSnapshot: {
            sellerNetAmount: net,
            sellerShippingPayoutAmount: shipping,
            sellerPayoutAmount: payout,
          },
        }),
      );
      expect(db.query.mock.calls[0]![1]![20]).toBe(expected);
    }
  });

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
        shippingDestinationSnapshot: {
          name: "Buyer",
          line1: "1 Main St",
          city: "Maize",
          state: "KS",
          postalCode: "67101",
          country: "US",
          email: "buyer@example.com",
        },
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
      JSON.stringify({
        name: "Buyer",
        line1: "1 Main St",
        city: "Maize",
        state: "KS",
        postalCode: "67101",
        country: "US",
        email: "buyer@example.com",
      }),
      "[]",
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
