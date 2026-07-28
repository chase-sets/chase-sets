import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type { CatalogAliasCandidate } from "../../../alias-equivalence/domain/alias";
import type { CatalogProviderIntegrationProfile } from "../provider-integration-profiles";
import {
  fetchTcgdexEnglishMirrorEntity,
  type TcgdexEnglishMirrorEntity,
  type TcgdexObservationPayload,
} from "./tcgdex-client";
import {
  extractTcgdexAliasCandidates,
  TCGDEX_ENGLISH_LANGUAGE_CODE,
  type TcgdexAliasCardEntity,
  type TcgdexAliasExpansionEntity,
  type TcgdexAliasSeriesEntity,
  type TcgdexEnglishEndpointMatches,
} from "./tcgdex-alias-extraction";

// ---------------------------------------------------------------------------
// TCGdex alias intake
//
// Bridges a recorded TCGdex Source Observation to the alias candidate model.
// For each observation payload it reads the native (source-language) series /
// expansion / card names, fetches the same-id English mirror entities (only when
// the source language is not already English, and only through the injected
// fetch so fixtures stay call-free), extracts typed alias candidates with the
// governance policy, and hands them to the persistence sink.
//
// The default English-mirror entity loader is fixture-injectable via `fetch`;
// no live provider call is required. When the source language is English there
// is nothing to mirror, so no English same-id alias is produced.
// ---------------------------------------------------------------------------

export type TcgdexAliasIntakeObservation = Readonly<{
  observationId: string;
  sourceProfileKey: string;
  sourceProfileVersion: string;
  mappingFingerprint: string;
  /** The TCGdex observation mapping payload (raw card/set + normalized facts). */
  payload: JsonValue;
}>;

/**
 * Loads the English-mirror counterpart for a single TCGdex entity, returning
 * null when `/v2/en/...` did not exist for that id. Injected so tests and
 * source-option labels can supply their own loader without a live provider call.
 */
export type TcgdexEnglishMirrorLoader = (input: {
  entity: "set" | "series" | "card";
  id: string;
}) => Promise<TcgdexEnglishMirrorEntity | null>;

export type TcgdexAliasIntakeInput = Readonly<{
  profile: CatalogProviderIntegrationProfile;
  observations: readonly TcgdexAliasIntakeObservation[];
  /** Persist the produced candidates (the upsert sink). */
  persist: (candidates: readonly CatalogAliasCandidate[], observedAt: string) => Promise<void>;
  observedAt: string;
  fetch?: typeof globalThis.fetch;
  /** Override the English-mirror loader (defaults to the TCGdex client). */
  loadEnglishMirrorEntity?: TcgdexEnglishMirrorLoader;
  /** Catalog Item field key the card-name alias attaches to. */
  catalogItemFieldKey?: string;
  /** Reference type keys for expansion/series aliases. */
  expansionReferenceTypeKey?: string;
  seriesReferenceTypeKey?: string;
  hasLegalSourceApproval?: boolean;
}>;

const DEFAULT_CATALOG_ITEM_FIELD_KEY = "card-name";
const DEFAULT_EXPANSION_REFERENCE_TYPE_KEY = "expansion";
const DEFAULT_SERIES_REFERENCE_TYPE_KEY = "series";

/**
 * Produce and persist alias candidates for a batch of TCGdex observations.
 * Returns the deduped candidates that were persisted (also useful for tests).
 */
export async function ingestTcgdexAliasCandidates(
  input: TcgdexAliasIntakeInput,
): Promise<readonly CatalogAliasCandidate[]> {
  const loadEnglishMirrorEntity =
    input.loadEnglishMirrorEntity ??
    ((mirror) =>
      fetchTcgdexEnglishMirrorEntity({
        profile: input.profile,
        entity: mirror.entity,
        id: mirror.id,
        fetch: input.fetch,
      }));

  const allCandidates: CatalogAliasCandidate[] = [];
  for (const observation of input.observations) {
    const parsed = parseTcgdexAliasObservation(observation, {
      catalogItemFieldKey: input.catalogItemFieldKey ?? DEFAULT_CATALOG_ITEM_FIELD_KEY,
      expansionReferenceTypeKey: input.expansionReferenceTypeKey ?? DEFAULT_EXPANSION_REFERENCE_TYPE_KEY,
      seriesReferenceTypeKey: input.seriesReferenceTypeKey ?? DEFAULT_SERIES_REFERENCE_TYPE_KEY,
    });
    if (!parsed) {
      continue;
    }

    const englishMatches = await resolveEnglishMatches(parsed, loadEnglishMirrorEntity);
    allCandidates.push(
      ...extractTcgdexAliasCandidates({
        sourceLanguageCode: parsed.sourceLanguageCode,
        observationId: observation.observationId,
        sourceProfileKey: observation.sourceProfileKey,
        sourceProfileVersion: observation.sourceProfileVersion,
        mappingFingerprint: observation.mappingFingerprint,
        card: parsed.card,
        expansion: parsed.expansion,
        series: parsed.series,
        englishMatches,
        hasLegalSourceApproval: input.hasLegalSourceApproval,
      }),
    );
  }

  if (allCandidates.length === 0) {
    return [];
  }

  await input.persist(allCandidates, input.observedAt);
  return allCandidates;
}

type ParsedTcgdexAliasObservation = Readonly<{
  sourceLanguageCode: string;
  card: TcgdexAliasCardEntity;
  expansion: TcgdexAliasExpansionEntity;
  series: TcgdexAliasSeriesEntity | null;
}>;

async function resolveEnglishMatches(
  parsed: ParsedTcgdexAliasObservation,
  loadEnglishMirrorEntity: TcgdexEnglishMirrorLoader,
): Promise<TcgdexEnglishEndpointMatches> {
  // When the source language is already English, there is nothing to mirror:
  // the native names are the English names and same-id English aliases are moot.
  if (parsed.sourceLanguageCode === TCGDEX_ENGLISH_LANGUAGE_CODE) {
    return {};
  }

  const [card, expansion, series] = await Promise.all([
    loadEnglishMirrorEntity({ entity: "card", id: parsed.card.id }),
    loadEnglishMirrorEntity({ entity: "set", id: parsed.expansion.id }),
    parsed.series ? loadEnglishMirrorEntity({ entity: "series", id: parsed.series.id }) : Promise.resolve(null),
  ]);

  return { card, expansion, series };
}

function parseTcgdexAliasObservation(
  observation: TcgdexAliasIntakeObservation,
  keys: Readonly<{
    catalogItemFieldKey: string;
    expansionReferenceTypeKey: string;
    seriesReferenceTypeKey: string;
  }>,
): ParsedTcgdexAliasObservation | null {
  const payload = asRecord(observation.payload);
  if (!payload) {
    return null;
  }

  const card = asRecord(payload.card);
  const set = asRecord(payload.set);
  const sourceLanguageCode = stringField(payload.languageCode);
  if (!card || !set || !sourceLanguageCode) {
    return null;
  }

  const cardId = stringField(card.id);
  const cardName = stringField(card.name);
  const cardCategory = stringField(card.category);
  const setId = stringField(set.id);
  const setName = stringField(set.name);
  if (!cardId || !cardName || !cardCategory || !setId || !setName) {
    return null;
  }

  const seriesId = stringField(payload.seriesId);
  const seriesName = stringField(payload.seriesName);

  return {
    sourceLanguageCode: sourceLanguageCode.toLowerCase(),
    card: {
      id: cardId,
      name: cardName,
      category: cardCategory,
      dexId: numberArrayField(card.dexId),
      catalogItemFieldKey: keys.catalogItemFieldKey,
      catalogItemId: null,
    },
    expansion: {
      id: setId,
      name: setName,
      referenceTypeKey: keys.expansionReferenceTypeKey,
      referenceRecordId: null,
    },
    series:
      seriesId && seriesName
        ? {
            id: seriesId,
            name: seriesName,
            referenceTypeKey: keys.seriesReferenceTypeKey,
            referenceRecordId: null,
          }
        : null,
  };
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function stringField(value: JsonValue | undefined): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function numberArrayField(value: JsonValue | undefined): readonly number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
}
