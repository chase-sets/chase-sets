import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import type {
  BulkReviewJobServices,
  CatalogMergeCandidateBulkJobKind,
  CatalogMergeCandidateBulkJobServices,
  IntegrationJobServices,
} from "../runtime";
import {
  CatalogMergeCandidateBulkJobCursorError,
  isCatalogMergeCandidateBulkJobKind,
} from "../source-observation-merge-candidate-bulk-job-runtime";
import {
  parseObservationIds,
  parsePromoteAsDraft,
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

export type BulkReviewJobRouteServices = BulkReviewJobServices &
  CatalogMergeCandidateBulkJobServices &
  Pick<IntegrationJobServices, "enqueueIntegrationJob">;

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
      promoteAsDraft?: unknown;
    };
    let job;
    try {
      job = await services.enqueueBulkReviewJob({
        action: "promote",
        observationIds: parseObservationIds(body.observationIds),
        scope: body.scope ? parsePromotionScope(body.scope) : undefined,
        promoteAsDraft: parsePromoteAsDraft(body.promoteAsDraft),
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
      promoteAsDraft?: unknown;
    };

    let job;
    try {
      job = await services.enqueueBulkReviewJob({
        action: "promote",
        observationIds: parseObservationIds(body.observationIds),
        scope: body.scope ? parsePromotionScope(body.scope) : undefined,
        promoteAsDraft: parsePromoteAsDraft(body.promoteAsDraft),
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

  // One scope-wide Catalog Merge Candidate review job. Candidates are selected
  // server-side when the job starts, never from the page that submitted it.
  app.post("/merge-candidate-bulk-jobs", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const parsed: unknown = await c.req.json().catch(() => null);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return c.json(
        { error: t("catalog.features.sourceObservations.api.route.merge.candidate.bulk.job.invalid") },
        400,
      );
    }
    const body = parsed as Record<string, unknown>;
    const scopeRecordId = typeof body.scopeRecordId === "string" ? body.scopeRecordId.trim() : "";
    if (!isCatalogMergeCandidateBulkJobKind(body.kind) || !scopeRecordId) {
      return c.json(
        { error: t("catalog.features.sourceObservations.api.route.merge.candidate.bulk.job.invalid") },
        400,
      );
    }

    const job = await services.enqueueCatalogMergeCandidateBulkJob({
      kind: body.kind,
      scopeRecordId,
      reason: typeof body.reason === "string" ? body.reason : null,
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.get("/merge-candidate-bulk-jobs/failed", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }
    const scopeRecordId = c.req.query("scopeRecordId")?.trim();
    if (!scopeRecordId) {
      return c.json(
        { error: t("catalog.features.sourceObservations.api.route.merge.candidate.bulk.job.failed.scope.required") },
        400,
      );
    }
    const items = await services.listFailedCatalogMergeCandidateBulkJobs({
      context: c.get("context"),
      scopeRecordId,
    });
    return c.json({ items, count: items.length });
  });

  // Unfiltered, this lists active observation bulk jobs exactly as before. The
  // additive `scopeRecordId`, `kind` and `status=completed` filters list
  // Catalog Merge Candidate scope jobs; completed jobs page newest first, 50 at
  // a time, and callers follow `cursor` until it is absent.
  app.get("/bulk-jobs/active", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

    const filter = mergeCandidateBulkJobListFilter(c.req.query());
    if (filter === "invalid") {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.bulk.job.invalid.filter") }, 400);
    }
    if (!filter) {
      const items = await services.listActiveBulkReviewJobs({
        context: c.get("context"),
      });

      return c.json({ items, total: items.length, count: items.length });
    }

    if (filter.status === "completed") {
      let page;
      try {
        page = await services.listCompletedCatalogMergeCandidateBulkJobs({
          context: c.get("context"),
          scopeRecordId: filter.scopeRecordId,
          kind: filter.kind,
          cursor: filter.cursor,
        });
      } catch (error) {
        if (error instanceof CatalogMergeCandidateBulkJobCursorError) {
          return c.json({ error: t("catalog.features.sourceObservations.api.route.bulk.job.invalid.cursor") }, 400);
        }
        throw error;
      }

      return c.json({ ...page, count: page.items.length });
    }

    const items = await services.listActiveCatalogMergeCandidateBulkJobs({
      context: c.get("context"),
      scopeRecordId: filter.scopeRecordId,
      kind: filter.kind,
    });

    return c.json({ items, count: items.length });
  });

  app.get("/bulk-jobs/:jobId", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

    const jobId = c.req.param("jobId");
    const job =
      (await services.getBulkReviewJob(jobId, c.get("context"))) ??
      (await services.getCatalogMergeCandidateBulkJob(jobId, c.get("context")));
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

type MergeCandidateBulkJobListFilter = Readonly<{
  scopeRecordId: string | null;
  kind: CatalogMergeCandidateBulkJobKind | null;
  status: "active" | "completed";
  cursor: string | null;
}>;

function mergeCandidateBulkJobListFilter(
  query: Readonly<Record<string, string | undefined>>,
): MergeCandidateBulkJobListFilter | "invalid" | null {
  const scopeRecordId = query.scopeRecordId?.trim() || null;
  const kind = query.kind?.trim() || null;
  const status = query.status?.trim() || null;
  const cursor = query.cursor?.trim() || null;
  if (!scopeRecordId && !kind && !status && !cursor) {
    return null;
  }
  if (kind !== null && !isCatalogMergeCandidateBulkJobKind(kind)) {
    return "invalid";
  }
  if ((status !== null && status !== "completed") || (cursor !== null && status !== "completed")) {
    return "invalid";
  }

  return { scopeRecordId, kind, status: status === "completed" ? "completed" : "active", cursor };
}

function hasExplicitBulkReviewScope(scope: ReturnType<typeof parsePromotionScope> | undefined): boolean {
  return Boolean(scope && Object.values(scope).some((value) => typeof value === "string" && value.trim().length > 0));
}
