import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { PlatformOperationsApiEnv } from "../../../api";
import type { SupportReferenceLookupServices } from "./runtime";

function jsonError(status: 400 | 401 | 403 | 404, code: string, message: string) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requireAccess(c: { get(key: "actor"): PlatformOperationsApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      response: jsonError(
        401,
        "authentication_required",
        t("support.features.supportReferenceLookup.api.route.authentication.required"),
      ),
    };
  }

  if (!actor.permissions.includes("support.manage")) {
    return {
      response: jsonError(
        403,
        "authorization_forbidden",
        t("support.features.supportReferenceLookup.api.route.forbidden"),
      ),
    };
  }

  return { response: null };
}

export function createSupportReferenceLookupRoutes(services: SupportReferenceLookupServices) {
  const app = new Hono<PlatformOperationsApiEnv>();

  app.get("/:reference", async (c) => {
    const access = requireAccess(c);
    if (access.response) {
      return access.response;
    }

    const reference = c.req.param("reference").trim();
    if (!reference) {
      return jsonError(
        400,
        "invalid_support_reference",
        t("support.features.supportReferenceLookup.api.route.reference.required"),
      );
    }

    const result = await services.resolveSupportReference(reference);
    if (!result) {
      return jsonError(
        404,
        "support_reference_not_found",
        t("support.features.supportReferenceLookup.api.route.reference.not.found"),
      );
    }

    return c.json({ result });
  });

  return app;
}
