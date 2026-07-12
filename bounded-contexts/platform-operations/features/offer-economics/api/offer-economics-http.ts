import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { OfferEconomicsServices } from "./offer-economics-runtime";

function requireActor(c: { get(key: "actor"): AuthenticatedApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: { code: "authentication_required", message: t("experience.api.authentication.required") },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    };
  }
  // Reuses the ops dashboard's operator gate rather than declaring a new
  // permission key: this is the same "platform-wide market analytics"
  // surface family, just a different cohort slice. Split into a
  // dedicated `offer-economics.view` permission if this monitor ever needs
  // narrower visibility than the rest of Insights.
  if (!actor.permissions.includes("insights-dashboards.view")) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({ error: { code: "authorization_forbidden", message: t("experience.api.forbidden") } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    };
  }
  return { actor, response: null };
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoUtc(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Offer-economics monitor routes: the founders 0%-locked-fee
 * cohort's listing volume, realized GMV share of the platform, foregone-fee
 * estimate against the published standard schedule, and cumulative
 * sell-through trend. Gated by `insights-dashboards.view`, same as the ops
 * dashboard.
 */
export function createOfferEconomicsRoutes(services: OfferEconomicsServices) {
  const app = new Hono<AuthenticatedApiEnv>();

  app.get("/summary", async (c) => {
    const access = requireActor(c);
    if (access.response) return access.response;
    const to = c.req.query("to") ?? todayUtc();
    const from = c.req.query("from") ?? daysAgoUtc(59, new Date(to));
    const accountType = c.req.query("accountType") ?? undefined;
    const snapshot = await services.getOfferEconomicsSnapshot({ from, to, accountType });
    return c.json({ snapshot });
  });

  return app;
}
