import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import {
  CatalogProviderProfileSectionValidationError,
  parseCatalogProviderProfileSectionUpdateCommand,
} from "./provider-profile-admin-contracts";
import {
  activateCatalogProviderProfileVersionForReview,
  CatalogProviderProfileActivationValidationError,
  cloneCatalogProviderProfileVersionForReview,
  createCatalogProviderProfileVersionForReview,
  deprecateCatalogProviderProfileVersionForReview,
  dryRunCatalogProviderProfileVersion,
  getCatalogProviderProfileAuthoringModel,
  listCatalogProviderProfileVersionReviews,
  retireCatalogProviderProfileVersionForReview,
  rollbackCatalogProviderProfileVersionForReview,
  updateCatalogProviderProfileSectionForReview,
  updateCatalogProviderProfileVersionForReview,
  CatalogProviderProfileLifecycleConsistencyError,
  type CatalogProviderProfileLifecycleBlockingJob,
} from "./provider-profile-review";
import type { CatalogProviderIntegrationProfileVersionRecord } from "./provider-integration-profiles";
import type {
  BulkReviewJobServices,
  CatalogIntegrationEngineServices,
  IntegrationJobServices,
  ProviderProfileAdminServices,
  SourceObservationBulkJob,
  SourceObservationIntegrationJob,
} from "./runtime";
import { authoringAuditFromContext, isRecord, readJsonObject, toJsonValue } from "./route-helpers";

export type ProviderProfileRouteServices = ProviderProfileAdminServices &
  Partial<Pick<CatalogIntegrationEngineServices, "previewDuplicatePreventionCandidates">> &
  Partial<Pick<IntegrationJobServices, "listActiveIntegrationJobs">> &
  Partial<Pick<BulkReviewJobServices, "listActiveBulkReviewJobs">>;

export function providerProfileRoutes(
  services: ProviderProfileRouteServices,
  profileVersions?: CatalogProviderIntegrationProfileVersionStore,
) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/provider-profiles", async (c) => {
    const items = profileVersions ? await listCatalogProviderProfileVersionReviews(profileVersions) : [];
    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/provider-profiles", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const body = await readJsonObject(c);
    if (body instanceof Response) {
      return body;
    }
    const result = await createCatalogProviderProfileVersionForReview({
      store: profileVersions,
      version: body.version as CatalogProviderIntegrationProfileVersionRecord,
      audit: authoringAuditFromContext(c.get("context")),
    });

    return c.json(result, 201);
  });

  app.get("/provider-profiles/:providerKey/:profileVersion/authoring", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const result = await getCatalogProviderProfileAuthoringModel({
      store: profileVersions,
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      selectedOptionSchema: await services.getSelectedOptionAuthoringSchema(),
      promotionTargetSchema: await services.getPromotionTargetAuthoringSchema(),
    });

    return c.json(result);
  });

  app.patch("/provider-profiles/:providerKey/:profileVersion", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const body = await readJsonObject(c);
    if (body instanceof Response) {
      return body;
    }
    if (!isRawProfilePatchQuarantineAccepted(body)) {
      return c.json(rawProfilePatchQuarantinedError(), 403);
    }
    let result;
    try {
      result = await updateCatalogProviderProfileVersionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        patch: body.patch as never,
        audit: authoringAuditFromContext(c.get("context")),
        activeJobs: await listProfileLifecycleBlockingJobs(services, c.get("context")),
      });
    } catch (error) {
      return lifecycleConsistencyErrorResponse(c, error);
    }

    return c.json(result);
  });

  app.patch("/provider-profiles/:providerKey/:profileVersion/sections/:section", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const body = await readJsonObject(c);
    if (body instanceof Response) {
      return body;
    }

    try {
      const commandBody = isRecord(body.command) ? body.command : body;
      const command = parseCatalogProviderProfileSectionUpdateCommand(commandBody, c.req.param("section"));
      const result = await updateCatalogProviderProfileSectionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        command,
        audit: authoringAuditFromContext(c.get("context")),
        activeJobs: await listProfileLifecycleBlockingJobs(services, c.get("context")),
      });

      return c.json(result);
    } catch (error) {
      if (error instanceof CatalogProviderProfileLifecycleConsistencyError) {
        return lifecycleConsistencyErrorResponse(c, error);
      }
      if (!(error instanceof CatalogProviderProfileSectionValidationError)) {
        throw error;
      }

      return c.json(
        {
          error: {
            code: "invalid_profile_section_command",
            message: error.message,
          },
        },
        400,
      );
    }
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/dry-run", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const body = await readJsonObject(c);
    if (body instanceof Response) {
      return body;
    }
    const result = await dryRunCatalogProviderProfileVersion({
      store: profileVersions,
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      payload: toJsonValue(body.payload),
      observedAt: new Date(0).toISOString(),
    });

    const duplicatePreventionCandidatePreview = await services.previewDuplicatePreventionCandidates?.({
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      payload: toJsonValue(body.payload),
      observedAt: new Date(0).toISOString(),
    });

    return c.json({
      ...result,
      duplicatePreventionCandidatePreview:
        duplicatePreventionCandidatePreview ?? result.duplicatePreventionCandidatePreview,
    });
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/activate", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    let result;
    try {
      result = await activateCatalogProviderProfileVersionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        activeJobs: await listProfileLifecycleBlockingJobs(services, c.get("context")),
      });
    } catch (error) {
      if (error instanceof CatalogProviderProfileLifecycleConsistencyError) {
        return lifecycleConsistencyErrorResponse(c, error);
      }
      if (!(error instanceof CatalogProviderProfileActivationValidationError)) {
        throw error;
      }

      return c.json(
        {
          error: {
            code: "profile_activation_blocked",
            message: error.message,
            diagnostics: error.diagnostics,
          },
        },
        400,
      );
    }

    return c.json(result);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/clone", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const body = await readJsonObject(c);
    if (body instanceof Response) {
      return body;
    }
    const result = await cloneCatalogProviderProfileVersionForReview({
      store: profileVersions,
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      targetProfileVersion: String(body.targetProfileVersion ?? ""),
      lifecycle: body.lifecycle === "test" ? "test" : "draft",
      audit: authoringAuditFromContext(c.get("context")),
    });

    return c.json(result, 201);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/rollback", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    let result;
    try {
      result = await rollbackCatalogProviderProfileVersionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        activeJobs: await listProfileLifecycleBlockingJobs(services, c.get("context")),
      });
    } catch (error) {
      return lifecycleConsistencyErrorResponse(c, error);
    }

    return c.json(result);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/retire", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    let result;
    try {
      result = await retireCatalogProviderProfileVersionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        audit: authoringAuditFromContext(c.get("context")),
        activeJobs: await listProfileLifecycleBlockingJobs(services, c.get("context")),
      });
    } catch (error) {
      return lifecycleConsistencyErrorResponse(c, error);
    }

    return c.json(result);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/deprecate", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    let result;
    try {
      result = await deprecateCatalogProviderProfileVersionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        activeJobs: await listProfileLifecycleBlockingJobs(services, c.get("context")),
      });
    } catch (error) {
      return lifecycleConsistencyErrorResponse(c, error);
    }

    return c.json(result);
  });

  return app;
}

async function listProfileLifecycleBlockingJobs(
  services: ProviderProfileRouteServices,
  context: CatalogAuthoringEnv["Variables"]["context"],
): Promise<readonly CatalogProviderProfileLifecycleBlockingJob[]> {
  const [integrationJobs, bulkJobs] = await Promise.all([
    services.listActiveIntegrationJobs?.({ context }) ?? Promise.resolve([]),
    services.listActiveBulkReviewJobs?.({ context }) ?? Promise.resolve([]),
  ]);

  return [
    ...integrationJobs.map(integrationJobToLifecycleBlockingJob),
    ...bulkJobs.map(bulkReviewJobToLifecycleBlockingJob),
  ];
}

function integrationJobToLifecycleBlockingJob(
  job: SourceObservationIntegrationJob,
): CatalogProviderProfileLifecycleBlockingJob {
  return {
    jobId: job.jobId,
    jobKind: "integration",
    action: job.action,
    status: job.status,
    providerKey: job.profileSnapshot?.providerKey ?? job.scope.provider ?? null,
    profileVersion: job.profileSnapshot?.profileVersion ?? null,
  };
}

function bulkReviewJobToLifecycleBlockingJob(
  job: SourceObservationBulkJob,
): CatalogProviderProfileLifecycleBlockingJob {
  return {
    jobId: job.jobId,
    jobKind: "bulk-review",
    action: job.action,
    status: job.status,
    providerKey: job.scope.provider ?? null,
    profileVersion: null,
  };
}

function lifecycleConsistencyErrorResponse(c: Context<CatalogAuthoringEnv>, error: unknown): Response {
  if (!(error instanceof CatalogProviderProfileLifecycleConsistencyError)) {
    throw error;
  }

  return c.json(
    {
      error: {
        code: error.code,
        message: error.message,
        blockingJobs: error.blockingJobs,
      },
    },
    409,
  );
}

function isRawProfilePatchQuarantineAccepted(body: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(body, "patch") || !isRecord(body.patch)) {
    return false;
  }

  const quarantine = body.rawJsonQuarantine;
  return (
    isRecord(quarantine) &&
    quarantine.ownerIssue === 789 &&
    typeof quarantine.reason === "string" &&
    quarantine.reason.trim().length > 0 &&
    quarantine.retirementCondition === "section-scoped-typed-commands-complete"
  );
}

function rawProfilePatchQuarantinedError() {
  return {
    error: {
      code: "raw_profile_patch_quarantined",
      message: t("catalog.features.sourceObservations.api.route.profile.review.raw.patch.quarantined"),
      ownerIssue: 789,
      requiredQuarantine: {
        rawJsonQuarantine: {
          ownerIssue: 789,
          reason: "Controlled internal compatibility or migration operation.",
          retirementCondition: "section-scoped-typed-commands-complete",
        },
      },
    },
  };
}
