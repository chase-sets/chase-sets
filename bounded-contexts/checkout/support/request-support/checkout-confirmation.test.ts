import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken } from "@chase-sets/http/responses";

const { mockCreateAccountPayment, mockCreatePaymentsRequestApiClient, mockGetCheckoutStatus } = vi.hoisted(() => {
  const mockCreateAccountPayment = vi.fn();
  const mockGetCheckoutStatus = vi.fn();
  return {
    mockCreateAccountPayment,
    mockGetCheckoutStatus,
    mockCreatePaymentsRequestApiClient: vi.fn(() => ({
      createAccountPayment: mockCreateAccountPayment,
      getCheckoutStatus: mockGetCheckoutStatus,
    })),
  };
});

vi.mock("@chase-sets/payments/server", () => ({
  createPaymentsRequestApiClient: mockCreatePaymentsRequestApiClient,
  hasPaymentsFreshReadAfterWriteSource: (source: unknown) =>
    typeof source === "object" && source !== null && "commandReceipt" in source,
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
    mockGetCheckoutStatus.mockReset();
    mockCreatePaymentsRequestApiClient.mockClear();
  });

  it("sends a stable checkout source reference so payment retries reuse the existing payment", async () => {
    mockCreateAccountPayment.mockResolvedValue({ payment_id: "pay_existing" });
    const request = new Request("https://checkout.test/account/checkout-sessions/chk_1/confirm");

    const payment = await createCheckoutPaymentThroughPayments(
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

    expect(payment).toEqual({ payment_id: "pay_existing" });
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

  it("fresh-reads Payments checkout status before payment creation after same-request order creation", async () => {
    mockGetCheckoutStatus.mockResolvedValue({ orderIds: ["ord_1"] });
    mockCreateAccountPayment.mockResolvedValue({ payment_id: "pay_fresh" });
    const request = new Request("https://checkout.test/account/checkout-sessions/chk_1/confirm");
    const orderCreationWriteResult = {
      orderIds: ["ord_1"],
      commandReceipt: {
        mode: "eventual",
        commitPosition: "42",
        commitEventIds: ["evt_order_created"],
        commitPositions: [
          {
            sourceContextName: "ordering",
            maxGlobalPosition: "42",
            eventIds: ["evt_order_created"],
          },
        ],
      },
    };

    await createCheckoutPaymentThroughPayments(
      request,
      "chk_1",
      ["ord_1"],
      null,
      "card",
      "quote_1",
      null,
      false,
      "/account/payments/:paymentId",
      null,
      orderCreationWriteResult,
    );

    expect(mockCreatePaymentsRequestApiClient).toHaveBeenCalledTimes(1);
    expect(mockCreatePaymentsRequestApiClient).toHaveBeenCalledWith(request, {
      afterWriteSource: orderCreationWriteResult,
    });
    expect(mockGetCheckoutStatus).toHaveBeenCalledWith({
      orderIds: ["ord_1"],
      requestedBalanceCreditAmount: null,
      paymentMethodCategory: "card",
    });
    expect(mockGetCheckoutStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateAccountPayment.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("fresh-reads Payments checkout status before payment creation when retry request carries afterWrite", async () => {
    mockGetCheckoutStatus.mockResolvedValue({ orderIds: ["ord_1"] });
    mockCreateAccountPayment.mockResolvedValue({ payment_id: "pay_retry" });
    const request = new Request(
      `https://checkout.test${appendFreshWriteToken(
        "/account/checkout-sessions/chk_1/confirm",
        {
          commitPositions: [
            {
              sourceContextName: "ordering",
              maxGlobalPosition: "42",
              eventIds: ["evt_order_created"],
            },
          ],
          commitEventIds: ["evt_order_created"],
        },
        Date.now(),
      )}`,
    );

    await createCheckoutPaymentThroughPayments(
      request,
      "chk_1",
      ["ord_1"],
      null,
      "card",
      "quote_1",
      null,
      false,
      "/account/payments/:paymentId",
    );

    expect(mockCreatePaymentsRequestApiClient).toHaveBeenCalledTimes(1);
    expect(mockCreatePaymentsRequestApiClient).toHaveBeenCalledWith(request);
    expect(mockGetCheckoutStatus).toHaveBeenCalledWith({
      orderIds: ["ord_1"],
      requestedBalanceCreditAmount: null,
      paymentMethodCategory: "card",
    });
    expect(mockGetCheckoutStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateAccountPayment.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });
});
