import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createInMemoryRateLimiter } from "@chase-sets/http/rate-limit";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { CheckoutApiEnv } from "../../api";

export const ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_MAX = 30;

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

export function createAnonymousRailCaptureRateLimiter(keyPrefix: string) {
  return createInMemoryRateLimiter({
    keyPrefix,
    max: ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_MAX,
    windowMs: ANONYMOUS_RAIL_CAPTURE_RATE_LIMIT_WINDOW_MS,
  });
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
