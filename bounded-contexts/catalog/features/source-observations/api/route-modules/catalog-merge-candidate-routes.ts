import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import type {
  CatalogMergeCandidateConflictResolution,
  CatalogMergeCandidateStatus,
} from "../../domain/catalog-merge-candidate";
import type {
  CatalogMergeCandidateReviewCommandErrorCode,
  CatalogMergeCandidateServices,
  SourceObservationReadServices,
} from "../runtime";
import { isCatalogMergeCandidateReviewCommandError } from "../runtime";
import { catalogMergeCandidateEditRequestFromJson } from "../promotion/catalog-merge-candidate-edit";
import { requireCatalogIntegrationControlPlanePermission } from "../admin/admin-control-plane-rbac";

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
      scopeRecordId: c.req.query("scopeRecordId") ?? undefined,
      matchedCatalogItemId: c.req.query("matchedCatalogItemId") ?? undefined,
      provider: c.req.query("provider") ?? undefined,
      language: c.req.query("language") ?? undefined,
      productLineId: c.req.query("productLineId") ?? undefined,
      productLineName: c.req.query("productLineName") ?? undefined,
      expansionId: c.req.query("expansionId") ?? undefined,
      setId: c.req.query("setId") ?? undefined,
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

  app.post("/admin/merge-candidates/:candidateId/promote", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = await requestBody(c.req);
    const reason = requiredReason(body, "promote");
    if (!reason.ok) {
      return c.json({ error: { code: "reason_required", message: reason.error } }, 400);
    }

    const result = await services.promoteCatalogMergeCandidate({
      candidateId: c.req.param("candidateId"),
      reason: reason.value,
      conflictResolutions: conflictResolutions(body),
      context: c.get("context"),
    });

    return c.json(result);
  });

  app.post("/admin/merge-candidates/:candidateId/split", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = await requestBody(c.req);
    const reason = requiredReason(body, "split");
    if (!reason.ok) {
      return c.json({ error: { code: "reason_required", message: reason.error } }, 400);
    }
    const expectedVersion = expectedVersionFrom(body);
    if (expectedVersion === null) {
      return expectedVersionRequired(c);
    }
    const splitObservationIds = body.splitObservationIds;
    if (
      !Array.isArray(splitObservationIds) ||
      splitObservationIds.length === 0 ||
      !splitObservationIds.every((id) => typeof id === "string" && id.trim().length > 0)
    ) {
      return c.json(
        {
          error: {
            code: "split_observations_required",
            message: t("catalog.features.sourceObservations.api.route.merge.candidate.split.requires.observations"),
          },
        },
        400,
      );
    }

    return reviewCommandResponse(c, () =>
      services.splitCatalogMergeCandidate({
        candidateId: c.req.param("candidateId"),
        expectedVersion,
        splitObservationIds: splitObservationIds as readonly string[],
        reason: reason.value,
        conflictResolutions: conflictResolutions(body),
        context: c.get("context"),
      }),
    );
  });

  app.post("/admin/merge-candidates/:candidateId/update", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = await requestBody(c.req);
    const reason = requiredReason(body, "update");
    if (!reason.ok) {
      return c.json({ error: { code: "reason_required", message: reason.error } }, 400);
    }
    const expectedVersion = expectedVersionFrom(body);
    if (expectedVersion === null) {
      return expectedVersionRequired(c);
    }
    const edit = catalogMergeCandidateEditRequestFromJson(body.edit);
    if (edit === null) {
      return c.json(
        {
          error: {
            code: "edit_required",
            message: t("catalog.features.sourceObservations.api.route.merge.candidate.update.requires.edit"),
          },
        },
        400,
      );
    }

    return reviewCommandResponse(c, () =>
      services.updateCatalogMergeCandidate({
        candidateId: c.req.param("candidateId"),
        expectedVersion,
        edit,
        reason: reason.value,
        conflictResolutions: conflictResolutions(body),
        context: c.get("context"),
      }),
    );
  });

  app.post("/admin/merge-candidates/:candidateId/ignore", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = await requestBody(c.req);
    const reason = requiredReason(body, "ignore");
    if (!reason.ok) {
      return c.json({ error: { code: "reason_required", message: reason.error } }, 400);
    }

    const result = await services.ignoreCatalogMergeCandidate({
      candidateId: c.req.param("candidateId"),
      reason: reason.value,
      conflictResolutions: conflictResolutions(body),
      context: c.get("context"),
    });

    return c.json(result);
  });

  app.post("/admin/merge-candidates/:candidateId/defer", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "bulk-review-write");
    if (permissionError) {
      return permissionError;
    }

    const body = await requestBody(c.req);
    const reason = requiredReason(body, "defer");
    if (!reason.ok) {
      return c.json({ error: { code: "reason_required", message: reason.error } }, 400);
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
  action: CatalogMergeCandidateRouteAction,
): Readonly<{ ok: true; value: string } | { ok: false; error: string }> {
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  return reason ? { ok: true, value: reason } : { ok: false, error: candidateActionReasonMessage(action) };
}

// The candidate version an update or split names as the one the operator saw.
function expectedVersionFrom(body: Record<string, unknown>): number | null {
  const value = body.expectedVersion;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function expectedVersionRequired(c: Context<CatalogAuthoringEnv>) {
  return c.json(
    {
      error: {
        code: "expected_version_required",
        message: t("catalog.features.sourceObservations.api.route.merge.candidate.requires.expected.version"),
      },
    },
    400,
  );
}

// An update or split, answered with its result, or with the reason the Catalog API refused it: a
// candidate that moved on since the operator read it is a 409 the page can say so for; a split or
// edit the candidate cannot take is a 400.
async function reviewCommandResponse(c: Context<CatalogAuthoringEnv>, run: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json(await run());
  } catch (error) {
    if (!isCatalogMergeCandidateReviewCommandError(error)) {
      throw error;
    }
    const status = error.code === "stale_merge_candidate" ? 409 : 400;
    return c.json({ error: { code: error.code, message: reviewCommandRefusalMessage(error.code) } }, status);
  }
}

function reviewCommandRefusalMessage(code: CatalogMergeCandidateReviewCommandErrorCode): string {
  switch (code) {
    case "stale_merge_candidate":
      return t("catalog.features.sourceObservations.api.route.merge.candidate.stale");
    case "edit_fact_not_editable":
      return t("catalog.features.sourceObservations.api.route.merge.candidate.update.fact.not.editable");
    case "split_selection_invalid":
      return t("catalog.features.sourceObservations.api.route.merge.candidate.split.selection.invalid");
    case "split_requires_two_members":
      return t("catalog.features.sourceObservations.api.route.merge.candidate.split.requires.remaining.member");
    case "split_requires_separable_reference_provenance":
      return t("catalog.features.sourceObservations.api.route.merge.candidate.split.requires.separable.references");
  }
}

type CatalogMergeCandidateRouteAction = "promote" | "split" | "update" | "ignore" | "defer";

function candidateActionReasonMessage(action: CatalogMergeCandidateRouteAction): string {
  switch (action) {
    case "promote":
      return t("catalog.features.sourceObservations.api.route.merge.candidate.promote.requires.reason");
    case "split":
      return t("catalog.features.sourceObservations.api.route.merge.candidate.split.requires.reason");
    case "update":
      return t("catalog.features.sourceObservations.api.route.merge.candidate.update.requires.reason");
    case "ignore":
      return t("catalog.features.sourceObservations.api.route.merge.candidate.ignore.requires.reason");
    case "defer":
      return t("catalog.features.sourceObservations.api.route.merge.candidate.defer.requires.reason");
  }
}

function conflictResolutions(
  body: Record<string, unknown>,
): readonly CatalogMergeCandidateConflictResolution[] | undefined {
  return Array.isArray(body.conflictResolutions)
    ? (body.conflictResolutions as CatalogMergeCandidateConflictResolution[])
    : undefined;
}
