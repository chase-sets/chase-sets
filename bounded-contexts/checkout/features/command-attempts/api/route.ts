import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import type { CheckoutApiEnv } from "../../../api";
import { createCheckoutAccessGuard } from "../../../support/request-support/checkout-route-guard";
import type { CheckoutCartServices } from "../../cart/api/runtime";
import { isCheckoutCartAttemptKind, isCheckoutCommandAttemptId } from "./contracts";

const requireLookupAccess = createCheckoutAccessGuard({
  authenticationRequiredMessage: t("checkout.features.cart.api.route.authentication.required"),
  authorizationForbiddenMessage: t("checkout.features.cart.api.route.forbidden"),
});

/**
 * Answers `GET /command-attempts/:attemptId?kind=&target=&requestHash=` for one
 * owner. The owner key comes only from the authenticated actor or the presented
 * anonymous cart key -- never from the query -- so a foreign attempt id resolves
 * to a stream that does not exist and returns the same `not-observed` payload a
 * missing attempt does. Nothing here writes.
 */
async function lookup(
  c: Context<CheckoutApiEnv>,
  services: Pick<CheckoutCartServices, "lookupCartAttempt">,
  ownerKey: string,
) {
  const attemptId = c.req.param("attemptId");
  const kind = c.req.query("kind");
  const target = c.req.query("target") ?? "";
  const requestHash = c.req.query("requestHash") ?? "";
  if (
    !attemptId ||
    !isCheckoutCommandAttemptId(attemptId) ||
    !isCheckoutCartAttemptKind(kind) ||
    target.length === 0 ||
    target.length > 128 ||
    !/^[0-9a-f]{64}$/.test(requestHash)
  ) {
    return c.json(
      {
        error: {
          code: "checkout_attempt_lookup_invalid",
          message: t("checkout.features.cart.api.route.request.failed"),
        },
      },
      400,
    );
  }
  const result = await services.lookupCartAttempt({ ownerKey, attemptId, kind, target, requestHash });
  return c.json({ attempt: result }, 200, { "cache-control": "no-store" });
}

export function createAccountCommandAttemptRoutes(services: Pick<CheckoutCartServices, "lookupCartAttempt">) {
  const app = new Hono<CheckoutApiEnv>();
  app.get("/command-attempts/:attemptId", async (c) => {
    const access = requireLookupAccess(c);
    if (access.response) {
      return access.response;
    }
    return lookup(c, services, access.actor.accountId);
  });
  return app;
}

export function createGuestCommandAttemptRoutes(services: Pick<CheckoutCartServices, "lookupCartAttempt">) {
  const app = new Hono<CheckoutApiEnv>();
  app.get("/command-attempts/:attemptId", async (c) => {
    const ownerKey = c.req.header("x-checkout-anonymous-cart-id")?.trim() ?? "";
    if (!ownerKey.startsWith("anon_")) {
      return c.json(
        {
          error: {
            code: "anonymous_cart_required",
            message: t("checkout.features.cart.api.route.authentication.required"),
          },
        },
        400,
      );
    }
    return lookup(c, services, ownerKey);
  });
  return app;
}
