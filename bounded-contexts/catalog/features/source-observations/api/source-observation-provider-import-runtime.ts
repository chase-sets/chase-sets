import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { isDurableJobHandoffError } from "@chase-sets/platform-runtime/durable-job-store";
import { toJsonValue, type JsonValue } from "@chase-sets/primitives/json";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { CatalogItemServices } from "../../catalog-items/api/runtime";
import type { ReferenceDataServices } from "../../reference-data/api/runtime";
import { isPokemonCardSourceObservationNormalized } from "../domain/domain";
import { type TcgdexObservationPayload } from "./tcgdex-client";
import { ingestTcgdexAliasCandidates } from "./tcgdex-alias-intake";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  type CatalogProviderIntegrationProfile,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import {
  catalogProviderSourceMappingFingerprint,
  requireCatalogProviderSourceObservation,
} from "./provider-source-observation-normalizer";
import { ProviderAdapterRegistry } from "./provider-adapters/registry";
import { createTcgdexProviderAdapter } from "./provider-adapters/tcgdex";
import { createTcgplayerProviderAdapter } from "./provider-adapters/tcgplayer";
import type {
  ProviderAdapter,
  ProviderImportPlan,
  ProviderPayloadEnvelope,
} from "./provider-adapters/provider-adapter";
import {
  listCatalogProviderIntegrationOptionsFromProfiles,
  type CatalogProviderIntegrationOption,
} from "./provider-option-query-resolver";
import type {
  SourceObservationAliasCandidateSink,
  SourceObservationIntegrationJobOutcome,
  SourceObservationRecordInput,
  DurableSideEffectRunner,
  SourceObservationIntegrationJobScope,
  ProviderAdapterIntegrationImportTarget,
  ProviderIntegrationImportTargetOptionScope,
  SourceObservationIntegrationImportPreviewTarget,
  ProviderAdapterImportProgress,
  SourceObservationCommandServices,
} from "./source-observation-runtime-contracts";
import { providerOptionAliasesToJson } from "./provider-option-queries";
import {
  SourceObservationJobCancelledError,
  integrationImportPreviewTargetFromPlan,
  providerUsageEvidenceFromImportPlan,
} from "./source-observation-job-serialization";
import {
  prepareProviderAdapterSourceObservationPayload,
  requireSourceObservationMappingContract,
} from "./source-observation-promotion-execution";
import { ensurePokemonReferenceHierarchy } from "./source-observation-promotion-reference-hierarchy";
import { sourceObservationStreamId } from "./source-observation-stream-identity";
import type { SourceObservationMergeCandidateRuntime } from "./source-observation-merge-candidate-runtime";

export type SourceObservationProviderImportRuntimeDeps = Readonly<{
  deps: CatalogRuntimeDeps;
  items: CatalogItemServices;
  referenceData: ReferenceDataServices;
  aliasCandidateSink: SourceObservationAliasCandidateSink;
  commandHandler: SourceObservationCommandServices["commandHandler"];
  providerAdapterRegistry: ProviderAdapterRegistry;
  mergeCandidates: Pick<
    SourceObservationMergeCandidateRuntime,
    "persistCatalogMergeCandidatesFromObservations" | "sourceObservationRecordToCandidateRow"
  >;
}>;

/**
 * Provider-adapter import: resolve the import targets a profile version covers,
 * fetch and normalize each target through its executable mapping contract, and
 * record the resulting Source Observations plus their merge candidates and
 * alias candidates. Driven by both the integration-job turns and the
 * representative-catalog replay engine.
 */
export function createSourceObservationProviderImportRuntime({
  deps,
  items,
  referenceData,
  aliasCandidateSink,
  commandHandler,
  providerAdapterRegistry,
  mergeCandidates,
}: SourceObservationProviderImportRuntimeDeps) {
  const { persistCatalogMergeCandidatesFromObservations, sourceObservationRecordToCandidateRow } = mergeCandidates;

  async function recordObservation(observation: SourceObservationRecordInput, context: EventStoreContext) {
    await commandHandler({
      streamId: sourceObservationStreamId(observation.observationId),
      command: {
        type: "RecordSourceObservation",
        ...observation,
      },
      context,
    });
  }

  async function resolveProviderAdapterImportTargets(
    scope: SourceObservationIntegrationJobScope,
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord,
  ): Promise<readonly ProviderAdapterIntegrationImportTarget[]> {
    const languageCode = scope.language || "en";
    const providerProfile = providerProfileVersion.profile;
    const unitKey = catalogProviderProfileVersionIngestionUnitKey(providerProfileVersion);
    const productId = scope.productId || null;
    if (productId) {
      if (providerProfile.supportedScopes.includes("product")) {
        return [
          {
            targetId: `product:${productId}`,
            name: `Product ${productId}`,
            scopeKey: "product",
            values: { productId, productName: `Product ${productId}`, languageCode },
            languageCode,
          },
        ];
      }

      if (providerProfile.normalizedObservationMapping.kind.endsWith("sealed-product")) {
        return [
          {
            targetId: `sealed:${productId}`,
            name: `Sealed product ${productId}`,
            scopeKey: "single-sealed-product",
            values: { sealedProductId: productId, languageCode },
            languageCode,
          },
        ];
      }

      return [
        {
          targetId: `card:${productId}`,
          name: `Card ${productId}`,
          scopeKey: "single-card",
          values: { cardId: productId, languageCode },
          languageCode,
        },
      ];
    }

    const expansionId = scope.setId?.trim() || null;
    if (expansionId && supportsImportTargetOptionScope(providerProfile, "expansion")) {
      return [
        {
          targetId: expansionId,
          name: scope.setName || expansionId,
          scopeKey: "expansion",
          values: {
            languageCode,
            setId: expansionId,
            expansionId,
            seriesId: scope.seriesId?.trim() ?? "",
          },
          languageCode,
        },
      ];
    }

    if (!expansionId && supportsImportTargetOptionScope(providerProfile, "expansion")) {
      const options = await listProviderImportTargetOptions({
        providerProfileVersion,
        queryScope: "expansion",
        languageCode,
        parentValue: scope.seriesId?.trim() || null,
        unitKey,
      });
      return options.map((option) => ({
        targetId: option.value,
        name: option.label,
        scopeKey: "expansion",
        values: {
          languageCode,
          setId: option.value,
          expansionId: option.value,
          seriesId: option.parentValue ?? scope.seriesId?.trim() ?? "",
        },
        languageCode,
      }));
    }

    const scopedSetName = scope.setName?.trim() || scope.setId?.trim() || null;
    const usesProductLineSetNames = providerProfile.supportedScopes.includes("product-line/category");
    if (scopedSetName && usesProductLineSetNames && supportsImportTargetOptionScope(providerProfile, "set-name")) {
      const productLine = await resolveProductLineImportParent(scope, providerProfileVersion, unitKey);
      return [
        {
          targetId: `set:${productLine.productLineId}:${scopedSetName}`,
          name: scopedSetName,
          scopeKey: "set-name",
          values: {
            productLineId: productLine.productLineId,
            productLineName: productLine.productLineName,
            setName: scopedSetName,
            cleanSetName: scopedSetName,
            languageCode,
          },
          languageCode,
        },
      ];
    }

    if (!scopedSetName && usesProductLineSetNames && supportsImportTargetOptionScope(providerProfile, "set-name")) {
      const productLine = await resolveProductLineImportParent(scope, providerProfileVersion, unitKey);
      const options = await listProviderImportTargetOptions({
        providerProfileVersion,
        queryScope: "set-name",
        languageCode,
        parentValue: productLine.productLineId,
        unitKey,
      });
      return options
        .filter((option) => option.metadata.active !== false)
        .map((option) => {
          const setName =
            option.metadata.cleanSetName === undefined ? option.value : String(option.metadata.cleanSetName);
          return {
            targetId: `set:${productLine.productLineId}:${setName}`,
            name: option.label || setName,
            scopeKey: "set-name",
            values: {
              productLineId: productLine.productLineId,
              productLineName: productLine.productLineName,
              setName,
              cleanSetName: setName,
              languageCode,
            },
            languageCode,
          };
        });
    }

    const setCode = scope.setId || scope.setName || null;
    if (setCode) {
      return [
        {
          targetId: `set:${setCode}`,
          name: scope.setName || setCode,
          scopeKey: "set",
          values: {
            setCode,
            setId: setCode,
            expansionId: setCode,
            ...(scope.setName ? { setName: scope.setName } : {}),
            languageCode,
          },
          languageCode,
        },
      ];
    }

    throw new Error(
      `Provider '${providerProfileVersion.providerKey}' integration unit '${unitKey}' import requires a set code or card id.`,
    );
  }

  function supportsImportTargetOptionScope(
    profile: CatalogProviderIntegrationProfile,
    queryScope: ProviderIntegrationImportTargetOptionScope,
  ): boolean {
    return profile.optionQueries.some((query) => query.scope === queryScope);
  }

  async function listProviderImportTargetOptions(input: {
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
    queryScope: ProviderIntegrationImportTargetOptionScope;
    languageCode: string;
    parentValue: string | null;
    unitKey: string;
  }): Promise<readonly CatalogProviderIntegrationOption[]> {
    const query = input.providerProfileVersion.profile.optionQueries.find(
      (candidate) => candidate.scope === input.queryScope,
    );
    if (!query) {
      throw new Error(
        `Provider '${input.providerProfileVersion.providerKey}' profile '${input.providerProfileVersion.profileKey}' does not declare a ${input.queryScope} import target query.`,
      );
    }

    const adapter = providerAdapterForProfileVersion(input.providerProfileVersion);
    const result = await adapter.listOptions({
      unitKey: input.unitKey,
      optionKind: query.queryKind,
      parentValues: {
        languageCode: input.languageCode,
        parentValue: input.parentValue ?? "",
        seriesId: input.queryScope === "expansion" ? (input.parentValue ?? "") : "",
        productLineId: input.queryScope === "set-name" ? (input.parentValue ?? "") : "",
      },
    });

    const records = result.items.map((item) => ({
      value: item.value,
      label: item.label,
      parentValue: item.parentValue ?? input.parentValue ?? null,
      aliases: providerOptionAliasesToJson(item.aliases),
      ...item.metadata,
    }));

    return listCatalogProviderIntegrationOptionsFromProfiles({
      profiles: [input.providerProfileVersion.profile],
      providerKey: input.providerProfileVersion.providerKey,
      queryKind: query.queryKind,
      languageCode: input.languageCode,
      parentValue: input.parentValue,
      defaultProviderKey: input.providerProfileVersion.providerKey,
      transports: {
        listTcgdexExpansions: async () => records,
        listTcgplayerSetNames: async () => records,
      },
    });
  }

  async function resolveProductLineImportParent(
    scope: SourceObservationIntegrationJobScope,
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord,
    unitKey: string,
  ): Promise<Readonly<{ productLineId: string; productLineName: string }>> {
    const productLineId = scope.productLineId?.trim() || scope.seriesId?.trim() || null;
    if (!productLineId) {
      throw new Error(
        `Provider '${providerProfileVersion.providerKey}' set-name import requires productLineId/categoryId or productId.`,
      );
    }

    const query = providerProfileVersion.profile.optionQueries.find(
      (candidate) => candidate.scope === "product-line/category",
    );
    if (!query) {
      return { productLineId, productLineName: productLineId };
    }

    const adapter = providerAdapterForProfileVersion(providerProfileVersion);
    const result = await adapter.listOptions({ unitKey, optionKind: query.queryKind });
    const option = result.items.find((item) => String(item.value).trim() === productLineId);
    if (!option) {
      throw new Error(`Provider product line '${productLineId}' was not found.`);
    }

    const productLineName = option.metadata?.productLineName?.trim() || option.label || productLineId;
    return { productLineId, productLineName };
  }

  async function previewProviderAdapterIntegrationImportTargets(
    scope: SourceObservationIntegrationJobScope,
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord,
  ): Promise<readonly SourceObservationIntegrationImportPreviewTarget[]> {
    const adapter = providerAdapterForProfileVersion(providerProfileVersion);
    const targets = await resolveProviderAdapterImportTargets(scope, providerProfileVersion);
    return Promise.all(
      targets.map(async (target) => {
        const plan = await adapter.planImport({
          unitKey: catalogProviderProfileVersionIngestionUnitKey(providerProfileVersion),
          scopeKey: target.scopeKey,
          values: target.values,
        });
        return integrationImportPreviewTargetFromPlan({
          targetId: target.targetId,
          name: target.name,
          languageCode: target.languageCode,
          plan,
        });
      }),
    );
  }

  async function importProviderAdapterIntegrationTarget(input: {
    target: ProviderAdapterIntegrationImportTarget;
    providerProfile: CatalogProviderIntegrationProfile;
    providerProfileVersion: CatalogProviderIntegrationProfileVersionRecord;
    syncRunId?: string | null;
    context: EventStoreContext;
    onProgress?: (progress: ProviderAdapterImportProgress) => void | Promise<void>;
    beforeRecordObservation?: () => Promise<void>;
    runRecordObservation?: DurableSideEffectRunner;
    adapterOverride?: ProviderAdapter;
    observedAtForEnvelope?: (envelope: ProviderPayloadEnvelope) => string;
  }): Promise<SourceObservationIntegrationJobOutcome> {
    let providerUsagePlan: ProviderImportPlan | null = null;
    const providerUsageRequestKeys = new Set<string>();
    try {
      const adapter = input.adapterOverride ?? providerAdapterForProfileVersion(input.providerProfileVersion);
      const unitKey = catalogProviderProfileVersionIngestionUnitKey(input.providerProfileVersion);
      const plan = await adapter.planImport({
        unitKey,
        scopeKey: input.target.scopeKey,
        values: input.target.values,
      });
      providerUsagePlan = plan;
      const contract = requireSourceObservationMappingContract(input.providerProfileVersion);
      const importObservedAt = new Date().toISOString();
      const estimatedPayloads = plan.estimatedPayloads ?? 1;
      let observed = 0;
      const payloadFailures: string[] = [];
      const recordedObservations: Array<Readonly<{ observation: SourceObservationRecordInput; payload: JsonValue }>> =
        [];

      for await (const envelope of adapter.fetchPayloads(plan, {
        onProgress: (progress) =>
          input.onProgress?.({
            currentName: progress.currentLabel ?? input.target.name,
            completed: progress.completed,
            total: progress.total,
          }),
      })) {
        const observedAt = input.observedAtForEnvelope?.(envelope) ?? importObservedAt;
        const providerRequestKey = envelope.provenance.sourceUrl?.trim();
        if (providerRequestKey) {
          providerUsageRequestKeys.add(providerRequestKey);
        }
        const preparedPayload = prepareProviderAdapterSourceObservationPayload({
          payload: toJsonValue(envelope.payload),
          providerProfile: input.providerProfile,
        });
        if (preparedPayload.kind === "failure") {
          payloadFailures.push(preparedPayload.reason);
          continue;
        }
        await input.beforeRecordObservation?.();
        const observation = requireCatalogProviderSourceObservation({
          contract,
          payload: preparedPayload.payload,
          observedAt,
        });
        if (observed === 0 && isPokemonCardSourceObservationNormalized(observation.normalized)) {
          await ensurePokemonReferenceHierarchy({
            deps,
            referenceData,
            profile: input.providerProfile,
            normalized: observation.normalized,
            context: input.context,
          });
        }
        const writeObservation = () =>
          recordObservation({ ...observation, syncRunId: input.syncRunId ?? null }, input.context);
        if (input.runRecordObservation) {
          await input.runRecordObservation(writeObservation);
        } else {
          await writeObservation();
        }
        recordedObservations.push({
          observation: { ...observation, syncRunId: input.syncRunId ?? null },
          payload: preparedPayload.payload,
        });
        observed += 1;
        await input.onProgress?.({
          currentName: input.target.name,
          completed: observed,
          total: Math.max(estimatedPayloads, observed),
        });
      }

      await ingestAliasCandidatesForImportedTarget({
        providerProfile: input.providerProfile,
        contract,
        recordedObservations,
        observedAt: importObservedAt,
      });

      if (input.syncRunId && recordedObservations.length > 0) {
        await persistCatalogMergeCandidatesFromObservations(
          recordedObservations.map((recorded) => sourceObservationRecordToCandidateRow(recorded.observation)),
          input.context,
        );
      }

      return {
        providerKey: input.providerProfile.providerKey,
        languageCode: input.target.languageCode,
        expansionId: input.target.targetId,
        status: payloadFailures.length > 0 ? "failed" : observed > 0 ? "imported" : "skipped",
        observed,
        reapplied: 0,
        reason:
          payloadFailures.length > 0
            ? payloadFailureReason(payloadFailures, observed, input.providerProfile.displayName)
            : observed > 0
              ? null
              : `No provider payloads found for ${input.target.name}.`,
        providerUsageEvidence: providerUsageEvidenceFromImportPlan(plan, providerUsageRequestKeys),
      };
    } catch (error) {
      if (error instanceof SourceObservationJobCancelledError || isDurableJobHandoffError(error)) {
        throw error;
      }

      return {
        providerKey: input.providerProfile.providerKey,
        languageCode: input.target.languageCode,
        expansionId: input.target.targetId,
        status: "failed",
        observed: 0,
        reapplied: 0,
        reason: error instanceof Error ? error.message : "Provider adapter import failed.",
        providerUsageEvidence: providerUsagePlan
          ? providerUsageEvidenceFromImportPlan(providerUsagePlan, providerUsageRequestKeys)
          : null,
      };
    }
  }

  function providerAdapterForProfileVersion(
    profileVersion: CatalogProviderIntegrationProfileVersionRecord,
  ): ProviderAdapter<unknown> {
    if (profileVersion.active) {
      return providerAdapterRegistry.require(profileVersion.providerKey);
    }

    if (profileVersion.profile.connector.kind === "tcgdex-json") {
      return createTcgdexProviderAdapter({ loadActiveProfileVersion: async () => profileVersion });
    }

    if (profileVersion.profile.connector.kind === "tcgplayer-automation-client") {
      return createTcgplayerProviderAdapter({
        loadProfileVersions: async () => [profileVersion],
        client: deps.tcgplayerAutomationCatalogClient,
      });
    }

    return providerAdapterRegistry.require(profileVersion.providerKey);
  }

  function payloadFailureReason(failures: readonly string[], observed: number, providerDisplayName: string): string {
    const failureText = failures.length === 1 ? failures[0] : `${failures.length} product details failed.`;
    return observed > 0
      ? `Imported ${observed} ${providerDisplayName} product details before ${failureText}`
      : failureText;
  }

  async function ingestAliasCandidatesForImportedTarget(input: {
    providerProfile: CatalogProviderIntegrationProfile;
    contract: ReturnType<typeof requireSourceObservationMappingContract>;
    recordedObservations: readonly Readonly<{ observation: SourceObservationRecordInput; payload: JsonValue }>[];
    observedAt: string;
  }): Promise<void> {
    if (!input.providerProfile.capabilities.includes("alias-candidate-extraction")) {
      return;
    }

    if (input.providerProfile.connector.kind !== "tcgdex-json") {
      return;
    }

    await ingestTcgdexAliasCandidates({
      profile: input.providerProfile,
      observations: input.recordedObservations.map((recorded) => ({
        observationId: recorded.observation.observationId,
        sourceProfileKey: input.contract.profileKey,
        sourceProfileVersion: input.contract.profileVersion,
        mappingFingerprint: catalogProviderSourceMappingFingerprint(input.contract),
        payload: recorded.payload as TcgdexObservationPayload["payload"],
      })),
      persist: aliasCandidateSink,
      observedAt: input.observedAt,
    });
  }

  return {
    resolveProviderAdapterImportTargets,
    previewProviderAdapterIntegrationImportTargets,
    importProviderAdapterIntegrationTarget,
  };
}

export type SourceObservationProviderImportRuntime = ReturnType<typeof createSourceObservationProviderImportRuntime>;
