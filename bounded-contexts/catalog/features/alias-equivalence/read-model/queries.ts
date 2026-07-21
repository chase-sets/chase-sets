import type { JsonValue } from "@chase-sets/primitives/json";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { catalogIsoUtcTimestampColumns } from "../../../support/runtime-support/iso-utc-timestamp";
import type { CatalogAliasReviewStateKey, CatalogAliasTargetKind, CatalogAliasTypeKey } from "../domain/alias";
import { CATALOG_ALIAS_PUBLISHABLE_REVIEW_STATES } from "../domain/alias";

// ---------------------------------------------------------------------------
// Catalog Alias read-model queries
//
// Read APIs needed by:
//   - admin review: list candidates and accepted aliases by review state.
//   - promotion: list pending candidates to act on, and accepted aliases
//     for a target.
//   - reapply / backfill: list candidates by provider profile version.
//   - removal: look up an alias by hash and list publishable aliases for a
//     target so a revoke can find what to drop downstream.
//
// Every query that feeds downstream search/display gates on publishable review
// states so rejected/pending/revoked/generated aliases never leak as
// high-weight aliases.
// ---------------------------------------------------------------------------

export type CatalogAliasCandidateRow = Readonly<{
  alias_hash: string;
  target_kind: CatalogAliasTargetKind;
  target_id: string | null;
  target_key: string;
  alias_text: string;
  normalized_alias_text: string;
  alias_language_code: string;
  source_language_code: string | null;
  alias_type: CatalogAliasTypeKey;
  confidence: string;
  review_status: CatalogAliasReviewStateKey;
  provider_key: string;
  observation_id: string | null;
  source_category: string;
  source_profile_key: string;
  source_profile_version: string;
  mapping_fingerprint: string;
  evidence: JsonValue;
  first_observed_at: string;
  updated_at: string;
}>;

export type CatalogItemAliasRow = Readonly<{
  alias_hash: string;
  catalog_item_id: string;
  target_field: string;
  alias_text: string;
  normalized_alias_text: string;
  alias_language_code: string;
  source_language_code: string | null;
  alias_type: CatalogAliasTypeKey;
  confidence: string;
  review_status: CatalogAliasReviewStateKey;
  provider_key: string;
  observation_id: string | null;
  source_category: string;
  source_profile_key: string;
  source_profile_version: string;
  mapping_fingerprint: string;
  evidence: JsonValue;
  last_actor: string | null;
  last_reason: string | null;
  policy_version: string;
  proposed_at: string;
  reviewed_at: string | null;
  updated_at: string;
}>;

export type CatalogReferenceRecordAliasRow = Readonly<{
  alias_hash: string;
  reference_record_id: string | null;
  type_key: string;
  alias_text: string;
  normalized_alias_text: string;
  alias_language_code: string;
  source_language_code: string | null;
  alias_type: CatalogAliasTypeKey;
  confidence: string;
  review_status: CatalogAliasReviewStateKey;
  provider_key: string;
  observation_id: string | null;
  source_category: string;
  source_profile_key: string;
  source_profile_version: string;
  mapping_fingerprint: string;
  evidence: JsonValue;
  last_actor: string | null;
  last_reason: string | null;
  policy_version: string;
  proposed_at: string;
  reviewed_at: string | null;
  updated_at: string;
}>;

export type CatalogAliasCandidateFilter = Readonly<{
  targetKind?: CatalogAliasTargetKind;
  targetId?: string;
  targetKey?: string;
  reviewStatuses?: readonly CatalogAliasReviewStateKey[];
  aliasType?: CatalogAliasTypeKey;
  providerKey?: string;
  sourceProfileVersion?: string;
  observationId?: string;
  limit?: number;
}>;

const PUBLISHABLE = [...CATALOG_ALIAS_PUBLISHABLE_REVIEW_STATES];

// --- Candidates ------------------------------------------------------------

/** Admin review + promotion: list alias candidates by review state and scope. */
export async function listSourceObservationAliasCandidates(
  db: PgQueryable,
  filter: CatalogAliasCandidateFilter = {},
): Promise<readonly CatalogAliasCandidateRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.targetKind) {
    values.push(filter.targetKind);
    conditions.push(`target_kind = $${values.length}`);
  }
  if (filter.targetId) {
    values.push(filter.targetId);
    conditions.push(`target_id = $${values.length}`);
  }
  if (filter.targetKey) {
    values.push(filter.targetKey);
    conditions.push(`target_key = $${values.length}`);
  }
  if (filter.reviewStatuses && filter.reviewStatuses.length > 0) {
    values.push(filter.reviewStatuses);
    conditions.push(`review_status = ANY($${values.length}::text[])`);
  }
  if (filter.aliasType) {
    values.push(filter.aliasType);
    conditions.push(`alias_type = $${values.length}`);
  }
  if (filter.providerKey) {
    values.push(filter.providerKey);
    conditions.push(`provider_key = $${values.length}`);
  }
  if (filter.sourceProfileVersion) {
    values.push(filter.sourceProfileVersion);
    conditions.push(`source_profile_version = $${values.length}`);
  }
  if (filter.observationId) {
    values.push(filter.observationId);
    conditions.push(`observation_id = $${values.length}`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = normalizeLimit(filter.limit);
  const result = await db.query<CatalogAliasCandidateRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("first_observed_at", "updated_at")}
     FROM catalog_source_observation_alias_candidates
     ${where}
     ORDER BY catalog_source_observation_alias_candidates.first_observed_at DESC, alias_hash ASC
     LIMIT ${limit}`,
    values,
  );

  return result.rows;
}

/** Reapply / backfill: count candidates produced by a provider profile version. */
export async function countSourceObservationAliasCandidatesByProfileVersion(
  db: PgQueryable,
  providerKey: string,
  sourceProfileVersion: string,
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM catalog_source_observation_alias_candidates
     WHERE provider_key = $1 AND source_profile_version = $2`,
    [providerKey, sourceProfileVersion],
  );

  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function getSourceObservationAliasCandidate(
  db: PgQueryable,
  aliasHash: string,
): Promise<CatalogAliasCandidateRow | null> {
  const result = await db.query<CatalogAliasCandidateRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("first_observed_at", "updated_at")}
     FROM catalog_source_observation_alias_candidates WHERE alias_hash = $1`,
    [aliasHash],
  );

  return result.rows[0] ?? null;
}

// --- Catalog Item aliases --------------------------------------------------

/** Admin review: all aliases for a Catalog Item regardless of review state. */
export async function listCatalogItemAliases(
  db: PgQueryable,
  catalogItemId: string,
  options: { reviewStatuses?: readonly CatalogAliasReviewStateKey[] } = {},
): Promise<readonly CatalogItemAliasRow[]> {
  const values: unknown[] = [catalogItemId];
  let statusCondition = "";
  if (options.reviewStatuses && options.reviewStatuses.length > 0) {
    values.push(options.reviewStatuses);
    statusCondition = ` AND review_status = ANY($${values.length}::text[])`;
  }

  const result = await db.query<CatalogItemAliasRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("proposed_at", "reviewed_at", "updated_at")}
     FROM catalog_item_aliases
     WHERE catalog_item_id = $1${statusCondition}
     ORDER BY alias_type ASC, normalized_alias_text ASC`,
    values,
  );

  return result.rows;
}

/**
 * Downstream publication / display: only accepted/auto-accepted aliases
 * for a Catalog Item. Never returns pending, rejected, revoked, or generated.
 */
export async function listPublishableCatalogItemAliases(
  db: PgQueryable,
  catalogItemId: string,
): Promise<readonly CatalogItemAliasRow[]> {
  const result = await db.query<CatalogItemAliasRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("proposed_at", "reviewed_at", "updated_at")}
     FROM catalog_item_aliases
     WHERE catalog_item_id = $1 AND review_status = ANY($2::text[])
     ORDER BY alias_type ASC, normalized_alias_text ASC`,
    [catalogItemId, PUBLISHABLE],
  );

  return result.rows;
}

/**
 * Cardinality signal for search weighting: how many distinct Catalog
 * Items a normalized alias text resolves to through publishable aliases. High
 * fan-out (e.g. species names) is the broad-alias case the ADR documents.
 */
export async function countCatalogItemsForAliasText(
  db: PgQueryable,
  normalizedAliasText: string,
  aliasLanguageCode: string,
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(DISTINCT catalog_item_id) AS count
     FROM catalog_item_aliases
     WHERE normalized_alias_text = $1
       AND alias_language_code = $2
       AND review_status = ANY($3::text[])`,
    [normalizedAliasText, aliasLanguageCode, PUBLISHABLE],
  );

  return Number.parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function getCatalogItemAlias(db: PgQueryable, aliasHash: string): Promise<CatalogItemAliasRow | null> {
  const result = await db.query<CatalogItemAliasRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("proposed_at", "reviewed_at", "updated_at")}
     FROM catalog_item_aliases WHERE alias_hash = $1`,
    [aliasHash],
  );

  return result.rows[0] ?? null;
}

// --- Reference Record aliases ----------------------------------------------

/** Admin review: all aliases for a Reference Record regardless of review state. */
export async function listReferenceRecordAliases(
  db: PgQueryable,
  referenceRecordId: string,
  options: { reviewStatuses?: readonly CatalogAliasReviewStateKey[] } = {},
): Promise<readonly CatalogReferenceRecordAliasRow[]> {
  const values: unknown[] = [referenceRecordId];
  let statusCondition = "";
  if (options.reviewStatuses && options.reviewStatuses.length > 0) {
    values.push(options.reviewStatuses);
    statusCondition = ` AND review_status = ANY($${values.length}::text[])`;
  }

  const result = await db.query<CatalogReferenceRecordAliasRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("proposed_at", "reviewed_at", "updated_at")}
     FROM catalog_reference_record_aliases
     WHERE reference_record_id = $1${statusCondition}
     ORDER BY alias_type ASC, normalized_alias_text ASC`,
    values,
  );

  return result.rows;
}

/** Downstream publication / display: only publishable Reference Record aliases. */
export async function listPublishableReferenceRecordAliases(
  db: PgQueryable,
  referenceRecordId: string,
): Promise<readonly CatalogReferenceRecordAliasRow[]> {
  const result = await db.query<CatalogReferenceRecordAliasRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("proposed_at", "reviewed_at", "updated_at")}
     FROM catalog_reference_record_aliases
     WHERE reference_record_id = $1 AND review_status = ANY($2::text[])
     ORDER BY alias_type ASC, normalized_alias_text ASC`,
    [referenceRecordId, PUBLISHABLE],
  );

  return result.rows;
}

export async function getReferenceRecordAlias(
  db: PgQueryable,
  aliasHash: string,
): Promise<CatalogReferenceRecordAliasRow | null> {
  const result = await db.query<CatalogReferenceRecordAliasRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("proposed_at", "reviewed_at", "updated_at")}
     FROM catalog_reference_record_aliases WHERE alias_hash = $1`,
    [aliasHash],
  );

  return result.rows[0] ?? null;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return 200;
  }
  return Math.min(1000, Math.max(1, Math.trunc(limit ?? 200)));
}
