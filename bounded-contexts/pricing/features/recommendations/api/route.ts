import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import { createDurableJobEventStream } from "@chase-sets/platform-runtime/durable-job-events";
import type { PricingApiEnv } from "../../../api";
import type { PricingRecommendationServices } from "./runtime";

function requireRecommendationAccess(
  c: { get(key: "actor"): PricingApiEnv["Variables"]["actor"] },
  permission: "pricing.view" | "pricing.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("pricing.features.recommendations.api.route.authentication.required"),
          },
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
        JSON.stringify({
          error: {
            code: "authorization_forbidden",
            message: t("pricing.features.recommendations.api.route.forbidden"),
          },
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      ),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("pricing.features.recommendations.api.route.request.failed");
}

function parseRecommendationIds(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(String)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function createAccountRecommendationRoutes(services: PricingRecommendationServices) {
  const app = new Hono<PricingApiEnv>();

  app.get("/recommendations", async (c) => {
    const access = requireRecommendationAccess(c, "pricing.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listAccountRecommendations({
      accountId: access.actor.accountId,
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/recommendations/:id", async (c) => {
    const access = requireRecommendationAccess(c, "pricing.view");
    if (access.response) {
      return access.response;
    }

    const recommendation = await services.getAccountRecommendation(c.req.param("id"), access.actor.accountId);
    if (!recommendation) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("pricing.features.recommendations.api.route.recommendation.not.found"),
          },
        },
        404,
      );
    }

    return c.json(recommendation);
  });

  app.post("/recommendations/:id/publish", async (c) => {
    const access = requireRecommendationAccess(c, "pricing.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("pricing.features.recommendations.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await services.publishRecommendation(
        {
          recommendationId: c.req.param("id"),
          accountId: access.actor.accountId,
          recommendedListAmount: Number(body.recommendedListAmount),
          reason: String(body.reason ?? ""),
          publishedAt: typeof body.publishedAt === "string" ? body.publishedAt : undefined,
        },
        context,
      );
      return c.json({ id: result.recommendationId, version: result.version });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/recommendations/refresh", async (c) => {
    const access = requireRecommendationAccess(c, "pricing.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("pricing.features.recommendations.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    try {
      const job = await services.enqueueRecommendationJob(
        { action: "refresh", accountId: access.actor.accountId },
        context,
      );
      return c.json(job, 202);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/recommendations/apply", async (c) => {
    const access = requireRecommendationAccess(c, "pricing.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("pricing.features.recommendations.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const job = await services.enqueueRecommendationJob(
        {
          action: "apply",
          accountId: access.actor.accountId,
          recommendationIds: parseRecommendationIds((body as { recommendationIds?: unknown }).recommendationIds),
        },
        context,
      );
      return c.json(job, 202);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/recommendations/dismiss", async (c) => {
    const access = requireRecommendationAccess(c, "pricing.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("pricing.features.recommendations.api.route.authentication.context.missing.4"),
          },
        },
        401,
      );
    }

    const body = await c.req.json().catch(() => ({}));

    try {
      const job = await services.enqueueRecommendationJob(
        {
          action: "dismiss",
          accountId: access.actor.accountId,
          recommendationIds: parseRecommendationIds((body as { recommendationIds?: unknown }).recommendationIds),
        },
        context,
      );
      return c.json(job, 202);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/recommendation-jobs/:jobId", async (c) => {
    const access = requireRecommendationAccess(c, "pricing.view");
    if (access.response) {
      return access.response;
    }

    const job = await services.getRecommendationJob(c.req.param("jobId"));
    if (!job || job.payload.accountId !== access.actor.accountId) {
      return c.json(
        { error: { code: "not_found", message: t("pricing.features.recommendations.api.route.job.not.found") } },
        404,
      );
    }

    return c.json(job);
  });

  app.get("/recommendation-jobs/:jobId/events", async (c) => {
    const access = requireRecommendationAccess(c, "pricing.view");
    if (access.response) {
      return access.response;
    }

    const jobId = c.req.param("jobId");
    const job = await services.getRecommendationJob(jobId);
    if (!job || job.payload.accountId !== access.actor.accountId) {
      return c.json(
        { error: { code: "not_found", message: t("pricing.features.recommendations.api.route.job.not.found") } },
        404,
      );
    }

    return createDurableJobEventStream({
      request: c.req.raw,
      signal: c.req.raw.signal,
      loadEvents: async (afterSequence) =>
        (await services.listRecommendationJobEvents(jobId, afterSequence)).map((event) => ({
          sequence: event.sequence,
          eventName: event.eventName,
          data: event.job,
        })),
      isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
    });
  });

  return app;
}
