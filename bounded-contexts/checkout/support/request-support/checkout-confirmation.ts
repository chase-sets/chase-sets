import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";
import { createPaymentsRequestApiClient } from "@chase-sets/payments/server";
import type { CheckoutSessionRow } from "../../features/sessions/read-model/queries";

function parseOrderIds(value: unknown) {
  return Array.isArray(value)
    ? value.map(String).filter(Boolean)
    : [];
}

export async function createCheckoutOrdersThroughOrdering(
  request: Request,
  session: CheckoutSessionRow,
) {
  const orderingApi = createOrderingRequestApiClient(request);
  const result = await orderingApi.createCheckoutOrders({
    checkoutSessionId: session.session_id,
    sourceType: session.source_type === "buy-now" ? "buy-now" : "cart-checkout",
    shippingOption: session.shipping_option,
    lines: session.lines,
  });

  return parseOrderIds((result as { orderIds?: unknown }).orderIds);
}

export async function createCheckoutPaymentThroughPayments(
  request: Request,
  sessionId: string,
  orderIds: readonly string[],
) {
  const paymentsApi = createPaymentsRequestApiClient(request);
  const payment = await paymentsApi.createBuyerPayment({
    orderIds,
    sourceContext: "checkout",
    sourceReferenceId: sessionId,
  });

  return payment.payment_id;
}
