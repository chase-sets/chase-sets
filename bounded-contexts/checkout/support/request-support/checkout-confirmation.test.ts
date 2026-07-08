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

const { mockCreateCheckoutReservation, mockCreateInventoryRequestApiClient } = vi.hoisted(() => {
  const mockCreateCheckoutReservation = vi.fn();
  return {
    mockCreateCheckoutReservation,
    mockCreateInventoryRequestApiClient: vi.fn(() => ({
      createCheckoutReservation: mockCreateCheckoutReservation,
    })),
  };
});

vi.mock("@chase-sets/payments/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/payments/server")>("@chase-sets/payments/server");

  return {
    ...actual,
    createPaymentsRequestApiClient: mockCreatePaymentsRequestApiClient,
    hasPaymentsFreshReadAfterWriteSource: (source: unknown) =>
      typeof source === "object" && source !== null && "commandReceipt" in source,
  };
});

vi.mock("@chase-sets/ordering/server", () => ({
  createOrderingRequestApiClient: vi.fn(),
}));

vi.mock("@chase-sets/inventory/server", () => ({
  createInventoryRequestApiClient: mockCreateInventoryRequestApiClient,
}));

vi.mock("@chase-sets/marketplace/server", () => ({
  createMarketplaceRequestApiClient: vi.fn(),
  MarketplaceApiError: class MarketplaceApiError extends Error {
    status = 400;
    body: unknown = null;
  },
}));

import { createCheckoutInventoryReservations, createCheckoutPaymentThroughPayments } from "./checkout-confirmation";
import type { CheckoutSessionRow } from "../../features/sessions/read-model/queries";

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
    mockCreateCheckoutReservation.mockReset();
    mockCreateInventoryRequestApiClient.mockClear();
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

  it("surfaces the Payments single-flight result as the existing checkout payment", async () => {
    mockCreateAccountPayment.mockResolvedValue({
      payment_id: "pay_existing",
      status: "pending-confirmation",
      source_context: "checkout",
      source_reference_id: "chk_1",
    });
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
    );

    expect(payment).toEqual({
      payment_id: "pay_existing",
      status: "pending-confirmation",
      source_context: "checkout",
      source_reference_id: "chk_1",
    });
    expect(mockCreateAccountPayment).toHaveBeenCalledTimes(1);
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

  it("reuses current checkout inventory reservations already recorded on the session", async () => {
    const reservation = {
      holdId: "hld_existing",
      lineKey: "cli_1",
      sellerAccountId: "acc_seller",
      inventoryItemId: "inv_1",
      quantity: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      extensionCount: 0,
      status: "active" as const,
    };
    const session = checkoutSessionForReservationTests({
      fulfillment_preview_snapshot: checkoutReservationPreview([checkoutReservationPreviewLine("cli_1")]),
      checkout_reservations: [reservation],
    });

    const result = await createCheckoutInventoryReservations(new Request("https://checkout.test"), session);

    expect(result).toEqual({ reservations: [reservation], unavailableLines: [] });
    expect(mockCreateInventoryRequestApiClient).toHaveBeenCalledTimes(1);
    expect(mockCreateCheckoutReservation).not.toHaveBeenCalled();
  });

  it("collects unavailable checkout reservation lines without dropping successful holds", async () => {
    const reservation = {
      holdId: "hld_created",
      lineKey: "cli_1",
      sellerAccountId: "acc_seller",
      inventoryItemId: "inv_1",
      quantity: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      extensionCount: 0,
      status: "active" as const,
    };
    mockCreateCheckoutReservation.mockResolvedValueOnce(reservation).mockRejectedValueOnce(
      Object.assign(new Error("Holds cannot exceed the available quantity for an inventory item."), {
        status: 409,
        body: {
          error: {
            code: "checkout_reservation_unavailable",
            message: "Holds cannot exceed the available quantity for an inventory item.",
          },
        },
      }),
    );

    const result = await createCheckoutInventoryReservations(
      new Request("https://checkout.test"),
      checkoutSessionForReservationTests(),
    );

    expect(result).toEqual({
      reservations: [reservation],
      unavailableLines: [
        {
          lineKey: "cli_2",
          sellerAccountId: "acc_second_seller",
          inventoryItemId: "inv_2",
          catalogItemId: "cat_blastoise",
          productId: "prod_blastoise",
          itemTitle: "Blastoise",
          productSummary: "Raw",
          quantity: 1,
          reason: "reserved-by-another-buyer",
        },
      ],
    });
    expect(mockCreateCheckoutReservation).toHaveBeenNthCalledWith(1, {
      checkoutSessionId: "chk_1",
      lineKey: "cli_1",
      sellerAccountId: "acc_seller",
      inventoryItemId: "inv_1",
      quantity: 1,
      reservationAttempt: 1,
    });
    expect(mockCreateCheckoutReservation).toHaveBeenNthCalledWith(2, {
      checkoutSessionId: "chk_1",
      lineKey: "cli_2",
      sellerAccountId: "acc_second_seller",
      inventoryItemId: "inv_2",
      quantity: 1,
      reservationAttempt: 1,
    });
  });

  it("does not reuse elapsed checkout reservations when reserving again", async () => {
    mockCreateCheckoutReservation.mockResolvedValue({
      holdId: "hld_second_attempt",
      lineKey: "cli_1",
      sellerAccountId: "acc_seller",
      inventoryItemId: "inv_1",
      quantity: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      extensionCount: 0,
      status: "active",
    });
    const session = checkoutSessionForReservationTests({
      fulfillment_preview_snapshot: checkoutReservationPreview([checkoutReservationPreviewLine("cli_1")]),
      checkout_reservations: [
        {
          holdId: "hld_elapsed",
          lineKey: "cli_1",
          sellerAccountId: "acc_seller",
          inventoryItemId: "inv_1",
          quantity: 1,
          expiresAt: "2000-01-01T00:00:00.000Z",
          extensionCount: 0,
          status: "active",
        },
      ],
    });

    await createCheckoutInventoryReservations(new Request("https://checkout.test"), session);

    expect(mockCreateCheckoutReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        checkoutSessionId: "chk_1",
        lineKey: "cli_1",
        reservationAttempt: 2,
      }),
    );
  });
});

function checkoutSessionForReservationTests(overrides: Partial<CheckoutSessionRow> = {}): CheckoutSessionRow {
  return {
    session_id: "chk_1",
    buyer_account_id: "acc_buyer",
    source_type: "cart",
    optimization_goal: "lowest-total",
    fulfillment_preview_revision: "preview_1",
    fulfillment_preview_snapshot: checkoutReservationPreview([
      checkoutReservationPreviewLine("cli_1"),
      checkoutReservationPreviewLine("cli_2", {
        sellerAccountId: "acc_second_seller",
        inventoryItemId: "inv_2",
        catalogItemId: "cat_blastoise",
        productId: "prod_blastoise",
        itemTitle: "Blastoise",
      }),
    ]),
    shipping_option: "standard",
    shipping_address_id: null,
    shipping_address: null,
    lines: [],
    order_ids: [],
    order_write_commit_positions: [],
    checkout_reservations: [],
    payment_id: null,
    submitted_offer_id: null,
    created_at: "2026-04-29T00:00:00.000Z",
    updated_at: "2026-04-29T00:00:00.000Z",
    ...overrides,
  };
}

function checkoutReservationPreviewLine(
  lineKey: string,
  overrides: Partial<{
    sellerAccountId: string;
    inventoryItemId: string;
    catalogItemId: string;
    productId: string;
    itemTitle: string;
  }> = {},
) {
  return {
    lineKey,
    sellerAccountId: overrides.sellerAccountId ?? "acc_seller",
    inventoryItemId: overrides.inventoryItemId ?? "inv_1",
    catalogItemId: overrides.catalogItemId ?? "cat_charizard",
    productId: overrides.productId ?? "prod_charizard",
    itemTitle: overrides.itemTitle ?? "Charizard",
    productSummary: "Raw",
    quantity: 1,
    listingId: `lst_${lineKey}`,
    estimatedUnitPriceAmount: "10.00",
    estimatedLineTotalAmount: "10.00",
    priceState: "available" as const,
    materialChangeReasons: [],
  };
}

function checkoutReservationPreview(
  lines: readonly ReturnType<typeof checkoutReservationPreviewLine>[],
): NonNullable<CheckoutSessionRow["fulfillment_preview_snapshot"]> {
  return {
    revision: "preview_1",
    optimizationGoal: "lowest-total",
    readyLineKeys: lines.map((line) => line.lineKey),
    unavailableLineKeys: [],
    sellerGroups: [
      {
        sellerAccountId: "acc_seller",
        sellerDisplayName: "Card Vault",
        itemSubtotalAmount: "10.00",
        shippingChargeAmount: "0.00",
        salesTaxAmount: "0.00",
        totalAmount: "10.00",
        deliveryEstimate: {
          earliestDate: "2026-05-01",
          latestDate: "2026-05-03",
          minimumTransitDays: 2,
          maximumTransitDays: 4,
          handlingDays: 1,
          serviceLevel: "standard",
          packageCount: 1,
          shipFromRegion: "IL",
          promiseOwner: "fulfillment",
          promiseSource: "fulfillment-promise-policy",
          promiseConfidence: "estimated",
          cutoffTimeLocal: "17:00",
          packingStartDate: "2026-04-30",
          carrierHandoffDate: "2026-05-01",
          basis: "seller-location",
        },
        postageRequirements: {
          policyVersion: "operator-postage-v1",
          parcelRequired: false,
          parcelReasons: [],
          signatureRequired: false,
          signatureReasons: [],
          insuranceRequired: false,
          insuranceReasons: [],
          insuredValueAmount: null,
          shippingEvidenceTier: "tracking",
        },
        lines,
      },
    ],
    totals: {
      itemSubtotalAmount: "10.00",
      shippingAmount: "0.00",
      salesTaxAmount: "0.00",
      totalAmount: "10.00",
      packageCount: 1,
    },
    unavailableLines: [],
    materialChangeReasons: [],
  };
}
