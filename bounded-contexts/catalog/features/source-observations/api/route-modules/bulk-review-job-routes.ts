import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import type { BulkReviewJobServices, IntegrationJobServices } from "../runtime";
import {
  parseObservationIds,
  parsePromotionScope,
  parseReapplyProfileMode,
  promotionScopeToIntegrationScope,
  streamBulkJobEvents,
} from "./route-helpers";
import {
  CatalogIntegrationRolloutControlError,
  rolloutControlErrorResponse,
} from "../governance/catalog-integration-rollout-controls";
import { requireCatalogIntegrationControlPlanePermission } from "../admin/admin-control-plane-rbac";

export type BulkReviewJobRouteServices = BulkReviewJobServices & Pick<IntegrationJobServices, "enqueueIntegrationJob">;

export function bulkReviewJobRoutes(services: BulkReviewJobRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.post("/reapply", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
      reapplyProfileMode?: unknown;
    };
    const reapplyProfileMode = parseReapplyProfileMode(body.reapplyProfileMode) ?? "current-active-profile";

    if (body.scope) {
      let job;
      try {
        job = await services.enqueueIntegrationJob({
          action: "reapply",
          scope: promotionScopeToIntegrationScope(parsePromotionScope(body.scope)),
          reapplyProfileMode,
          context: c.get("context"),
        });
      } catch (error) {
        if (error instanceof CatalogIntegrationRolloutControlError) {
          return c.json(rolloutControlErrorResponse(error), 403);
        }
        throw error;
      }

      return c.json(job, 202);
    }

    let job;
    try {
      job = await services.enqueueBulkReviewJob({
        action: "reapply",
        observationIds: parseObservationIds(body.observationIds),
        reapplyProfileMode,
        context: c.get("context"),
      });
    } catch (error) {
      if (error instanceof CatalogIntegrationRolloutControlError) {
        return c.json(rolloutControlErrorResponse(error), 403);
      }
      throw error;
    }

    return c.json(job, 202);
  });

  app.post("/bulk-defer/jobs", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
      reason?: unknown;
    };
    const observationIds = parseObservationIds(body.observationIds);
    const scope = body.scope ? parsePromotionScope(body.scope) : undefined;
    if (observationIds.length === 0 && !hasExplicitBulkReviewScope(scope)) {
      return c.json(
        {
          error: t("catalog.features.sourceObservations.api.route.bulk.deferral.requires.selection.or.scope"),
        },
        400,
      );
    }
    const reason = String(body.reason ?? "").trim() || "Deferred during Source Observation review.";

    const job = await services.enqueueBulkReviewJob({
      action: "defer",
      observationIds,
      scope,
      reason,
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.post("/bulk-promote/jobs", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
    };
    let job;
    try {
      job = await services.enqueueBulkReviewJob({
        action: "promote",
        observationIds: parseObservationIds(body.observationIds),
        scope: body.scope ? parsePromotionScope(body.scope) : undefined,
        context: c.get("context"),
      });
    } catch (error) {
      if (error instanceof CatalogIntegrationRolloutControlError) {
        return c.json(rolloutControlErrorResponse(error), 403);
      }
      throw error;
    }

    return c.json(job, 202);
  });

  app.post("/bulk-promote", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
    };

    let job;
    try {
      job = await services.enqueueBulkReviewJob({
        action: "promote",
        observationIds: parseObservationIds(body.observationIds),
        scope: body.scope ? parsePromotionScope(body.scope) : undefined,
        context: c.get("context"),
      });
    } catch (error) {
      if (error instanceof CatalogIntegrationRolloutControlError) {
        return c.json(rolloutControlErrorResponse(error), 403);
      }
      throw error;
    }

    return c.json(job, 202);
  });

  app.post("/bulk-reject", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

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
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

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
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

    const items = await services.listActiveBulkReviewJobs({
      context: c.get("context"),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/bulk-jobs/:jobId", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

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

  app.get("/bulk-jobs/:jobId/outcome", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

    const jobId = c.req.param("jobId");
    const job = await services.getBulkReviewJob(jobId, c.get("context"));
    if (!job || job.action !== "promote") {
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

    const outcome = await services.getBulkReviewPromotionOutcome(jobId);
    return c.json({ outcome }, outcome ? 200 : 202);
  });

  app.get("/bulk-jobs/:jobId/events", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

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

function hasExplicitBulkReviewScope(scope: ReturnType<typeof parsePromotionScope> | undefined): boolean {
  return Boolean(scope && Object.values(scope).some((value) => typeof value === "string" && value.trim().length > 0));
}
