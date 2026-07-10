import { createHash } from "node:crypto";
import type { JsonObject } from "@chase-sets/primitives/json";
import type {
  CatalogAliasReviewStateKey,
  CatalogAliasSourceCategoryKey,
  CatalogAliasTypeKey,
} from "../../source-observations/api/catalog-integration-data-governance";
import { assert } from "../../../support/runtime-support/common";

// ---------------------------------------------------------------------------
// Catalog Alias value objects
//
// A Catalog Alias is reviewable evidence that a piece of text refers to a
// Catalog Item or Reference Record. The vocabulary (alias type, source
// category, review state) is locked by the ADR and the alias
// source-governance policy; this file imports those terms rather than
// re-declaring them so there is one source of truth.
//
// Two durable shapes live here:
//   - `CatalogAliasCandidate`: a queryable claim produced by a Source
//     Observation, awaiting (or having undergone) review. Persisted into
//     `catalog_source_observation_alias_candidates`.
//   - `CatalogAcceptedAlias`: the accepted/auto-accepted (or revoked/rejected)
//     downstream fact for a target. Persisted into `catalog_item_aliases` and
//     `catalog_reference_record_aliases`.
// ---------------------------------------------------------------------------

/** Re-export the ADR-locked vocabulary so alias consumers import one place. */
export type {
  CatalogAliasReviewStateKey,
  CatalogAliasSourceCategoryKey,
  CatalogAliasTypeKey,
} from "../../source-observations/api/catalog-integration-data-governance";

/**
 * What an alias is an equivalent name for. `catalog-item` covers card-level
 * aliases; `reference-record` covers expansion/series (set-equivalent and
 * series-equivalent) aliases per the ADR.
 */
export type CatalogAliasTargetKind = "catalog-item" | "reference-record";

/**
 * The concrete target an alias attaches to.
 *
 * - For a Catalog Item, `targetId` is the Catalog Item id and `targetField`
 *   names the aliased field (e.g. `"name"`), preserving the contract's
 *   `catalogItemFieldKey`.
 * - For a Reference Record, `targetKey` is the reference type key (e.g.
 *   `"expansion"`) and `targetId` is the Reference Record id when it has been
 *   resolved. A candidate may carry only the key/field before promotion has
 *   resolved a concrete record id.
 */
export type CatalogAliasTarget = Readonly<{
  kind: CatalogAliasTargetKind;
  /** Resolved target id (Catalog Item id or Reference Record id). Null until resolved. */
  targetId: string | null;
  /** Catalog Item field key (catalog-item targets) or reference type key (reference-record targets). */
  targetKey: string;
}>;

/** Provenance describing the source that produced an alias candidate. */
export type CatalogAliasProvenance = Readonly<{
  providerKey: string;
  /** Source Observation that produced the candidate, when applicable. */
  observationId: string | null;
  sourceCategory: CatalogAliasSourceCategoryKey;
  sourceProfileKey: string;
  sourceProfileVersion: string;
  /** Mapping fingerprint of the producing profile, for replay/idempotency. */
  mappingFingerprint: string;
}>;

/**
 * A typed alias candidate value object. Every field needed for an operator to
 * understand why the alias exists and for deterministic idempotent persistence.
 */
export type CatalogAliasCandidate = Readonly<{
  target: CatalogAliasTarget;
  aliasText: string;
  /** Lowercased, trimmed alias text used for dedupe and uniqueness. */
  normalizedAliasText: string;
  /** Language of the alias text (e.g. "fr", "ja"). */
  aliasLanguageCode: string;
  /** Language of the canonical name the alias is an equivalent of, when known. */
  sourceLanguageCode: string | null;
  aliasType: CatalogAliasTypeKey;
  /** Trust marking, orthogonal to alias type. */
  confidence: CatalogAliasConfidenceKey;
  /** Review status; candidates default to `pending` or `auto-accepted`. */
  reviewStatus: CatalogAliasReviewStateKey;
  provenance: CatalogAliasProvenance;
  /** Supporting evidence (e.g. shared provider id) backing the alias. */
  evidence: JsonObject;
  /** Deterministic hash of the identity fields; stable across re-import/replay. */
  aliasHash: string;
}>;

/** Alias confidence, locked by the ADR. Orthogonal to alias type. */
export type CatalogAliasConfidenceKey = "exact" | "high" | "candidate" | "generated" | "manual";

const CATALOG_ALIAS_CONFIDENCE_KEYS: readonly CatalogAliasConfidenceKey[] = [
  "exact",
  "high",
  "candidate",
  "generated",
  "manual",
];

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

const CATALOG_ALIAS_REVIEW_STATE_KEYS: readonly CatalogAliasReviewStateKey[] = [
  "pending",
  "accepted",
  "auto-accepted",
  "rejected",
  "revoked",
];

/**
 * Review states that make an alias eligible to publish as a downstream search
 * or display alias. Anything else (pending, rejected, revoked, generated) must
 * never silently become a high-weight downstream alias.
 */
export const CATALOG_ALIAS_PUBLISHABLE_REVIEW_STATES: readonly CatalogAliasReviewStateKey[] = [
  "accepted",
  "auto-accepted",
];

/**
 * Reference-record-level alias types per the ADR. Every other alias type
 * operates at the Catalog Item level.
 */
const REFERENCE_RECORD_ALIAS_TYPES: readonly CatalogAliasTypeKey[] = ["set-equivalent", "series-equivalent"];

export function isReferenceRecordAliasType(aliasType: CatalogAliasTypeKey): boolean {
  return REFERENCE_RECORD_ALIAS_TYPES.includes(aliasType);
}

export function isCatalogAliasPublishable(reviewStatus: CatalogAliasReviewStateKey): boolean {
  return CATALOG_ALIAS_PUBLISHABLE_REVIEW_STATES.includes(reviewStatus);
}

/** Normalize alias text for dedupe: trim, collapse internal whitespace, lowercase. */
export function normalizeAliasText(aliasText: string): string {
  return aliasText.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeLanguageCode(languageCode: string): string {
  return languageCode.trim().toLowerCase();
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The identity tuple that makes an alias unique. The deterministic hash is
 * computed over exactly these fields, so re-importing the same evidence yields
 * the same hash and persistence stays idempotent. Evidence and confidence are
 * intentionally excluded from identity: the same equivalence claim from the
 * same source must dedupe even if its supporting evidence is re-serialized.
 */
export type CatalogAliasIdentity = Readonly<{
  targetKind: CatalogAliasTargetKind;
  targetKey: string;
  targetId: string | null;
  normalizedAliasText: string;
  aliasLanguageCode: string;
  aliasType: CatalogAliasTypeKey;
  providerKey: string;
  sourceCategory: CatalogAliasSourceCategoryKey;
}>;

export function catalogAliasIdentity(candidate: {
  target: CatalogAliasTarget;
  normalizedAliasText: string;
  aliasLanguageCode: string;
  aliasType: CatalogAliasTypeKey;
  provenance: Pick<CatalogAliasProvenance, "providerKey" | "sourceCategory">;
}): CatalogAliasIdentity {
  return {
    targetKind: candidate.target.kind,
    targetKey: candidate.target.targetKey,
    targetId: candidate.target.targetId,
    normalizedAliasText: candidate.normalizedAliasText,
    aliasLanguageCode: candidate.aliasLanguageCode,
    aliasType: candidate.aliasType,
    providerKey: candidate.provenance.providerKey,
    sourceCategory: candidate.provenance.sourceCategory,
  };
}

export function computeCatalogAliasHash(identity: CatalogAliasIdentity): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export type BuildCatalogAliasCandidateInput = Readonly<{
  target: Readonly<{ kind: CatalogAliasTargetKind; targetId?: string | null; targetKey: string }>;
  aliasText: string;
  aliasLanguageCode: string;
  sourceLanguageCode?: string | null;
  aliasType: CatalogAliasTypeKey;
  confidence: CatalogAliasConfidenceKey;
  reviewStatus: CatalogAliasReviewStateKey;
  provenance: Readonly<{
    providerKey: string;
    observationId?: string | null;
    sourceCategory: CatalogAliasSourceCategoryKey;
    sourceProfileKey: string;
    sourceProfileVersion: string;
    mappingFingerprint: string;
  }>;
  evidence?: JsonObject;
}>;

/**
 * Build a normalized, hashed `CatalogAliasCandidate` from raw input. Validates
 * vocabulary, normalizes text and language codes, enforces that the alias type
 * matches its target level, and computes the deterministic hash. This is the
 * single constructor for candidate value objects so every producer dedupes the
 * same way.
 */
export function buildCatalogAliasCandidate(input: BuildCatalogAliasCandidateInput): CatalogAliasCandidate {
  const aliasText = input.aliasText.trim();
  assert(aliasText.length > 0, "Alias candidates require non-empty alias text.");
  assert(CATALOG_ALIAS_TYPE_KEYS.includes(input.aliasType), `Unknown Catalog Alias type '${input.aliasType}'.`);
  assert(
    CATALOG_ALIAS_CONFIDENCE_KEYS.includes(input.confidence),
    `Unknown Catalog Alias confidence '${input.confidence}'.`,
  );
  assert(
    CATALOG_ALIAS_REVIEW_STATE_KEYS.includes(input.reviewStatus),
    `Unknown Catalog Alias review status '${input.reviewStatus}'.`,
  );

  const targetKey = normalizeKey(input.target.targetKey);
  assert(targetKey.length > 0, "Alias candidates require a target key.");

  const aliasTypeIsReferenceLevel = isReferenceRecordAliasType(input.aliasType);
  assert(
    aliasTypeIsReferenceLevel === (input.target.kind === "reference-record"),
    `Alias type '${input.aliasType}' does not match target kind '${input.target.kind}'.`,
  );

  const aliasLanguageCode = normalizeLanguageCode(input.aliasLanguageCode);
  assert(aliasLanguageCode.length > 0, "Alias candidates require an alias language code.");

  const provenance: CatalogAliasProvenance = {
    providerKey: normalizeKey(input.provenance.providerKey),
    observationId: input.provenance.observationId?.trim() || null,
    sourceCategory: input.provenance.sourceCategory,
    sourceProfileKey: normalizeKey(input.provenance.sourceProfileKey),
    sourceProfileVersion: input.provenance.sourceProfileVersion.trim(),
    mappingFingerprint: input.provenance.mappingFingerprint.trim(),
  };
  assert(provenance.providerKey.length > 0, "Alias candidates require a provider key.");

  const target: CatalogAliasTarget = {
    kind: input.target.kind,
    targetId: input.target.targetId?.trim() || null,
    targetKey,
  };
  const normalizedAliasText = normalizeAliasText(aliasText);

  return {
    target,
    aliasText,
    normalizedAliasText,
    aliasLanguageCode,
    sourceLanguageCode: input.sourceLanguageCode ? normalizeLanguageCode(input.sourceLanguageCode) : null,
    aliasType: input.aliasType,
    confidence: input.confidence,
    reviewStatus: input.reviewStatus,
    provenance,
    evidence: input.evidence ?? {},
    aliasHash: computeCatalogAliasHash(
      catalogAliasIdentity({
        target,
        normalizedAliasText,
        aliasLanguageCode,
        aliasType: input.aliasType,
        provenance,
      }),
    ),
  };
}

/**
 * Deduplicate candidates by deterministic hash, keeping the last occurrence so
 * a re-import overwrites stale evidence with fresh evidence. Preserves input
 * order of the surviving entries.
 */
export function dedupeCatalogAliasCandidates(
  candidates: readonly CatalogAliasCandidate[],
): readonly CatalogAliasCandidate[] {
  const byHash = new Map<string, CatalogAliasCandidate>();
  for (const candidate of candidates) {
    byHash.set(candidate.aliasHash, candidate);
  }
  return [...byHash.values()];
}
