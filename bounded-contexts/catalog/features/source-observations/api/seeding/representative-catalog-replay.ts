import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { t } from "@chase-sets/localization";
import { toJsonValue, type JsonValue } from "@chase-sets/primitives/json";

import type { CatalogServices } from "../../../../support/authoring-support/services";
import type { ProductAssetSet } from "../../../../support/runtime-support/product-assets";
import { BoundedHttpObjectError, readBoundedHttpObject } from "../providers/bounded-http-object";
import { createCatalogProviderCredentialReadiness } from "../governance/catalog-integration-credential-readiness";
import {
  evolveSourceObservation,
  initialSourceObservationState,
  type SourceObservationEvent,
  type SourceObservationState,
} from "../../domain/domain";
import {
  extractObservationPackImageReferences,
  observationPackEnvelopeContentHash,
  observationPackManifestV1Schema,
  readVerifiedObservationPackEnvelopes,
  sha256,
  stableStringify,
  verifyObservationPack,
  type ObservationPackEnvelope,
  type ObservationPackManifestV1,
  type ObservationPackObjectStorage,
} from "./observation-pack";
import { assertDecodableProductAssetSource } from "./product-asset-normalization";
import type { ProviderAdapter, ProviderImportPlan, ProviderImportScope } from "../provider-adapters/provider-adapter";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";
import {
  requireCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationInput,
} from "../promotion/provider-source-observation-normalizer";
import {
  prepareProviderAdapterSourceObservationPayload,
  requireSourceObservationMappingContract,
  type RepresentativeCatalogProductAssetSource,
  type SourceObservationIntegrationJobScope,
} from "../runtime";

const MAX_PACK_COUNT = 4;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
const MAX_REMOTE_OBJECT_BYTES = 5 * 1024 * 1024 * 1024;
const REMOTE_OBJECT_DEADLINE_MS = 30_000;
const REPRESENTATIVE_CATALOG_PROFILE = "representative-catalog";
const MAX_LOCAL_PACK_FILES = 1_020_000;
const MAX_LOCAL_SOURCE_ENTRIES = MAX_PACK_COUNT * MAX_LOCAL_PACK_FILES;
const MAX_LOCAL_DIRECTORY_DEPTH = 256;

export type RepresentativeCatalogReplayDiagnosticCode =
  | "representative-catalog-pack-source-missing"
  | "representative-catalog-pack-source-invalid"
  | "representative-catalog-pack-contract-invalid"
  | "representative-catalog-pack-not-accepted"
  | "representative-catalog-profile-version-mismatch"
  | "representative-catalog-asset-missing"
  | "representative-catalog-asset-hash-mismatch"
  | "representative-catalog-asset-undecodable"
  | "representative-catalog-asset-reference-ambiguous"
  | "representative-catalog-history-invalid"
  | "representative-catalog-history-invalid-status"
  | "representative-catalog-history-invalid-target"
  | "representative-catalog-history-invalid-profile"
  | "representative-catalog-history-invalid-plan"
  | "representative-catalog-import-failed"
  | "representative-catalog-promotion-failed"
  | "representative-catalog-publication-failed";

export class RepresentativeCatalogReplayError extends Error {
  readonly code: RepresentativeCatalogReplayDiagnosticCode;

  constructor(code: RepresentativeCatalogReplayDiagnosticCode) {
    super(code);
    this.name = "RepresentativeCatalogReplayError";
    this.code = code;
  }
}

export type RepresentativeCatalogPackReplaySummary = Readonly<{
  packId: string;
  packVersion: string;
  manifestKey: string;
  captureContentHash: string;
  providerKey: string;
  envelopeCount: number;
  observationCount: number;
  catalogItemCount: number;
  assetSetCount: number;
  appendedEventCount: number;
  appendedAssetSetCount: number;
  externalReferenceDigest: string;
}>;

export type RepresentativeCatalogReplayReceipt = Readonly<{
  schemaVersion: "representative-catalog-replay.receipt/v1";
  type: "representative-catalog-replay.complete";
  checkedAt: string;
  replayRunIdentity: string;
  packSetIdentity: string;
  replayStateIdentity: string;
  sandbox: RepresentativeCatalogReplaySandboxBinding;
  packs: readonly RepresentativeCatalogPackReplaySummary[];
  totals: Readonly<{
    appendedEventCount: number;
    appendedAssetSetCount: number;
  }>;
}>;

export type RepresentativeCatalogReplaySandboxBinding = Readonly<{
  sandboxId: string;
  postgresPort: number;
  catalogDatabaseName: string;
}>;

type LoadedPackSource = Readonly<{
  storage: Pick<ObservationPackObjectStorage, "getObject">;
  manifestKey: string;
  sourceManifestKey: string;
  listedRelativePaths?: readonly string[];
}>;

type PreflightAsset = RepresentativeCatalogProductAssetSource &
  Readonly<{
    envelopeContentHashes: readonly string[];
    sourceReferenceHash: string;
    sourceReferences: readonly string[];
  }>;

type PreparedObservation = Readonly<{
  envelope: ObservationPackEnvelope;
  observation: CatalogProviderSourceObservationInput;
  asset: PreflightAsset;
  history: SourceObservationState | null;
}>;

type StoredEventRow = Readonly<{
  event_type: string;
  payload: JsonValue;
}>;

export async function replayRepresentativeCatalogPacks(input: {
  services: CatalogServices;
  source: string | null | undefined;
  context: EventStoreContext;
  fetch?: typeof globalThis.fetch;
}): Promise<readonly RepresentativeCatalogPackReplaySummary[]> {
  const sources = await loadPackSources(input.source, input.fetch ?? globalThis.fetch).catch((error) => {
    if (error instanceof RepresentativeCatalogReplayError) {
      throw error;
    }
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
  });
  const summaries: RepresentativeCatalogPackReplaySummary[] = [];
  for (const source of sources) {
    summaries.push(await replayRepresentativeCatalogPack({ ...input, source }));
  }
  return summaries;
}

async function replayRepresentativeCatalogPack(input: {
  services: CatalogServices;
  source: LoadedPackSource;
  context: EventStoreContext;
}): Promise<RepresentativeCatalogPackReplaySummary> {
  const eventCountBefore = await countCatalogEvents(input.services);
  const assetSetCountBefore = await countCatalogProductAssetSets(input.services);
  const verification = await verifyObservationPack({
    storage: input.source.storage,
    manifestKey: input.source.manifestKey,
    requireAccepted: true,
    ...(input.source.listedRelativePaths ? { listedRelativePaths: input.source.listedRelativePaths } : {}),
  }).catch(() => {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
  });
  if (!verification.valid || !verification.replayEligible || !verification.manifest) {
    throw verificationError(verification.diagnostics.map((diagnostic) => diagnostic.code));
  }
  const manifest = verification.manifest;
  const profileVersion = await requireCompatibleActiveProfile(input.services, manifest);
  const envelopes = await readVerifiedObservationPackEnvelopes({
    storage: input.source.storage,
    manifest,
    manifestKey: input.source.manifestKey,
  }).catch(() => {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
  });
  const assets = await preflightAssets(input.source, manifest);
  const prepared = await prepareObservations(input.services, manifest, profileVersion, envelopes, assets);
  const empty = prepared.filter((entry) => entry.history === null);

  if (empty.length > 0) {
    const adapter = createPackBackedProviderAdapter(
      manifest,
      empty.map((entry) => entry.envelope),
    );
    const outcomes = await input.services.sourceObservations.importProviderAdapterForReplay({
      adapter,
      profileVersion,
      scope: integrationScopeFromManifest(manifest),
      context: input.context,
    });
    if (
      outcomes.some((outcome) => outcome.status === "failed") ||
      outcomes.reduce((sum, outcome) => sum + outcome.observed, 0) !== empty.length
    ) {
      throw new RepresentativeCatalogReplayError("representative-catalog-import-failed");
    }
  }

  await drainLocalProjectionHandlerSets("catalog", input.services.pool, input.services.sourceObservations.projectors);

  const catalogItemIds: string[] = [];
  for (const entry of prepared) {
    const detail = await input.services.sourceObservations.getSourceObservationDetail(entry.observation.observationId);
    if (!detail) {
      throw new RepresentativeCatalogReplayError("representative-catalog-import-failed");
    }
    if (detail.status === "promoted" && detail.promoted_catalog_item_id) {
      const reconciled = await input.services.sourceObservations
        .reconcilePromotedObservationForReplay({
          observationId: entry.observation.observationId,
          context: input.context,
          productAssetSource: entry.asset,
        })
        .catch(() => {
          throw new RepresentativeCatalogReplayError("representative-catalog-history-invalid");
        });
      if (entry.history?.status !== "promoted") {
        throw new RepresentativeCatalogReplayError("representative-catalog-history-invalid-status");
      }
      if (entry.history.promotedCatalogItemId !== reconciled.catalogItemId) {
        throw new RepresentativeCatalogReplayError("representative-catalog-history-invalid-target");
      }
      if (
        entry.history.promotionProfileKey !== reconciled.promotionProfileKey ||
        entry.history.promotionProfileVersion !== reconciled.promotionProfileVersion
      ) {
        throw new RepresentativeCatalogReplayError("representative-catalog-history-invalid-profile");
      }
      if (
        entry.history.promotionPlanFingerprint === null ||
        !reconciled.promotionPlanFingerprints.includes(entry.history.promotionPlanFingerprint)
      ) {
        throw new RepresentativeCatalogReplayError("representative-catalog-history-invalid-plan");
      }
      catalogItemIds.push(reconciled.catalogItemId);
      continue;
    }
    const promoted = await input.services.sourceObservations
      .promoteObservation({
        observationId: entry.observation.observationId,
        context: input.context,
        productAssetSource: entry.asset,
      })
      .catch(() => {
        throw new RepresentativeCatalogReplayError("representative-catalog-promotion-failed");
      });
    if (!promoted.catalogItemId) {
      throw new RepresentativeCatalogReplayError("representative-catalog-promotion-failed");
    }
    catalogItemIds.push(promoted.catalogItemId);
  }

  await drainLocalProjectionHandlerSets("catalog", input.services.pool, input.services.projectors);
  const uniqueCatalogItemIds = [...new Set(catalogItemIds)].sort();
  const drafts = await loadDraftCatalogItemIds(input.services, uniqueCatalogItemIds);
  if (drafts.length > 0) {
    const publication = await input.services.items.publishBulk(drafts, input.context);
    if (publication.failed_count > 0 || publication.published_count !== drafts.length) {
      throw new RepresentativeCatalogReplayError("representative-catalog-publication-failed");
    }
    await drainLocalProjectionHandlerSets("catalog", input.services.pool, input.services.items.projectors);
  }

  const evidence = await loadReplayEvidence(input.services, uniqueCatalogItemIds);
  if (
    evidence.length !== uniqueCatalogItemIds.length ||
    evidence.some((item) => item.status !== "active" || item.productAssetSets.length !== 1)
  ) {
    throw new RepresentativeCatalogReplayError("representative-catalog-publication-failed");
  }
  const eventCountAfter = await countCatalogEvents(input.services);
  const assetSetCountAfter = await countCatalogProductAssetSets(input.services);
  return {
    packId: manifest.packId,
    packVersion: manifest.packVersion,
    manifestKey: input.source.sourceManifestKey,
    captureContentHash: manifest.captureContentHash,
    providerKey: manifest.identity.provider.key,
    envelopeCount: envelopes.length,
    observationCount: prepared.length,
    catalogItemCount: evidence.length,
    assetSetCount: evidence.reduce((sum, item) => sum + item.productAssetSets.length, 0),
    appendedEventCount: eventCountAfter - eventCountBefore,
    appendedAssetSetCount: assetSetCountAfter - assetSetCountBefore,
    externalReferenceDigest: representativeCatalogExternalReferenceDigest(evidence),
  };
}

export function buildRepresentativeCatalogReplayReceipt(
  packs: readonly RepresentativeCatalogPackReplaySummary[],
  checkedAt: string,
  sandbox: RepresentativeCatalogReplaySandboxBinding,
): RepresentativeCatalogReplayReceipt {
  const orderedPackIdentity = packs.map(({ packId, packVersion, manifestKey, captureContentHash }) => ({
    packId,
    packVersion,
    manifestKey,
    captureContentHash,
  }));
  const replayState = packs.map(
    ({
      packId,
      packVersion,
      manifestKey,
      captureContentHash,
      providerKey,
      envelopeCount,
      observationCount,
      catalogItemCount,
      assetSetCount,
      externalReferenceDigest,
    }) => ({
      packId,
      packVersion,
      manifestKey,
      captureContentHash,
      providerKey,
      envelopeCount,
      observationCount,
      catalogItemCount,
      assetSetCount,
      externalReferenceDigest,
    }),
  );
  const packSetIdentity = contentIdentity(orderedPackIdentity);
  const replayStateIdentity = contentIdentity(replayState);
  const totals = {
    appendedEventCount: packs.reduce((sum, pack) => sum + pack.appendedEventCount, 0),
    appendedAssetSetCount: packs.reduce((sum, pack) => sum + pack.appendedAssetSetCount, 0),
  };
  const replayRunIdentity = contentIdentity({
    checkedAt,
    sandbox,
    packSetIdentity,
    replayStateIdentity,
    appendDeltas: packs.map(({ manifestKey, appendedEventCount, appendedAssetSetCount }) => ({
      manifestKey,
      appendedEventCount,
      appendedAssetSetCount,
    })),
    totals,
  });
  return {
    schemaVersion: "representative-catalog-replay.receipt/v1",
    type: "representative-catalog-replay.complete",
    checkedAt,
    replayRunIdentity,
    packSetIdentity,
    replayStateIdentity,
    sandbox: { ...sandbox },
    packs: packs.map((pack) => ({ ...pack })),
    totals,
  };
}

async function requireCompatibleActiveProfile(
  services: CatalogServices,
  manifest: ObservationPackManifestV1,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const provider = manifest.identity.provider;
  const active = await services.providerIntegrationProfiles.getActiveProfileVersion(provider.key, {
    profileKey: provider.integrationProfileKey,
    ingestionUnitKey: provider.ingestionUnit as never,
  });
  if (
    !active ||
    active.profileKey !== provider.integrationProfileKey ||
    active.profileVersion !== provider.integrationProfileVersion ||
    catalogProviderProfileVersionIngestionUnitKey(active) !== provider.ingestionUnit
  ) {
    throw new RepresentativeCatalogReplayError("representative-catalog-profile-version-mismatch");
  }
  return active;
}

async function preflightAssets(
  source: LoadedPackSource,
  manifest: ObservationPackManifestV1,
): Promise<readonly PreflightAsset[]> {
  const prefix = objectKeyDirectory(source.manifestKey);
  const assets: PreflightAsset[] = [];
  for (const declared of manifest.assets) {
    const object = await source.storage.getObject(joinObjectKey(prefix, declared.path)).catch(() => null);
    if (!object) {
      throw new RepresentativeCatalogReplayError("representative-catalog-asset-missing");
    }
    if (object.body.byteLength !== declared.byteCount || sha256(object.body) !== declared.contentHash) {
      throw new RepresentativeCatalogReplayError("representative-catalog-asset-hash-mismatch");
    }
    await assertDecodableProductAssetSource(object.body).catch(() => {
      throw new RepresentativeCatalogReplayError("representative-catalog-asset-undecodable");
    });
    assets.push({
      body: object.body,
      contentType: declared.mediaType,
      sourceUrl: null,
      sourceHash: declared.contentHash,
      envelopeContentHashes: declared.envelopeContentHashes,
      sourceReferenceHash: declared.sourceReferenceHash,
      sourceReferences: [],
    });
  }
  return assets;
}

async function prepareObservations(
  services: CatalogServices,
  manifest: ObservationPackManifestV1,
  profileVersion: CatalogProviderIntegrationProfileVersionRecord,
  envelopes: readonly ObservationPackEnvelope[],
  assets: readonly PreflightAsset[],
): Promise<readonly PreparedObservation[]> {
  const contract = requireSourceObservationMappingContract(profileVersion);
  const assetsByEnvelope = new Map<string, PreflightAsset[]>();
  const imageReferencesByEnvelope = new Map(
    envelopes.map((envelope) => [
      observationPackEnvelopeContentHash(envelope),
      extractObservationPackImageReferences(envelope).map((reference) => reference.sourceReference),
    ]),
  );
  for (const asset of assets) {
    const candidateReferences = [
      ...new Set(asset.envelopeContentHashes.flatMap((hash) => imageReferencesByEnvelope.get(hash) ?? [])),
    ].sort();
    const sourceReferences = recoverAssetSourceReferences(candidateReferences, asset.sourceReferenceHash);
    if (sourceReferences.length === 0) {
      throw new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
    }
    const resolvedAsset = { ...asset, sourceReferences };
    for (const envelopeHash of asset.envelopeContentHashes) {
      const current = assetsByEnvelope.get(envelopeHash) ?? [];
      current.push(resolvedAsset);
      assetsByEnvelope.set(envelopeHash, current);
    }
  }

  const prepared: PreparedObservation[] = [];
  for (const envelope of envelopes) {
    const payload = prepareProviderAdapterSourceObservationPayload({
      payload: toJsonValue(envelope.payload),
      providerProfile: profileVersion.profile,
    });
    if (payload.kind === "failure") {
      throw new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
    }
    const observation = requireCatalogProviderSourceObservation({
      contract,
      payload: payload.payload,
      observedAt: envelope.provenance.fetchedAt,
    });
    const envelopeHash = observationPackEnvelopeContentHash(envelope);
    const matchingAssets = assetsByEnvelope.get(envelopeHash) ?? [];
    if (matchingAssets.length === 0) {
      throw new RepresentativeCatalogReplayError("representative-catalog-asset-reference-ambiguous");
    }
    const preferredSourceReferences = preferredObservationImageReferences(observation);
    const selectedAsset =
      preferredSourceReferences
        .map((sourceReference) =>
          matchingAssets.find((candidate) => candidate.sourceReferences.includes(sourceReference)),
        )
        .find((candidate): candidate is PreflightAsset => Boolean(candidate)) ??
      [...matchingAssets].sort((left, right) => compareCanonicalText(left.sourceHash, right.sourceHash))[0]!;
    const sourceUrl =
      preferredSourceReferences.find((reference) => selectedAsset.sourceReferences.includes(reference)) ??
      selectedAsset.sourceReferences[0] ??
      null;
    const asset = { ...selectedAsset, sourceUrl };
    const history = await loadObservationHistory(services, observation);
    prepared.push({ envelope, observation, asset, history });
  }

  if (prepared.length !== manifest.counts.envelopes) {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
  }
  return prepared;
}

function recoverAssetSourceReferences(candidates: readonly string[], expectedHash: string): readonly string[] {
  const hash = (values: readonly string[]) => sha256(new TextEncoder().encode([...values].sort().join("\n")));
  if (hash(candidates) === expectedHash) {
    return candidates;
  }
  const singles = candidates.filter((candidate) => hash([candidate]) === expectedHash);
  if (singles.length === 1) {
    return singles;
  }
  if (candidates.length > 16) {
    return [];
  }
  for (let mask = 1; mask < 2 ** candidates.length; mask += 1) {
    const subset = candidates.filter((_, index) => (mask & (1 << index)) !== 0);
    if (hash(subset) === expectedHash) {
      return subset;
    }
  }
  return [];
}

function preferredObservationImageReferences(observation: CatalogProviderSourceObservationInput): readonly string[] {
  const normalized = observation.normalized;
  return [
    ...(normalized.kind === "pokemon-card" && normalized.imageBaseUrl ? [normalized.imageBaseUrl] : []),
    ...normalized.imageUrls,
  ];
}

async function loadObservationHistory(
  services: CatalogServices,
  expected: CatalogProviderSourceObservationInput,
): Promise<SourceObservationState | null> {
  const rows = await services.db.query<StoredEventRow>(
    `SELECT event_type, payload
     FROM event_store_events
     WHERE stream_id = $1
     ORDER BY stream_version ASC`,
    [`catalog.source-observation-${expected.observationId}`],
  );
  if (rows.rows.length === 0) {
    return null;
  }
  const eventTypes = rows.rows.map((row) => row.event_type);
  if (
    eventTypes[0] !== "catalog.source-observation.recorded" ||
    eventTypes.filter((type) => type === "catalog.source-observation.recorded").length !== 1 ||
    eventTypes.some(
      (type) =>
        type !== "catalog.source-observation.recorded" &&
        type !== "catalog.source-observation.source-payload-chunk-recorded" &&
        type !== "catalog.source-observation.promoted",
    ) ||
    eventTypes.filter((type) => type === "catalog.source-observation.promoted").length > 1 ||
    (eventTypes.includes("catalog.source-observation.promoted") &&
      eventTypes.at(-1) !== "catalog.source-observation.promoted")
  ) {
    throw new RepresentativeCatalogReplayError("representative-catalog-history-invalid");
  }

  let state = initialSourceObservationState;
  try {
    for (const row of rows.rows) {
      state = evolveSourceObservation(state, sourceObservationEvent(row));
    }
  } catch {
    throw new RepresentativeCatalogReplayError("representative-catalog-history-invalid");
  }
  if (
    state.pendingSourcePayloadChunks !== null ||
    state.id !== expected.observationId ||
    state.providerKey !== expected.providerKey ||
    state.externalKey !== expected.externalKey ||
    state.sourceUrl !== expected.sourceUrl ||
    state.languageCode !== expected.languageCode ||
    state.sourceRecordHash !== expected.sourceRecordHash ||
    state.sourceUpdatedAt !== expected.sourceUpdatedAt ||
    state.observedAt !== expected.observedAt ||
    state.sourceProfileKey !== expected.sourceProfileKey ||
    state.sourceProfileVersion !== expected.sourceProfileVersion ||
    state.sourceMappingFingerprint !== expected.sourceMappingFingerprint ||
    !isDeepStrictEqual(state.normalized, expected.normalized) ||
    !isDeepStrictEqual(state.sourcePayload, expected.sourcePayload) ||
    (state.status !== "observed" && state.status !== "promoted")
  ) {
    throw new RepresentativeCatalogReplayError("representative-catalog-history-invalid");
  }
  if (state.status === "promoted" && !state.promotedCatalogItemId) {
    throw new RepresentativeCatalogReplayError("representative-catalog-history-invalid");
  }
  return state;
}

function sourceObservationEvent(row: StoredEventRow): SourceObservationEvent {
  switch (row.event_type) {
    case "catalog.source-observation.recorded":
    case "catalog.source-observation.source-payload-chunk-recorded":
    case "catalog.source-observation.promoted":
      return { type: row.event_type, data: row.payload } as SourceObservationEvent;
    default:
      throw new RepresentativeCatalogReplayError("representative-catalog-history-invalid");
  }
}

function createPackBackedProviderAdapter(
  manifest: ObservationPackManifestV1,
  envelopes: readonly ObservationPackEnvelope[],
): ProviderAdapter {
  const provider = manifest.identity.provider;
  const scope = providerImportScopeFromManifest(manifest);
  return {
    providerKey: provider.key,
    capabilities: {
      supportsOptionQueries: false,
      supportsImportPlanning: true,
      supportsPayloadFetch: true,
    },
    listIntegrationUnits: async () => [
      {
        unitKey: provider.ingestionUnit as never,
        providerKey: provider.key,
        productDomain: manifest.identity.productLine.key,
        productForm: "catalog-item",
        displayName: manifest.identity.set.displayName,
        profileVersion: provider.integrationProfileVersion,
      },
    ],
    listOptions: async () => {
      throw new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
    },
    planImport: async (requested) => {
      if (requested.unitKey !== scope.unitKey || requested.scopeKey !== scope.scopeKey) {
        throw new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
      }
      return {
        unitKey: scope.unitKey,
        planKey: `${REPRESENTATIVE_CATALOG_PROFILE}:${manifest.captureContentHash}`,
        scope,
        estimatedPayloads: envelopes.length,
        transportSteps: ["observation-pack-cache"],
      };
    },
    fetchPayloads: async function* (plan: ProviderImportPlan, options) {
      if (plan.planKey !== `${REPRESENTATIVE_CATALOG_PROFILE}:${manifest.captureContentHash}`) {
        throw new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
      }
      let completed = 0;
      for (const envelope of envelopes) {
        completed += 1;
        await options?.onProgress?.({
          phase: "fetching",
          completed,
          total: envelopes.length,
          currentLabel: null,
        });
        yield envelope;
      }
    },
    getCredentialReadiness: async () => [
      createCatalogProviderCredentialReadiness({
        providerKey: provider.key,
        unitKey: provider.ingestionUnit as never,
        requirement: "not-required",
        sourceKind: "none",
        state: "not-required",
        message: t(
          "catalog.features.sourceObservations.api.providerAdapters.representativeCatalog.credential.not.required",
        ),
        checkedAt: null,
        evidence: { source: "accepted-observation-pack" },
      }),
    ],
    getTransportDiagnostics: async () => [],
  };
}

function providerImportScopeFromManifest(manifest: ObservationPackManifestV1): ProviderImportScope {
  return {
    unitKey: manifest.identity.provider.ingestionUnit as never,
    scopeKey: manifest.identity.scope.scopeKey,
    values: Object.fromEntries(manifest.identity.scope.coordinates.map(({ key, value }) => [key, value])),
  };
}

function integrationScopeFromManifest(manifest: ObservationPackManifestV1): SourceObservationIntegrationJobScope {
  const coordinates = Object.fromEntries(manifest.identity.scope.coordinates.map(({ key, value }) => [key, value]));
  return {
    provider: manifest.identity.provider.key,
    profileKey: manifest.identity.provider.integrationProfileKey,
    ingestionUnitKey: manifest.identity.provider.ingestionUnit,
    language: manifest.identity.language,
    ...(coordinates.seriesId ? { seriesId: coordinates.seriesId } : {}),
    ...((coordinates.setId ?? coordinates.expansionId ?? coordinates.setCode)
      ? { setId: coordinates.setId ?? coordinates.expansionId ?? coordinates.setCode }
      : {}),
    ...(coordinates.productLineId ? { productLineId: coordinates.productLineId } : {}),
    ...(coordinates.setName ? { setName: coordinates.setName } : {}),
    ...((coordinates.productId ?? coordinates.cardId)
      ? { productId: coordinates.productId ?? coordinates.cardId }
      : {}),
  };
}

async function loadDraftCatalogItemIds(services: CatalogServices, itemIds: readonly string[]): Promise<string[]> {
  if (itemIds.length === 0) {
    return [];
  }
  const result = await services.db.query<Readonly<{ catalog_item_id: string }>>(
    "SELECT catalog_item_id FROM catalog_items WHERE catalog_item_id = ANY($1::text[]) AND status = 'draft'",
    [itemIds],
  );
  return result.rows.map((row) => row.catalog_item_id).sort();
}

type ReplayEvidenceRow = Readonly<{
  catalogItemId: string;
  status: string;
  externalReferences: readonly Readonly<{ providerKey: string; externalKey: string }>[];
  productAssetSets: readonly ProductAssetSet[];
}>;

async function loadReplayEvidence(
  services: CatalogServices,
  itemIds: readonly string[],
): Promise<readonly ReplayEvidenceRow[]> {
  if (itemIds.length === 0) {
    return [];
  }
  const result = await services.db.query<
    Readonly<{
      catalog_item_id: string;
      status: string;
      external_references: unknown;
      product_asset_sets: unknown;
    }>
  >(
    `SELECT
       item.catalog_item_id,
       item.status,
       item.product_asset_sets,
       COALESCE(
         (
           SELECT jsonb_agg(
             jsonb_build_object(
               'providerKey', reference.provider_key,
               'externalKey', reference.external_key
             )
             ORDER BY reference.provider_key, reference.external_key
           )
           FROM catalog_external_catalog_item_references AS reference
           WHERE reference.catalog_item_id = item.catalog_item_id
         ),
         '[]'::jsonb
       ) AS external_references
     FROM catalog_items AS item
     WHERE item.catalog_item_id = ANY($1::text[])
     ORDER BY item.catalog_item_id`,
    [itemIds],
  );
  return result.rows.map((row) => ({
    catalogItemId: row.catalog_item_id,
    status: row.status,
    externalReferences: Array.isArray(row.external_references)
      ? (row.external_references as ReplayEvidenceRow["externalReferences"])
      : [],
    productAssetSets: Array.isArray(row.product_asset_sets)
      ? (row.product_asset_sets as readonly ProductAssetSet[])
      : [],
  }));
}

export function representativeCatalogExternalReferenceDigest(items: readonly ReplayEvidenceRow[]): string {
  const rows = items
    .flatMap((item) =>
      item.externalReferences.map((reference) => ({
        providerKey: reference.providerKey,
        externalKey: reference.externalKey,
        assetSourceHashes: item.productAssetSets.map((assetSet) => assetSet.sourceHash).sort(),
      })),
    )
    .sort((left, right) =>
      `${left.providerKey}:${left.externalKey}`.localeCompare(`${right.providerKey}:${right.externalKey}`),
    );
  return `sha256:${createHash("sha256").update(JSON.stringify(rows)).digest("hex")}`;
}

async function countCatalogEvents(services: CatalogServices): Promise<number> {
  const result = await services.db.query<Readonly<{ count: string }>>(
    "SELECT COUNT(*) AS count FROM event_store_events",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function countCatalogProductAssetSets(services: CatalogServices): Promise<number> {
  const result = await services.db.query<Readonly<{ count: string }>>(
    `SELECT COALESCE(SUM(jsonb_array_length(product_asset_sets)), 0)::text AS count
     FROM catalog_items`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

function contentIdentity(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function verificationError(codes: readonly string[]): RepresentativeCatalogReplayError {
  if (codes.includes("captured-not-accepted") || codes.includes("lifecycle-invalid")) {
    return new RepresentativeCatalogReplayError("representative-catalog-pack-not-accepted");
  }
  if (codes.includes("missing-asset")) {
    return new RepresentativeCatalogReplayError("representative-catalog-asset-missing");
  }
  if (codes.includes("asset-hash-mismatch")) {
    return new RepresentativeCatalogReplayError("representative-catalog-asset-hash-mismatch");
  }
  return new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
}

async function loadPackSources(
  sourceValue: string | null | undefined,
  fetcher: typeof globalThis.fetch,
): Promise<readonly LoadedPackSource[]> {
  const source = sourceValue?.trim();
  if (!source) {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-missing");
  }
  if (/^https:\/\//i.test(source)) {
    const urls = source
      .split(/[\n,]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (urls.length === 0 || urls.length > MAX_PACK_COUNT || urls.some((value) => !isHttpsUrl(value))) {
      throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
    }
    return Promise.all(urls.map((url) => remotePackSource(url, fetcher)));
  }
  if (/^[a-z]+:\/\//i.test(source)) {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
  }
  return localPackSources(path.resolve(source));
}

async function localPackSources(root: string): Promise<readonly LoadedPackSource[]> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
  }
  if (!rootStat.isDirectory()) {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
  }
  const manifests: string[] = [];
  await findLocalManifests(root, "", manifests, { count: 0 }, 0);
  if (manifests.length === 0 || manifests.length > MAX_PACK_COUNT) {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
  }
  return Promise.all(
    manifests.sort(compareCanonicalText).map(async (relativeManifest) => {
      const packRoot = path.dirname(path.join(root, ...relativeManifest.split("/")));
      const manifestBody = await readBoundedLocalFile(
        path.join(packRoot, path.basename(relativeManifest)),
        MAX_MANIFEST_BYTES,
      );
      const manifest = parseManifest(manifestBody);
      const expectedSizes = expectedObjectSizes(manifest);
      const listedRelativePaths = await listLocalPackFiles(packRoot, "", { count: 0 }, 0);
      return {
        manifestKey: "manifest.json",
        sourceManifestKey: relativeManifest,
        listedRelativePaths,
        storage: {
          getObject: (key: string) => readLocalPackObject(packRoot, key, expectedSizes),
        },
      };
    }),
  );
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function findLocalManifests(
  root: string,
  current: string,
  manifests: string[],
  visited: { count: number },
  depth: number,
): Promise<void> {
  if (depth > MAX_LOCAL_DIRECTORY_DEPTH) {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
  }
  const directory = path.join(root, ...current.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareCanonicalText(left.name, right.name))) {
    visited.count += 1;
    if (visited.count > MAX_LOCAL_SOURCE_ENTRIES) {
      throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
    }
    if (entry.isSymbolicLink()) {
      throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
    }
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await findLocalManifests(root, relative, manifests, visited, depth + 1);
    } else if (entry.isFile() && entry.name === "manifest.json") {
      manifests.push(relative);
      if (manifests.length > MAX_PACK_COUNT) {
        throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
      }
    }
  }
}

async function listLocalPackFiles(
  root: string,
  current: string,
  visited: { count: number },
  depth: number,
): Promise<string[]> {
  if (depth > MAX_LOCAL_DIRECTORY_DEPTH) {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
  }
  const directory = path.join(root, ...current.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareCanonicalText(left.name, right.name))) {
    visited.count += 1;
    if (visited.count > MAX_LOCAL_PACK_FILES) {
      throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
    }
    if (entry.isSymbolicLink()) {
      throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
    }
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listLocalPackFiles(root, relative, visited, depth + 1)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

async function readLocalPackObject(
  root: string,
  key: string,
  expectedSizes: ReadonlyMap<string, number>,
): Promise<Readonly<{ body: Uint8Array; contentType: string }> | null> {
  const safeKey = safeObjectKey(key);
  const file = path.resolve(root, ...safeKey.split("/"));
  if (!isWithinRoot(root, file)) {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
  }
  let fileStat;
  try {
    fileStat = await lstat(file);
  } catch {
    return null;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    return null;
  }
  const limit = expectedSizes.get(safeKey) ?? MAX_MANIFEST_BYTES;
  if (fileStat.size > limit) {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
  }
  const body = new Uint8Array(await readFile(file));
  return { body, contentType: contentTypeForKey(key) };
}

async function readBoundedLocalFile(file: string, limit: number): Promise<Uint8Array> {
  const fileStat = await lstat(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > limit) {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
  }
  return new Uint8Array(await readFile(file));
}

async function remotePackSource(manifestUrl: string, fetcher: typeof globalThis.fetch): Promise<LoadedPackSource> {
  const base = new URL(".", manifestUrl);
  const cache = new Map<string, Readonly<{ body: Uint8Array; contentType: string }>>();
  const manifestBody = await readRemoteObject(fetcher, manifestUrl, MAX_MANIFEST_BYTES);
  const manifest = parseManifest(manifestBody.body);
  const expectedSizes = expectedObjectSizes(manifest);
  cache.set("manifest.json", manifestBody);
  return {
    manifestKey: "manifest.json",
    sourceManifestKey: new URL(manifestUrl).pathname.replace(/^\/+/u, ""),
    storage: {
      getObject: async (key) => {
        const safeKey = safeObjectKey(key);
        const cached = cache.get(safeKey);
        if (cached) {
          return cached;
        }
        const limit = expectedSizes.get(safeKey) ?? MAX_REMOTE_OBJECT_BYTES;
        const object = await readRemoteObject(fetcher, new URL(safeKey, base).href, limit).catch((error) => {
          if (error instanceof BoundedHttpObjectError && error.code === "not-found") {
            return null;
          }
          throw error;
        });
        if (object) {
          cache.set(safeKey, object);
        }
        return object;
      },
    },
  };
}

async function readRemoteObject(
  fetcher: typeof globalThis.fetch,
  url: string,
  maxBytes: number,
): Promise<Readonly<{ body: Uint8Array; contentType: string }>> {
  try {
    return await readBoundedHttpObject({
      fetch: fetcher,
      url,
      maxBytes,
      deadlineMs: REMOTE_OBJECT_DEADLINE_MS,
      accept: "application/json,image/*;q=0.9,*/*;q=0.1",
    });
  } catch (error) {
    if (error instanceof BoundedHttpObjectError && error.code === "not-found") {
      throw error;
    }
    if (error instanceof BoundedHttpObjectError && error.code === "response-too-large") {
      throw new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
    }
    if (error instanceof RepresentativeCatalogReplayError) {
      throw error;
    }
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
  }
}

function parseManifest(body: Uint8Array): ObservationPackManifestV1 {
  try {
    return observationPackManifestV1Schema.parse(JSON.parse(new TextDecoder().decode(body)) as unknown);
  } catch {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-contract-invalid");
  }
}

function expectedObjectSizes(manifest: ObservationPackManifestV1): ReadonlyMap<string, number> {
  return new Map([
    ["manifest.json", MAX_MANIFEST_BYTES],
    ...manifest.entries.map((entry) => [entry.path, entry.byteCount] as const),
    ...manifest.assets.map((asset) => [asset.path, asset.byteCount] as const),
  ]);
}

function safeObjectKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.length > 512 ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    /^[a-z]:/i.test(normalized)
  ) {
    throw new RepresentativeCatalogReplayError("representative-catalog-pack-source-invalid");
  }
  return normalized;
}

function joinObjectKey(prefix: string, relative: string): string {
  return safeObjectKey(prefix ? `${prefix}/${relative}` : relative);
}

function objectKeyDirectory(key: string): string {
  const normalized = safeObjectKey(key);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentTypeForKey(key: string): string {
  const extension = path.extname(key).toLowerCase();
  if (extension === ".json") return "application/json";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".gif") return "image/gif";
  if (extension === ".avif") return "image/avif";
  return "application/octet-stream";
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
