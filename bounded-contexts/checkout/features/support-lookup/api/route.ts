import { Hono } from "hono";
import type { CheckoutApiEnv } from "../../../api";
import type { CheckoutSupportLookupServices } from "./runtime";

function jsonError(status: number, code: string, message: string) {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
      },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function requireSupportLookupAccess(c: { get(key: "actor"): CheckoutApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      response: jsonError(
        401,
        "authentication_required",
        "Sign in with a support account to look up checkout references.",
      ),
    };
  }

  if (actor.roleKey !== "platform-admin" || !actor.permissions.includes("support.manage")) {
    return {
      response: jsonError(
        403,
        "authorization_forbidden",
        "Support checkout lookup requires internal support management access.",
      ),
    };
  }

  return { response: null };
}

export function createCheckoutSupportLookupRoutes(services: CheckoutSupportLookupServices) {
  const app = new Hono<CheckoutApiEnv>();

  app.get("/checkout-references/:supportReference", async (c) => {
    const access = requireSupportLookupAccess(c);
    if (access.response) {
      return access.response;
    }

    const supportReference = c.req.param("supportReference").trim();
    if (!supportReference) {
      return jsonError(400, "invalid_support_reference", "Provide a support-safe checkout reference.");
    }

    const result = await services.lookupBySupportReference(supportReference);
    if (!result) {
      return jsonError(404, "support_reference_not_found", "No checkout state was found for that support reference.");
    }

    return c.json({ result });
  });

  return app;
}
