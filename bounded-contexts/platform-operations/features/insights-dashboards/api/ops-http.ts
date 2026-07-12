import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { OpsGranularity } from "./ops-contracts";
import type { OpsDashboardServices } from "./ops-runtime";

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

function normalizeGranularity(value: string | undefined): OpsGranularity {
  return value === "weekly" || value === "monthly" ? value : "daily";
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoUtc(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Platform-wide GMV/liquidity ops dashboard routes. Separate from
 * this feature's existing seller-scoped `api/route.ts` + `api/mcp.ts`
 * (account self-service KPIs) -- this is the operator-facing surface,
 * gated by the `insights-dashboards.view` permission rather than
 * account self-scoping.
 */
export function createOpsDashboardRoutes(services: OpsDashboardServices) {
  const app = new Hono<AuthenticatedApiEnv>();

  app.get("/summary", async (c) => {
    const access = requireActor(c);
    if (access.response) return access.response;
    const to = c.req.query("to") ?? todayUtc();
    const from = c.req.query("from") ?? daysAgoUtc(29, new Date(to));
    const [summary, liquidity, topCatalogItems] = await Promise.all([
      services.getPlatformKpiSummary({ from, to }),
      services.getPlatformLiquiditySummary({ asOfDay: to }),
      services.getTopCatalogItemsByGmv({ from, to, limit: Number(c.req.query("limit") ?? 10) }),
    ]);
    return c.json({ from, to, summary, liquidity, topCatalogItems });
  });

  app.get("/series", async (c) => {
    const access = requireActor(c);
    if (access.response) return access.response;
    const granularity = normalizeGranularity(c.req.query("granularity"));
    const to = c.req.query("to") ?? todayUtc();
    const from =
      c.req.query("from") ??
      daysAgoUtc(granularity === "monthly" ? 364 : granularity === "weekly" ? 119 : 29, new Date(to));
    const series = await services.getPlatformGmvSeries({ from, to, granularity });
    return c.json({ from, to, granularity, series });
  });

  app.get("/reconciliation-runs", async (c) => {
    const access = requireActor(c);
    if (access.response) return access.response;
    const runs = await services.listReconciliationRuns({ limit: Number(c.req.query("limit") ?? 24) });
    return c.json({ items: runs, count: runs.length });
  });

  return app;
}
