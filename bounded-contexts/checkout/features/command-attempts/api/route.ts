import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import type { CheckoutApiEnv } from "../../../api";
import { createCheckoutAccessGuard } from "../../../support/request-support/checkout-route-guard";
import type { CheckoutCartServices } from "../../cart/api/runtime";
import type { CheckoutSessionServices } from "../../sessions/api/runtime";
import {
  CHECKOUT_ENTRY_ATTEMPT_KIND,
  CHECKOUT_ENTRY_ATTEMPT_TARGET,
  isCheckoutCartAttemptKind,
  isCheckoutCommandAttemptId,
} from "./contracts";

type CommandAttemptLookups = Readonly<{
  lookupCartAttempt: CheckoutCartServices["lookupCartAttempt"];
  lookupEntryAttempt: CheckoutSessionServices["lookupEntryAttempt"];
}>;

const requireLookupAccess = createCheckoutAccessGuard({
  authenticationRequiredMessage: t("checkout.features.cart.api.route.authentication.required"),
  authorizationForbiddenMessage: t("checkout.features.cart.api.route.forbidden"),
});

function lookupInvalid(c: Context<CheckoutApiEnv>) {
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

function isEntryLookup(kind: string | undefined) {
  return kind === CHECKOUT_ENTRY_ATTEMPT_KIND;
}

/**
 * Answers `GET /command-attempts/:attemptId?kind=&target=&requestHash=` for one
 * owner. The owner key comes only from the authenticated actor or the presented
 * anonymous cart key -- never from the query -- so a foreign attempt id resolves
 * to a stream that does not exist and returns the same `not-observed` payload a
 * missing attempt does. Entry attempts belong to an Account (a guest-buyer's
 * included), never to an anonymous cart key. Nothing here writes.
 */
async function lookup(
  c: Context<CheckoutApiEnv>,
  services: Partial<CommandAttemptLookups> & Pick<CommandAttemptLookups, "lookupCartAttempt">,
  ownerKey: string,
) {
  const attemptId = c.req.param("attemptId");
  const kind = c.req.query("kind");
  const target = c.req.query("target") ?? "";
  const requestHash = c.req.query("requestHash") ?? "";
  if (
    !attemptId ||
    !isCheckoutCommandAttemptId(attemptId) ||
    target.length === 0 ||
    target.length > 128 ||
    !/^[0-9a-f]{64}$/.test(requestHash)
  ) {
    return lookupInvalid(c);
  }
  if (isEntryLookup(kind)) {
    if (!services.lookupEntryAttempt || target !== CHECKOUT_ENTRY_ATTEMPT_TARGET) {
      return lookupInvalid(c);
    }
    const result = await services.lookupEntryAttempt({ ownerKey, attemptId, requestHash });
    return c.json({ attempt: result }, 200, { "cache-control": "no-store" });
  }
  if (!isCheckoutCartAttemptKind(kind)) {
    return lookupInvalid(c);
  }
  const result = await services.lookupCartAttempt({ ownerKey, attemptId, kind, target, requestHash });
  return c.json({ attempt: result }, 200, { "cache-control": "no-store" });
}

export function createAccountCommandAttemptRoutes(services: CommandAttemptLookups) {
  const app = new Hono<CheckoutApiEnv>();
  app.get("/command-attempts/:attemptId", async (c) => {
    // A guest-buyer Account may read back only the entry it submitted itself.
    const access = requireLookupAccess(c, { allowGuestCheckout: isEntryLookup(c.req.query("kind")) });
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
