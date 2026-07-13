import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { checkoutApi, CheckoutApiError, createCheckoutApiClient } from "../../client";
export type {
  CheckoutApiClientOptions,
  CartReadinessDecisionInput,
  CartReadinessSnapshot,
  SellListReadinessDecisionInput,
  SellListReadinessSnapshot,
  SellListConfirmationSummary,
  SellListSellerConfirmationEvidence,
  CheckoutCartLine,
  AddCheckoutSellListLineRequest,
  CheckoutSellListLineRow,
  CheckoutSellListConfirmationRow,
  CheckoutSellListCompositeReview,
  CheckoutSellListOfferReview,
  CheckoutSellOfferMatch,
  CheckoutSellPayoutReadinessRow,
  CheckoutShipFromAddressRow,
  CreateCheckoutSessionRequest,
  CheckoutSessionRow,
  CheckoutFulfillmentPreview,
  CheckoutPaymentConfirmation,
} from "../../client";
import { createCheckoutApiClient } from "../../client";

export function createCheckoutRequestApiClient(
  request: Request,
  options: Readonly<{
    headers?: HeadersInit;
    requestTimeoutMs?: number;
    recoverTransportErrorsAsGatewayTimeout?: boolean;
  }> = {},
) {
  return createCheckoutApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "checkout" }),
    headers: options.headers,
    requestTimeoutMs: options.requestTimeoutMs,
    recoverTransportErrorsAsGatewayTimeout: options.recoverTransportErrorsAsGatewayTimeout,
  });
}
