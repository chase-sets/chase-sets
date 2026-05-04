import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
export {
  checkoutApi,
  CheckoutApiError,
  createCheckoutApiClient,
} from "../../client";
export type {
  CheckoutApiClientOptions,
  CheckoutCartLine,
  CheckoutSessionRow,
} from "../../client";
import { createCheckoutApiClient } from "../../client";

export function createCheckoutRequestApiClient(
  request: Request,
  options: Readonly<{ headers?: HeadersInit }> = {},
) {
  return createCheckoutApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
    headers: options.headers,
  });
}
