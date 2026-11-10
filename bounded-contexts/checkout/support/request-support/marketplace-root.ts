import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createCheckoutRequestApiClient } from "./api-client";
import { readAnonymousCartId } from "./guest-checkout";

export async function resolveCartCount(request: Request, actor: ResolvedActor | null) {
  try {
    const checkoutApi = createCheckoutRequestApiClient(request);

    if (actor && actor.roleKey !== "guest-buyer" && !actor.permissions.includes("guest-checkout.manage")) {
      const cart = await checkoutApi.getCart();
      return cart.count;
    }

    const anonymousCartId = readAnonymousCartId(request);
    if (!anonymousCartId) {
      return 0;
    }

    const cart = await checkoutApi.getGuestCart(anonymousCartId);
    return cart.count;
  } catch {
    return 0;
  }
}
