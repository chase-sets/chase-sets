import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { PlatformFeedbackServices } from "./runtime";
import { normalizeTopic, normalizeWorkflow, type PlatformFeedbackRelatedEntity } from "../domain/common";

export type ExperienceApiEnv = AuthenticatedApiEnv;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("experience.api.request.failed");
}

function requireActor(
  c: {
    get(key: "actor"): ExperienceApiEnv["Variables"]["actor"];
  },
  permission?: "platform-feedback.view" | "platform-feedback.manage",
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

  if (permission && !actor.permissions.includes(permission)) {
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

function relatedEntitiesFromBody(value: unknown): readonly PlatformFeedbackRelatedEntity[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      type: String(record.type ?? ""),
      id: String(record.id ?? ""),
    };
  });
}

function relatedEntitiesFromQuery(c: { req: { query(name: string): string | undefined } }) {
  const relatedEntityType = c.req.query("relatedEntityType");
  const relatedEntityId = c.req.query("relatedEntityId");
  return relatedEntityType && relatedEntityId ? [{ type: relatedEntityType, id: relatedEntityId }] : [];
}

export function createPlatformFeedbackRoutes(services: PlatformFeedbackServices) {
  const app = new Hono<ExperienceApiEnv>();

  app.get("/prompt", async (c) => {
    const access = requireActor(c);
    if (access.response) {
      return access.response;
    }

    try {
      return c.json(
        await services.getPromptEligibility({
          accountId: access.actor.accountId,
          workflow: normalizeWorkflow(c.req.query("workflow") ?? ""),
          relatedEntities: relatedEntitiesFromQuery(c),
        }),
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/", async (c) => {
    const access = requireActor(c);
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
    const body = await c.req.json();

    try {
      const result = await services.submitPlatformFeedback(
        {
          userId: access.actor.userId,
          accountId: access.actor.accountId,
          rating: Number(body.rating ?? 0),
          topic: normalizeTopic(String(body.topic ?? "")),
          comment: typeof body.comment === "string" ? body.comment : null,
          followUpConsent: Boolean(body.followUpConsent),
          workflow: normalizeWorkflow(String(body.workflow ?? "")),
          sourceRoutePath: String(body.sourceRoutePath ?? ""),
          relatedEntities: relatedEntitiesFromBody(body.relatedEntities),
        },
        context,
      );
      return c.json({ id: result.feedbackId, version: result.version, status: "submitted" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/dismiss", async (c) => {
    const access = requireActor(c);
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing.2") } },
        401,
      );
    }
    const body = await c.req.json();

    try {
      const result = await services.dismissPrompt(
        {
          userId: access.actor.userId,
          accountId: access.actor.accountId,
          workflow: normalizeWorkflow(String(body.workflow ?? "")),
          sourceRoutePath: String(body.sourceRoutePath ?? ""),
          relatedEntities: relatedEntitiesFromBody(body.relatedEntities),
        },
        context,
      );
      return c.json({ id: result.promptId, version: result.version, snoozedUntil: result.snoozedUntil });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/", async (c) => {
    const access = requireActor(c, "platform-feedback.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listPlatformFeedback({
      limit,
      offset,
      status: c.req.query("status"),
      topic: c.req.query("topic"),
      workflow: c.req.query("workflow"),
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/metrics", async (c) => {
    const access = requireActor(c, "platform-feedback.view");
    if (access.response) {
      return access.response;
    }

    return c.json(await services.getPlatformFeedbackMetrics());
  });

  app.get("/:id", async (c) => {
    const access = requireActor(c, "platform-feedback.view");
    if (access.response) {
      return access.response;
    }

    const feedback = await services.getPlatformFeedback(c.req.param("id"));
    if (!feedback) {
      return c.json({ error: { code: "not_found", message: t("experience.api.platform.feedback.not.found") } }, 404);
    }

    return c.json(feedback);
  });

  app.post("/:id/review", async (c) => {
    const access = requireActor(c, "platform-feedback.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing.3") } },
        401,
      );
    }

    try {
      const result = await services.markReviewed(c.req.param("id"), access.actor.userId, context);
      return c.json({ id: result.feedbackId, version: result.version, status: "reviewed" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/archive", async (c) => {
    const access = requireActor(c, "platform-feedback.manage");
    if (access.response) {
      return access.response;
    }
    const context = c.get("context");
    if (!context) {
      return c.json(
        { error: { code: "authentication_required", message: t("experience.api.authentication.context.missing.4") } },
        401,
      );
    }

    try {
      const result = await services.archive(c.req.param("id"), access.actor.userId, context);
      return c.json({ id: result.feedbackId, version: result.version, status: "archived" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}

export function buildExperienceApi(platformFeedback: PlatformFeedbackServices) {
  const app = new Hono<ExperienceApiEnv>();
  app.route("/platform-feedback", createPlatformFeedbackRoutes(platformFeedback));
  return app;
}
