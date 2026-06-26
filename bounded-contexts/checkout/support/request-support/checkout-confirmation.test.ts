import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  appendFreshWriteToken,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";

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

function paymentsApiError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), {
    status,
    body: {
      error: {
        code,
        message,
      },
    },
  });
}

describe("checkout confirmation request support", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("retries existing-order payment creation when freshness metadata is missing and order input is still pending", async () => {
    mockCreateAccountPayment
      .mockRejectedValueOnce(
        paymentsApiError(
          400,
          "order_not_payment_ready",
          "Order ord_1 is not eligible for payment in status pending-reservation.",
        ),
      )
      .mockResolvedValue({ payment_id: "pay_retry_without_source" });
    const request = new Request("https://checkout.test/account/checkout-sessions/chk_1/confirm");

    const payment = await createCheckoutPaymentThroughPayments(
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
      undefined,
      { maxAttempts: 2, delayMs: 0 },
    );

    expect(payment).toEqual({ payment_id: "pay_retry_without_source" });
    expect(mockCreatePaymentsRequestApiClient).toHaveBeenCalledWith(request);
    expect(mockGetCheckoutStatus).not.toHaveBeenCalled();
    expect(mockCreateAccountPayment).toHaveBeenCalledTimes(2);
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

  it("retries payment start when the same-request order input is still reservation-pending", async () => {
    mockGetCheckoutStatus
      .mockRejectedValueOnce(
        paymentsApiError(
          400,
          "order_not_payment_ready",
          "Order ord_1 is not eligible for payment in status pending-reservation.",
        ),
      )
      .mockResolvedValue({ orderIds: ["ord_1"] });
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
      { maxAttempts: 2, delayMs: 0 },
    );

    expect(mockGetCheckoutStatus).toHaveBeenCalledTimes(2);
    expect(mockCreateAccountPayment).toHaveBeenCalledTimes(1);
  });

  it("covers the chained reservation handoff before surfacing payment-start recovery", async () => {
    vi.useFakeTimers();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      mockGetCheckoutStatus.mockRejectedValueOnce(
        paymentsApiError(
          400,
          "order_not_payment_ready",
          "Order ord_1 is not eligible for payment in status pending-reservation.",
        ),
      );
    }
    mockGetCheckoutStatus.mockResolvedValue({ orderIds: ["ord_1"] });
    mockCreateAccountPayment.mockResolvedValue({ payment_id: "pay_ready" });
    const request = new Request("https://checkout.test/account/checkout-sessions/chk_1/confirm");
    const orderCreationWriteResult = {
      commandReceipt: {
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

    const paymentPromise = createCheckoutPaymentThroughPayments(
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
    await vi.runAllTimersAsync();

    await expect(paymentPromise).resolves.toEqual({ payment_id: "pay_ready" });
    expect(mockGetCheckoutStatus).toHaveBeenCalledTimes(9);
    expect(mockCreateAccountPayment).toHaveBeenCalledTimes(1);
  });

  it("retries payment creation when Payments catches a pending order input after the status read", async () => {
    mockGetCheckoutStatus.mockResolvedValue({ orderIds: ["ord_1"] });
    mockCreateAccountPayment
      .mockRejectedValueOnce(
        paymentsApiError(
          400,
          "order_not_payment_ready",
          "Order ord_1 is not eligible for payment in status pending-reservation.",
        ),
      )
      .mockResolvedValue({ payment_id: "pay_retry" });
    const request = new Request("https://checkout.test/account/checkout-sessions/chk_1/confirm");
    const orderCreationWriteResult = {
      commandReceipt: {
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

    const payment = await createCheckoutPaymentThroughPayments(
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
      { maxAttempts: 2, delayMs: 0 },
    );

    expect(payment).toEqual({ payment_id: "pay_retry" });
    expect(mockGetCheckoutStatus).toHaveBeenCalledTimes(2);
    expect(mockCreateAccountPayment).toHaveBeenCalledTimes(2);
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

  it("forwards header-carried retry freshness to Payments checkout status", async () => {
    mockGetCheckoutStatus.mockResolvedValue({ orderIds: ["ord_1"] });
    mockCreateAccountPayment.mockResolvedValue({ payment_id: "pay_retry" });
    const encodedReceipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [
        {
          sourceContextName: "ordering",
          maxGlobalPosition: "42",
          eventIds: ["evt_order_created"],
        },
      ],
    });
    const request = new Request("https://checkout.test/account/checkout-sessions/chk_1/confirm", {
      headers: {
        [CHASE_SETS_READ_AFTER_WRITE_HEADER]: encodedReceipt,
        [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "checkout",
      },
    });

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
    const paymentsApiClientCalls = mockCreatePaymentsRequestApiClient.mock.calls as unknown as Array<
      [Request, { headers?: HeadersInit }?]
    >;
    const options = paymentsApiClientCalls[0]?.[1];
    const headers = new Headers(options?.headers);
    expect(headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBe(encodedReceipt);
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("payments");
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
