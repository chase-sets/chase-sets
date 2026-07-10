import type { JsonObject } from "@chase-sets/primitives/json";
import {
  buildCatalogAliasCandidate,
  dedupeCatalogAliasCandidates,
  type CatalogAliasCandidate,
  type CatalogAliasConfidenceKey,
} from "../../alias-equivalence/domain/alias";
import {
  CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION,
  decideCatalogAliasAcceptance,
  getCatalogAliasSourceGovernancePolicy,
  isRejectedNonEnglishLanguageCode,
  TCGDEX_INDONESIAN_LANGUAGE_CODE,
  type CatalogAliasAcceptanceDecision,
  type CatalogAliasSourceCategoryKey,
  type CatalogAliasTypeKey,
} from "./catalog-integration-data-governance";

// ---------------------------------------------------------------------------
// TCGdex alias extraction
//
// The first provider proof of the alias model. Turns a governed TCGdex Source
// Observation (series / expansion / card, in a chosen source language) into
// typed `CatalogAliasCandidate` value objects, honoring the alias
// source-governance policy and the ADR (#1903) verbatim.
//
// Three hard rules from the ADR / governance, encoded here once:
//
//   1. The TCGdex `id` language code is Indonesian, not English. An Indonesian
//      name is emitted as an Indonesian `provider-localized-name`, NEVER as an
//      English `official-equivalent`. Some Pokemon species names look English in
//      Indonesian, which is exactly the false-friend trap this guard closes.
//   2. The TCGdex English endpoint (`/v2/en/...`) is one evidence source, not
//      truth. A same-id English match is only used when the same provider id
//      exists AND the English endpoint returned a matching entity. It produces a
//      `provider-same-id-localized-endpoint` candidate, which the governance
//      policy holds for review (it never silently becomes official).
//   3. Species (`species-name`) aliases require reliable species evidence
//      (dex/species id) and never assert exact card equivalence. Trainer and
//      Energy cards (no dex id) get no species alias.
//
// This module never makes live provider calls. The English-endpoint match logic
// is exposed as a reusable pure function (`matchTcgdexEnglishEndpointEntity`) so
// source-option labels reuse the exact same alignment rule rather than
// duplicating it.
// ---------------------------------------------------------------------------

export const TCGDEX_PROVIDER_KEY = "tcgdex";

/** A TCGdex entity (series, set, or card) identified by id and localized name. */
export type TcgdexAliasEntity = Readonly<{
  id: string;
  name: string;
}>;

/** A TCGdex card observed in a source language, with optional species evidence. */
export type TcgdexAliasCardEntity = TcgdexAliasEntity &
  Readonly<{
    /** TCGdex card category. `Pokemon` carries species; Trainer/Energy do not. */
    category: string;
    /**
     * National Pokedex / species identifiers for the card. Present only for
     * Pokemon cards; empty/absent for Trainer and Energy cards.
     */
    dexId?: readonly number[] | null;
    /** Catalog Item field the card-name alias attaches to (e.g. "card-name"). */
    catalogItemFieldKey: string;
    /** Resolved Catalog Item id when known; null before promotion resolves one. */
    catalogItemId?: string | null;
  }>;

/** A TCGdex expansion observed in a source language. */
export type TcgdexAliasExpansionEntity = TcgdexAliasEntity &
  Readonly<{
    /** Reference type key for the expansion (e.g. "expansion"). */
    referenceTypeKey: string;
    /** Resolved Reference Record id when known; null before resolution. */
    referenceRecordId?: string | null;
  }>;

/** A TCGdex series observed in a source language. */
export type TcgdexAliasSeriesEntity = TcgdexAliasEntity &
  Readonly<{
    /** Reference type key for the series (e.g. "series"). */
    referenceTypeKey: string;
    referenceRecordId?: string | null;
  }>;

/**
 * The English-language counterparts that the same-id English endpoint returned,
 * one per entity. Each is matched against the source entity by id via
 * `matchTcgdexEnglishEndpointEntity`. A `null` entry means the English endpoint
 * did not exist or did not return a matching entity (common for Japanese/Asia
 * set ids), and no English same-id alias is produced for it.
 */
export type TcgdexEnglishEndpointMatches = Readonly<{
  card?: TcgdexAliasEntity | null;
  expansion?: TcgdexAliasEntity | null;
  series?: TcgdexAliasEntity | null;
}>;

export type TcgdexAliasExtractionInput = Readonly<{
  /** TCGdex provider language code the source names were read from (e.g. "ja", "id"). */
  sourceLanguageCode: string;
  observationId: string;
  sourceProfileKey: string;
  sourceProfileVersion: string;
  mappingFingerprint: string;
  card: TcgdexAliasCardEntity;
  expansion: TcgdexAliasExpansionEntity;
  series?: TcgdexAliasSeriesEntity | null;
  /** Same-id English endpoint counterparts, when an English mirror was fetched. */
  englishMatches?: TcgdexEnglishEndpointMatches;
  /**
   * Whether the named TCGdex source has recorded legal/source approval for
   * storing official English names. Defaults to false: without approval the
   * governed same-id endpoint category cannot auto-accept regardless.
   */
  hasLegalSourceApproval?: boolean;
}>;

export const TCGDEX_ENGLISH_LANGUAGE_CODE = "en";

/**
 * Reusable, pure English-endpoint alignment rule (exposed for reuse by source-option labels).
 *
 * A same-id English match exists only when:
 *   - the source entity has a non-empty provider id,
 *   - the English endpoint returned an entity (not null), and
 *   - the English entity's id equals the source entity's id, and
 *   - the English entity has a usable name.
 *
 * Returns the trimmed English name on a match, otherwise null. This never reads
 * the network; the caller supplies the already-fetched English entity (or null
 * when `/v2/en/...` did not exist for the id), keeping fixtures call-free.
 */
export function matchTcgdexEnglishEndpointEntity(input: {
  sourceId: string;
  englishEntity: TcgdexAliasEntity | null | undefined;
}): string | null {
  const sourceId = input.sourceId.trim();
  const englishEntity = input.englishEntity;
  if (!sourceId || !englishEntity) {
    return null;
  }

  if (englishEntity.id.trim() !== sourceId) {
    return null;
  }

  const englishName = englishEntity.name.trim();
  return englishName.length > 0 ? englishName : null;
}

/**
 * Extract every alias candidate a single TCGdex observation supports.
 * Deterministic and idempotent: re-running on the same observation yields the
 * same hashed candidates so persistence dedupes cleanly.
 */
export function extractTcgdexAliasCandidates(input: TcgdexAliasExtractionInput): readonly CatalogAliasCandidate[] {
  const candidates: CatalogAliasCandidate[] = [];
  const englishMatches = input.englishMatches ?? {};

  // --- Series ----------------------------------------------------------------
  // A series/expansion name is a reference-level equivalence claim: the provider
  // record id links the localized (or English) name to a Catalog series/
  // expansion. Both names therefore flow through the same-id endpoint category,
  // which can produce `series-equivalent` / `set-equivalent` and is held for
  // review. The native (source-language) name keeps its source language, so an
  // Indonesian set name is an Indonesian `set-equivalent`, never English.
  if (input.series) {
    const seriesTarget = referenceTarget(input.series);
    pushReferenceEquivalent(candidates, input, {
      entity: input.series,
      aliasText: input.series.name,
      aliasLanguageCode: input.sourceLanguageCode,
      aliasType: "series-equivalent",
      target: seriesTarget,
      evidenceKind: "series-id",
    });
    pushSameIdEnglish(candidates, input, {
      sourceEntity: input.series,
      englishEntity: englishMatches.series,
      aliasType: "series-equivalent",
      target: seriesTarget,
      evidenceKind: "series-id",
    });
  }

  // --- Expansion -------------------------------------------------------------
  const expansionTarget = referenceTarget(input.expansion);
  pushReferenceEquivalent(candidates, input, {
    entity: input.expansion,
    aliasText: input.expansion.name,
    aliasLanguageCode: input.sourceLanguageCode,
    aliasType: "set-equivalent",
    target: expansionTarget,
    evidenceKind: "set-id",
  });
  pushSameIdEnglish(candidates, input, {
    sourceEntity: input.expansion,
    englishEntity: englishMatches.expansion,
    aliasType: "set-equivalent",
    target: expansionTarget,
    evidenceKind: "set-id",
  });

  // --- Card ------------------------------------------------------------------
  // The native card name is the provider's localized name (catalog-item level).
  pushProviderLocalizedCard(candidates, input);
  pushSameIdEnglish(candidates, input, {
    sourceEntity: input.card,
    englishEntity: englishMatches.card,
    aliasType: "official-equivalent",
    target: {
      kind: "catalog-item",
      targetKey: input.card.catalogItemFieldKey,
      targetId: input.card.catalogItemId,
    },
    evidenceKind: "card-id",
  });
  pushSpeciesAlias(candidates, input);

  return dedupeCatalogAliasCandidates(candidates);
}

function referenceTarget(
  entity: Readonly<{ referenceTypeKey: string; referenceRecordId?: string | null }>,
): AliasTarget {
  return { kind: "reference-record", targetKey: entity.referenceTypeKey, targetId: entity.referenceRecordId };
}

type AliasTarget = Readonly<{
  kind: "catalog-item" | "reference-record";
  targetKey: string;
  targetId?: string | null;
}>;

/**
 * Reference-level equivalence (`set-equivalent` / `series-equivalent`) for a
 * native (source-language) series/expansion name. Backed by the provider record
 * id under the same-id endpoint category, held for review. The alias keeps its
 * source language, so an Indonesian set name is an Indonesian `set-equivalent`
 * and the governance decision records that it is not English evidence.
 */
function pushReferenceEquivalent(
  candidates: CatalogAliasCandidate[],
  input: TcgdexAliasExtractionInput,
  spec: Readonly<{
    entity: TcgdexAliasEntity;
    aliasText: string;
    aliasLanguageCode: string;
    aliasType: CatalogAliasTypeKey;
    target: AliasTarget;
    evidenceKind: string;
  }>,
): void {
  const aliasText = spec.aliasText.trim();
  if (aliasText.length === 0) {
    return;
  }

  appendCandidate(candidates, input, {
    aliasText,
    aliasType: spec.aliasType,
    sourceCategory: "provider-same-id-localized-endpoint",
    confidence: "candidate",
    aliasLanguageCode: spec.aliasLanguageCode,
    target: spec.target,
    evidence: { providerId: spec.entity.id, evidenceKind: spec.evidenceKind },
  });
}

function pushProviderLocalizedCard(candidates: CatalogAliasCandidate[], input: TcgdexAliasExtractionInput): void {
  pushProviderLocalizedName(candidates, input, {
    aliasText: input.card.name,
    aliasType: "provider-localized-name",
    target: { kind: "catalog-item", targetKey: input.card.catalogItemFieldKey, targetId: input.card.catalogItemId },
    evidence: { providerId: input.card.id, evidenceKind: "card-id" },
  });
}

/**
 * Native card name in the selected source language, preserved as a
 * catalog-item-level `provider-localized-name`.
 *
 * The Indonesian guard lives here: when the source language is the TCGdex `id`
 * (Indonesian) code, the alias language is explicitly Indonesian. Because the
 * source category is `provider-localized-name` (never `canProvideOfficialEnglish`),
 * an Indonesian name can never leak out as an English official equivalent.
 */
function pushProviderLocalizedName(
  candidates: CatalogAliasCandidate[],
  input: TcgdexAliasExtractionInput,
  spec: Readonly<{
    aliasText: string;
    aliasType: CatalogAliasTypeKey;
    target: AliasTarget;
    evidence: JsonObject;
  }>,
): void {
  const aliasText = spec.aliasText.trim();
  if (aliasText.length === 0) {
    return;
  }

  appendCandidate(candidates, input, {
    aliasText,
    aliasType: spec.aliasType,
    sourceCategory: "provider-localized-name",
    confidence: "candidate",
    aliasLanguageCode: input.sourceLanguageCode,
    target: spec.target,
    evidence: spec.evidence,
  });
}

/**
 * Same-id English-endpoint alias. Only emitted when the reusable matcher
 * confirms the same provider id resolved to a matching English entity. Produces
 * a `provider-same-id-localized-endpoint` candidate which the governance policy
 * holds for review and never auto-accepts without recorded legal approval.
 *
 * The candidate's alias language is always English. The source language (which
 * may be Indonesian) is recorded as `sourceLanguageCode` for provenance, never
 * as the alias language, so Indonesian never poses as English.
 */
function pushSameIdEnglish(
  candidates: CatalogAliasCandidate[],
  input: TcgdexAliasExtractionInput,
  spec: Readonly<{
    sourceEntity: TcgdexAliasEntity;
    englishEntity: TcgdexAliasEntity | null | undefined;
    aliasType: CatalogAliasTypeKey;
    target: AliasTarget;
    evidenceKind: string;
  }>,
): void {
  const englishName = matchTcgdexEnglishEndpointEntity({
    sourceId: spec.sourceEntity.id,
    englishEntity: spec.englishEntity,
  });
  if (!englishName) {
    return;
  }

  appendCandidate(candidates, input, {
    aliasText: englishName,
    aliasType: spec.aliasType,
    sourceCategory: "provider-same-id-localized-endpoint",
    confidence: "high",
    aliasLanguageCode: TCGDEX_ENGLISH_LANGUAGE_CODE,
    target: spec.target,
    evidence: {
      providerId: spec.sourceEntity.id,
      sharedProviderId: spec.sourceEntity.id,
      evidenceKind: spec.evidenceKind,
      englishEndpointLanguageCode: TCGDEX_ENGLISH_LANGUAGE_CODE,
    },
  });
}

/**
 * Species alias from reliable dex/species evidence. Only Pokemon cards with at
 * least one dex id qualify; Trainer/Energy cards (and any card without a dex id)
 * never get a species alias because species mapping cannot solve their
 * English display/search need. The species name is the card name in English
 * when the English endpoint matched; otherwise there is no reliable English
 * species name to assert, so none is emitted (absence is a valid state).
 */
function pushSpeciesAlias(candidates: CatalogAliasCandidate[], input: TcgdexAliasExtractionInput): void {
  if (!hasReliableSpeciesEvidence(input.card)) {
    return;
  }

  const englishSpeciesName = matchTcgdexEnglishEndpointEntity({
    sourceId: input.card.id,
    englishEntity: input.englishMatches?.card,
  });
  if (!englishSpeciesName) {
    return;
  }

  appendCandidate(candidates, input, {
    aliasText: englishSpeciesName,
    aliasType: "species-name",
    sourceCategory: "species-reference",
    confidence: "candidate",
    aliasLanguageCode: TCGDEX_ENGLISH_LANGUAGE_CODE,
    target: { kind: "catalog-item", targetKey: input.card.catalogItemFieldKey, targetId: input.card.catalogItemId },
    evidence: {
      dexId: [...(input.card.dexId ?? [])],
      evidenceKind: "dex-id",
    },
  });
}

/**
 * A card carries reliable species evidence when it is a Pokemon (not a Trainer
 * or Energy card) and has at least one dex/species identifier.
 */
export function hasReliableSpeciesEvidence(card: TcgdexAliasCardEntity): boolean {
  if (card.category.trim().toLowerCase() !== "pokemon") {
    return false;
  }
  return (card.dexId ?? []).some((dexId) => Number.isFinite(dexId) && dexId > 0);
}

function appendCandidate(
  candidates: CatalogAliasCandidate[],
  input: TcgdexAliasExtractionInput,
  spec: Readonly<{
    aliasText: string;
    aliasType: CatalogAliasTypeKey;
    sourceCategory: CatalogAliasSourceCategoryKey;
    confidence: CatalogAliasConfidenceKey;
    aliasLanguageCode: string;
    target: AliasTarget;
    evidence: JsonObject;
  }>,
): void {
  const policy = getCatalogAliasSourceGovernancePolicy(spec.sourceCategory);
  if (!policy.producibleAliasTypes.includes(spec.aliasType)) {
    // The source category cannot produce this alias type; this is a programming
    // error caught by tests, not a runtime condition to surface to operators.
    throw new Error(`TCGdex alias source category '${spec.sourceCategory}' cannot produce '${spec.aliasType}'.`);
  }

  const decision = decideCatalogAliasAcceptance({
    category: spec.sourceCategory,
    languageCode: spec.aliasLanguageCode,
    hasLegalSourceApproval: input.hasLegalSourceApproval,
  });

  candidates.push(
    buildCatalogAliasCandidate({
      target: spec.target,
      aliasText: spec.aliasText,
      aliasLanguageCode: spec.aliasLanguageCode,
      sourceLanguageCode: input.sourceLanguageCode,
      aliasType: spec.aliasType,
      confidence: spec.confidence,
      reviewStatus: decision.reviewState,
      provenance: {
        providerKey: TCGDEX_PROVIDER_KEY,
        observationId: input.observationId,
        sourceCategory: spec.sourceCategory,
        sourceProfileKey: input.sourceProfileKey,
        sourceProfileVersion: input.sourceProfileVersion,
        mappingFingerprint: input.mappingFingerprint,
      },
      evidence: aliasEvidence(spec.evidence, spec.sourceCategory, input, decision),
    }),
  );
}

function aliasEvidence(
  evidence: JsonObject,
  sourceCategory: CatalogAliasSourceCategoryKey,
  input: TcgdexAliasExtractionInput,
  decision: CatalogAliasAcceptanceDecision,
): JsonObject {
  return {
    ...evidence,
    sourceCategory,
    sourceLanguageCode: input.sourceLanguageCode,
    sourceLanguageIsIndonesian: isRejectedNonEnglishLanguageCode(input.sourceLanguageCode),
    policyVersion: CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION,
    governedReviewState: decision.reviewState,
    governedOfficial: decision.official,
  };
}

/** Re-exported for downstream slices that branch on the Indonesian guard. */
export { TCGDEX_INDONESIAN_LANGUAGE_CODE };
