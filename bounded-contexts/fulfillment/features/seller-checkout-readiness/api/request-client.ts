import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { CHECKOUT_ANONYMOUS_SELL_LIST_COOKIE_NAME, parseCookieHeader } from "@chase-sets/auth-context";
import { createFulfillmentClientTransport } from "../../../support/request-support/client";
import { fulfillmentRequestOptions } from "../../../support/request-support/request-options";
import { createSellerShippingSetupClient } from "./client";
export { FulfillmentApiError } from "../../../support/request-support/client";
export type { SellerShippingSetupResult } from "./client";

// Only authentication or the existing Sell List cookie chooses this owner.
export async function createSellerShippingSetupRequestClient(request: Request) {
  const actor = await resolveActorFromAuthApi({ request });
  if (actor && actor.roleKey !== "guest-buyer" && !actor.sessionId.startsWith("guest:")) {
    return {
      api: createSellerShippingSetupClient(createFulfillmentClientTransport(fulfillmentRequestOptions(request))),
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
    api: createSellerShippingSetupClient(
      createFulfillmentClientTransport(fulfillmentRequestOptions(request, { "x-checkout-anonymous-sell-list-id": id })),
    ),
    mode: "guest" as const,
    scope: `anonymous:${id}`,
  };
}
