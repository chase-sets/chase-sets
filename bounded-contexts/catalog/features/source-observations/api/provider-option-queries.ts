import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { type JsonValue } from "@chase-sets/primitives/json";
import { type SourceObservationFilterScope } from "../read-model/queries";
import {
  type TcgdexExpansionOption,
  type TcgdexLanguageOption,
  type TcgdexObservationPayload,
  type TcgdexSeriesOption,
} from "./tcgdex-client";
import { type TcgplayerAutomationCatalogClient } from "./tcgplayer-automation-catalog-client";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  type CatalogProviderIntegrationProfileVersionRecord,
  type CatalogProviderProfileVersionSelector,
} from "./provider-integration-profiles";
import {
  CatalogIntegrationRolloutControlError,
  type CatalogIntegrationRolloutControlPolicy,
} from "./catalog-integration-rollout-controls";
import { ProviderAdapterRegistry } from "./provider-adapters/registry";
import { createReferenceCardsProviderAdapter } from "./provider-adapters/reference-cards";
import {
  createTcgdexProviderAdapter,
  TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./provider-adapters/tcgdex";
import {
  createTcgplayerProviderAdapter,
  TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  type TcgplayerProviderPayload,
} from "./provider-adapters/tcgplayer";
import {
  createMtgjsonProviderAdapter,
  MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  type MtgjsonProviderPayload,
} from "./provider-adapters/mtgjson";
import {
  createLorcanajsonProviderAdapter,
  LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  type LorcanajsonProviderPayload,
} from "./provider-adapters/lorcanajson";
import {
  createLorcastProviderAdapter,
  LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  type LorcastProviderPayload,
} from "./provider-adapters/lorcast";
import {
  createScryfallProviderAdapter,
  SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  type ScryfallProviderPayload,
} from "./provider-adapters/scryfall";
import {
  createYgoprodeckProviderAdapter,
  YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  type YgoprodeckProviderPayload,
} from "./provider-adapters/ygoprodeck";
import {
  createYgojsonProviderAdapter,
  YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
  YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
  type YgojsonProviderPayload,
} from "./provider-adapters/ygojson";
import {
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  type ScrydexOnePieceCredentials,
  type ScrydexOnePieceProviderPayload,
} from "./provider-adapters/scrydex-one-piece";
import type { ProviderAdapter, ProviderOptionAlias } from "./provider-adapters/provider-adapter";
import { listCatalogProviderIntegrationOptionsFromProfiles } from "./provider-option-query-resolver";
import {
  createPgCatalogProviderOptionQueryCacheStore,
  queryCatalogProviderIntegrationOptionsWithCache,
  type CatalogProviderOptionQueryPage,
} from "./provider-option-query-cache";
import {
  normalizeCatalogControlPlaneTelemetryEvent,
  type SourceObservationTelemetry,
} from "./catalog-integration-observability";
import { staticCatalogProviderIntegrationProfileVersions } from "./source-observation-runtime-contracts";
import type {
  SourceObservationIntegrationJobAction,
  SourceObservationBulkJobAction,
  SourceObservationIntegrationJobResult,
  SourceObservationBulkWorkUnitResult,
  SourceObservationIntegrationJobScope,
  SourceObservationIntegrationProfileSnapshot,
  CatalogProviderIntegrationProfileVersionReader,
  SourceObservationIntegrationOption,
} from "./source-observation-runtime-contracts";
import {
  isActiveProviderOptionQueryProfileVersion,
  normalizeIntegrationKey,
  isActiveSourceObservationImportProfileVersion,
} from "./catalog-integration-control-plane-readiness";
import type {
  ClaimedSourceObservationIntegrationJob,
  ClaimedSourceObservationBulkJob,
} from "./source-observation-job-serialization";

export function recordIntegrationJobTelemetry(
  telemetry: SourceObservationTelemetry | undefined,
  jobKind: SourceObservationIntegrationJobAction,
  result: "completed" | "failed" | "skipped" | "cancelled" | "released" | "reconciled",
): void {
  telemetry?.recordIntegrationJob?.({ jobKind, result });
}

export function recordBulkReviewWorkUnitTelemetry(
  telemetry: SourceObservationTelemetry | undefined,
  jobKind: SourceObservationBulkJobAction,
  result: "completed" | "failed" | "skipped" | "cancelled" | "released" | "reconciled",
): void {
  telemetry?.recordBulkReviewWorkUnit?.({ jobKind, result });
}

export function recordIntegrationJobControlPlaneTelemetry(
  telemetry: SourceObservationTelemetry | undefined,
  job: ClaimedSourceObservationIntegrationJob,
  result: SourceObservationIntegrationJobResult | null,
  fallbackResult?: "failed",
): void {
  if (job.action !== "import") {
    return;
  }

  const failed = fallbackResult === "failed" || (result?.failed ?? 0) > 0;
  telemetry?.recordControlPlaneEvent?.(
    normalizeCatalogControlPlaneTelemetryEvent({
      eventName: failed ? "catalog_control_plane.import_failed" : "catalog_control_plane.import_completed",
      providerKey: job.scope.provider ?? job.profileSnapshot?.providerKey ?? null,
      scopeId: integrationScopeTelemetryRef(job.scope),
      profileRef: integrationProfileTelemetryRef(job.profileSnapshot),
      jobRefState: "present",
      observationStatus: result ? "mixed" : "unknown",
      observationCount: result?.observed ?? result?.imported ?? null,
      promotionResult: failed ? "failed" : "completed",
      blockerCategory: failed ? "provider-transport" : null,
      roleBucket: "unknown",
    }),
  );
}

export function recordBulkReviewControlPlaneTelemetry(
  telemetry: SourceObservationTelemetry | undefined,
  job: ClaimedSourceObservationBulkJob,
  outcome: SourceObservationBulkWorkUnitResult,
): void {
  if (job.action !== "promote") {
    return;
  }

  const failed = outcome.status === "failed";
  telemetry?.recordControlPlaneEvent?.(
    normalizeCatalogControlPlaneTelemetryEvent({
      eventName: failed ? "catalog_control_plane.promotion_failed" : "catalog_control_plane.promotion_completed",
      providerKey: job.scope.provider ?? null,
      scopeId: promotionScopeTelemetryRef(job.scope),
      jobRefState: "present",
      observationStatus: failed ? "unknown" : "promoted",
      observationCount: 1,
      promotionResult: failed ? "failed" : "completed",
      promotionCount: failed ? 0 : 1,
      blockerCategory: failed ? "promotion-conflict" : null,
      roleBucket: "unknown",
    }),
  );
}

export function sourceObservationIntegrationJobTelemetryResult(
  result: SourceObservationIntegrationJobResult,
): "completed" | "failed" | "skipped" {
  if (result.failed > 0) {
    return "failed";
  }
  if (result.skipped > 0 && result.observed === 0 && result.reapplied === 0) {
    return "skipped";
  }
  return "completed";
}

export function integrationScopeTelemetryRef(scope: SourceObservationIntegrationJobScope): string | null {
  const segments = [scope.language, scope.productLineId, scope.seriesId, scope.setId, scope.productId].filter(
    (segment): segment is string => Boolean(segment),
  );

  return segments.length > 0 ? segments.join(":") : null;
}

export function promotionScopeTelemetryRef(scope: SourceObservationFilterScope): string | null {
  const segments = [
    scope.provider,
    scope.language,
    scope.productLineId,
    scope.seriesId,
    scope.expansionId ?? scope.setId,
    scope.status,
  ].filter((segment): segment is string => Boolean(segment));

  return segments.length > 0 ? segments.join(":") : null;
}

export function integrationProfileTelemetryRef(
  profile: SourceObservationIntegrationProfileSnapshot | null,
): string | null {
  return profile ? `${profile.profileKey}:${profile.profileVersion}` : null;
}

export async function listProviderIntegrationOptions(
  input: {
    providerKey: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    queryKind: string;
    languageCode?: string | null;
    parentValue?: string | null;
  },
  tcgplayerAutomationCatalogClient?: TcgplayerAutomationCatalogClient,
  profileVersions: CatalogProviderIntegrationProfileVersionReader = staticCatalogProviderIntegrationProfileVersions,
  providerAdapterRegistry: ProviderAdapterRegistry = new ProviderAdapterRegistry([
    createReferenceCardsProviderAdapter(),
    createTcgdexProviderAdapter({
      loadActiveProfileVersion: () => requireCatalogImportProfileVersion(profileVersions, "tcgdex"),
    }),
    createTcgplayerProviderAdapter({
      loadProfileVersions: () => profileVersions.listProfileVersions("tcgplayer"),
      client: tcgplayerAutomationCatalogClient,
    }),
    createMtgjsonProviderAdapter(),
    createLorcanajsonProviderAdapter(),
    createLorcastProviderAdapter(),
    createScryfallProviderAdapter(),
    createYgoprodeckProviderAdapter(),
    createYgojsonProviderAdapter(),
    createScrydexOnePieceProviderAdapter({ credentials: scrydexOnePieceCredentialsFromEnv() }),
  ]),
): Promise<readonly SourceObservationIntegrationOption[]> {
  const versions = await profileVersions.listProfileVersions();
  const activeOptionQueryVersions = versions.filter(isActiveProviderOptionQueryProfileVersion);
  const selectedVersion = profileVersionForProviderOptionQuery(activeOptionQueryVersions, {
    providerKey: input.providerKey,
    queryKind: input.queryKind,
    profileKey: input.profileKey,
    ingestionUnitKey: input.ingestionUnitKey,
  });
  const selectedOptionUnitKey = selectedVersion ? catalogProviderProfileVersionIngestionUnitKey(selectedVersion) : null;
  return listCatalogProviderIntegrationOptionsFromProfiles({
    profiles: (selectedVersion ? [selectedVersion] : activeOptionQueryVersions).map((version) => version.profile),
    providerKey: input.providerKey,
    queryKind: input.queryKind,
    languageCode: input.languageCode,
    parentValue: input.parentValue,
    defaultProviderKey: await defaultSourceObservationImportProviderKey(profileVersions),
    transports: {
      listTcgdexLanguages: () => listTcgdexLanguageOptionRecordsThroughAdapter(providerAdapterRegistry),
      listTcgdexSeries: ({ languageCode }) =>
        listTcgdexSeriesOptionRecordsThroughAdapter(providerAdapterRegistry, { languageCode }),
      listTcgdexExpansions: ({ languageCode, seriesId }) =>
        listTcgdexExpansionOptionRecordsThroughAdapter(providerAdapterRegistry, { languageCode, seriesId }),
      listTcgplayerProductLines: () =>
        listTcgplayerProductLineOptionRecordsThroughAdapter(providerAdapterRegistry, {
          unitKey: selectedOptionUnitKey,
        }),
      listTcgplayerSetNames: ({ productLineId }) =>
        listTcgplayerSetNameOptionRecordsThroughAdapter(providerAdapterRegistry, {
          productLineId,
          unitKey: selectedOptionUnitKey,
        }),
      listTcgplayerProducts: ({ setName }) =>
        listTcgplayerProductOptionRecordsThroughAdapter(providerAdapterRegistry, {
          setName,
          unitKey: selectedOptionUnitKey,
        }),
      listTcgplayerSkus: ({ productId }) =>
        listTcgplayerSkuOptionRecordsThroughAdapter(providerAdapterRegistry, {
          productId,
          unitKey: selectedOptionUnitKey,
        }),
      listMtgjsonSets: () => listMtgjsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listMtgjsonCards: ({ setCode }) =>
        listMtgjsonCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
      listLorcanajsonSets: () => listLorcanajsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listLorcanajsonCards: ({ setCode }) =>
        listLorcanajsonCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
      listLorcastSets: () => listLorcastSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listLorcastCards: ({ setCode }) =>
        listLorcastCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
      listScryfallSets: () => listScryfallSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listScryfallCards: ({ setCode }) =>
        listScryfallCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
      listScrydexOnePieceSets: () => listScrydexOnePieceSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listScrydexOnePieceCards: ({ setId }) =>
        listScrydexOnePieceCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
      listScrydexOnePieceSealedProducts: ({ setId }) =>
        listScrydexOnePieceSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
      listScrydexLorcanaSets: () => listScrydexLorcanaSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listScrydexLorcanaCards: ({ setId }) =>
        listScrydexLorcanaCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
      listScrydexLorcanaSealedProducts: ({ setId }) =>
        listScrydexLorcanaSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
      listYgoprodeckSets: () => listYgoprodeckSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listYgoprodeckCards: ({ setCode }) =>
        listYgoprodeckCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
      listYgojsonSets: () => listYgojsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
      listYgojsonSealedProducts: () => listYgojsonSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry),
    },
  });
}

export async function queryProviderIntegrationOptions(
  input: {
    providerKey: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
    queryKind: string;
    languageCode?: string | null;
    parentValue?: string | null;
    cursor?: string | null;
    limit?: number | null;
    forceRefresh?: boolean | null;
    cacheOnly?: boolean | null;
  },
  db: PgQueryable | null,
  rolloutControlPolicy: CatalogIntegrationRolloutControlPolicy | null,
  tcgplayerAutomationCatalogClient?: TcgplayerAutomationCatalogClient,
  profileVersions: CatalogProviderIntegrationProfileVersionReader = staticCatalogProviderIntegrationProfileVersions,
  providerAdapterRegistry: ProviderAdapterRegistry = new ProviderAdapterRegistry([
    createReferenceCardsProviderAdapter(),
    createTcgdexProviderAdapter({
      loadActiveProfileVersion: () => requireCatalogImportProfileVersion(profileVersions, "tcgdex"),
    }),
    createTcgplayerProviderAdapter({
      loadProfileVersions: () => profileVersions.listProfileVersions("tcgplayer"),
      client: tcgplayerAutomationCatalogClient,
    }),
    createMtgjsonProviderAdapter(),
    createLorcanajsonProviderAdapter(),
    createLorcastProviderAdapter(),
    createScryfallProviderAdapter(),
    createYgoprodeckProviderAdapter(),
    createYgojsonProviderAdapter(),
    createScrydexOnePieceProviderAdapter({ credentials: scrydexOnePieceCredentialsFromEnv() }),
  ]),
  telemetry?: SourceObservationTelemetry,
): Promise<CatalogProviderOptionQueryPage> {
  const decision = rolloutControlPolicy?.decide({
    capability: "provider-option-query",
    providerKey: input.providerKey,
  });
  const blockingControls = decision?.controls ?? [];
  const rolloutCacheOnly =
    blockingControls.length > 0 &&
    blockingControls.every((control) => control.controlId === "provider-option-queries-cache-only");
  if (decision && !decision.allowed && !rolloutCacheOnly) {
    throw new CatalogIntegrationRolloutControlError(decision);
  }
  const cacheOnly = input.cacheOnly === true || rolloutCacheOnly;

  const versions = await profileVersions.listProfileVersions();
  const activeOptionQueryVersions = versions.filter(isActiveProviderOptionQueryProfileVersion);
  const providerKey = input.providerKey.trim().toLowerCase();
  const queryKind = input.queryKind.trim().toLowerCase();
  const profileVersion = profileVersionForProviderOptionQuery(activeOptionQueryVersions, {
    providerKey,
    queryKind,
    profileKey: input.profileKey,
    ingestionUnitKey: input.ingestionUnitKey,
  });
  const selectedOptionUnitKey = profileVersion ? catalogProviderProfileVersionIngestionUnitKey(profileVersion) : null;
  const liveVersions = profileVersion
    ? activeOptionQueryVersions.filter(
        (version) =>
          version.providerKey === profileVersion.providerKey &&
          version.profileKey === profileVersion.profileKey &&
          version.profileVersion === profileVersion.profileVersion,
      )
    : activeOptionQueryVersions;

  try {
    const page = await queryCatalogProviderIntegrationOptionsWithCache({
      request: {
        providerKey,
        profileKey: profileVersion?.profileKey ?? "catalog-providers",
        profileVersion:
          profileVersion?.profileVersion ??
          `catalog-providers:${activeOptionQueryVersions
            .map(
              (version) =>
                `${version.providerKey}/${version.profileKey}@${version.profileVersion}:${catalogProviderProfileVersionIngestionUnitKey(
                  version,
                )}`,
            )
            .join("|")}`,
        ingestionUnitKey: profileVersion ? catalogProviderProfileVersionIngestionUnitKey(profileVersion) : "catalog",
        queryKind,
        languageCode: input.languageCode,
        parentValue: input.parentValue,
        cursor: input.cursor,
        limit: input.limit,
        forceRefresh: input.forceRefresh,
        cacheOnly,
      },
      cacheStore: createPgCatalogProviderOptionQueryCacheStore(db),
      loadLive: () =>
        listCatalogProviderIntegrationOptionsFromProfiles({
          profiles: liveVersions.map((version) => version.profile),
          providerKey: input.providerKey,
          queryKind: input.queryKind,
          languageCode: input.languageCode,
          parentValue: input.parentValue,
          defaultProviderKey: defaultSourceObservationImportProviderKeyFromVersions(activeOptionQueryVersions),
          transports: {
            listTcgdexLanguages: () => listTcgdexLanguageOptionRecordsThroughAdapter(providerAdapterRegistry),
            listTcgdexSeries: ({ languageCode }) =>
              listTcgdexSeriesOptionRecordsThroughAdapter(providerAdapterRegistry, { languageCode }),
            listTcgdexExpansions: ({ languageCode, seriesId }) =>
              listTcgdexExpansionOptionRecordsThroughAdapter(providerAdapterRegistry, { languageCode, seriesId }),
            listTcgplayerProductLines: () =>
              listTcgplayerProductLineOptionRecordsThroughAdapter(providerAdapterRegistry, {
                unitKey: selectedOptionUnitKey,
              }),
            listTcgplayerSetNames: ({ productLineId }) =>
              listTcgplayerSetNameOptionRecordsThroughAdapter(providerAdapterRegistry, {
                productLineId,
                unitKey: selectedOptionUnitKey,
              }),
            listTcgplayerProducts: ({ setName }) =>
              listTcgplayerProductOptionRecordsThroughAdapter(providerAdapterRegistry, {
                setName,
                unitKey: selectedOptionUnitKey,
              }),
            listTcgplayerSkus: ({ productId }) =>
              listTcgplayerSkuOptionRecordsThroughAdapter(providerAdapterRegistry, {
                productId,
                unitKey: selectedOptionUnitKey,
              }),
            listMtgjsonSets: () => listMtgjsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listMtgjsonCards: ({ setCode }) =>
              listMtgjsonCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
            listLorcanajsonSets: () => listLorcanajsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listLorcanajsonCards: ({ setCode }) =>
              listLorcanajsonCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
            listLorcastSets: () => listLorcastSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listLorcastCards: ({ setCode }) =>
              listLorcastCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
            listScryfallSets: () => listScryfallSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listScryfallCards: ({ setCode }) =>
              listScryfallCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
            listScrydexOnePieceSets: () => listScrydexOnePieceSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listScrydexOnePieceCards: ({ setId }) =>
              listScrydexOnePieceCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
            listScrydexOnePieceSealedProducts: ({ setId }) =>
              listScrydexOnePieceSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
            listScrydexLorcanaSets: () => listScrydexLorcanaSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listScrydexLorcanaCards: ({ setId }) =>
              listScrydexLorcanaCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
            listScrydexLorcanaSealedProducts: ({ setId }) =>
              listScrydexLorcanaSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry, { setId }),
            listYgoprodeckSets: () => listYgoprodeckSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listYgoprodeckCards: ({ setCode }) =>
              listYgoprodeckCardOptionRecordsThroughAdapter(providerAdapterRegistry, { setCode }),
            listYgojsonSets: () => listYgojsonSetOptionRecordsThroughAdapter(providerAdapterRegistry),
            listYgojsonSealedProducts: () =>
              listYgojsonSealedProductOptionRecordsThroughAdapter(providerAdapterRegistry),
          },
        }),
    });
    telemetry?.recordProviderOptionQuery?.({
      providerKey,
      queryKind,
      cacheStatus: page.cache.status,
      cacheSource: page.cache.source,
      result: "success",
      degraded: page.cache.degraded,
      cacheOnly: page.cache.cacheOnly,
      forceRefresh: page.cache.forceRefresh,
    });
    return page;
  } catch (error) {
    telemetry?.recordProviderOptionQuery?.({
      providerKey,
      queryKind,
      cacheStatus: "error",
      cacheSource: "none",
      result: "failure",
      degraded: true,
      cacheOnly,
      forceRefresh: input.forceRefresh === true,
    });
    throw error;
  }
}

export function profileVersionForProviderOptionQuery(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  input: Readonly<{
    providerKey: string;
    queryKind: string;
    profileKey?: string | null;
    ingestionUnitKey?: string | null;
  }>,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const providerKey = input.providerKey.trim().toLowerCase();
  const queryKind = input.queryKind.trim().toLowerCase();
  if (queryKind === "providers" || queryKind === "provider") {
    return null;
  }
  const selector = {
    profileKey: input.profileKey,
    ingestionUnitKey: input.ingestionUnitKey,
  };
  const matchingVersions = versions.filter(
    (version) =>
      version.providerKey.trim().toLowerCase() === providerKey &&
      (!selector.profileKey || version.profileKey.trim().toLowerCase() === selector.profileKey.trim().toLowerCase()) &&
      (!selector.ingestionUnitKey ||
        catalogProviderProfileVersionIngestionUnitKey(version).trim().toLowerCase() ===
          selector.ingestionUnitKey.trim().toLowerCase()) &&
      version.profile.optionQueries.some(
        (query) => query.queryKind === queryKind || (query.queryKeySynonyms ?? []).includes(queryKind),
      ),
  );
  if (matchingVersions.length === 0) {
    return null;
  }
  if (matchingVersions.length === 1) {
    return matchingVersions[0] ?? null;
  }

  throw new Error(
    `Catalog provider '${providerKey}' has multiple active profile units for option query '${queryKind}'. Select a profileKey or ingestionUnitKey.`,
  );
}

export function defaultSourceObservationImportProviderKeyFromVersions(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
): string {
  return versions[0]?.providerKey ?? "catalog";
}

export async function listTcgdexLanguagesThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly TcgdexLanguageOption[]> {
  const records = await listTcgdexLanguageOptionRecordsThroughAdapter(providerAdapterRegistry);
  return records.map((record) => ({ languageCode: stringRecordValue(record, "languageCode") || "en" }));
}

export async function listTcgdexSeriesThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { languageCode: string },
): Promise<readonly TcgdexSeriesOption[]> {
  const records = await listTcgdexSeriesOptionRecordsThroughAdapter(providerAdapterRegistry, input);
  return records.map((record) => ({
    seriesId: stringRecordValue(record, "seriesId") || "",
    name: stringRecordValue(record, "name") || "",
    logoUrl: stringRecordValue(record, "logoUrl"),
  }));
}

export async function listTcgdexExpansionsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { languageCode: string; seriesId?: string | null },
): Promise<readonly TcgdexExpansionOption[]> {
  const records = await listTcgdexExpansionOptionRecordsThroughAdapter(providerAdapterRegistry, input);
  return records.map((record) => ({
    expansionId: stringRecordValue(record, "expansionId") || "",
    name: stringRecordValue(record, "name") || "",
    seriesId: stringRecordValue(record, "seriesId"),
    seriesName: stringRecordValue(record, "seriesName"),
    logoUrl: stringRecordValue(record, "logoUrl"),
    symbolUrl: stringRecordValue(record, "symbolUrl"),
    cardCount: numberRecordValue(record, "cardCount"),
    officialCardCount: numberRecordValue(record, "officialCardCount"),
  }));
}

export async function listTcgdexLanguageOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireTcgdexAdapter(providerAdapterRegistry).listOptions({
    unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "languages",
  });
  return result.items.map((item) => ({ languageCode: item.value }));
}

export async function listTcgdexSeriesOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { languageCode: string },
): Promise<readonly JsonValue[]> {
  const result = await requireTcgdexAdapter(providerAdapterRegistry).listOptions({
    unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "series",
    parentValues: { languageCode: input.languageCode },
  });
  return result.items.map((item) => ({
    seriesId: item.value,
    name: item.label,
    aliases: providerOptionAliasesToJson(item.aliases),
    logoUrl: item.metadata?.logoUrl ?? null,
  }));
}

export async function listTcgdexExpansionOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { languageCode: string; seriesId?: string | null },
): Promise<readonly JsonValue[]> {
  const result = await requireTcgdexAdapter(providerAdapterRegistry).listOptions({
    unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "expansions",
    parentValues: { languageCode: input.languageCode, seriesId: input.seriesId ?? "" },
  });
  return result.items.map((item) => ({
    expansionId: item.value,
    name: item.label,
    seriesId: item.parentValue ?? null,
    seriesName: item.metadata?.seriesName ?? null,
    aliases: providerOptionAliasesToJson(item.aliases),
    logoUrl: item.metadata?.logoUrl ?? null,
    symbolUrl: item.metadata?.symbolUrl ?? null,
    cardCount: numberFromString(item.metadata?.cardCount),
    officialCardCount: numberFromString(item.metadata?.officialCardCount),
  }));
}

export function requireTcgdexAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<TcgdexObservationPayload> {
  return providerAdapterRegistry.require("tcgdex") as ProviderAdapter<TcgdexObservationPayload>;
}

export async function listMtgjsonSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireMtgjsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setCode: item.value,
    name: item.label,
    releaseDate: item.metadata?.releaseDate ?? null,
    totalSetSize: numberFromString(item.metadata?.totalSetSize),
    type: item.metadata?.type ?? null,
    mtgjsonVersion: item.metadata?.mtgjsonVersion ?? null,
  }));
}

export async function listMtgjsonCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setCode: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setCode) {
    throw new Error("MTGJSON card option queries require a set code parent value.");
  }

  const result = await requireMtgjsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "cards",
    parentValues: { setCode: input.setCode },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    setCode: item.metadata?.setCode ?? input.setCode,
    setName: item.metadata?.setName ?? null,
    collectorNumber: item.metadata?.collectorNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    layout: item.metadata?.layout ?? null,
    scryfallId: item.metadata?.scryfallId ?? null,
  }));
}

export function requireMtgjsonAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<MtgjsonProviderPayload> {
  return providerAdapterRegistry.require("mtgjson") as ProviderAdapter<MtgjsonProviderPayload>;
}

export async function listLorcanajsonSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireLorcanajsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setId: item.metadata?.setId ?? item.value,
    setCode: item.value,
    name: item.label,
    releaseDate: item.metadata?.releaseDate ?? null,
    prereleaseDate: item.metadata?.prereleaseDate ?? null,
    type: item.metadata?.type ?? null,
    setNumber: item.metadata?.setNumber ?? null,
    cardCount: numberFromString(item.metadata?.cardCount),
    formatVersion: item.metadata?.formatVersion ?? null,
    generatedOn: item.metadata?.generatedOn ?? null,
  }));
}

export async function listLorcanajsonCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setCode: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setCode) {
    throw new Error("LorcanaJSON card option queries require a set code parent value.");
  }

  const result = await requireLorcanajsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "cards",
    parentValues: { setCode: input.setCode },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    setCode: item.metadata?.setCode ?? input.setCode,
    setName: item.metadata?.setName ?? null,
    cardNumber: item.metadata?.cardNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    cardType: item.metadata?.cardType ?? null,
    inkColor: item.metadata?.inkColor ?? null,
    tcgplayerProductId: item.metadata?.tcgplayerProductId ?? null,
    imageUrl: item.metadata?.imageUrl ?? null,
  }));
}

export function requireLorcanajsonAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<LorcanajsonProviderPayload> {
  return providerAdapterRegistry.require("lorcanajson") as ProviderAdapter<LorcanajsonProviderPayload>;
}

export async function listLorcastSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireLorcastAdapter(providerAdapterRegistry).listOptions({
    unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setId: item.metadata?.setId ?? item.value,
    setCode: item.value,
    name: item.label,
    releaseDate: item.metadata?.releaseDate ?? null,
    prereleaseDate: item.metadata?.prereleaseDate ?? null,
    cacheGuidance: item.metadata?.cacheGuidance ?? null,
  }));
}

export async function listLorcastCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setCode: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setCode) {
    throw new Error("Lorcast card option queries require a set code parent value.");
  }

  const result = await requireLorcastAdapter(providerAdapterRegistry).listOptions({
    unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "cards",
    parentValues: { setCode: input.setCode },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    setId: item.metadata?.setId ?? null,
    setCode: item.metadata?.setCode ?? input.setCode,
    setName: item.metadata?.setName ?? null,
    cardNumber: item.metadata?.cardNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    cardType: item.metadata?.cardType ?? null,
    inkColor: item.metadata?.inkColor ?? null,
    tcgplayerProductId: item.metadata?.tcgplayerProductId ?? null,
    imageUrl: item.metadata?.imageUrl ?? null,
    releaseDate: item.metadata?.releaseDate ?? null,
  }));
}

export function requireLorcastAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<LorcastProviderPayload> {
  return providerAdapterRegistry.require("lorcast") as ProviderAdapter<LorcastProviderPayload>;
}

export async function listScryfallSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireScryfallAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setCode: item.value,
    name: item.label,
    setId: item.metadata?.setId ?? null,
    setType: item.metadata?.setType ?? null,
    releasedAt: item.metadata?.releasedAt ?? null,
    cardCount: numberFromString(item.metadata?.cardCount),
    digital: booleanFromString(item.metadata?.digital),
  }));
}

export async function listScryfallCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setCode: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setCode) {
    throw new Error("Scryfall card option queries require a set code parent value.");
  }

  const result = await requireScryfallAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "cards",
    parentValues: { setCode: input.setCode },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    setCode: item.metadata?.setCode ?? input.setCode,
    oracleId: item.metadata?.oracleId ?? null,
    setName: item.metadata?.setName ?? null,
    collectorNumber: item.metadata?.collectorNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    imageStatus: item.metadata?.imageStatus ?? null,
    imageUrl: null,
  }));
}

export function requireScryfallAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<ScryfallProviderPayload> {
  return providerAdapterRegistry.require("scryfall") as ProviderAdapter<ScryfallProviderPayload>;
}

export async function listScrydexOnePieceSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    expansionId: item.value,
    name: item.label,
    code: item.metadata?.code ?? null,
    total: numberFromString(item.metadata?.total),
    releaseDate: item.metadata?.releaseDate ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

export async function listScrydexOnePieceCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setId: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setId) {
    throw new Error("Scrydex One Piece card option queries require a selected set.");
  }

  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "cards",
    parentValues: { expansionId: input.setId, setId: input.setId },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    expansionId: item.parentValue ?? item.metadata?.expansionId ?? input.setId,
    number: item.metadata?.number ?? null,
    printedNumber: item.metadata?.printedNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    rarityCode: item.metadata?.rarityCode ?? null,
    type: item.metadata?.type ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

export async function listScrydexOnePieceSealedProductOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setId: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setId) {
    throw new Error("Scrydex One Piece sealed-product option queries require a selected set.");
  }

  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "sealed-products",
    parentValues: { expansionId: input.setId, setId: input.setId },
  });
  return result.items.map((item) => ({
    sealedProductId: item.value,
    name: item.label,
    expansionId: item.parentValue ?? item.metadata?.expansionId ?? input.setId,
    type: item.metadata?.type ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

export async function listScrydexLorcanaSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    expansionId: item.value,
    name: item.label,
    code: item.metadata?.code ?? null,
    total: numberFromString(item.metadata?.total),
    releaseDate: item.metadata?.releaseDate ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

export async function listScrydexLorcanaCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setId: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setId) {
    throw new Error("Scrydex Lorcana card option queries require a selected set.");
  }

  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "cards",
    parentValues: { expansionId: input.setId, setId: input.setId },
  });
  return result.items.map((item) => ({
    cardId: item.value,
    name: item.label,
    expansionId: item.parentValue ?? item.metadata?.expansionId ?? input.setId,
    number: item.metadata?.number ?? null,
    printedNumber: item.metadata?.printedNumber ?? null,
    rarity: item.metadata?.rarity ?? null,
    rarityCode: item.metadata?.rarityCode ?? null,
    type: item.metadata?.type ?? null,
    inkColor: item.metadata?.inkColor ?? null,
    tcgplayerProductId: item.metadata?.tcgplayerProductId ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

export async function listScrydexLorcanaSealedProductOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setId: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setId) {
    throw new Error("Scrydex Lorcana sealed-product option queries require a selected set.");
  }

  const result = await requireScrydexOnePieceAdapter(providerAdapterRegistry).listOptions({
    unitKey: SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "sealed-products",
    parentValues: { expansionId: input.setId, setId: input.setId },
  });
  return result.items.map((item) => ({
    sealedProductId: item.value,
    name: item.label,
    expansionId: item.parentValue ?? item.metadata?.expansionId ?? input.setId,
    type: item.metadata?.type ?? null,
    language: item.metadata?.language ?? null,
    languageCode: item.metadata?.languageCode ?? null,
  }));
}

export function requireScrydexOnePieceAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<ScrydexOnePieceProviderPayload> {
  return providerAdapterRegistry.require("scrydex") as ProviderAdapter<ScrydexOnePieceProviderPayload>;
}

export async function listYgoprodeckSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireYgoprodeckAdapter(providerAdapterRegistry).listOptions({
    unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setName: item.value,
    setCode: item.metadata?.setCode ?? null,
    releaseDate: item.metadata?.releaseDate ?? null,
    cardCount: numberFromString(item.metadata?.cardCount),
  }));
}

export async function listYgoprodeckCardOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setCode: string | null },
): Promise<readonly JsonValue[]> {
  if (!input.setCode) {
    throw new Error("YGOPRODeck card option queries require a selected set name or set code.");
  }

  const result = await requireYgoprodeckAdapter(providerAdapterRegistry).listOptions({
    unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
    optionKind: "cards",
    parentValues: { setName: input.setCode, setCode: input.setCode },
  });
  return result.items.map((item) => ({
    cardPrintId: item.value,
    name: item.label,
    setName: item.metadata?.setName ?? input.setCode,
    setCode: item.metadata?.setCode ?? null,
    cardId: item.metadata?.cardId ?? null,
    rarity: item.metadata?.rarity ?? null,
    cardType: item.metadata?.cardType ?? null,
    frameType: item.metadata?.frameType ?? null,
    race: item.metadata?.race ?? null,
    attribute: item.metadata?.attribute ?? null,
    archetype: item.metadata?.archetype ?? null,
    imageEvidenceAvailable: booleanFromString(item.metadata?.imageEvidenceAvailable),
  }));
}

export function requireYgoprodeckAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<YgoprodeckProviderPayload> {
  return providerAdapterRegistry.require("ygoprodeck") as ProviderAdapter<YgoprodeckProviderPayload>;
}

export async function listYgojsonSetOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireYgojsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sets",
  });
  return result.items.map((item) => ({
    setId: item.value,
    name: item.label,
    releaseDate: item.metadata?.releaseDate ?? null,
    localeCount: numberFromString(item.metadata?.localeCount),
    printCount: numberFromString(item.metadata?.printCount),
    packContentEvidenceCount: numberFromString(item.metadata?.packContentEvidenceCount),
    yugipediaId: item.metadata?.yugipediaId ?? null,
  }));
}

export async function listYgojsonSealedProductOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): Promise<readonly JsonValue[]> {
  const result = await requireYgojsonAdapter(providerAdapterRegistry).listOptions({
    unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
    optionKind: "sealed-products",
  });
  return result.items.map((item) => ({
    sealedProductId: item.value,
    name: item.label,
    releaseDate: item.metadata?.releaseDate ?? null,
    localeCount: numberFromString(item.metadata?.localeCount),
    boxOfSetCount: numberFromString(item.metadata?.boxOfSetCount),
    packContentEvidenceCount: numberFromString(item.metadata?.packContentEvidenceCount),
    yugipediaId: item.metadata?.yugipediaId ?? null,
  }));
}

export function requireYgojsonAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<YgojsonProviderPayload> {
  return providerAdapterRegistry.require("ygojson") as ProviderAdapter<YgojsonProviderPayload>;
}

export async function listTcgplayerProductLineOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { unitKey?: string | null } = {},
): Promise<readonly JsonValue[]> {
  const result = await requireTcgplayerAdapter(providerAdapterRegistry).listOptions({
    unitKey: input.unitKey ?? TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "product-lines",
  });
  return result.items.map((item) => ({
    productLineId: numberFromString(item.value),
    productLineName: item.label,
    productLineUrlName: item.metadata?.productLineUrlName ?? null,
    isDirect: booleanFromString(item.metadata?.isDirect),
  }));
}

export async function listTcgplayerSetNameOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { productLineId: number; unitKey?: string | null },
): Promise<readonly JsonValue[]> {
  const result = await requireTcgplayerAdapter(providerAdapterRegistry).listOptions({
    unitKey: input.unitKey ?? TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "set-names",
    parentValues: { productLineId: String(input.productLineId) },
  });
  return result.items.map((item) => ({
    setNameId: numberFromString(item.metadata?.setNameId),
    categoryId: numberFromString(item.metadata?.categoryId),
    name: item.label,
    cleanSetName: item.value,
    urlName: item.metadata?.urlName ?? null,
    abbreviation: item.metadata?.abbreviation ?? null,
    releaseDate: item.metadata?.releaseDate ?? null,
    isSupplemental: booleanFromString(item.metadata?.isSupplemental),
    active: booleanFromString(item.metadata?.active),
  }));
}

export async function listTcgplayerProductOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { setName: string; unitKey?: string | null },
): Promise<readonly JsonValue[]> {
  const result = await requireTcgplayerAdapter(providerAdapterRegistry).listOptions({
    unitKey: input.unitKey ?? TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "products",
    parentValues: { setName: input.setName },
  });
  return result.items.map((item) => ({
    productId: numberFromString(item.value),
    productName: item.label,
    productLineId: numberFromString(item.metadata?.productLineId),
    productLineName: item.metadata?.productLineName ?? null,
    productTypeName: item.metadata?.productTypeName ?? null,
    setId: numberFromString(item.metadata?.setId),
    setName: item.metadata?.setName ?? input.setName,
    rarityName: item.metadata?.rarityName ?? null,
    sealed: booleanFromString(item.metadata?.sealed),
  }));
}

export async function listTcgplayerSkuOptionRecordsThroughAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
  input: { productId: number; unitKey?: string | null },
): Promise<readonly JsonValue[]> {
  const result = await requireTcgplayerAdapter(providerAdapterRegistry).listOptions({
    unitKey: input.unitKey ?? TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    optionKind: "skus",
    parentValues: { productId: String(input.productId) },
  });
  return result.items.map((item) => ({
    sku: numberFromString(item.value),
    condition: item.metadata?.condition ?? null,
    variant: item.metadata?.variant ?? null,
    language: item.metadata?.language ?? null,
  }));
}

export function requireTcgplayerAdapter(
  providerAdapterRegistry: ProviderAdapterRegistry,
): ProviderAdapter<TcgplayerProviderPayload> {
  return providerAdapterRegistry.require("tcgplayer") as ProviderAdapter<TcgplayerProviderPayload>;
}

export function stringRecordValue(record: JsonValue, key: string): string | null {
  if (!isJsonRecord(record)) {
    return null;
  }
  const value = record[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }
  return null;
}

export function providerOptionAliasesToJson(aliases: readonly ProviderOptionAlias[] | undefined): JsonValue {
  return (aliases ?? []).map((alias) => ({
    aliasText: alias.aliasText,
    aliasLanguageCode: alias.aliasLanguageCode,
    aliasType: alias.aliasType,
    confidence: alias.confidence,
    reviewStatus: alias.reviewStatus,
    sourceCategory: alias.sourceCategory,
    ...(alias.evidence ? { evidence: alias.evidence } : {}),
  }));
}

export function numberRecordValue(record: JsonValue, key: string): number | null {
  return numberFromString(stringRecordValue(record, key));
}

export function numberFromString(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function booleanFromString(value: string | null | undefined): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return null;
}

export function scrydexOnePieceCredentialsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ScrydexOnePieceCredentials | undefined {
  const apiKey = env.SCRYDEX_API_KEY?.trim() || "";
  const teamId = env.SCRYDEX_TEAM_ID?.trim() || "";

  return apiKey && teamId ? { apiKey, teamId } : undefined;
}

async function requireCatalogImportProfileVersion(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
  providerKey: string | null | undefined,
  selector?: CatalogProviderProfileVersionSelector | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const normalizedProvider = normalizeIntegrationKey(
    providerKey || (await defaultSourceObservationImportProviderKey(profileVersions)),
  );
  const version = await profileVersions.getActiveProfileVersion(normalizedProvider, selector);
  if (!version || !isActiveSourceObservationImportProfileVersion(version)) {
    throw new Error(`Provider '${normalizedProvider}' does not support background import.`);
  }

  return version;
}

async function defaultSourceObservationImportProviderKey(
  profileVersions: CatalogProviderIntegrationProfileVersionReader,
): Promise<string> {
  const activeImportProfiles = (await profileVersions.listProfileVersions()).filter(
    isActiveSourceObservationImportProfileVersion,
  );
  if (activeImportProfiles.length === 0) {
    throw new Error("No active Catalog source observation import provider is configured.");
  }

  return defaultSourceObservationImportProviderKeyFromVersions(activeImportProfiles);
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
