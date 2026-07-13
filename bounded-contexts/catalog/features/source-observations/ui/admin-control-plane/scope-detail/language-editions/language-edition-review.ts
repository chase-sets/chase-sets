import type {
  CatalogAliasReviewCandidateSummary,
  CatalogAliasReviewReadModel,
} from "../../../../../alias-equivalence/api/alias-review-admin-contracts";

// ---------------------------------------------------------------------------
// Scope Detail — language editions review
//
// A pure composer that turns one scope's `language_editions` attribute plus
// the alias review read model (already scoped by the caller to
// `targetKind: "reference-record", targetId: <this scope's reference record>`)
// into an operator-facing per-edition view: sync/link state, accepted alias
// count, and the pending set-equivalent / series-equivalent candidates for
// THIS scope only — never the generic all-scopes alias table.
//
// The canonical edition (the language the Reference Record's own name and
// identity are recorded in — English, per the alias source-governance policy)
// needs no alias to be "linked": it already IS the reference record. Every
// other edition links via an accepted `set-equivalent`/`series-equivalent`
// alias whose `aliasLanguageCode` matches the edition and whose target is
// this scope's reference record.
// ---------------------------------------------------------------------------

export const CATALOG_SCOPE_CANONICAL_LANGUAGE_CODE = "en";

export type CatalogScopeLanguageEditionLinkState = "linked" | "pending-review" | "not-yet-observed";

export type CatalogScopeLanguageEditionSummary = Readonly<{
  languageCode: string;
  isCanonical: boolean;
  linkState: CatalogScopeLanguageEditionLinkState;
  acceptedAliasCount: number;
  /** Pending set-equivalent/series-equivalent candidates for this edition, this scope only. */
  pendingCandidates: readonly CatalogAliasReviewCandidateSummary[];
  /** Accepted/auto-accepted candidates for this edition, so a linked edition can still be revoked inline. */
  acceptedCandidates: readonly CatalogAliasReviewCandidateSummary[];
}>;

export type CatalogScopeLanguageEditionReviewReadModel = Readonly<{
  scopeRecordId: string;
  referenceRecordId: string;
  editions: readonly CatalogScopeLanguageEditionSummary[];
}>;

export type CatalogScopeLanguageEditionReviewScope = Readonly<{
  scopeRecordId: string;
  referenceRecordId: string;
  languageEditions: readonly string[];
}>;

/**
 * True when a scope has more than one language edition and therefore has a
 * language-editions journey worth showing on Scope Detail: the canonical
 * scope has sibling language editions to review.
 */
export function catalogScopeHasLanguageEditionsToReview(scope: CatalogScopeLanguageEditionReviewScope): boolean {
  return scope.languageEditions.length > 1;
}

export function buildCatalogScopeLanguageEditionReviewReadModel(input: {
  scope: CatalogScopeLanguageEditionReviewScope;
  /** Alias review read model already scoped to this scope's reference record. */
  aliasReview: CatalogAliasReviewReadModel;
}): CatalogScopeLanguageEditionReviewReadModel {
  const { scope, aliasReview } = input;
  const orderedLanguageCodes = orderLanguageEditions(scope.languageEditions);

  const editions = orderedLanguageCodes.map((languageCode) =>
    buildEditionSummary({ languageCode, referenceRecordId: scope.referenceRecordId, aliasReview }),
  );

  return {
    scopeRecordId: scope.scopeRecordId,
    referenceRecordId: scope.referenceRecordId,
    editions,
  };
}

function buildEditionSummary(input: {
  languageCode: string;
  referenceRecordId: string;
  aliasReview: CatalogAliasReviewReadModel;
}): CatalogScopeLanguageEditionSummary {
  const { languageCode, referenceRecordId, aliasReview } = input;
  const isCanonical = languageCode === CATALOG_SCOPE_CANONICAL_LANGUAGE_CODE;

  const candidatesForEdition = aliasReview.candidates.filter(
    (candidate) =>
      candidate.targetKind === "reference-record" &&
      candidate.targetId === referenceRecordId &&
      candidate.aliasLanguageCode === languageCode,
  );
  const pendingCandidates = candidatesForEdition.filter((candidate) => candidate.reviewStatus === "pending");
  const acceptedCandidates = candidatesForEdition.filter(
    (candidate) => candidate.reviewStatus === "accepted" || candidate.reviewStatus === "auto-accepted",
  );

  return {
    languageCode,
    isCanonical,
    linkState: linkStateFor({
      isCanonical,
      acceptedAliasCount: acceptedCandidates.length,
      pendingCandidateCount: pendingCandidates.length,
    }),
    acceptedAliasCount: acceptedCandidates.length,
    pendingCandidates,
    acceptedCandidates,
  };
}

function linkStateFor(input: {
  isCanonical: boolean;
  acceptedAliasCount: number;
  pendingCandidateCount: number;
}): CatalogScopeLanguageEditionLinkState {
  if (input.isCanonical || input.acceptedAliasCount > 0) {
    return "linked";
  }
  if (input.pendingCandidateCount > 0) {
    return "pending-review";
  }
  return "not-yet-observed";
}

/** Canonical edition first, then the rest alphabetically for a stable operator order. */
function orderLanguageEditions(languageEditions: readonly string[]): readonly string[] {
  return [...new Set(languageEditions)].sort((left, right) => {
    if (left === CATALOG_SCOPE_CANONICAL_LANGUAGE_CODE) return -1;
    if (right === CATALOG_SCOPE_CANONICAL_LANGUAGE_CODE) return 1;
    return left.localeCompare(right);
  });
}
