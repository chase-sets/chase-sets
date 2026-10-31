import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import type { CommercialTermsApiEnv } from "../../../api";
import { CommercialTermsHomeIncompleteError, type HomeServices } from "./home-read";

function viewAccessRefusal(c: Context<CommercialTermsApiEnv>) {
  const actor = c.get("actor");
  if (!actor) {
    return c.json(
      {
        error: {
          code: "authentication_required",
          message: t("commercialTerms.features.schedules.api.route.authentication.required"),
        },
      },
      401,
    );
  }
  if (!actor.permissions.includes("commercial-terms.view")) {
    return c.json(
      {
        error: {
          code: "authorization_forbidden",
          message: t("commercialTerms.features.schedules.api.route.forbidden"),
        },
      },
      403,
    );
  }
  return null;
}

export function createHomeRoutes(services: HomeServices, clock: () => Date = () => new Date()) {
  const app = new Hono<CommercialTermsApiEnv>();

  app.get("/", async (c) => {
    const refusal = viewAccessRefusal(c);
    if (refusal) {
      return refusal;
    }

    const resolvedAt = clock().toISOString();
    try {
      return c.json(await services.readHome({ resolvedAt, scheduleId: c.req.query("schedule") || null }));
    } catch (error) {
      if (error instanceof CommercialTermsHomeIncompleteError) {
        console.warn("[commercial-terms-home] incomplete source read", {
          source: error.source,
          rowCount: error.rowCount,
          total: error.total,
        });
        return c.json(
          {
            error: {
              code: "commercial_terms_home_incomplete",
              message: t("commercialTerms.features.home.unavailable"),
            },
          },
          503,
        );
      }
      throw error;
    }
  });

  return app;
}
