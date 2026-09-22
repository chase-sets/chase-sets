import type { MiddlewareHandler } from "hono";
import { getObservabilityRuntime } from "@chase-sets/observability";
import type { TenantContextEnv } from "./auth-context";

const accountPrefix = "/api/marketplace/account";
const closedPosts = new Set([
  `${accountPrefix}/checkout-sessions`,
  `${accountPrefix}/purchases/checkout`,
  `${accountPrefix}/purchases/checkout/preview`,
  `${accountPrefix}/payments`,
  `${accountPrefix}/checkout/recover`,
]);

export function createCheckoutClosedMiddleware(checkoutClosed: boolean): MiddlewareHandler<TenantContextEnv> {
  return async (c, next) => {
    const route = c.req.path;
    const closed =
      (c.req.method === "POST" && closedPosts.has(route)) ||
      (c.req.method !== "GET" && route.startsWith(`${accountPrefix}/checkout-sessions/`));
    const actor = c.get("actor");
    // Anonymous requests retain the owning route's authentication response.
    if (!checkoutClosed || !closed || !actor) return next();

    getObservabilityRuntime().logger.info("checkout_closed_refusal", {
      type: "checkout_closed_refusal",
      route,
      method: c.req.method,
      actorKind: actor.roleKey,
    });
    return c.json({ error: { code: "checkout_closed", message: "Checkout is closed until public launch." } }, 503);
  };
}
