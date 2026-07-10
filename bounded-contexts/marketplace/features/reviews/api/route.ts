import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { ReputationApiEnv } from "./http";
import type { ReviewServices } from "./runtime";

function readRoleFilter(value: string | undefined): "seller" | "buyer" | undefined {
  return value === "seller" || value === "buyer" ? value : undefined;
}

function requireReviewAccess(
  c: {
    get(key: "actor"): ReputationApiEnv["Variables"]["actor"];
  },
  permission: "reputation.view" | "reputation.manage",
) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("reputation.features.reviews.api.route.authentication.required"),
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
          error: { code: "authorization_forbidden", message: t("reputation.features.reviews.api.route.forbidden") },
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
  return error instanceof Error ? error.message : t("reputation.features.reviews.api.route.request.failed");
}

export function createPublicReputationRoutes(services: ReviewServices) {
  const app = new Hono<ReputationApiEnv>();

  app.get("/:accountId/review-summary", async (c) => {
    const summary = await services.getPublicAccountSummary(c.req.param("accountId"));
    return c.json(summary);
  });

  app.get("/:accountId/reviews", async (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listPublicAccountReviews({
      accountId: c.req.param("accountId"),
      role: readRoleFilter(c.req.query("role")),
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  return app;
}

export function createAccountReviewRoutes(services: ReviewServices) {
  const app = new Hono<ReputationApiEnv>();

  app.get("/written", async (c) => {
    const access = requireReviewAccess(c, "reputation.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listWrittenReviews({
      authorAccountId: access.actor.accountId,
      role: readRoleFilter(c.req.query("role")),
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/received", async (c) => {
    const access = requireReviewAccess(c, "reputation.view");
    if (access.response) {
      return access.response;
    }

    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const result = await services.listReceivedReviews({
      subjectAccountId: access.actor.accountId,
      role: readRoleFilter(c.req.query("role")),
      limit,
      offset,
    });

    return c.json({
      items: result.items,
      total: result.total,
      count: result.items.length,
    });
  });

  app.get("/opportunities/orders/:orderId", async (c) => {
    const access = requireReviewAccess(c, "reputation.view");
    if (access.response) {
      return access.response;
    }

    const opportunity = await services.getOrderReviewOpportunity(c.req.param("orderId"), access.actor.accountId);
    if (!opportunity) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("reputation.features.reviews.api.route.review.opportunity.not.found"),
          },
        },
        404,
      );
    }

    return c.json(opportunity);
  });

  app.get("/:id", async (c) => {
    const access = requireReviewAccess(c, "reputation.view");
    if (access.response) {
      return access.response;
    }

    const review = await services.getAccountReview(c.req.param("id"), access.actor.accountId);
    if (!review) {
      return c.json(
        { error: { code: "not_found", message: t("reputation.features.reviews.api.route.review.not.found") } },
        404,
      );
    }

    return c.json(review);
  });

  app.post("/", async (c) => {
    const access = requireReviewAccess(c, "reputation.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("reputation.features.reviews.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await services.submitReview(
        {
          orderId: String(body.orderId ?? ""),
          authorAccountId: access.actor.accountId,
          subjectAccountId: String(body.subjectAccountId ?? ""),
          rating: Number(body.rating ?? 0),
          feedback: typeof body.feedback === "string" ? body.feedback : null,
        },
        context,
      );
      return c.json({ id: result.reviewId, version: result.version, status: "submitted" }, 201);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/update", async (c) => {
    const access = requireReviewAccess(c, "reputation.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("reputation.features.reviews.api.route.authentication.context.missing.2"),
          },
        },
        401,
      );
    }

    const body = await c.req.json();

    try {
      const result = await services.updateReview(
        {
          reviewId: c.req.param("id"),
          authorAccountId: access.actor.accountId,
          rating: Number(body.rating ?? 0),
          feedback: typeof body.feedback === "string" ? body.feedback : null,
        },
        context,
      );
      return c.json({ id: result.reviewId, version: result.version, status: "updated" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.post("/:id/withdraw", async (c) => {
    const access = requireReviewAccess(c, "reputation.manage");
    if (access.response) {
      return access.response;
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("reputation.features.reviews.api.route.authentication.context.missing.3"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.withdrawReview(
        {
          reviewId: c.req.param("id"),
          authorAccountId: access.actor.accountId,
        },
        context,
      );
      return c.json({ id: result.reviewId, version: result.version, status: "withdrawn" });
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
