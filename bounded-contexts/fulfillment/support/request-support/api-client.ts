import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME, parseCookieHeader } from "@chase-sets/auth-context";
export { createFulfillmentApiClient, fulfillmentApi, FulfillmentApiError } from "../../client";
export type {
  FulfillmentApiClientOptions,
  FulfillmentPackingSlip,
  FulfillmentPackingSlipBatch,
  FulfillmentPackingSlipFormat,
  FulfillmentShipmentDetail,
  FulfillmentShipmentListItem,
  FulfillmentReturnIntakeQueue,
  FulfillmentReturnIntakeResolution,
  SellerShippingSetupInput,
  SellerShippingSetupResult,
  SellerShippingSetupMode,
} from "../../client";
import { createFulfillmentApiClient } from "../../client";

export function createFulfillmentRequestApiClient(request: Request, headers?: HeadersInit) {
  return createFulfillmentApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "fulfillment" }),
    headers,
  });
}

// Only authentication or the existing Sell List cookie chooses this owner.
export async function createSellerShippingSetupRequestClient(request: Request) {
  const actor = await resolveActorFromAuthApi({ request });
  if (actor && actor.roleKey !== "guest-buyer" && !actor.sessionId.startsWith("guest:")) {
    return {
      api: createFulfillmentRequestApiClient(request),
      mode: "account" as const,
      scope: `account:${actor.accountId}`,
    };
  }
  let id: string | undefined;
  try {
    id = parseCookieHeader(request.headers.get("cookie")).get(CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME);
  } catch {
    return null;
  }
  if (!id || id.length > 160 || !/^anon_[A-Za-z0-9_-]+$/.test(id)) return null;
  return {
    api: createFulfillmentRequestApiClient(request, { "x-checkout-anonymous-sell-list-id": id }),
    mode: "guest" as const,
    scope: `anonymous:${id}`,
  };
}
