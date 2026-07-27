import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { type JsonValue } from "@chase-sets/primitives/json";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemId } from "../../../ids";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ProductContentServices } from "../../product-contents/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import {
  getSourceObservationDetail,
  summarizeSourceObservationLifecycleImpact,
  summarizeSourceObservationReplayImpact,
  type SourceObservationFilterScope,
} from "../read-model/queries";
import {
  getCatalogProviderIntegrationProfileVersion,
  type CatalogProviderIntegrationProfileVersionRecord,
  type CatalogProviderProfileVersionSelector,
} from "./provider-integration-profiles";
import { normalizeCatalogProviderSourceObservation } from "./provider-source-observation-normalizer";
import { createCatalogIntegrationDryRunProofRegistry } from "./catalog-integration-dry-run-proofs";
import { type CatalogIntegrationRolloutControlPolicy } from "./catalog-integration-rollout-controls";
import {
  buildCatalogLifecycleImpactReadModel,
  buildCatalogReplayReapplyImpactReadModel,
  toCatalogAdminProfileVersionPointer,
  unitKeyForCatalogProviderProfileVersion,
  type CatalogIntegrationImpactJobSample,
} from "./catalog-integration-impact-analysis";
import type {
  CatalogAdminReplayReapplyImpactSummaryReadModel,
  CatalogAdminRollbackRetirementImpactSummaryReadModel,
} from "./admin-control-plane-read-model-contracts";
import { ProviderAdapterRegistry } from "./provider-adapters/registry";
import { resolveCatalogProviderDuplicatePrevention } from "./provider-duplicate-prevention-resolver";
import type {
  CatalogProviderIntegrationProfileVersionReader,
  SourceObservationIntegrationJobOutcome,
  SourceObservationDuplicatePreventionCandidatePreview,
  CatalogIntegrationEngineServices,
  SourceObservationBulkReviewJobStore,
  SourceObservationIntegrationJobStore,
} from "./source-observation-runtime-contracts";
import {
  notEvaluatedDuplicatePreventionPreview,
  duplicatePreventionCandidatePreview,
  buildCatalogIntegrationControlPlaneReadiness,
} from "./catalog-integration-control-plane-readiness";
import {
  profileSelectorFromScope,
  jobMatchesContext,
  toSourceObservationIntegrationJob,
  isImpactBlockingJob,
  impactJobProviderKey,
  toSourceObservationBulkJob,
} from "./source-observation-job-serialization";
import {
  createCatalogDraftFromObservation,
  loadCatalogItemPromotionProfile,
  refreshCatalogItemFromObservation,
  requireCatalogItemPromotionObservation,
  requireCatalogPromotionProfileVersion,
  requirePromotionAssetPorts,
  requireSourceObservationMappingContract,
} from "./source-observation-promotion-execution";
import type { SourceObservationProviderImportRuntime } from "./source-observation-provider-import-runtime";

export type SourceObservationIntegrationEngineRuntimeDeps = Readonly<{
  deps: CatalogRuntimeDeps;
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  productContents: ProductContentServices | null;
  profileVersions: CatalogProviderIntegrationProfileVersionReader;
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy;
  providerAdapterRegistry: ProviderAdapterRegistry;
  dryRunProofRegistry: ReturnType<typeof createCatalogIntegrationDryRunProofRegistry>;
  bulkReviewJobStore: SourceObservationBulkReviewJobStore;
  integrationJobStore: SourceObservationIntegrationJobStore;
  providerImport: Pick<
    SourceObservationProviderImportRuntime,
    "resolveProviderAdapterImportTargets" | "importProviderAdapterIntegrationTarget"
  >;
}>;

/**
 * Catalog integration engine facet: duplicate-prevention and profile-lifecycle
 * impact previews, control-plane readiness/rollout surfaces, and the two replay
 * entry points the representative-catalog replay harness drives.
 */
export function createSourceObservationIntegrationEngineRuntime({
  deps,
  items,
  referenceData,
  productContents,
  profileVersions,
  rolloutControlPolicy,
  providerAdapterRegistry,
  dryRunProofRegistry,
  bulkReviewJobStore,
  integrationJobStore,
  providerImport,
}: SourceObservationIntegrationEngineRuntimeDeps) {
  const { resolveProviderAdapterImportTargets, importProviderAdapterIntegrationTarget } = providerImport;

  async function previewDuplicatePreventionCandidates(input: {
    providerKey: string;
    profileVersion: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    payload: JsonValue;
    observedAt?: string;
  }): Promise<SourceObservationDuplicatePreventionCandidatePreview> {
    const version = getCatalogProviderIntegrationProfileVersion(
      input.providerKey,
      input.profileVersion,
      profileSelectorFromScope(input),
      await profileVersions.listProfileVersions(input.providerKey),
    );
    if (!version) {
      return notEvaluatedDuplicatePreventionPreview(
        `Catalog provider profile version ${input.providerKey}@${input.profileVersion} was not found.`,
      );
    }

    try {
      const contract = requireSourceObservationMappingContract(version);
      const normalization = normalizeCatalogProviderSourceObservation({
        contract,
        payload: input.payload,
        observedAt: input.observedAt ?? new Date(0).toISOString(),
      });
      if (!normalization.observation) {
        return notEvaluatedDuplicatePreventionPreview("Source Observation normalization did not complete.");
      }

      const normalized = requireCatalogItemPromotionObservation(
        normalization.observation.normalized,
        input.providerKey,
      );
      const catalogMapping = await loadCatalogItemPromotionProfile(deps, version.profile);
      const result = await resolveCatalogProviderDuplicatePrevention({
        db: deps.db,
        profile: version.profile,
        providerKey: input.providerKey,
        externalKey: normalization.observation.externalKey,
        normalized,
        catalog: {
          blueprintId: catalogMapping.blueprintId,
          categoryId: catalogMapping.categoryId,
          fieldIds: catalogMapping.fieldIds,
        },
      });

      return duplicatePreventionCandidatePreview(result);
    } catch (error) {
      return notEvaluatedDuplicatePreventionPreview(
        error instanceof Error ? error.message : "Duplicate-prevention candidate preview failed.",
      );
    }
  }

  async function previewReplayReapplyImpact(input: {
    providerKey: string;
    profileVersion: string;
    scope: SourceObservationFilterScope;
    context?: EventStoreContext | null;
  }): Promise<CatalogAdminReplayReapplyImpactSummaryReadModel> {
    const version = await requireCatalogImpactProfileVersion(input.providerKey, input.profileVersion);
    const impact = await summarizeSourceObservationReplayImpact(deps.db, {
      ...input.scope,
      provider: input.providerKey,
    });
    const activeJobs = await listCatalogIntegrationImpactActiveJobs({
      providerKey: input.providerKey,
      profileVersion: input.profileVersion,
      context: input.context ?? null,
    });

    return buildCatalogReplayReapplyImpactReadModel({
      unitKey: unitKeyForCatalogProviderProfileVersion(version),
      profile: toCatalogAdminProfileVersionPointer(version),
      impact,
      activeJobs,
    });
  }

  async function previewProviderProfileLifecycleImpact(input: {
    providerKey: string;
    profileVersion: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    operation: CatalogAdminRollbackRetirementImpactSummaryReadModel["operation"];
    context?: EventStoreContext | null;
  }): Promise<CatalogAdminRollbackRetirementImpactSummaryReadModel> {
    const version = await requireCatalogImpactProfileVersion(
      input.providerKey,
      input.profileVersion,
      profileSelectorFromScope(input),
    );
    const [impact, activeJobs] = await Promise.all([
      summarizeSourceObservationLifecycleImpact(deps.db, {
        providerKey: input.providerKey,
        profileVersion: input.profileVersion,
        operation: input.operation,
      }),
      listCatalogIntegrationImpactActiveJobs({
        providerKey: input.providerKey,
        profileVersion: input.profileVersion,
        context: input.context ?? null,
      }),
    ]);

    return buildCatalogLifecycleImpactReadModel({
      unitKey: unitKeyForCatalogProviderProfileVersion(version),
      profile: toCatalogAdminProfileVersionPointer(version),
      operation: input.operation,
      impact,
      activeJobs,
    });
  }

  async function requireCatalogImpactProfileVersion(
    providerKey: string,
    profileVersion: string,
    selector?: CatalogProviderProfileVersionSelector | null,
  ): Promise<CatalogProviderIntegrationProfileVersionRecord> {
    const version = getCatalogProviderIntegrationProfileVersion(
      providerKey,
      profileVersion,
      selector,
      await profileVersions.listProfileVersions(providerKey),
    );
    if (!version) {
      throw new Error(`Catalog provider profile version ${providerKey}@${profileVersion} was not found.`);
    }

    return version;
  }

  async function listCatalogIntegrationImpactActiveJobs(input: {
    providerKey: string;
    profileVersion: string;
    context: EventStoreContext | null;
  }): Promise<readonly CatalogIntegrationImpactJobSample[]> {
    const [integrationJobs, bulkJobs] = await Promise.all([
      integrationJobStore.listActive({ jobKinds: ["import", "reapply"] }),
      bulkReviewJobStore.listActive({ jobKinds: ["promote", "reject", "reapply"] }),
    ]);
    const providerKey = input.providerKey.trim().toLowerCase();

    return [
      ...integrationJobs
        .filter((job) => !input.context || jobMatchesContext(job, input.context))
        .map(toSourceObservationIntegrationJob)
        .filter((job) => isImpactBlockingJob(job.status, job.action))
        .filter((job) => impactJobProviderKey(job)?.trim().toLowerCase() === providerKey)
        .map((job) => ({
          jobId: job.jobId,
          jobKind: "integration" as const,
          action: job.action,
          status: job.status,
          providerKey: impactJobProviderKey(job),
          profileVersion: job.profileSnapshot?.profileVersion ?? null,
        })),
      ...bulkJobs
        .filter((job) => !input.context || jobMatchesContext(job, input.context))
        .map(toSourceObservationBulkJob)
        .filter((job) => isImpactBlockingJob(job.status, job.action))
        .filter((job) => {
          const jobProviderKey = job.scope.provider?.trim().toLowerCase() ?? null;
          return !jobProviderKey || jobProviderKey === providerKey;
        })
        .map((job) => ({
          jobId: job.jobId,
          jobKind: "bulk-review" as const,
          action: job.action,
          status: job.status,
          providerKey: job.scope.provider ?? null,
          profileVersion: null,
        })),
    ];
  }

  const services: CatalogIntegrationEngineServices = {
    previewDuplicatePreventionCandidates,
    previewReplayReapplyImpact,
    previewProviderProfileLifecycleImpact,
    getCatalogIntegrationControlPlaneReadiness: async () =>
      buildCatalogIntegrationControlPlaneReadiness(providerAdapterRegistry, dryRunProofRegistry, rolloutControlPolicy),
    getCatalogIntegrationRolloutControls: () => rolloutControlPolicy.snapshot(),
    assertCatalogIntegrationRolloutAllowed: rolloutControlPolicy.assertAllowed,
    importProviderAdapterForReplay: async ({ adapter, profileVersion, scope, context }) => {
      const targets = await resolveProviderAdapterImportTargets(scope, profileVersion);
      const outcomes: SourceObservationIntegrationJobOutcome[] = [];
      for (const target of targets) {
        outcomes.push(
          await importProviderAdapterIntegrationTarget({
            target,
            providerProfile: profileVersion.profile,
            providerProfileVersion: profileVersion,
            context,
            adapterOverride: adapter,
            observedAtForEnvelope: (envelope) => envelope.provenance.fetchedAt,
          }),
        );
      }
      return outcomes;
    },
    reconcilePromotedObservationForReplay: async ({ observationId, context, productAssetSource }) => {
      const observation = await getSourceObservationDetail(deps.db, observationId);
      if (!observation || observation.status !== "promoted" || !observation.promoted_catalog_item_id) {
        throw new Error("Replay reconciliation requires a promoted Catalog Item observation.");
      }
      rolloutControlPolicy.assertAllowed({ capability: "promotion", providerKey: observation.provider_key });
      const normalized = requireCatalogItemPromotionObservation(observation.normalized, observation.provider_key);
      const providerProfileVersion = await requireCatalogPromotionProfileVersion(
        profileVersions,
        observation.provider_key,
        normalized,
      );
      const providerProfile = providerProfileVersion.profile;
      requirePromotionAssetPorts({ deps, normalized, productAssetSource });
      const catalogItemId = observation.promoted_catalog_item_id as CatalogItemId;
      const planningInput = {
        items,
        referenceData,
        productContents,
        deps,
        catalogItemId,
        normalized,
        providerKey: observation.provider_key,
        externalKey: observation.external_key,
        providerProfile,
        providerProfileVersion,
        catalogMapping: await loadCatalogItemPromotionProfile(deps, providerProfile),
        sourceUpdatedAt: observation.source_updated_at,
        observedAt: observation.observed_at,
        productAssetSource,
        context,
        executeCommands: false,
      } as const;
      const createEvidence = await createCatalogDraftFromObservation(planningInput);
      const refreshEvidence = await refreshCatalogItemFromObservation(planningInput);
      return {
        catalogItemId,
        promotionProfileKey: providerProfileVersion.profileKey,
        promotionProfileVersion: providerProfileVersion.profileVersion,
        promotionPlanFingerprints: [createEvidence.promotionPlanFingerprint, refreshEvidence.promotionPlanFingerprint],
      };
    },
  };

  return { services };
}
