import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import {
  decideCatalogAliasAcceptance,
  getCatalogAliasSourceGovernancePolicy,
  type CatalogAliasReviewStateKey,
  type CatalogAliasSourceCategoryKey,
  type CatalogAliasTypeKey,
} from "./catalog-integration-data-governance";
import type { CatalogAliasConfidenceKey } from "../../alias-equivalence/domain/alias";
import type { ProviderOptionAlias } from "./provider-adapters/provider-adapter";

// ---------------------------------------------------------------------------
// Provider option aliases
//
// Source scope selection happens BEFORE any import, so option labels come from
// provider option queries / provider English endpoints rather than durable
// Catalog Alias candidates (which only exist after import). This is a separate
// data path, but it MUST reuse the same alias vocabulary and the same
// English-endpoint alignment rule instead of inventing an untyped label
// mechanism. This module is the pure bridge: it turns a same-id English match
// into a typed `ProviderOptionAlias`, and it owns the deterministic label policy
// every option-list renderer applies.
// ---------------------------------------------------------------------------

/**
 * Build a typed option alias from an already-matched English-endpoint name.
 *
 * The caller runs `matchTcgdexEnglishEndpointEntity` (the reusable rule)
 * to obtain `englishName`; this function only wraps the result in the shared
 * vocabulary, assigning the governed review status and recording evidence. It
 * never duplicates the alignment rule.
 *
 * Returns null when there is no usable English name, so callers can spread the
 * result unconditionally.
 */
export function buildEnglishEndpointOptionAlias(input: {
  englishName: string | null;
  aliasType: CatalogAliasTypeKey;
  sourceLanguageCode: string;
  /** The shared provider record id that aligned the localized and English names. */
  providerId: string;
  /** Evidence kind, e.g. "series-id" or "set-id". */
  evidenceKind: string;
  confidence?: CatalogAliasConfidenceKey;
  /** Whether the named source has recorded legal/source approval for English names. */
  hasLegalSourceApproval?: boolean;
}): ProviderOptionAlias | null {
  const englishName = input.englishName?.trim();
  if (!englishName) {
    return null;
  }

  const sourceCategory: CatalogAliasSourceCategoryKey = "provider-same-id-localized-endpoint";
  const policy = getCatalogAliasSourceGovernancePolicy(sourceCategory);
  if (!policy.producibleAliasTypes.includes(input.aliasType)) {
    // The source category cannot produce this alias type; a programming error
    // caught by tests, not a runtime condition surfaced to operators.
    throw new Error(`Option alias source category '${sourceCategory}' cannot produce '${input.aliasType}'.`);
  }

  const decision = decideCatalogAliasAcceptance({
    category: sourceCategory,
    languageCode: ENGLISH_ALIAS_LANGUAGE_CODE,
    hasLegalSourceApproval: input.hasLegalSourceApproval,
  });

  const evidence: JsonObject = {
    providerId: input.providerId,
    sharedProviderId: input.providerId,
    evidenceKind: input.evidenceKind,
    sourceCategory,
    sourceLanguageCode: input.sourceLanguageCode,
    englishEndpointLanguageCode: ENGLISH_ALIAS_LANGUAGE_CODE,
    governedReviewState: decision.reviewState,
    governedOfficial: decision.official,
    policyVersion: decision.policyVersion,
  };

  return {
    aliasText: englishName,
    aliasLanguageCode: ENGLISH_ALIAS_LANGUAGE_CODE,
    aliasType: input.aliasType,
    confidence: input.confidence ?? "high",
    reviewStatus: decision.reviewState,
    sourceCategory,
    evidence,
  };
}

export const ENGLISH_ALIAS_LANGUAGE_CODE = "en";

/**
 * Confidence keys strong enough to surface an alias as a display label without
 * human review having confirmed it. `exact`/`high` are governed-source strength;
 * `manual` is a reviewer assertion. `candidate` and `generated` are not.
 */
const DISPLAY_TRUSTED_CONFIDENCE: readonly CatalogAliasConfidenceKey[] = ["exact", "high", "manual"];

/**
 * Review states whose aliases may be shown as the primary English display label
 * without further review. Mirrors the publishable states in the alias domain.
 */
const DISPLAY_TRUSTED_REVIEW_STATES: readonly string[] = ["accepted", "auto-accepted"];

export type OptionAliasShape = Readonly<{
  aliasText: string;
  aliasLanguageCode: string;
  confidence: CatalogAliasConfidenceKey;
  reviewStatus: string;
}>;

/**
 * Pick the English alias that should drive an option's display label, applying
 * the deterministic policy: an accepted/auto-accepted English alias wins; among
 * pending evidence, only governed-strength (exact/high/manual) English aliases
 * are eligible. Returns null when no trustworthy English alias exists, so the
 * caller falls back to the native provider label and then the provider id.
 */
export function selectDisplayEnglishAlias(
  aliases: readonly OptionAliasShape[] | null | undefined,
): OptionAliasShape | null {
  if (!aliases || aliases.length === 0) {
    return null;
  }

  const english = aliases.filter(
    (alias) => normalize(alias.aliasLanguageCode) === ENGLISH_ALIAS_LANGUAGE_CODE && Boolean(alias.aliasText.trim()),
  );
  if (english.length === 0) {
    return null;
  }

  const accepted = english.find((alias) => DISPLAY_TRUSTED_REVIEW_STATES.includes(normalize(alias.reviewStatus)));
  if (accepted) {
    return accepted;
  }

  return english.find((alias) => DISPLAY_TRUSTED_CONFIDENCE.includes(alias.confidence)) ?? null;
}

/**
 * Render an option's display label from its typed aliases and native label,
 * applying the deterministic policy:
 *   1. accepted/high-confidence English alias, shown as `English (native name)`;
 *   2. the native provider label;
 *   3. the provider id (value).
 */
export function optionDisplayLabelFromAliases(input: {
  value: string;
  nativeLabel: string | null | undefined;
  aliases: readonly OptionAliasShape[] | null | undefined;
}): string {
  const value = input.value.trim();
  const nativeLabel = input.nativeLabel?.trim() || value;
  const english = selectDisplayEnglishAlias(input.aliases);
  if (!english) {
    return nativeLabel;
  }

  const englishText = english.aliasText.trim();
  if (!englishText || normalize(englishText) === normalize(nativeLabel)) {
    return nativeLabel;
  }

  return `${englishText} (${nativeLabel})`;
}

/**
 * A typed option alias parsed back from its JSON record form (after the adapter
 * -> option-query record -> resolver hop). Carries the full shared vocabulary so
 * downstream label policy and consumers never re-derive semantics from strings.
 */
export type ProviderOptionAliasRecord = Readonly<{
  aliasText: string;
  aliasLanguageCode: string;
  aliasType: CatalogAliasTypeKey;
  confidence: CatalogAliasConfidenceKey;
  reviewStatus: CatalogAliasReviewStateKey;
  sourceCategory: CatalogAliasSourceCategoryKey;
  evidence: JsonObject;
}>;

const CATALOG_ALIAS_TYPE_KEYS: readonly CatalogAliasTypeKey[] = [
  "official-equivalent",
  "provider-localized-name",
  "species-name",
  "literal-translation",
  "romanization",
  "generated-translation",
  "set-equivalent",
  "series-equivalent",
];

const CATALOG_ALIAS_CONFIDENCE_KEYS: readonly CatalogAliasConfidenceKey[] = [
  "exact",
  "high",
  "candidate",
  "generated",
  "manual",
];

const CATALOG_ALIAS_REVIEW_STATE_KEYS: readonly CatalogAliasReviewStateKey[] = [
  "pending",
  "accepted",
  "auto-accepted",
  "rejected",
  "revoked",
];

const CATALOG_ALIAS_SOURCE_CATEGORY_KEYS: readonly CatalogAliasSourceCategoryKey[] = [
  "provider-same-id-localized-endpoint",
  "provider-localized-name",
  "official-english-source",
  "curated-operator-mapping",
  "species-reference",
  "machine-translation",
  "romanization",
];

/**
 * Parse a JSON value into typed `ProviderOptionAliasRecord`s, dropping any entry
 * that does not carry the full shared vocabulary. Unknown/malformed entries are
 * ignored rather than coerced, so a provider with no (or invalid) aliases falls
 * back safely to the native label.
 */
export function parseProviderOptionAliasesFromJson(value: JsonValue | undefined): readonly ProviderOptionAliasRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = parseProviderOptionAliasRecord(entry);
    return record ? [record] : [];
  });
}

function parseProviderOptionAliasRecord(value: JsonValue): ProviderOptionAliasRecord | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const record = value;
  const aliasText = jsonString(record.aliasText)?.trim();
  const aliasLanguageCode = jsonString(record.aliasLanguageCode)?.trim();
  const aliasType = jsonMember(record.aliasType, CATALOG_ALIAS_TYPE_KEYS);
  const confidence = jsonMember(record.confidence, CATALOG_ALIAS_CONFIDENCE_KEYS);
  const reviewStatus = jsonMember(record.reviewStatus, CATALOG_ALIAS_REVIEW_STATE_KEYS);
  const sourceCategory = jsonMember(record.sourceCategory, CATALOG_ALIAS_SOURCE_CATEGORY_KEYS);
  if (!aliasText || !aliasLanguageCode || !aliasType || !confidence || !reviewStatus || !sourceCategory) {
    return null;
  }

  const evidenceValue = record.evidence;
  const evidence: JsonObject = isJsonObject(evidenceValue) ? evidenceValue : {};

  return { aliasText, aliasLanguageCode, aliasType, confidence, reviewStatus, sourceCategory, evidence };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function jsonMember<T extends string>(value: JsonValue | undefined, members: readonly T[]): T | null {
  return typeof value === "string" && (members as readonly string[]).includes(value) ? (value as T) : null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
