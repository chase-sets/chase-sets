import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { BulkReviewJobServices, IntegrationJobServices } from "./runtime";
import {
  parseObservationIds,
  parsePromotionScope,
  promotionScopeToIntegrationScope,
  streamBulkJobEvents,
} from "./route-helpers";

export type BulkReviewJobRouteServices = BulkReviewJobServices & Pick<IntegrationJobServices, "enqueueIntegrationJob">;

export function bulkReviewJobRoutes(services: BulkReviewJobRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/reapply", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
    };

    if (body.scope) {
      const job = await services.enqueueIntegrationJob({
        action: "reapply",
        scope: promotionScopeToIntegrationScope(parsePromotionScope(body.scope)),
        context: c.get("context"),
      });

      return c.json(job, 202);
    }

    const job = await services.enqueueBulkReviewJob({
      action: "reapply",
      observationIds: parseObservationIds(body.observationIds),
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.post("/bulk-promote/jobs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
    };
    const job = await services.enqueueBulkReviewJob({
      action: "promote",
      observationIds: parseObservationIds(body.observationIds),
      scope: body.scope ? parsePromotionScope(body.scope) : undefined,
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.post("/bulk-promote", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
    };

    const job = await services.enqueueBulkReviewJob({
      action: "promote",
      observationIds: parseObservationIds(body.observationIds),
      scope: body.scope ? parsePromotionScope(body.scope) : undefined,
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.post("/bulk-reject", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
      reason?: unknown;
    };
    const reason = String(body.reason ?? "").trim();

    if (!reason) {
      return c.json(
        {
          error: t("catalog.features.sourceObservations.api.route.bulk.rejection.requires.reason"),
        },
        400,
      );
    }

    const job = await services.enqueueBulkReviewJob({
      action: "reject",
      observationIds: parseObservationIds(body.observationIds),
      scope: body.scope ? parsePromotionScope(body.scope) : undefined,
      reason,
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.post("/bulk-reject/jobs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
      reason?: unknown;
    };
    const reason = String(body.reason ?? "").trim();

    if (!reason) {
      return c.json(
        {
          error: t("catalog.features.sourceObservations.api.route.bulk.rejection.requires.reason"),
        },
        400,
      );
    }

    const job = await services.enqueueBulkReviewJob({
      action: "reject",
      observationIds: parseObservationIds(body.observationIds),
      scope: body.scope ? parsePromotionScope(body.scope) : undefined,
      reason,
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.get("/bulk-jobs/active", async (c) => {
    const items = await services.listActiveBulkReviewJobs({
      context: c.get("context"),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/bulk-jobs/:jobId", async (c) => {
    const job = await services.getBulkReviewJob(c.req.param("jobId"), c.get("context"));
    if (!job) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.sourceObservations.api.route.bulk.job.not.found"),
          },
        },
        404,
      );
    }

    return c.json(job);
  });

  app.get("/bulk-jobs/:jobId/events", async (c) => {
    const jobId = c.req.param("jobId");
    const job = await services.getBulkReviewJob(jobId, c.get("context"));
    if (!job) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.sourceObservations.api.route.bulk.job.not.found"),
          },
        },
        404,
      );
    }

    return streamBulkJobEvents(services, jobId, c.req.raw, c.get("context"));
  });

  return app;
}
