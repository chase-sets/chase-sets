import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";
import { createPaymentsRequestApiClient, hasPaymentsFreshReadAfterWriteSource } from "@chase-sets/payments/server";
import { createMarketplaceRequestApiClient, MarketplaceApiError } from "@chase-sets/marketplace/server";
import { createInventoryRequestApiClient } from "@chase-sets/inventory/server";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  decodeFreshWriteReceipt,
  readApiErrorCode,
  readFreshWriteToken,
} from "@chase-sets/http/responses";
import type { AgenticProcessorPaymentInput } from "@chase-sets/payment-processing";
import {
  checkoutSessionSourceCreatesOrders,
  toOrderingSourceForCheckoutOrderCreation,
} from "@chase-sets/checkout-order-source";
import type { CheckoutSessionRow } from "../../features/sessions/read-model/queries";
export { normalizeRequestedBalanceCreditAmount } from "./balance-credit";

export type CheckoutInventoryReservation = Readonly<{
  holdId: string;
  lineKey: string;
  sellerAccountId: string;
  inventoryItemId: string;
  quantity: number;
  expiresAt: string;
  extensionCount: number;
  status: "active" | "expired" | "converted";
}>;

export type CheckoutInventoryReservationUnavailableLine = Readonly<{
  lineKey: string;
  sellerAccountId: string;
  inventoryItemId: string;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  productSummary: string | null;
  quantity: number;
  reason: "reserved-by-another-buyer";
}>;

export type CheckoutInventoryReservationAttempt = Readonly<{
  reservations: readonly CheckoutInventoryReservation[];
  unavailableLines: readonly CheckoutInventoryReservationUnavailableLine[];
}>;

function parseOrderIds(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

const defaultPaymentStartReadinessRetry = {
  // Payment start waits on a chained handoff after Ordering order creation:
  // Inventory reserves stock, Ordering records pending-payment, then Payments
  // projects the updated order input. The default covers that multi-context
  // readiness path without changing Payments' strict payment-ready rule.
  maxAttempts: 24,
  delayMs: 500,
} as const;

const paymentOrderReadinessPendingCodes = new Set(["order_input_not_ready", "order_not_payment_ready"]);

type PaymentStartReadinessRetryOptions = Readonly<{
  maxAttempts?: number;
  delayMs?: number;
}>;

function responseLikeErrorStatus(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : null;
}

function responseLikeErrorBody(error: unknown) {
  return typeof error === "object" && error !== null && "body" in error ? (error as { body?: unknown }).body : null;
}

function paymentOrderReadinessIsPending(error: unknown) {
  const status = responseLikeErrorStatus(error);
  const code = readApiErrorCode(responseLikeErrorBody(error));

  if (status === 503 && code === "projection_freshness_timeout") {
    return true;
  }

  return status === 400 && paymentOrderReadinessPendingCodes.has(code ?? "");
}

function checkoutReservationIsUnavailable(error: unknown) {
  return (
    responseLikeErrorStatus(error) === 409 &&
    readApiErrorCode(responseLikeErrorBody(error)) === "checkout_reservation_unavailable"
  );
}

function reservationIsUsable(reservation: CheckoutInventoryReservation, nowMs: number) {
  if (reservation.status !== "active") {
    return false;
  }

  const expiresAtMs = Date.parse(reservation.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

function normalizeRetryAttemptCount(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) {
    return defaultPaymentStartReadinessRetry.maxAttempts;
  }

  return Math.max(1, Math.floor(value));
}

function normalizeRetryDelayMs(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) {
    return defaultPaymentStartReadinessRetry.delayMs;
  }

  return Math.max(0, Math.floor(value));
}

async function waitForPaymentStartRetry(delayMs: number) {
  if (delayMs <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function createCheckoutOrdersThroughOrdering(
  request: Request,
  session: CheckoutSessionRow,
  options: Readonly<{
    fulfillmentPreviewRevision?: string | null;
    acknowledgedMaterialChanges?: boolean;
    checkoutReservations?: readonly CheckoutInventoryReservation[];
  }> = {},
) {
  if (!session.shipping_address) {
    throw new Error("Shipping destination is required before checkout can create purchases.");
  }

  if (!checkoutSessionSourceCreatesOrders(session.source_type)) {
    throw new Error("Offer intent submits a Marketplace offer and does not create orders during checkout.");
  }

  const orderingSourceType = toOrderingSourceForCheckoutOrderCreation(session.source_type);
  const orderingApi = createOrderingRequestApiClient(request);
  const preview = await orderingApi.previewCheckoutFulfillment({
    checkoutSessionId: session.session_id,
    sourceType: orderingSourceType,
    shippingOption: session.shipping_option,
    shippingAddress: session.shipping_address,
    optimizationGoal: session.optimization_goal,
    lines: session.lines,
  });
  const result = await orderingApi.createCheckoutOrders({
    checkoutSessionId: session.session_id,
    sourceType: orderingSourceType,
    shippingOption: session.shipping_option,
    shippingAddress: session.shipping_address,
    optimizationGoal: session.optimization_goal,
    fulfillmentPreviewRevision: options.fulfillmentPreviewRevision ?? preview.revision,
    acknowledgedMaterialChanges: options.acknowledgedMaterialChanges,
    checkoutReservations: options.checkoutReservations?.map((reservation) => ({
      holdId: reservation.holdId,
      sellerAccountId: reservation.sellerAccountId,
      inventoryItemId: reservation.inventoryItemId,
      quantity: reservation.quantity,
    })),
    lines: session.lines,
  });

  return {
    orderIds: parseOrderIds((result as { orderIds?: unknown }).orderIds),
    readyLineKeys: preview.readyLineKeys,
    writeResult: result,
  };
}

export async function createCheckoutInventoryReservations(
  request: Request,
  session: CheckoutSessionRow,
  preview = session.fulfillment_preview_snapshot,
): Promise<CheckoutInventoryReservationAttempt> {
  if (!preview) {
    return { reservations: [], unavailableLines: [] };
  }

  const inventoryApi = createInventoryRequestApiClient(request);
  const nowMs = Date.now();
  const existingByLine = new Map<string, CheckoutInventoryReservation[]>();
  for (const reservation of session.checkout_reservations) {
    const key = `${reservation.lineKey}|${reservation.sellerAccountId}|${reservation.inventoryItemId}`;
    existingByLine.set(key, [...(existingByLine.get(key) ?? []), reservation]);
  }
  const reservations: CheckoutInventoryReservation[] = [];
  const unavailableLines: CheckoutInventoryReservationUnavailableLine[] = [];

  for (const line of preview.sellerGroups.flatMap((group) => group.lines)) {
    const key = `${line.lineKey}|${line.sellerAccountId}|${line.inventoryItemId}`;
    const existingReservations = existingByLine.get(key) ?? [];
    const existingReservation = existingReservations.find((reservation) => reservationIsUsable(reservation, nowMs));
    if (existingReservation) {
      reservations.push(existingReservation);
      continue;
    }

    try {
      const reservation = (await inventoryApi.createCheckoutReservation({
        checkoutSessionId: session.session_id,
        lineKey: line.lineKey,
        sellerAccountId: line.sellerAccountId,
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
        reservationAttempt: existingReservations.length + 1,
      })) as CheckoutInventoryReservation;
      reservations.push(reservation);
    } catch (error) {
      if (!checkoutReservationIsUnavailable(error)) {
        throw error;
      }

      unavailableLines.push({
        lineKey: line.lineKey,
        sellerAccountId: line.sellerAccountId,
        inventoryItemId: line.inventoryItemId,
        catalogItemId: line.catalogItemId,
        productId: line.productId,
        itemTitle: line.itemTitle,
        productSummary: line.productSummary,
        quantity: line.quantity,
        reason: "reserved-by-another-buyer",
      });
    }
  }

  return { reservations, unavailableLines };
}

export async function previewBuyNowCheckoutSupplyThroughOrdering(
  request: Request,
  params: Readonly<{
    checkoutSessionId: string;
    shippingOption: CheckoutSessionRow["shipping_option"];
    optimizationGoal: CheckoutSessionRow["optimization_goal"];
    line: CheckoutSessionRow["lines"][number];
  }>,
) {
  const orderingApi = createOrderingRequestApiClient(request);
  return orderingApi.previewCheckoutFulfillment({
    checkoutSessionId: params.checkoutSessionId,
    sourceType: "buy-now",
    shippingOption: params.shippingOption,
    optimizationGoal: params.optimizationGoal,
    lines: [params.line],
  });
}

export async function previewCheckoutFulfillmentThroughOrdering(
  request: Request,
  session: CheckoutSessionRow,
  options: Readonly<{
    shippingOption?: CheckoutSessionRow["shipping_option"];
    shippingAddress?: CheckoutSessionRow["shipping_address"];
  }> = {},
) {
  if (!checkoutSessionSourceCreatesOrders(session.source_type)) {
    return null;
  }

  const orderingApi = createOrderingRequestApiClient(request);
  return orderingApi.previewCheckoutFulfillment({
    checkoutSessionId: session.session_id,
    sourceType: toOrderingSourceForCheckoutOrderCreation(session.source_type),
    shippingOption: options.shippingOption ?? session.shipping_option,
    shippingAddress: options.shippingAddress ?? session.shipping_address,
    optimizationGoal: session.optimization_goal,
    lines: session.lines,
  });
}

export async function createCheckoutPaymentThroughPayments(
  request: Request,
  sessionId: string,
  orderIds: readonly string[],
  requestedBalanceCreditAmount?: string | null,
  paymentMethodCategory: string = "card",
  marketplaceCheckoutFeeQuoteFingerprint?: string | null,
  savedCheckoutInstrumentId?: string | null,
  savePaymentMethodForFuture?: boolean,
  returnUrlPath?: string | null,
  agenticPayment?: AgenticProcessorPaymentInput["agenticPayment"] | null,
  orderCreationWriteResult?: unknown,
  readinessRetry?: PaymentStartReadinessRetryOptions,
) {
  const confirmedFingerprint = marketplaceCheckoutFeeQuoteFingerprint?.trim();
  if (!confirmedFingerprint) {
    throw new Error("Review the payment quote before creating checkout payment.");
  }

  const forwardedFreshReadHeaders = paymentsFreshReadHeadersFromForwardedRequest(request);
  const hasSameRequestOrderWrite = hasPaymentsFreshReadAfterWriteSource(orderCreationWriteResult);
  const needsOrderInputFreshRead =
    hasSameRequestOrderWrite || readFreshWriteToken(request) !== null || forwardedFreshReadHeaders !== undefined;
  const shouldRetryPendingOrderReadiness = orderIds.length > 0;
  const paymentsApi = hasSameRequestOrderWrite
    ? createPaymentsRequestApiClient(request, { afterWriteSource: orderCreationWriteResult })
    : forwardedFreshReadHeaders
      ? createPaymentsRequestApiClient(request, { headers: forwardedFreshReadHeaders })
      : createPaymentsRequestApiClient(request);

  const maxAttempts = shouldRetryPendingOrderReadiness ? normalizeRetryAttemptCount(readinessRetry?.maxAttempts) : 1;
  const delayMs = normalizeRetryDelayMs(readinessRetry?.delayMs);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (needsOrderInputFreshRead) {
        await paymentsApi.getCheckoutStatus({
          orderIds,
          requestedBalanceCreditAmount,
          paymentMethodCategory,
        });
      }

      return await paymentsApi.createAccountPayment({
        orderIds,
        sourceContext: "checkout",
        sourceReferenceId: sessionId,
        requestedBalanceCreditAmount,
        paymentMethodCategory,
        marketplaceCheckoutFeeQuoteFingerprint: confirmedFingerprint,
        savedCheckoutInstrumentId,
        savePaymentMethodForFuture,
        returnUrlPath,
        agenticPayment,
      });
    } catch (error) {
      if (attempt >= maxAttempts || !paymentOrderReadinessIsPending(error)) {
        throw error;
      }

      await waitForPaymentStartRetry(delayMs);
    }
  }

  throw new Error("Payment start retry loop exited without creating payment.");
}

function paymentsFreshReadHeadersFromForwardedRequest(request: Request): HeadersInit | undefined {
  const encodedReceipt = request.headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER);
  const receipt = decodeFreshWriteReceipt(encodedReceipt);
  if (!receipt || receipt.sources.length === 0 || !encodedReceipt) {
    return undefined;
  }

  const headers = new Headers();
  headers.set(CHASE_SETS_READ_AFTER_WRITE_HEADER, encodedReceipt);
  headers.set(CHASE_SETS_READ_TARGET_CONTEXT_HEADER, "payments");
  return headers;
}

function offerIdForCheckoutSession(sessionId: string) {
  return `off_${sessionId.replace(/^chk_?/, "")}`;
}

function isAlreadySubmittedOfferError(error: unknown) {
  if (!(error instanceof MarketplaceApiError) || error.status !== 400) {
    return false;
  }

  const message =
    typeof error.body === "object" &&
    error.body !== null &&
    "error" in error.body &&
    typeof (error.body as { error?: { message?: unknown } }).error?.message === "string"
      ? (error.body as { error: { message: string } }).error.message
      : "";

  return message.includes("Offer has already been submitted.");
}

export type PurchaseIntentSubmissionResult = Readonly<{
  offerId: string;
  writeResult: unknown | null;
}>;

export async function submitPurchaseIntentThroughMarketplace(request: Request, session: CheckoutSessionRow) {
  if (!session.shipping_address) {
    throw new Error("Shipping destination is required before checkout can place purchase intent.");
  }

  if (session.source_type !== "offer-intent") {
    throw new Error("Only purchase-intent checkout can submit an offer.");
  }

  const line = session.lines[0];
  if (!line) {
    throw new Error("Purchase intent requires one checkout line.");
  }

  const offerPriceAmount = line.offerPriceAmount?.trim();
  if (!offerPriceAmount) {
    throw new Error("Purchase intent requires an offer price.");
  }

  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const offerId = offerIdForCheckoutSession(session.session_id);

  try {
    const offer = (await marketplaceApi.createSubmittedOffer({
      offerId,
      catalogItemId: line.catalogItemId,
      productId: line.productId,
      itemTitle: line.itemTitle,
      itemSubtitle: line.itemSubtitle,
      selectedOptions: line.selectedOptions,
      productSummary: line.productSummary,
      shippingDestinationSnapshot: session.shipping_address,
      priceAmount: offerPriceAmount,
      quantityRequested: line.quantity,
    })) as { id?: string; offer_id?: string };

    return {
      offerId: offer.id ?? offer.offer_id ?? offerId,
      writeResult: offer,
    } satisfies PurchaseIntentSubmissionResult;
  } catch (error) {
    if (isAlreadySubmittedOfferError(error)) {
      return {
        offerId,
        writeResult: null,
      } satisfies PurchaseIntentSubmissionResult;
    }

    throw error;
  }
}
