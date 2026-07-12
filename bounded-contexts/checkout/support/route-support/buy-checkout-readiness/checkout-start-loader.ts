import type { LoaderFunctionArgs } from "react-router";
import { resolveActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createId } from "@chase-sets/primitives/typed-ids";
import { createCheckoutRequestApiClient, type CartReadinessSnapshot } from "../../request-support/api-client";
import { readAnonymousCartId } from "../../request-support/guest-checkout";
import type { CheckoutStartCartReadinessSummary } from "../../../features/sessions/ui/checkout-start-page-types";
import { currentPathWithSearch, signInPathForReturnTo } from "./checkout-start-guest";
import { sourceFromUrl } from "./checkout-start-source";

function cartReadinessSummary(snapshot: CartReadinessSnapshot): CheckoutStartCartReadinessSummary {
  return {
    status: snapshot.status,
    lineCount: snapshot.lineCount,
    customerSafeFacts: snapshot.customerSafeFacts,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actor = await resolveActorFromAuthApi({ request });
  const url = new URL(request.url);
  const source = sourceFromUrl(url);
  const api = createCheckoutRequestApiClient(request);
  const isGuestBuyer = actor?.roleKey === "guest-buyer";
  const cartReadiness =
    actor && !isGuestBuyer && !source ? cartReadinessSummary((await api.createCartReadiness({})).readiness) : null;
  const cart = actor || source ? null : await api.getGuestCart(readAnonymousCartId(request));
  const returnTo = currentPathWithSearch(request);

  return {
    isSignedIn: Boolean(actor && !isGuestBuyer),
    isGuestBuyer,
    source,
    cartReadiness,
    cartCount: cartReadiness?.lineCount ?? cart?.count ?? (source ? 1 : 0),
    entryAttemptKey: createId("chkentry"),
    signInPath: signInPathForReturnTo(returnTo),
  };
}
