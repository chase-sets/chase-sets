import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { RiskAlertAction } from "./contracts";
import type { RiskAlertServices } from "./runtime";

function requireActor(c: { get(key: "actor"): AuthenticatedApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: { code: "authentication_required", message: t("experience.api.authentication.required") },
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }
  if (!actor.permissions.includes("reported-content.view")) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({ error: { code: "authorization_forbidden", message: t("experience.api.forbidden") } }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }
  return { actor, response: null };
}

function normalizeAction(value: unknown): RiskAlertAction {
  if (value === "request-manual-payout-review" || value === "acknowledge") {
    return value;
  }
  throw new Error("Risk alert action is invalid.");
}

export function createRiskAlertRoutes(services: RiskAlertServices) {
  const app = new Hono<AuthenticatedApiEnv>();

  app.get("/", async (c) => {
    const access = requireActor(c);
    if (access.response) return access.response;
    const result = await services.listRiskAlertQueue({
      limit: Number(c.req.query("limit") ?? 50),
      offset: Number(c.req.query("offset") ?? 0),
      status: c.req.query("status"),
      alertKind: c.req.query("alertKind"),
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/metrics", async (c) => {
    const access = requireActor(c);
    if (access.response) return access.response;
    return c.json(await services.getRiskAlertQueueMetrics());
  });

  app.get("/:alertId", async (c) => {
    const access = requireActor(c);
    if (access.response) return access.response;
    const item = await services.getRiskAlertQueueItem(c.req.param("alertId"));
    if (!item) {
      return c.json({ error: { code: "not_found", message: t("experience.api.reported.content.not.found") } }, 404);
    }
    return c.json(item);
  });

  app.post("/:alertId/actions", async (c) => {
    const access = requireActor(c);
    if (access.response) return access.response;
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing") } },
        401,
      );
    }
    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await services.recordRiskAlertAction(
        {
          alertId: c.req.param("alertId"),
          action: normalizeAction(body.action),
          note: typeof body.note === "string" && body.note.trim() ? body.note.trim() : null,
          operatorUserId: access.actor.userId,
        },
        context,
      );
      return c.json({ id: result.actionId, recordedAt: result.recordedAt });
    } catch (error) {
      return c.json(
        { error: { code: "validation_failed", message: error instanceof Error ? error.message : String(error) } },
        400,
      );
    }
  });

  return app;
}
