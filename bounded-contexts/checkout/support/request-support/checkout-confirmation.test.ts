import { afterEach, describe, expect, it, vi } from "vitest";

const { mockCreateAccountPayment, mockCreatePaymentsRequestApiClient } = vi.hoisted(() => {
  const mockCreateAccountPayment = vi.fn();
  return {
    mockCreateAccountPayment,
    mockCreatePaymentsRequestApiClient: vi.fn(() => ({
      createAccountPayment: mockCreateAccountPayment,
    })),
  };
});

vi.mock("@chase-sets/payments/server", () => ({
  createPaymentsRequestApiClient: mockCreatePaymentsRequestApiClient,
}));

vi.mock("@chase-sets/ordering/server", () => ({
  createOrderingRequestApiClient: vi.fn(),
}));

vi.mock("@chase-sets/marketplace/server", () => ({
  createMarketplaceRequestApiClient: vi.fn(),
  MarketplaceApiError: class MarketplaceApiError extends Error {
    status = 400;
    body: unknown = null;
  },
}));

import { createCheckoutPaymentThroughPayments } from "./checkout-confirmation";

describe("checkout confirmation request support", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockCreateAccountPayment.mockReset();
    mockCreatePaymentsRequestApiClient.mockClear();
  });

  it("sends a stable checkout source reference so payment retries reuse the existing payment", async () => {
    mockCreateAccountPayment.mockResolvedValue({ payment_id: "pay_existing" });
    const request = new Request("https://checkout.test/account/checkout-sessions/chk_1/confirm");

    const paymentId = await createCheckoutPaymentThroughPayments(
      request,
      "chk_1",
      ["ord_1", "ord_2"],
      "4.00",
      "saved-card",
      " quote_1 ",
      "inst_1",
      true,
      "/account/payments/:paymentId",
    );

    expect(paymentId).toBe("pay_existing");
    expect(mockCreatePaymentsRequestApiClient).toHaveBeenCalledWith(request);
    expect(mockCreateAccountPayment).toHaveBeenCalledWith({
      orderIds: ["ord_1", "ord_2"],
      sourceContext: "checkout",
      sourceReferenceId: "chk_1",
      requestedBalanceCreditAmount: "4.00",
      paymentMethodCategory: "saved-card",
      marketplaceCheckoutFeeQuoteFingerprint: "quote_1",
      savedCheckoutInstrumentId: "inst_1",
      savePaymentMethodForFuture: true,
      returnUrlPath: "/account/payments/:paymentId",
      agenticPayment: undefined,
    });
  });
});
