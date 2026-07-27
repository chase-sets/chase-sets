import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import type { CatalogProviderIntegrationProfileVersionStore } from "../providers/provider-integration-profile-store";
import {
  CatalogProviderProfileSectionValidationError,
  parseCatalogProviderProfileSectionUpdateCommand,
} from "../admin/provider-profile-admin-contracts";
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
  CatalogProviderProfileLifecycleConsistencyError,
  CatalogProviderProfileVersionNotFoundError,
  type CatalogProviderProfileLifecycleBlockingJob,
} from "../providers/provider-profile-review";
import type {
  CatalogProviderIntegrationProfileVersionRecord,
  CatalogProviderProfileVersionSelector,
} from "../provider-integration-profiles";
import type {
  BulkReviewJobServices,
  CatalogIntegrationEngineServices,
  IntegrationJobServices,
  ProviderProfileAdminServices,
  SourceObservationBulkJob,
  SourceObservationIntegrationJob,
} from "../runtime";
import { authoringAuditFromContext, isRecord, readJsonObject, toJsonValue } from "./route-helpers";
import {
  CatalogIntegrationRolloutControlError,
  rolloutControlErrorResponse,
  type CatalogIntegrationRolloutControlPolicy,
} from "../governance/catalog-integration-rollout-controls";
import { requireCatalogIntegrationControlPlanePermission } from "../admin/admin-control-plane-rbac";

export type ProviderProfileRouteServices = ProviderProfileAdminServices &
  Partial<Pick<CatalogIntegrationEngineServices, "previewDuplicatePreventionCandidates">> &
  Pick<CatalogIntegrationEngineServices, "previewProviderProfileLifecycleImpact"> &
  Partial<Pick<IntegrationJobServices, "listActiveIntegrationJobs">> &
  Partial<Pick<BulkReviewJobServices, "listActiveBulkReviewJobs">> &
  Partial<Pick<CatalogIntegrationEngineServices, "assertCatalogIntegrationRolloutAllowed">>;

export function providerProfileRoutes(
  services: ProviderProfileRouteServices,
  profileVersions?: CatalogProviderIntegrationProfileVersionStore,
) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/provider-profiles", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-profile-read");
    if (permissionError) {
      return permissionError;
    }

    const items = profileVersions ? await listCatalogProviderProfileVersionReviews(profileVersions) : [];
    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/provider-profiles", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-profile-author");
    if (permissionError) {
      return permissionError;
    }

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
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-profile-read");
    if (permissionError) {
      return permissionError;
    }

    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    try {
      const result = await getCatalogProviderProfileAuthoringModel({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        ...profileVersionSelectorFromRequest(c),
        selectedOptionSchema: await services.getSelectedOptionAuthoringSchema(),
        promotionTargetSchema: await services.getPromotionTargetAuthoringSchema(),
      });

      return c.json(result);
    } catch (error) {
      if (error instanceof CatalogProviderProfileVersionNotFoundError) {
        return c.json({ error: { code: error.code, message: error.message } }, 404);
      }
      throw error;
    }
  });

  app.patch("/provider-profiles/:providerKey/:profileVersion/sections/:section", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-profile-author");
    if (permissionError) {
      return permissionError;
    }

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
        ...profileVersionSelectorFromRequest(c),
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
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-profile-dry-run");
    if (permissionError) {
      return permissionError;
    }

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
      ...profileVersionSelectorFromRequest(c),
      payload: toJsonValue(body.payload),
      observedAt: new Date(0).toISOString(),
    });

    const duplicatePreventionCandidatePreview = await services.previewDuplicatePreventionCandidates?.({
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      ...profileVersionSelectorFromRequest(c),
      payload: toJsonValue(body.payload),
      observedAt: new Date(0).toISOString(),
    });

    return c.json({
      ...result,
      duplicatePreventionCandidatePreview:
        duplicatePreventionCandidatePreview ?? result.duplicatePreventionCandidatePreview,
    });
  });

  app.get("/provider-profiles/:providerKey/:profileVersion/lifecycle-impact", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-profile-read");
    if (permissionError) {
      return permissionError;
    }

    const operation = parseLifecycleImpactOperation(c.req.query("operation"));
    if (!operation) {
      return c.json(
        {
          error: {
            code: "invalid_lifecycle_impact_operation",
            message: t("catalog.features.sourceObservations.api.route.impact.lifecycle.operation.invalid"),
          },
        },
        400,
      );
    }

    const result = await services.previewProviderProfileLifecycleImpact({
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      ...profileVersionSelectorFromRequest(c),
      operation,
      context: c.get("context"),
    });

    return c.json(result);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/activate", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-profile-lifecycle");
    if (permissionError) {
      return permissionError;
    }

    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    let result;
    try {
      await assertActivationRolloutAllowed(services, profileVersions, {
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        ...profileVersionSelectorFromRequest(c),
      });
      result = await activateCatalogProviderProfileVersionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        ...profileVersionSelectorFromRequest(c),
        activeJobs: await listProfileLifecycleBlockingJobs(services, c.get("context")),
      });
    } catch (error) {
      if (error instanceof CatalogIntegrationRolloutControlError) {
        return c.json(rolloutControlErrorResponse(error), 403);
      }
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
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-profile-author");
    if (permissionError) {
      return permissionError;
    }

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
      ...profileVersionSelectorFromRequest(c),
      targetProfileVersion: String(body.targetProfileVersion ?? ""),
      lifecycle: body.lifecycle === "test" ? "test" : "draft",
      audit: authoringAuditFromContext(c.get("context")),
    });

    return c.json(result, 201);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/rollback", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-profile-lifecycle");
    if (permissionError) {
      return permissionError;
    }

    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    let result;
    try {
      result = await rollbackCatalogProviderProfileVersionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        ...profileVersionSelectorFromRequest(c),
        activeJobs: await listProfileLifecycleBlockingJobs(services, c.get("context")),
      });
    } catch (error) {
      return lifecycleConsistencyErrorResponse(c, error);
    }

    return c.json(result);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/retire", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-profile-lifecycle");
    if (permissionError) {
      return permissionError;
    }

    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    let result;
    try {
      result = await retireCatalogProviderProfileVersionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        ...profileVersionSelectorFromRequest(c),
        audit: authoringAuditFromContext(c.get("context")),
        activeJobs: await listProfileLifecycleBlockingJobs(services, c.get("context")),
      });
    } catch (error) {
      return lifecycleConsistencyErrorResponse(c, error);
    }

    return c.json(result);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/deprecate", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "provider-profile-lifecycle");
    if (permissionError) {
      return permissionError;
    }

    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    let result;
    try {
      result = await deprecateCatalogProviderProfileVersionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        ...profileVersionSelectorFromRequest(c),
        activeJobs: await listProfileLifecycleBlockingJobs(services, c.get("context")),
      });
    } catch (error) {
      return lifecycleConsistencyErrorResponse(c, error);
    }

    return c.json(result);
  });

  return app;
}

function parseLifecycleImpactOperation(value: string | undefined) {
  return value === "activation" || value === "rollback" || value === "deprecate" || value === "retire" ? value : null;
}

async function assertActivationRolloutAllowed(
  services: Readonly<{
    assertCatalogIntegrationRolloutAllowed?: CatalogIntegrationRolloutControlPolicy["assertAllowed"];
  }>,
  profileVersions: CatalogProviderIntegrationProfileVersionStore,
  input: Readonly<{ providerKey: string; profileVersion: string } & CatalogProviderProfileVersionSelector>,
): Promise<void> {
  if (!services.assertCatalogIntegrationRolloutAllowed) {
    return;
  }

  const version = await profileVersions.getProfileVersion(input.providerKey, input.profileVersion, input);
  services.assertCatalogIntegrationRolloutAllowed({
    capability: "activation",
    providerKey: input.providerKey,
    profileKey: version?.profileKey ?? null,
    profileVersion: input.profileVersion,
    profileLifecycle: version?.lifecycle ?? null,
  });
}

function profileVersionSelectorFromRequest(c: Context<CatalogAuthoringEnv>): CatalogProviderProfileVersionSelector {
  const profileKey = c.req.query("profileKey")?.trim();
  const ingestionUnitKey = (c.req.query("ingestionUnitKey") ?? c.req.query("unitKey"))?.trim();
  return {
    ...(profileKey ? { profileKey } : {}),
    ...(ingestionUnitKey ? { ingestionUnitKey } : {}),
  };
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
