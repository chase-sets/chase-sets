import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { PlatformFeedbackServices } from "./runtime";
import { normalizeTopic, normalizeWorkflow, type PlatformFeedbackRelatedEntity } from "../domain/common";
import { createReportedContentRoutes } from "../../reported-content/api/http";
import type { ReportedContentServices } from "../../reported-content/api/runtime";
import { createRiskAlertRoutes } from "../../risk-alerts/api/http";
import type { RiskAlertServices } from "../../risk-alerts/api/runtime";

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

function csvCell(value: unknown) {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function feedbackIdsFromBody(value: unknown): readonly string[] {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return Array.isArray(record.feedbackIds) ? record.feedbackIds.map(String) : [];
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

  app.get("/export", async (c) => {
    const access = requireActor(c, "platform-feedback.view");
    if (access.response) {
      return access.response;
    }

    const result = await services.listPlatformFeedback({
      limit: 500,
      offset: 0,
      status: c.req.query("status"),
      topic: c.req.query("topic"),
      workflow: c.req.query("workflow"),
    });
    const rows = [
      [
        "feedback_id",
        "account_id",
        "user_id",
        "rating",
        "topic",
        "workflow",
        "status",
        "comment",
        "follow_up_consent",
        "source_route_path",
        "related_entity_key",
        "submitted_at",
        "updated_at",
        "reviewed_by_user_id",
        "reviewed_at",
        "archived_by_user_id",
        "archived_at",
        "operator_note_count",
      ],
      ...result.items.map((item) => [
        item.feedback_id,
        item.account_id,
        item.user_id,
        item.rating,
        item.topic,
        item.workflow,
        item.status,
        item.comment,
        item.follow_up_consent,
        item.source_route_path,
        item.related_entity_key,
        item.submitted_at,
        item.updated_at,
        item.reviewed_by_user_id,
        item.reviewed_at,
        item.archived_by_user_id,
        item.archived_at,
        item.operator_notes.length,
      ]),
    ];

    return new Response(rows.map((row) => row.map(csvCell).join(",")).join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="chase-sets-platform-feedback.csv"',
      },
    });
  });

  app.post("/bulk/review", async (c) => {
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
      const body = await c.req.json().catch(() => ({}));
      const result = await services.bulkMarkReviewed(feedbackIdsFromBody(body), access.actor.userId, context);
      return c.json({
        action: result.action,
        updated: result.updated,
        skipped: result.skipped,
        items: result.items.map((item) => ({ id: item.feedbackId, version: item.version, status: "reviewed" })),
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/bulk/archive", async (c) => {
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
      const body = await c.req.json().catch(() => ({}));
      const result = await services.bulkArchive(feedbackIdsFromBody(body), access.actor.userId, context);
      return c.json({
        action: result.action,
        updated: result.updated,
        skipped: result.skipped,
        items: result.items.map((item) => ({ id: item.feedbackId, version: item.version, status: "archived" })),
      });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
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

  app.post("/:id/notes", async (c) => {
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
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const result = await services.recordOperatorNote(
        c.req.param("id"),
        {
          body: String(body.body ?? ""),
          recordedByUserId: access.actor.userId,
        },
        context,
      );
      return c.json({ id: result.feedbackId, version: result.version, noteId: result.noteId });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
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

export function buildExperienceApi(
  platformFeedback: PlatformFeedbackServices,
  reportedContent?: ReportedContentServices,
  riskAlerts?: RiskAlertServices,
) {
  const app = new Hono<ExperienceApiEnv>();
  app.route("/platform-feedback", createPlatformFeedbackRoutes(platformFeedback));
  if (reportedContent) {
    app.route("/reported-content", createReportedContentRoutes(reportedContent));
  }
  if (riskAlerts) {
    app.route("/risk-alerts", createRiskAlertRoutes(riskAlerts));
  }
  return app;
}
