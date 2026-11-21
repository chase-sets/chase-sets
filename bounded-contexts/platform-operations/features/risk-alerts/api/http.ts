import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { RiskAlertActionRejectedError, type RiskAlertAction } from "./contracts";
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

function normalizeActionBody(body: unknown): { action: RiskAlertAction; note: string | null } {
  if (body === null || typeof body !== "object" || Array.isArray(body) || !("action" in body)) {
    throw new Error("Risk alert action is invalid.");
  }
  const { action } = body;
  if (action !== "request-manual-payout-review" && action !== "acknowledge") {
    throw new Error("Risk alert action is invalid.");
  }
  const note = "note" in body && typeof body.note === "string" ? body.note.trim() : "";
  return { action, note: note || null };
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
    try {
      const { action, note } = normalizeActionBody(await c.req.json<unknown>().catch(() => null));
      if (
        action === "request-manual-payout-review" &&
        !access.actor.permissions.includes("payout-review-holds.manage")
      ) {
        return c.json({ error: { code: "authorization_forbidden", message: t("experience.api.forbidden") } }, 403);
      }
      const context = c.get("context");
      if (!context) {
        return c.json(
          { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing") } },
          401,
        );
      }
      const result = await services.recordRiskAlertAction(
        {
          alertId: c.req.param("alertId"),
          action,
          note,
          operatorUserId: access.actor.userId,
          ...(action === "request-manual-payout-review" ? { actorPermissions: access.actor.permissions } : {}),
        },
        context,
      );
      return c.json({ id: result.actionId, recordedAt: result.recordedAt });
    } catch (error) {
      if (error instanceof RiskAlertActionRejectedError) {
        if (error.code === "alert-not-found") {
          return c.json(
            {
              error: {
                code: "not_found",
                reason: error.code,
                message: t("experience.api.risk.alert.action.rejected"),
              },
            },
            404,
          );
        }
        return c.json(
          {
            error: {
              code: "validation_failed",
              reason: error.code,
              message: t("experience.api.risk.alert.action.rejected"),
            },
          },
          400,
        );
      }
      return c.json(
        { error: { code: "validation_failed", message: error instanceof Error ? error.message : String(error) } },
        400,
      );
    }
  });

  return app;
}
