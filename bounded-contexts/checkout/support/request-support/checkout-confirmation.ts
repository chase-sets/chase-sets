import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";
import { createPaymentsRequestApiClient } from "@chase-sets/payments/server";
import { createMarketplaceRequestApiClient, MarketplaceApiError } from "@chase-sets/marketplace/server";
import type { AgenticProcessorPaymentInput } from "@chase-sets/payment-processing";
import type { CheckoutSessionRow } from "../../features/sessions/read-model/queries";
export { normalizeRequestedBalanceCreditAmount } from "./balance-credit";

function parseOrderIds(value: unknown) {
  return Array.isArray(value)
    ? value.map(String).filter(Boolean)
    : [];
}

export async function createCheckoutOrdersThroughOrdering(
  request: Request,
  session: CheckoutSessionRow,
  options: Readonly<{
    fulfillmentPreviewRevision?: string | null;
    acknowledgedMaterialChanges?: boolean;
  }> = {},
) {
  if (!session.shipping_address) {
    throw new Error("Shipping destination is required before checkout can create purchases.");
  }

  const orderingApi = createOrderingRequestApiClient(request);
  const preview = await orderingApi.previewCheckoutFulfillment({
    checkoutSessionId: session.session_id,
    sourceType: session.source_type === "buy-now" ? "buy-now" : "cart-checkout",
    shippingOption: session.shipping_option,
    shippingAddress: session.shipping_address,
    optimizationGoal: session.optimization_goal,
    lines: session.lines,
  });
  const result = await orderingApi.createCheckoutOrders({
    checkoutSessionId: session.session_id,
    sourceType: session.source_type === "buy-now" ? "buy-now" : "cart-checkout",
    shippingOption: session.shipping_option,
    shippingAddress: session.shipping_address,
    optimizationGoal: session.optimization_goal,
    fulfillmentPreviewRevision: options.fulfillmentPreviewRevision,
    acknowledgedMaterialChanges: options.acknowledgedMaterialChanges,
    lines: session.lines,
  });

  return {
    orderIds: parseOrderIds((result as { orderIds?: unknown }).orderIds),
    readyLineKeys: preview.readyLineKeys,
  };
}

export async function createCheckoutPaymentThroughPayments(
  request: Request,
  sessionId: string,
  orderIds: readonly string[],
  requestedBalanceCreditAmount?: string | null,
  paymentMethodCategory: string = "card",
  marketplaceCheckoutFeeQuoteFingerprint?: string | null,
  returnUrlPath?: string | null,
  agenticPayment?: AgenticProcessorPaymentInput["agenticPayment"] | null,
) {
  const paymentsApi = createPaymentsRequestApiClient(request);
  const confirmedFingerprint =
    marketplaceCheckoutFeeQuoteFingerprint ??
    (
      await paymentsApi.getCheckoutStatus({
        orderIds,
        requestedBalanceCreditAmount,
        paymentMethodCategory,
      })
    ).marketplace_checkout_fee.quote_fingerprint;
  const payment = await paymentsApi.createAccountPayment({
    orderIds,
    sourceContext: "checkout",
    sourceReferenceId: sessionId,
    requestedBalanceCreditAmount,
    paymentMethodCategory,
    marketplaceCheckoutFeeQuoteFingerprint: confirmedFingerprint,
    returnUrlPath,
    agenticPayment,
  });

  return payment.payment_id;
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

export async function submitPurchaseIntentThroughMarketplace(
  request: Request,
  session: CheckoutSessionRow,
) {
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
    const offer = await marketplaceApi.createSubmittedOffer({
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
    }) as { id?: string; offer_id?: string };

    return offer.id ?? offer.offer_id ?? offerId;
  } catch (error) {
    if (isAlreadySubmittedOfferError(error)) {
      return offerId;
    }

    throw error;
  }
}
