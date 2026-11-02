import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { isReportedContentModerationAction, ReportedContentActionRejectedError } from "./contracts";
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

const actionBodyKeys: readonly PropertyKey[] = ["action", "note"];

/** Reads the closed action body `{ action, note? }`; the action vocabulary is the contract table's. */
function parseActionBody(body: unknown) {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Reflect.ownKeys(body).some((key) => !actionBodyKeys.includes(key))
  ) {
    throw new ReportedContentActionRejectedError("invalid-request");
  }
  const { action, note = null } = body as Readonly<Record<string, unknown>>;
  if (typeof action !== "string" || (note !== null && typeof note !== "string")) {
    throw new ReportedContentActionRejectedError("invalid-request");
  }
  if (!isReportedContentModerationAction(action)) {
    throw new ReportedContentActionRejectedError("unknown-action");
  }
  return { action, note: note?.trim() || null };
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
      const body = parseActionBody(await c.req.json().catch(() => null));
      const result = await services.recordModerationAction(
        {
          targetType: c.req.param("targetType"),
          targetId: c.req.param("targetId"),
          action: body.action,
          note: body.note,
          operatorUserId: access.actor.userId,
        },
        context,
      );
      return c.json({ id: result.actionId, recordedAt: result.recordedAt });
    } catch (error) {
      if (error instanceof ReportedContentActionRejectedError) {
        // The bounded code is the whole explanation; request text is never echoed.
        return c.json(
          {
            error: {
              code: "validation_failed",
              reason: error.code,
              message: t("experience.api.reported.content.action.rejected"),
            },
          },
          400,
        );
      }
      throw error;
    }
  });

  return app;
}
