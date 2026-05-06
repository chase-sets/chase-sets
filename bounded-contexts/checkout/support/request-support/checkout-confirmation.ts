import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";
import { createPaymentsRequestApiClient } from "@chase-sets/payments/server";
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
  });

  return payment.payment_id;
}
