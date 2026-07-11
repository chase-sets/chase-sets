import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPolicyBackedRateLimiter, type RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutApiEnv } from "../../api";

export const ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_MAX = 30;
/** Shared surface key: both cart and sell-list anonymous capture tune together as one incident-response dial. */
export const ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_SURFACE = "checkout.anonymous-rail-capture";

type CheckoutActor = CheckoutApiEnv["Variables"]["actor"];
type CheckoutAccessGuardOptions = Readonly<{
  authenticationRequiredMessage: string;
  authorizationForbiddenMessage: string;
}>;

function jsonErrorResponse(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Rate limits anonymous cart/sell-list capture. `keyPrefix` isolates the two
 * call sites' bucket stores; both share the `ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_SURFACE`
 * policy surface so an operator tunes (or kill-switches) them together. When
 * `resolveRateLimitRule` is not wired (standalone/test composition without
 * Platform Operations mounted), the compiled defaults apply unchanged.
 */
export function createAnonymousRailCaptureRateLimiter(keyPrefix: string, resolveRateLimitRule?: RateLimitRuleResolver) {
  return createPolicyBackedRateLimiter(
    ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_SURFACE,
    { max: ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_MAX, windowMs: ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_WINDOW_MS },
    resolveRateLimitRule ?? (async (_surface, defaults) => defaults),
    { keyPrefix },
  );
}

export function createGuestCheckoutContext(
  auditIdentity: Readonly<{ performedByUserId: UserId; forAccountId: AccountId }>,
): EventStoreContext {
  return { tenantId: "tnt_identity" as TenantId, audit: auditIdentity, trace: {} };
}

export function anonymousRequestRateLimitedResponse(message: string, retryAfterSeconds: number) {
  return {
    body: { error: { code: "anonymous_request_rate_limited", message } },
    headers: { "Retry-After": String(retryAfterSeconds) },
  };
}

export function createCheckoutAccessGuard(options: CheckoutAccessGuardOptions) {
  return (
    c: {
      get(key: "actor"): CheckoutActor;
    },
    accessOptions: Readonly<{ allowGuestCheckout?: boolean }> = {},
  ) => {
    const actor = c.get("actor");
    if (!actor) {
      return {
        actor: null,
        response: jsonErrorResponse(401, "authentication_required", options.authenticationRequiredMessage),
      };
    }

    if (actor.permissions.includes("guest-checkout.manage") && !accessOptions.allowGuestCheckout) {
      return {
        actor: null,
        response: jsonErrorResponse(403, "authorization_forbidden", options.authorizationForbiddenMessage),
      };
    }

    return { actor, response: null };
  };
}
