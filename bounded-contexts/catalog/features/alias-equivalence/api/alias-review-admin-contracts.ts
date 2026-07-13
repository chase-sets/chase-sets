import type { JsonValue } from "@chase-sets/primitives/json";
import { t } from "@chase-sets/localization";
import {
  decideCatalogAliasAcceptance,
  type CatalogAliasSourceCategoryKey,
  CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION,
} from "../../source-observations/api/catalog-integration-data-governance";
import type {
  CatalogAliasConfidenceKey,
  CatalogAliasReviewStateKey,
  CatalogAliasTargetKind,
  CatalogAliasTypeKey,
} from "../domain/alias";
import { CATALOG_ALIAS_PUBLISHABLE_REVIEW_STATES, isReferenceRecordAliasType } from "../domain/alias";
import type {
  CatalogAliasCandidateFilter,
  CatalogAliasCandidateRow,
  CatalogItemAliasRow,
  CatalogReferenceRecordAliasRow,
} from "../read-model/queries";

// ---------------------------------------------------------------------------
// Admin alias review read-model contracts
//
// Operators review alias candidates as part of integration review. This module
// turns DB-backed candidate/accepted-alias rows into an operator-facing
// read model that answers, without opening raw JSON:
//   - what each candidate is (native printed name, proposed alias, alias type,
//     confidence, source, evidence, review status);
//   - whether a candidate is auto-accept eligible (via the
//     `decideCatalogAliasAcceptance` governance decision), so the UI can offer
//     auto-accept;
//   - whether a candidate carries a generated/low-confidence warning;
//   - alias coverage by provider setup / import scope: which cards have an
//     accepted English alias, which have only species aliases, which need
//     review, and which expansions/series need review.
//
// Everything here is a pure transform over rows the alias-equivalence queries
// return, so it is unit-testable without a database and is the single place the
// UI and tests agree on alias-review vocabulary. Acceptance/rejection/revocation
// are dispatched through the Catalog Alias event-sourced aggregate; this read
// model only reads.
// ---------------------------------------------------------------------------

export const catalogAliasReviewContractVersion = "catalog-alias-review-v1" as const;

export type CatalogAliasReviewContractVersion = typeof catalogAliasReviewContractVersion;

/**
 * The scope dimensions an operator can group/filter alias candidates by during
 * provider setup and import review. Matches the natural language the issue uses:
 * provider, ingestion unit, language, series, expansion, plus the three alias
 * targets (Source Observation, Catalog Item, Reference Record).
 */
export type CatalogAliasReviewScopeKey =
  | "provider"
  | "unit"
  | "language"
  | "series"
  | "expansion"
  | "source-observation"
  | "catalog-item"
  | "reference-record";

export const catalogAliasReviewScopeKeys = [
  "provider",
  "unit",
  "language",
  "series",
  "expansion",
  "source-observation",
  "catalog-item",
  "reference-record",
] as const satisfies readonly CatalogAliasReviewScopeKey[];

/** A non-confusing reason an operator should look closely at a candidate. */
export type CatalogAliasReviewWarningKey =
  | "generated-translation"
  | "low-confidence-evidence"
  | "never-official-source"
  | "indonesian-id-not-english";

/**
 * The bulk review actions the operator UI dispatches against the Catalog Alias aggregate.
 * `defer` keeps a candidate pending; `auto-accept` is only offered when the
 * governance decision yields an `auto-accepted` review state.
 */
export type CatalogAliasReviewActionKey = "accept" | "reject" | "defer" | "revoke" | "auto-accept";

/**
 * Auto-accept eligibility for a candidate, derived from the
 * `decideCatalogAliasAcceptance` governance decision. `reasons` explains the
 * decision in operator language so the UI never shows an unexplained disabled
 * action.
 */
export type CatalogAliasReviewAutoAcceptEligibility = Readonly<{
  eligible: boolean;
  /** Review state the candidate would land in if proposed under current policy. */
  governedReviewState: "auto-accepted" | "pending";
  /** Whether the resulting alias may be displayed as an official equivalent. */
  official: boolean;
  policyVersion: typeof CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION;
  reasons: readonly string[];
}>;

/** A single alias candidate as an operator sees it in the review table. */
export type CatalogAliasReviewCandidateSummary = Readonly<{
  aliasHash: string;
  targetKind: CatalogAliasTargetKind;
  targetId: string | null;
  targetKey: string;
  /** The native (source-language) printed name the alias is an equivalent of. */
  nativePrintedName: string;
  nativeLanguageCode: string | null;
  /** The proposed alias text and its language. */
  proposedAlias: string;
  aliasLanguageCode: string;
  aliasType: CatalogAliasTypeKey;
  confidence: CatalogAliasConfidenceKey;
  reviewStatus: CatalogAliasReviewStateKey;
  /** Source category (how the candidate was produced) plus the producing provider. */
  sourceCategory: CatalogAliasSourceCategoryKey;
  providerKey: string;
  observationId: string | null;
  sourceProfileKey: string;
  sourceProfileVersion: string;
  /** Redacted, operator-readable evidence lines (never raw provider bodies). */
  evidence: readonly CatalogAliasReviewEvidenceLine[];
  warnings: readonly CatalogAliasReviewWarningKey[];
  autoAccept: CatalogAliasReviewAutoAcceptEligibility;
  /** Whether the candidate is in a state an operator can still act on. */
  reviewable: boolean;
  /** The review actions available for this candidate given its review state. */
  availableActions: readonly CatalogAliasReviewActionKey[];
  firstObservedAt: string;
  updatedAt: string;
}>;

export type CatalogAliasReviewEvidenceLine = Readonly<{
  key: string;
  label: string;
  value: string;
}>;

/** Counts that drive review-progress and readiness signals for a set of candidates. */
export type CatalogAliasReviewCounts = Readonly<{
  total: number;
  pending: number;
  accepted: number;
  autoAccepted: number;
  rejected: number;
  revoked: number;
  /** Candidates the operator still has to act on (pending). */
  needsReview: number;
  /** Pending candidates the governance policy would auto-accept. */
  autoAcceptEligible: number;
  /** Candidates carrying a generated/low-confidence warning. */
  warned: number;
}>;

/** A grouping of candidates by one scope dimension (e.g. one expansion). */
export type CatalogAliasReviewGroupSummary = Readonly<{
  scope: CatalogAliasReviewScopeKey;
  /** The grouping value (provider key, language code, series/expansion id, …). */
  value: string;
  label: string;
  counts: CatalogAliasReviewCounts;
}>;

/** Coverage classification for a single reviewed target (Catalog Item). */
export type CatalogAliasCoverageState =
  | "accepted-english-alias"
  | "species-aliases-only"
  | "needs-review"
  | "no-aliases";

/**
 * Coverage cards for a provider setup / import scope. Each counter makes it clear
 * whether a scope is ready for promotion/search, per the acceptance criteria.
 */
export type CatalogAliasCoverageReadModel = Readonly<{
  /** Catalog Items (cards) with at least one accepted/auto-accepted English alias. */
  cardsWithAcceptedEnglishAlias: number;
  /** Catalog Items whose only accepted aliases are species names (recall-only). */
  cardsWithOnlySpeciesAliases: number;
  /** Catalog Items that still have pending alias candidates needing review. */
  cardsNeedingReview: number;
  /** Reference Records (expansions/series) with pending set/series-equivalent candidates. */
  expansionsAndSeriesNeedingReview: number;
  /** Per-target rows backing the counters above. */
  cards: readonly CatalogAliasCoverageCard[];
  referenceScopes: readonly CatalogAliasCoverageReferenceScope[];
}>;

export type CatalogAliasCoverageCard = Readonly<{
  catalogItemId: string;
  /** Best-known printed name for the card (native or English). */
  displayName: string;
  state: CatalogAliasCoverageState;
  hasAcceptedEnglishAlias: boolean;
  acceptedSpeciesAliasCount: number;
  pendingCandidateCount: number;
}>;

export type CatalogAliasCoverageReferenceScope = Readonly<{
  referenceRecordId: string | null;
  typeKey: string;
  displayName: string;
  pendingCandidateCount: number;
  acceptedAliasCount: number;
}>;

/** The full admin alias review read model for a selected provider/scope. */
export type CatalogAliasReviewReadModel = Readonly<{
  schemaVersion: CatalogAliasReviewContractVersion;
  generatedAt: string;
  filter: CatalogAliasReviewFilter;
  counts: CatalogAliasReviewCounts;
  candidates: readonly CatalogAliasReviewCandidateSummary[];
  /** Candidate groupings by each scope dimension that has values present. */
  groups: readonly CatalogAliasReviewGroupSummary[];
  coverage: CatalogAliasCoverageReadModel;
}>;

/** The operator-facing filter narrowing the review scope. */
export type CatalogAliasReviewFilter = Readonly<{
  providerKey: string | null;
  sourceProfileVersion: string | null;
  aliasType: CatalogAliasTypeKey | null;
  reviewStatuses: readonly CatalogAliasReviewStateKey[];
  observationId: string | null;
  /**
   * Narrow to one alias target (kind + id), e.g. the one Reference Record a
   * Scope Detail language-editions section reviews. Both fields are required
   * together: a bare `targetKind` with no `targetId` would match every
   * candidate of that kind, which no caller wants.
   */
  targetKind: CatalogAliasTargetKind | null;
  targetId: string | null;
}>;

const ENGLISH_LANGUAGE_CODE = "en";
const INDONESIAN_LANGUAGE_CODE = "id";
const SPECIES_ALIAS_TYPE: CatalogAliasTypeKey = "species-name";
const PUBLISHABLE = new Set<CatalogAliasReviewStateKey>(CATALOG_ALIAS_PUBLISHABLE_REVIEW_STATES);

// --- Candidate mapping ------------------------------------------------------

/**
 * Map a raw alias candidate row to its operator-facing summary, computing
 * auto-accept eligibility from governance and surfacing generated/low-confidence
 * warnings so the operator understands why the candidate exists.
 */
export function mapCatalogAliasReviewCandidate(row: CatalogAliasCandidateRow): CatalogAliasReviewCandidateSummary {
  const evidence = readEvidenceObject(row.evidence);
  const autoAccept = autoAcceptEligibility(row);
  const warnings = candidateWarnings(row, autoAccept);
  const reviewable = row.review_status === "pending";

  return {
    aliasHash: row.alias_hash,
    targetKind: row.target_kind,
    targetId: row.target_id,
    targetKey: row.target_key,
    nativePrintedName: nativePrintedName(row, evidence),
    nativeLanguageCode: nativeLanguageCode(row),
    proposedAlias: row.alias_text,
    aliasLanguageCode: row.alias_language_code,
    aliasType: row.alias_type,
    confidence: row.confidence as CatalogAliasConfidenceKey,
    reviewStatus: row.review_status,
    sourceCategory: row.source_category as CatalogAliasSourceCategoryKey,
    providerKey: row.provider_key,
    observationId: row.observation_id,
    sourceProfileKey: row.source_profile_key,
    sourceProfileVersion: row.source_profile_version,
    evidence: evidenceLines(row, evidence),
    warnings,
    autoAccept,
    reviewable,
    availableActions: availableActions(row.review_status, autoAccept.eligible),
    firstObservedAt: row.first_observed_at,
    updatedAt: row.updated_at,
  };
}

function autoAcceptEligibility(row: CatalogAliasCandidateRow): CatalogAliasReviewAutoAcceptEligibility {
  const decision = decideCatalogAliasAcceptance({
    category: row.source_category as CatalogAliasSourceCategoryKey,
    languageCode: row.source_language_code ?? row.alias_language_code,
  });
  return {
    // Only a still-pending candidate that governance would auto-accept is
    // eligible for the bulk auto-accept action; already-resolved aliases are not.
    eligible: row.review_status === "pending" && decision.reviewState === "auto-accepted",
    governedReviewState: decision.reviewState,
    official: decision.official,
    policyVersion: decision.policyVersion,
    reasons: decision.reasons,
  };
}

function candidateWarnings(
  row: CatalogAliasCandidateRow,
  autoAccept: CatalogAliasReviewAutoAcceptEligibility,
): readonly CatalogAliasReviewWarningKey[] {
  const warnings: CatalogAliasReviewWarningKey[] = [];
  if (row.alias_type === "generated-translation") {
    warnings.push("generated-translation");
  }
  if (row.confidence === "generated" || row.confidence === "candidate") {
    warnings.push("low-confidence-evidence");
  }
  if (autoAccept.governedReviewState === "pending" && isNeverOfficialCategory(row.source_category)) {
    warnings.push("never-official-source");
  }
  if ((row.source_language_code ?? "").toLowerCase() === INDONESIAN_LANGUAGE_CODE) {
    warnings.push("indonesian-id-not-english");
  }
  return warnings;
}

function isNeverOfficialCategory(category: string): boolean {
  return category === "machine-translation" || category === "romanization";
}

function availableActions(
  reviewStatus: CatalogAliasReviewStateKey,
  autoAcceptEligible: boolean,
): readonly CatalogAliasReviewActionKey[] {
  if (PUBLISHABLE.has(reviewStatus)) {
    // Accepted/auto-accepted aliases can only be revoked.
    return ["revoke"];
  }
  if (reviewStatus === "pending") {
    return autoAcceptEligible ? ["accept", "auto-accept", "reject", "defer"] : ["accept", "reject", "defer"];
  }
  // Rejected/revoked aliases can be re-accepted if evidence warrants.
  return ["accept"];
}

function nativePrintedName(row: CatalogAliasCandidateRow, evidence: Record<string, JsonValue>): string {
  // When the candidate IS the native (non-English) provider name, the alias text
  // is the native printed name. Otherwise the native name lives in evidence.
  if (row.alias_type === "provider-localized-name") {
    return row.alias_text;
  }
  const fromEvidence = stringEvidence(evidence, "nativeName") ?? stringEvidence(evidence, "sourceName");
  if (fromEvidence) {
    return fromEvidence;
  }
  // Fall back to the alias text so the operator never sees an empty cell.
  return row.alias_text;
}

function nativeLanguageCode(row: CatalogAliasCandidateRow): string | null {
  if (row.alias_type === "provider-localized-name") {
    return row.alias_language_code;
  }
  return row.source_language_code;
}

function evidenceLines(
  row: CatalogAliasCandidateRow,
  evidence: Record<string, JsonValue>,
): readonly CatalogAliasReviewEvidenceLine[] {
  const lines: CatalogAliasReviewEvidenceLine[] = [
    {
      key: "sourceCategory",
      label: t("catalog.features.sourceObservations.ui.aliasReview.evidence.sourceCategory"),
      value: row.source_category,
    },
    {
      key: "provider",
      label: t("catalog.features.sourceObservations.ui.aliasReview.evidence.provider"),
      value: row.provider_key,
    },
    {
      key: "sourceProfileVersion",
      label: t("catalog.features.sourceObservations.ui.aliasReview.evidence.profileVersion"),
      value: row.source_profile_version,
    },
  ];
  const providerId = stringEvidence(evidence, "providerId");
  if (providerId) {
    lines.push({
      key: "providerId",
      label: t("catalog.features.sourceObservations.ui.aliasReview.evidence.providerId"),
      value: providerId,
    });
  }
  const evidenceKind = stringEvidence(evidence, "evidenceKind");
  if (evidenceKind) {
    lines.push({
      key: "evidenceKind",
      label: t("catalog.features.sourceObservations.ui.aliasReview.evidence.evidenceKind"),
      value: evidenceKind,
    });
  }
  if (row.observation_id) {
    lines.push({
      key: "observationId",
      label: t("catalog.features.sourceObservations.ui.aliasReview.evidence.sourceObservation"),
      value: row.observation_id,
    });
  }
  if (row.source_language_code) {
    lines.push({
      key: "sourceLanguageCode",
      label: t("catalog.features.sourceObservations.ui.aliasReview.evidence.nativeLanguage"),
      value: row.source_language_code,
    });
  }
  return lines;
}

// --- Counts and groups ------------------------------------------------------

export function summarizeCatalogAliasReviewCounts(
  candidates: readonly CatalogAliasReviewCandidateSummary[],
): CatalogAliasReviewCounts {
  const counts = {
    total: candidates.length,
    pending: 0,
    accepted: 0,
    autoAccepted: 0,
    rejected: 0,
    revoked: 0,
    needsReview: 0,
    autoAcceptEligible: 0,
    warned: 0,
  };
  for (const candidate of candidates) {
    switch (candidate.reviewStatus) {
      case "pending":
        counts.pending += 1;
        counts.needsReview += 1;
        break;
      case "accepted":
        counts.accepted += 1;
        break;
      case "auto-accepted":
        counts.autoAccepted += 1;
        break;
      case "rejected":
        counts.rejected += 1;
        break;
      case "revoked":
        counts.revoked += 1;
        break;
    }
    if (candidate.autoAccept.eligible) {
      counts.autoAcceptEligible += 1;
    }
    if (candidate.warnings.length > 0) {
      counts.warned += 1;
    }
  }
  return counts;
}

function buildGroups(
  candidates: readonly CatalogAliasReviewCandidateSummary[],
): readonly CatalogAliasReviewGroupSummary[] {
  const groups: CatalogAliasReviewGroupSummary[] = [];
  for (const scope of catalogAliasReviewScopeKeys) {
    const byValue = new Map<string, CatalogAliasReviewCandidateSummary[]>();
    for (const candidate of candidates) {
      const value = scopeValue(scope, candidate);
      if (value === null) {
        continue;
      }
      const bucket = byValue.get(value) ?? [];
      bucket.push(candidate);
      byValue.set(value, bucket);
    }
    for (const [value, bucket] of [...byValue.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      groups.push({
        scope,
        value,
        label: value,
        counts: summarizeCatalogAliasReviewCounts(bucket),
      });
    }
  }
  return groups;
}

function scopeValue(scope: CatalogAliasReviewScopeKey, candidate: CatalogAliasReviewCandidateSummary): string | null {
  switch (scope) {
    case "provider":
      return candidate.providerKey || null;
    case "unit":
      return candidate.sourceProfileKey || null;
    case "language":
      return candidate.aliasLanguageCode || null;
    case "series":
      return candidate.targetKind === "reference-record" && candidate.targetKey === "series"
        ? (candidate.targetId ?? candidate.targetKey)
        : null;
    case "expansion":
      return candidate.targetKind === "reference-record" && candidate.targetKey === "expansion"
        ? (candidate.targetId ?? candidate.targetKey)
        : null;
    case "source-observation":
      return candidate.observationId;
    case "catalog-item":
      return candidate.targetKind === "catalog-item" ? candidate.targetId : null;
    case "reference-record":
      return candidate.targetKind === "reference-record" ? candidate.targetId : null;
  }
}

// --- Coverage ---------------------------------------------------------------

/**
 * Classify alias coverage for the selected scope. Combines pending candidates
 * (still needing review) with accepted Catalog Item / Reference Record aliases
 * so the operator can see whether a scope is ready for promotion/search.
 */
export function buildCatalogAliasCoverage(input: {
  candidates: readonly CatalogAliasReviewCandidateSummary[];
  catalogItemAliases: readonly CatalogItemAliasRow[];
  referenceRecordAliases: readonly CatalogReferenceRecordAliasRow[];
}): CatalogAliasCoverageReadModel {
  const cardsById = new Map<string, MutableCoverageCard>();
  const referenceById = new Map<string, MutableCoverageReference>();

  // Pending candidates contribute "needs review" signal per target.
  for (const candidate of input.candidates) {
    if (candidate.reviewStatus !== "pending") {
      continue;
    }
    if (candidate.targetKind === "catalog-item" && candidate.targetId) {
      const card = ensureCard(cardsById, candidate.targetId, candidate.nativePrintedName || candidate.proposedAlias);
      card.pendingCandidateCount += 1;
    } else if (candidate.targetKind === "reference-record") {
      const key = candidate.targetId ?? candidate.targetKey;
      const reference = ensureReference(
        referenceById,
        candidate.targetId,
        candidate.targetKey,
        candidate.proposedAlias,
      );
      reference.pendingCandidateCount += 1;
      referenceById.set(key, reference);
    }
  }

  // Accepted Catalog Item aliases contribute the English/species coverage signal.
  for (const alias of input.catalogItemAliases) {
    if (!PUBLISHABLE.has(alias.review_status)) {
      continue;
    }
    const card = ensureCard(cardsById, alias.catalog_item_id, alias.alias_text);
    if (alias.alias_language_code.toLowerCase() === ENGLISH_LANGUAGE_CODE && alias.alias_type !== SPECIES_ALIAS_TYPE) {
      card.hasAcceptedEnglishAlias = true;
    }
    if (alias.alias_type === SPECIES_ALIAS_TYPE) {
      card.acceptedSpeciesAliasCount += 1;
    }
  }

  for (const alias of input.referenceRecordAliases) {
    const key = alias.reference_record_id ?? alias.type_key;
    const reference = ensureReference(referenceById, alias.reference_record_id, alias.type_key, alias.alias_text);
    if (PUBLISHABLE.has(alias.review_status)) {
      reference.acceptedAliasCount += 1;
    }
    referenceById.set(key, reference);
  }

  const cards = [...cardsById.values()]
    .map(finalizeCard)
    .sort((a, b) => a.catalogItemId.localeCompare(b.catalogItemId));
  const referenceScopes = [...referenceById.values()]
    .map(finalizeReference)
    .sort((a, b) => (a.referenceRecordId ?? a.typeKey).localeCompare(b.referenceRecordId ?? b.typeKey));

  return {
    cardsWithAcceptedEnglishAlias: cards.filter((card) => card.state === "accepted-english-alias").length,
    cardsWithOnlySpeciesAliases: cards.filter((card) => card.state === "species-aliases-only").length,
    cardsNeedingReview: cards.filter((card) => card.state === "needs-review").length,
    expansionsAndSeriesNeedingReview: referenceScopes.filter((scope) => scope.pendingCandidateCount > 0).length,
    cards,
    referenceScopes,
  };
}

type MutableCoverageCard = {
  catalogItemId: string;
  displayName: string;
  hasAcceptedEnglishAlias: boolean;
  acceptedSpeciesAliasCount: number;
  pendingCandidateCount: number;
};

type MutableCoverageReference = {
  referenceRecordId: string | null;
  typeKey: string;
  displayName: string;
  pendingCandidateCount: number;
  acceptedAliasCount: number;
};

function ensureCard(map: Map<string, MutableCoverageCard>, catalogItemId: string, displayName: string) {
  const existing = map.get(catalogItemId);
  if (existing) {
    if (!existing.displayName && displayName) {
      existing.displayName = displayName;
    }
    return existing;
  }
  const card: MutableCoverageCard = {
    catalogItemId,
    displayName,
    hasAcceptedEnglishAlias: false,
    acceptedSpeciesAliasCount: 0,
    pendingCandidateCount: 0,
  };
  map.set(catalogItemId, card);
  return card;
}

function ensureReference(
  map: Map<string, MutableCoverageReference>,
  referenceRecordId: string | null,
  typeKey: string,
  displayName: string,
) {
  const key = referenceRecordId ?? typeKey;
  const existing = map.get(key);
  if (existing) {
    if (!existing.displayName && displayName) {
      existing.displayName = displayName;
    }
    return existing;
  }
  const reference: MutableCoverageReference = {
    referenceRecordId,
    typeKey,
    displayName,
    pendingCandidateCount: 0,
    acceptedAliasCount: 0,
  };
  map.set(key, reference);
  return reference;
}

function finalizeCard(card: MutableCoverageCard): CatalogAliasCoverageCard {
  return {
    catalogItemId: card.catalogItemId,
    displayName: card.displayName,
    state: coverageState(card),
    hasAcceptedEnglishAlias: card.hasAcceptedEnglishAlias,
    acceptedSpeciesAliasCount: card.acceptedSpeciesAliasCount,
    pendingCandidateCount: card.pendingCandidateCount,
  };
}

function coverageState(card: MutableCoverageCard): CatalogAliasCoverageState {
  if (card.hasAcceptedEnglishAlias) {
    return "accepted-english-alias";
  }
  if (card.pendingCandidateCount > 0) {
    return "needs-review";
  }
  if (card.acceptedSpeciesAliasCount > 0) {
    return "species-aliases-only";
  }
  return "no-aliases";
}

function finalizeReference(reference: MutableCoverageReference): CatalogAliasCoverageReferenceScope {
  return {
    referenceRecordId: reference.referenceRecordId,
    typeKey: reference.typeKey,
    displayName: reference.displayName,
    pendingCandidateCount: reference.pendingCandidateCount,
    acceptedAliasCount: reference.acceptedAliasCount,
  };
}

// --- Read-model assembly ----------------------------------------------------

/**
 * Build the full alias review read model from already-fetched rows. Pure: the
 * caller fetches candidate rows plus the accepted Catalog Item / Reference Record
 * aliases for the targets in scope, and this assembles the operator view.
 */
export function buildCatalogAliasReviewReadModel(input: {
  generatedAt: string;
  filter: CatalogAliasReviewFilter;
  candidateRows: readonly CatalogAliasCandidateRow[];
  catalogItemAliasRows: readonly CatalogItemAliasRow[];
  referenceRecordAliasRows: readonly CatalogReferenceRecordAliasRow[];
}): CatalogAliasReviewReadModel {
  const candidates = input.candidateRows.map(mapCatalogAliasReviewCandidate);
  return {
    schemaVersion: catalogAliasReviewContractVersion,
    generatedAt: input.generatedAt,
    filter: input.filter,
    counts: summarizeCatalogAliasReviewCounts(candidates),
    candidates,
    groups: buildGroups(candidates),
    coverage: buildCatalogAliasCoverage({
      candidates,
      catalogItemAliases: input.catalogItemAliasRows,
      referenceRecordAliases: input.referenceRecordAliasRows,
    }),
  };
}

/** Read services the alias review assembler needs (a subset of CatalogAliasServices). */
export type CatalogAliasReviewQueryServices = Readonly<{
  listSourceObservationAliasCandidates: (
    filter?: CatalogAliasCandidateFilter,
  ) => Promise<readonly CatalogAliasCandidateRow[]>;
  listCatalogItemAliases: (
    catalogItemId: string,
    options?: { reviewStatuses?: readonly CatalogAliasReviewStateKey[] },
  ) => Promise<readonly CatalogItemAliasRow[]>;
  listReferenceRecordAliases: (
    referenceRecordId: string,
    options?: { reviewStatuses?: readonly CatalogAliasReviewStateKey[] },
  ) => Promise<readonly CatalogReferenceRecordAliasRow[]>;
}>;

/**
 * Assemble the alias review read model from the live read-model services. Fetches
 * candidates for the filtered scope, then the accepted aliases for every distinct
 * Catalog Item / Reference Record target the candidates touch, so coverage
 * reflects what is already published.
 */
export async function assembleCatalogAliasReviewReadModel(
  services: CatalogAliasReviewQueryServices,
  input: {
    generatedAt: string;
    filter?: Partial<CatalogAliasReviewFilter>;
    candidateLimit?: number;
  },
): Promise<CatalogAliasReviewReadModel> {
  const filter = normalizeFilter(input.filter);
  const candidateRows = await services.listSourceObservationAliasCandidates({
    providerKey: filter.providerKey ?? undefined,
    sourceProfileVersion: filter.sourceProfileVersion ?? undefined,
    aliasType: filter.aliasType ?? undefined,
    reviewStatuses: filter.reviewStatuses.length > 0 ? filter.reviewStatuses : undefined,
    observationId: filter.observationId ?? undefined,
    targetKind: filter.targetKind ?? undefined,
    targetId: filter.targetId ?? undefined,
    limit: input.candidateLimit,
  });

  const catalogItemIds = distinctTargetIds(candidateRows, "catalog-item");
  const referenceRecordIds = distinctTargetIds(candidateRows, "reference-record");

  const [catalogItemAliasRows, referenceRecordAliasRows] = await Promise.all([
    fetchMany(catalogItemIds, (id) => services.listCatalogItemAliases(id)),
    fetchMany(referenceRecordIds, (id) => services.listReferenceRecordAliases(id)),
  ]);

  return buildCatalogAliasReviewReadModel({
    generatedAt: input.generatedAt,
    filter,
    candidateRows,
    catalogItemAliasRows,
    referenceRecordAliasRows,
  });
}

function normalizeFilter(filter: Partial<CatalogAliasReviewFilter> | undefined): CatalogAliasReviewFilter {
  return {
    providerKey: filter?.providerKey ?? null,
    sourceProfileVersion: filter?.sourceProfileVersion ?? null,
    aliasType: filter?.aliasType ?? null,
    reviewStatuses: filter?.reviewStatuses ?? [],
    observationId: filter?.observationId ?? null,
    targetKind: filter?.targetKind ?? null,
    targetId: filter?.targetId ?? null,
  };
}

function distinctTargetIds(rows: readonly CatalogAliasCandidateRow[], kind: CatalogAliasTargetKind): readonly string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.target_kind === kind && row.target_id) {
      ids.add(row.target_id);
    }
  }
  return [...ids];
}

async function fetchMany<T>(ids: readonly string[], fetchOne: (id: string) => Promise<readonly T[]>): Promise<T[]> {
  const results = await Promise.all(ids.map(fetchOne));
  return results.flat();
}

function readEvidenceObject(evidence: JsonValue): Record<string, JsonValue> {
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) {
    return evidence as Record<string, JsonValue>;
  }
  return {};
}

function stringEvidence(evidence: Record<string, JsonValue>, key: string): string | null {
  const value = evidence[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/** Reference-record alias types, re-exported so the UI can label series/expansion scopes. */
export function isReferenceLevelAliasType(aliasType: CatalogAliasTypeKey): boolean {
  return isReferenceRecordAliasType(aliasType);
}
