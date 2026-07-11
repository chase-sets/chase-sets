import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { ReportedContentModerationAction } from "./contracts";
import type { ReportedContentServices } from "./runtime";

type ExperienceApiEnv = AuthenticatedApiEnv;

function requireActor(
  c: {
    get(key: "actor"): ExperienceApiEnv["Variables"]["actor"];
  },
  permission: "reported-content.view",
) {
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

  if (!actor.permissions.includes(permission)) {
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

function normalizeAction(value: unknown): ReportedContentModerationAction {
  if (
    value === "dismiss" ||
    value === "contact-seller" ||
    value === "unlist" ||
    value === "escalate-account-suspension" ||
    value === "withdraw-review" ||
    value === "redact-review-feedback" ||
    value === "withdraw-review-reply"
  ) {
    return value;
  }

  throw new Error("Reported content action is invalid.");
}

export function createReportedContentRoutes(services: ReportedContentServices) {
  const app = new Hono<ExperienceApiEnv>();

  app.get("/", async (c) => {
    const access = requireActor(c, "reported-content.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listReportedContentQueue({
      limit,
      offset,
      status: c.req.query("status"),
      targetType: c.req.query("targetType"),
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/metrics", async (c) => {
    const access = requireActor(c, "reported-content.view");
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getReportedContentQueueMetrics());
  });

  app.get("/:targetType/:targetId", async (c) => {
    const access = requireActor(c, "reported-content.view");
    if (access.response) {
      return access.response;
    }

    const item = await services.getReportedContentQueueItem(c.req.param("targetType"), c.req.param("targetId"));
    if (!item) {
      return c.json({ error: { code: "not_found", message: t("experience.api.reported.content.not.found") } }, 404);
    }

    return c.json(item);
  });

  app.post("/:targetType/:targetId/actions", async (c) => {
    const access = requireActor(c, "reported-content.view");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing") } },
        401,
      );
    }

    try {
      const body = await c.req.json().catch(() => ({}));
      const result = await services.recordModerationAction(
        {
          targetType: c.req.param("targetType"),
          targetId: c.req.param("targetId"),
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
