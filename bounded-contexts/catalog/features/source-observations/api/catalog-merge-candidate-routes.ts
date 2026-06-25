import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type {
  CatalogMergeCandidateConflictResolution,
  CatalogMergeCandidateReviewSnapshot,
  CatalogMergeCandidateStatus,
} from "../domain/catalog-merge-candidate";
import type { CatalogMergeCandidateServices, SourceObservationReadServices } from "./runtime";
import { requireCatalogIntegrationControlPlanePermission } from "./admin-control-plane-rbac";

export type CatalogMergeCandidateRouteServices = CatalogMergeCandidateServices & SourceObservationReadServices;

export function catalogMergeCandidateRoutes(services: CatalogMergeCandidateRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/merge-candidates", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-read");
    if (permissionError) {
      return permissionError;
    }

    const result = await services.listCatalogMergeCandidates({
      search: c.req.query("search") ?? undefined,
      status: candidateStatusQuery(c.req.query("status")),
      syncRunId: c.req.query("syncRunId") ?? undefined,
      identityFingerprint: c.req.query("identityFingerprint") ?? undefined,
      matchedCatalogItemId: c.req.query("matchedCatalogItemId") ?? undefined,
      limit: positiveIntegerQuery(c.req.query("limit")),
      offset: nonNegativeIntegerQuery(c.req.query("offset")),
    });

    return c.json(result);
  });

  app.post("/merge-candidates/generate", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "integration-job-write");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      syncRunId?: unknown;
      scope?: unknown;
    };
    const result = await services.generateCatalogMergeCandidates({
      syncRunId: typeof body.syncRunId === "string" ? body.syncRunId : null,
      scope: isRecord(body.scope)
        ? {
            search: textValue(body.scope.search),
            status: textValue(body.scope.status),
            syncRunId: textValue(body.scope.syncRunId),
            provider: textValue(body.scope.provider),
            language: textValue(body.scope.language),
            productLineId: textValue(body.scope.productLineId),
            seriesId: textValue(body.scope.seriesId),
            expansionId: textValue(body.scope.expansionId),
            setId: textValue(body.scope.setId),
          }
        : undefined,
      context: c.get("context"),
    });

    return c.json(result, 202);
  });

  app.post("/merge-candidates/:candidateId/promote", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = await requestBody(c.req);
    const reason = requiredReason(body, "Promotion");
    if (!reason.ok) {
      return c.json({ error: reason.error }, 400);
    }

    const result = await services.promoteCatalogMergeCandidate({
      candidateId: c.req.param("candidateId"),
      reason: reason.value,
      conflictResolutions: conflictResolutions(body),
      context: c.get("context"),
    });

    return c.json(result);
  });

  app.post("/merge-candidates/:candidateId/split", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = await requestBody(c.req);
    const reason = requiredReason(body, "Split");
    if (!reason.ok) {
      return c.json({ error: reason.error }, 400);
    }
    if (
      !isRecord(body.remainingSnapshot) ||
      !isRecord(body.splitSnapshot) ||
      typeof body.splitCandidateId !== "string"
    ) {
      return c.json({ error: "Split requires remainingSnapshot, splitCandidateId, and splitSnapshot." }, 400);
    }

    const result = await services.splitCatalogMergeCandidate({
      candidateId: c.req.param("candidateId"),
      remainingSnapshot: body.remainingSnapshot as CatalogMergeCandidateReviewSnapshot,
      splitCandidateId: body.splitCandidateId,
      splitSnapshot: body.splitSnapshot as CatalogMergeCandidateReviewSnapshot,
      reason: reason.value,
      conflictResolutions: conflictResolutions(body),
      context: c.get("context"),
    });

    return c.json(result);
  });

  app.post("/merge-candidates/:candidateId/update", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = await requestBody(c.req);
    const reason = requiredReason(body, "Update");
    if (!reason.ok) {
      return c.json({ error: reason.error }, 400);
    }
    if (!isRecord(body.snapshot)) {
      return c.json({ error: "Update requires a candidate snapshot." }, 400);
    }

    const result = await services.updateCatalogMergeCandidate({
      candidateId: c.req.param("candidateId"),
      snapshot: body.snapshot as CatalogMergeCandidateReviewSnapshot,
      reason: reason.value,
      conflictResolutions: conflictResolutions(body),
      context: c.get("context"),
    });

    return c.json(result);
  });

  app.post("/merge-candidates/:candidateId/ignore", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = await requestBody(c.req);
    const reason = requiredReason(body, "Ignore");
    if (!reason.ok) {
      return c.json({ error: reason.error }, 400);
    }

    const result = await services.ignoreCatalogMergeCandidate({
      candidateId: c.req.param("candidateId"),
      reason: reason.value,
      conflictResolutions: conflictResolutions(body),
      context: c.get("context"),
    });

    return c.json(result);
  });

  app.post("/merge-candidates/:candidateId/defer", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = await requestBody(c.req);
    const reason = requiredReason(body, "Deferral");
    if (!reason.ok) {
      return c.json({ error: reason.error }, 400);
    }

    const result = await services.deferCatalogMergeCandidate({
      candidateId: c.req.param("candidateId"),
      reason: reason.value,
      conflictResolutions: conflictResolutions(body),
      context: c.get("context"),
    });

    return c.json(result);
  });

  return app;
}

function positiveIntegerQuery(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function candidateStatusQuery(value: string | undefined): CatalogMergeCandidateStatus | undefined {
  return value === "ready" ||
    value === "has-conflicts" ||
    value === "stale" ||
    value === "deferred" ||
    value === "rejected" ||
    value === "promoted"
    ? value
    : undefined;
}

function nonNegativeIntegerQuery(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function requestBody(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

function requiredReason(
  body: Record<string, unknown>,
  label: string,
): Readonly<{ ok: true; value: string } | { ok: false; error: string }> {
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  return reason ? { ok: true, value: reason } : { ok: false, error: `${label} requires a reason.` };
}

function conflictResolutions(
  body: Record<string, unknown>,
): readonly CatalogMergeCandidateConflictResolution[] | undefined {
  return Array.isArray(body.conflictResolutions)
    ? (body.conflictResolutions as CatalogMergeCandidateConflictResolution[])
    : undefined;
}
