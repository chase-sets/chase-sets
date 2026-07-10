import {
  buildCatalogAliasCandidate,
  isCatalogAliasPublishable,
  isReferenceRecordAliasType,
  type CatalogAliasCandidate,
  type CatalogAliasConfidenceKey,
  type CatalogAliasReviewStateKey,
  type CatalogAliasTargetKind,
  type CatalogAliasTypeKey,
} from "../../alias-equivalence/domain/alias";
import type { CatalogAliasSourceCategoryKey } from "./catalog-integration-data-governance";
import {
  catalogAliasOfficialEnglishPrecedenceOrder,
  resolveCatalogAliasOfficialEnglish,
} from "./catalog-integration-data-governance";

// ---------------------------------------------------------------------------
// Promotion alias planning
//
// Turns the reviewed alias candidates an observation produced into the durable
// alias facts a promotion must write, plus the retractions a promotion must
// drive when previously-accepted aliases are no longer supported.
//
// Promotion runs after the Catalog Item id and Reference Record ids are
// resolved (the Catalog Item alias projection throws unless `catalog_item_id`
// is resolved before a row is written). This planner
// therefore takes the resolved ids, re-resolves every candidate's target, and
// re-builds it through the single `buildCatalogAliasCandidate` constructor so
// the durable `alias_hash` carries the resolved id. The same evidence yields the
// same hash on re-promotion/reapply, so writes are idempotent.
//
// The planner is pure: it returns a typed action list. The runtime drives the
// Catalog Alias aggregate command handler with those actions. Pending, rejected,
// generated, and revoked candidates never become Catalog truth — only
// accepted/auto-accepted candidates produce a publishable alias, and conflicting
// official equivalents are resolved through the source-precedence order.
// ---------------------------------------------------------------------------

/**
 * A reviewed alias candidate persisted by intake, with its target id
 * still unresolved at the candidate stage. The fields are the durable candidate
 * row shape promotion reads back from
 * `catalog_source_observation_alias_candidates`.
 */
export type PromotionAliasCandidate = Readonly<{
  target: Readonly<{ kind: CatalogAliasTargetKind; targetKey: string }>;
  aliasText: string;
  aliasLanguageCode: string;
  sourceLanguageCode: string | null;
  aliasType: CatalogAliasTypeKey;
  confidence: CatalogAliasConfidenceKey;
  reviewStatus: CatalogAliasReviewStateKey;
  provenance: Readonly<{
    providerKey: string;
    observationId: string | null;
    sourceCategory: CatalogAliasSourceCategoryKey;
    sourceProfileKey: string;
    sourceProfileVersion: string;
    mappingFingerprint: string;
  }>;
  evidence: CatalogAliasCandidate["evidence"];
}>;

/**
 * An alias fact already published for a target (an `accepted`/`auto-accepted`
 * row from `catalog_item_aliases` / `catalog_reference_record_aliases`). Used to
 * detect retractions: a published alias no longer supported by an accepted
 * candidate from the same observation must be revoked, not silently kept.
 */
export type PromotionPublishedAlias = Readonly<{
  aliasHash: string;
  reviewStatus: CatalogAliasReviewStateKey;
  observationId: string | null;
  providerKey: string;
}>;

/**
 * Resolved target ids promotion already established before alias planning. The
 * Catalog Item id is always resolved; Reference Record ids are resolved per
 * reference type key (e.g. `expansion`, `series`). A reference type key without
 * a resolved record id is skipped: a key-only candidate row already exists from
 * intake, and resolution can lag set/series provisioning.
 */
export type PromotionAliasTargetResolution = Readonly<{
  catalogItemId: string;
  referenceRecordIdsByTypeKey: Readonly<Record<string, string>>;
}>;

export type PromotionAliasActionReason =
  | "accepted-candidate"
  | "evidence-only-candidate"
  | "conflict-outranked"
  | "rejected-candidate"
  | "revoked-candidate";

/**
 * Propose (and possibly accept) a durable alias fact. `targetResolved` is false
 * only for reference-record candidates whose record id has not been provisioned
 * yet; the runtime persists those as key-only candidates rather than item-level
 * facts (a Catalog Item alias always resolves its id first).
 */
export type PromotionAliasProposeAction = Readonly<{
  kind: "propose";
  reason: PromotionAliasActionReason;
  candidate: CatalogAliasCandidate;
  /** Whether the candidate should also be accepted into a publishable fact. */
  accept: boolean;
  targetResolved: boolean;
}>;

/**
 * Retract a previously-published alias by revoking it. Driven for rejected /
 * revoked candidates and for accepted facts the current evidence no longer
 * supports, so downstream consumers can drop the alias.
 */
export type PromotionAliasRetractAction = Readonly<{
  kind: "retract";
  reason: PromotionAliasActionReason;
  aliasHash: string;
}>;

export type PromotionAliasAction = PromotionAliasProposeAction | PromotionAliasRetractAction;

export type PromotionAliasPlan = Readonly<{
  actions: readonly PromotionAliasAction[];
}>;

export type PlanPromotionAliasesInput = Readonly<{
  candidates: readonly PromotionAliasCandidate[];
  resolution: PromotionAliasTargetResolution;
  /** Aliases already published for the Catalog Item, used to detect retractions. */
  publishedCatalogItemAliases?: readonly PromotionPublishedAlias[];
  /** Aliases already published for each reference record id, keyed by record id. */
  publishedReferenceRecordAliasesByRecordId?: Readonly<Record<string, readonly PromotionPublishedAlias[]>>;
}>;

/**
 * Plan the durable alias writes and retractions for a promotion/reapply pass.
 *
 * Order of operations:
 *   1. Resolve each candidate's target id and re-build it (re-hash) so the fact
 *      carries the resolved id.
 *   2. Decide publishability: only `accepted`/`auto-accepted` candidates publish;
 *      everything else proposes evidence-only (so the candidate is queryable) but
 *      never accepts.
 *   3. Resolve official-equivalent conflicts via the precedence order: when
 *      several accepted official equivalents share normalized text and disagree,
 *      the strongest source wins and the rest are demoted to evidence-only.
 *   4. Compute retractions: rejected/revoked candidates that match a published
 *      alias, and published aliases from this observation no longer supported by
 *      any accepted candidate.
 */
export function planPromotionAliases(input: PlanPromotionAliasesInput): PromotionAliasPlan {
  const resolved = input.candidates
    .map((candidate) => resolveCandidate(candidate, input.resolution))
    .filter((entry): entry is ResolvedPromotionAliasCandidate => entry !== null);

  const publishableHashes = decidePublishableHashes(resolved);

  // Build a propose action for every candidate that carries publication intent
  // (accepted/auto-accepted/pending source). Rejected and revoked source
  // candidates are handled by retraction only — proposing them would create
  // noise and they can never publish.
  //
  // The proposed event carries the alias's review status into the projection, so
  // a candidate that must not publish (conflict loser, unresolved target) is
  // proposed `pending` — queryable as a candidate but never a publishable Catalog
  // fact. The alias hash excludes review status, so this never changes identity
  // and re-promotion stays idempotent.
  const proposeActions: PromotionAliasProposeAction[] = resolved
    .filter((entry) => entry.sourceReviewStatus !== "rejected" && entry.sourceReviewStatus !== "revoked")
    .map((entry) => {
      const publishable = publishableHashes.has(entry.candidate.aliasHash);
      const proposedReviewStatus: CatalogAliasReviewStateKey = publishable ? entry.sourceReviewStatus : "pending";
      return {
        kind: "propose",
        reason: actionReasonFor(entry, publishableHashes),
        candidate: rebuildWithReviewStatus(entry.candidate, proposedReviewStatus),
        // `accept` signals the alias should become a publishable Catalog fact. The
        // writer skips the explicit accept for `auto-accepted` (already published
        // on propose) but still counts it as publishable.
        accept: publishable,
        targetResolved: entry.targetResolved,
      };
    });

  const retractActions = planRetractions({
    resolved,
    publishableHashes,
    publishedCatalogItemAliases: input.publishedCatalogItemAliases ?? [],
    publishedReferenceRecordAliasesByRecordId: input.publishedReferenceRecordAliasesByRecordId ?? {},
  });

  return { actions: [...proposeActions, ...retractActions] };
}

type ResolvedPromotionAliasCandidate = Readonly<{
  candidate: CatalogAliasCandidate;
  /** False only for reference-record candidates whose record id is not resolved. */
  targetResolved: boolean;
  /** Original review status the intake/policy recorded for the candidate. */
  sourceReviewStatus: CatalogAliasReviewStateKey;
}>;

function resolveCandidate(
  candidate: PromotionAliasCandidate,
  resolution: PromotionAliasTargetResolution,
): ResolvedPromotionAliasCandidate | null {
  const targetId = resolveTargetId(candidate, resolution);
  // A Catalog Item alias must resolve its id before a row is written; a missing
  // id here is a programming error in the promotion path, surfaced as a skip so
  // the rest of the plan still proceeds.
  if (candidate.target.kind === "catalog-item" && !targetId) {
    return null;
  }

  const built = buildCatalogAliasCandidate({
    target: {
      kind: candidate.target.kind,
      targetId,
      targetKey: candidate.target.targetKey,
    },
    aliasText: candidate.aliasText,
    aliasLanguageCode: candidate.aliasLanguageCode,
    sourceLanguageCode: candidate.sourceLanguageCode,
    aliasType: candidate.aliasType,
    confidence: candidate.confidence,
    // Identity is independent of review status; preserve provenance and the
    // candidate's recorded review status as the proposed status.
    reviewStatus: candidate.reviewStatus,
    provenance: candidate.provenance,
    evidence: candidate.evidence,
  });

  return {
    candidate: built,
    targetResolved: candidate.target.kind === "catalog-item" ? true : targetId !== null,
    sourceReviewStatus: candidate.reviewStatus,
  };
}

/**
 * Re-build a candidate with a different proposed review status. The alias hash is
 * computed over identity fields only (review status excluded), so the rebuilt
 * candidate keeps the same hash and idempotency is preserved.
 */
function rebuildWithReviewStatus(
  candidate: CatalogAliasCandidate,
  reviewStatus: CatalogAliasReviewStateKey,
): CatalogAliasCandidate {
  if (candidate.reviewStatus === reviewStatus) {
    return candidate;
  }
  return { ...candidate, reviewStatus };
}

function resolveTargetId(
  candidate: PromotionAliasCandidate,
  resolution: PromotionAliasTargetResolution,
): string | null {
  if (candidate.target.kind === "catalog-item") {
    return resolution.catalogItemId;
  }
  return resolution.referenceRecordIdsByTypeKey[candidate.target.targetKey.trim().toLowerCase()] ?? null;
}

/**
 * Decide which built candidates publish. Only `accepted`/`auto-accepted`
 * candidates with a resolved target are eligible, and conflicting official
 * equivalents are narrowed to the precedence winner.
 */
function decidePublishableHashes(resolved: readonly ResolvedPromotionAliasCandidate[]): ReadonlySet<string> {
  const eligible = resolved.filter(
    (entry) => entry.targetResolved && isCatalogAliasPublishable(entry.sourceReviewStatus),
  );

  const conflictLosers = officialEquivalentConflictLosers(eligible);

  return new Set(
    eligible
      .filter((entry) => !conflictLosers.has(entry.candidate.aliasHash))
      .map((entry) => entry.candidate.aliasHash),
  );
}

/**
 * Among eligible accepted official-equivalent candidates that share normalized
 * alias text + language for the same target, find the ones outranked by the
 * source precedence so they are demoted to evidence-only instead of
 * silently competing as Catalog truth.
 */
function officialEquivalentConflictLosers(eligible: readonly ResolvedPromotionAliasCandidate[]): ReadonlySet<string> {
  const precedence = catalogAliasOfficialEnglishPrecedenceOrder();
  const officialEquivalents = eligible.filter((entry) => entry.candidate.aliasType === "official-equivalent");
  if (officialEquivalents.length < 2) {
    return new Set();
  }

  const losers = new Set<string>();
  const groups = groupBy(officialEquivalents, (entry) =>
    [
      entry.candidate.target.kind,
      entry.candidate.target.targetId ?? "",
      entry.candidate.target.targetKey,
      entry.candidate.normalizedAliasText,
      entry.candidate.aliasLanguageCode,
    ].join(" "),
  );

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const winner = resolveCatalogAliasOfficialEnglish(
      group.map((entry) => ({
        category: entry.candidate.provenance.sourceCategory,
        englishName: entry.candidate.aliasText,
        languageCode: entry.candidate.aliasLanguageCode,
      })),
    ).winner;
    const winnerHash = winner ? winnerHashFor(group, winner.category, precedence) : null;
    for (const entry of group) {
      if (entry.candidate.aliasHash !== winnerHash) {
        losers.add(entry.candidate.aliasHash);
      }
    }
  }

  return losers;
}

function winnerHashFor(
  group: readonly ResolvedPromotionAliasCandidate[],
  winningCategory: CatalogAliasSourceCategoryKey,
  precedence: readonly CatalogAliasSourceCategoryKey[],
): string | null {
  // The winner is the first member of the strongest category. If the resolver
  // returned a category, prefer it; otherwise fall back to precedence order so
  // the choice is deterministic and one alias always wins.
  const byCategory = group.filter((entry) => entry.candidate.provenance.sourceCategory === winningCategory);
  if (byCategory.length > 0) {
    return byCategory[0]?.candidate.aliasHash ?? null;
  }
  for (const category of precedence) {
    const match = group.find((entry) => entry.candidate.provenance.sourceCategory === category);
    if (match) {
      return match.candidate.aliasHash;
    }
  }
  return group[0]?.candidate.aliasHash ?? null;
}

function planRetractions(input: {
  resolved: readonly ResolvedPromotionAliasCandidate[];
  publishableHashes: ReadonlySet<string>;
  publishedCatalogItemAliases: readonly PromotionPublishedAlias[];
  publishedReferenceRecordAliasesByRecordId: Readonly<Record<string, readonly PromotionPublishedAlias[]>>;
}): readonly PromotionAliasRetractAction[] {
  const retractions: PromotionAliasRetractAction[] = [];
  const seen = new Set<string>();

  const publishedByHash = new Map<string, PromotionPublishedAlias>();
  for (const published of [
    ...input.publishedCatalogItemAliases,
    ...Object.values(input.publishedReferenceRecordAliasesByRecordId).flat(),
  ]) {
    publishedByHash.set(published.aliasHash, published);
  }

  // Explicit rejected/revoked candidates whose resolved hash matches a still
  // publishable fact are retracted through a revoke, not left as silent Catalog
  // truth, so downstream consumers can drop them. This is the reliable
  // retraction signal: an operator's reject/revoke review decision. Changed
  // provider evidence is handled review-first by intake re-proposing affected
  // candidates as `pending`, so promotion never silently auto-revokes an alias
  // that an operator still accepts.
  for (const entry of input.resolved) {
    if (entry.sourceReviewStatus !== "rejected" && entry.sourceReviewStatus !== "revoked") {
      continue;
    }
    const published = publishedByHash.get(entry.candidate.aliasHash);
    if (published && isCatalogAliasPublishable(published.reviewStatus) && !seen.has(entry.candidate.aliasHash)) {
      seen.add(entry.candidate.aliasHash);
      retractions.push({
        kind: "retract",
        reason: entry.sourceReviewStatus === "rejected" ? "rejected-candidate" : "revoked-candidate",
        aliasHash: entry.candidate.aliasHash,
      });
    }
  }

  return retractions;
}

function actionReasonFor(
  entry: ResolvedPromotionAliasCandidate,
  publishableHashes: ReadonlySet<string>,
): PromotionAliasActionReason {
  if (publishableHashes.has(entry.candidate.aliasHash)) {
    return "accepted-candidate";
  }
  if (
    isCatalogAliasPublishable(entry.sourceReviewStatus) &&
    entry.targetResolved &&
    entry.candidate.aliasType === "official-equivalent"
  ) {
    // It was accepted but lost a same-text official-equivalent conflict.
    return "conflict-outranked";
  }
  return "evidence-only-candidate";
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

export { isReferenceRecordAliasType };
