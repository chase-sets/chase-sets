import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { sourceObservationIntegrationScopeSummaryTable } from "../../source-observations/read-model/integration-scope-summary";
import type { CatalogLifecycleStatus } from "../../../support/runtime-support/common";
import type { CatalogScopeProductDomain, CatalogScopeRecordKind } from "../../scope-registry/domain/contract";
import type { ProviderScopeMappingConfidenceTier, ProviderScopeMappingReviewStatus } from "../domain/mapping";

// ---------------------------------------------------------------------------
// Scope coverage composite reads
//
// The unmapped-scope inbox and the per-scope coverage matrix both need a
// canonical Catalog Scope Record's identity alongside its Provider Scope
// Mapping rows. Both tables are catalog-owned (scope-registry,
// provider-scope-mapping), so this is a same-context composite read, not a
// cross-context one — it stays a plain SQL join rather than a new projection
// group.
//
// Sync/settlement status is read from the existing per-provider observation
// scope summary (`catalog_source_observation_integration_scope_summaries`,
// m84), keyed by the accepted mapping's own provider coordinates
// (productLineId/seriesId/setId-or-setName) — the same coalesce expressions
// the summary table already indexes by. No new table, no new projection
// group.
// ---------------------------------------------------------------------------

export type ScopeRecordSummaryRow = Readonly<{
  scope_record_id: string;
  product_domain: CatalogScopeProductDomain;
  scope_kind: CatalogScopeRecordKind;
  name: string;
  official_set_code: string | null;
  release_date: string | null;
  lifecycle_status: CatalogLifecycleStatus;
}>;

export type ProviderScopeMappingWithScopeRow = Readonly<{
  mapping_id: string;
  scope_record_id: string;
  provider_key: string;
  unit_key: string;
  product_line_id: string | null;
  series_id: string | null;
  set_id: string | null;
  set_name: string | null;
  language_coordinates: unknown;
  confidence: ProviderScopeMappingConfidenceTier;
  review_status: ProviderScopeMappingReviewStatus;
  provenance: unknown;
  evidence: unknown;
  last_actor: string | null;
  last_reason: string | null;
  policy_version: string;
  proposed_at: string;
  reviewed_at: string | null;
  updated_at: string;
  scope_product_domain: CatalogScopeProductDomain;
  scope_kind: CatalogScopeRecordKind;
  scope_name: string;
  scope_official_set_code: string | null;
  scope_release_date: string | null;
  scope_lifecycle_status: CatalogLifecycleStatus;
}>;

/**
 * Every `proposed` Provider Scope Mapping, joined to its (possibly still
 * draft) canonical scope record — the unmapped-scope inbox source. Grouping
 * by scope record happens in the admin-contracts layer.
 */
export async function listUnmappedScopeInboxRows(
  db: PgQueryable,
  params: Readonly<{ limit?: number }> = {},
): Promise<readonly ProviderScopeMappingWithScopeRow[]> {
  const limit = normalizePositiveInt(params.limit, 1000);
  const result = await db.query<ProviderScopeMappingWithScopeRow>(
    `SELECT
       m.mapping_id,
       m.scope_record_id,
       m.provider_key,
       m.unit_key,
       m.product_line_id,
       m.series_id,
       m.set_id,
       m.set_name,
       m.language_coordinates,
       m.confidence,
       m.review_status,
       m.provenance,
       m.evidence,
       m.last_actor,
       m.last_reason,
       m.policy_version,
       m.proposed_at,
       m.reviewed_at,
       m.updated_at,
       r.product_domain AS scope_product_domain,
       r.scope_kind AS scope_kind,
       r.name AS scope_name,
       r.official_set_code AS scope_official_set_code,
       r.release_date AS scope_release_date,
       r.lifecycle_status AS scope_lifecycle_status
     FROM catalog_provider_scope_mappings m
     JOIN catalog_scope_records r ON r.scope_record_id = m.scope_record_id
     WHERE m.review_status = 'proposed'
     ORDER BY m.proposed_at ASC
     LIMIT $1`,
    [limit],
  );

  return result.rows;
}

/** The canonical scope record identity, for the coverage matrix header. */
export async function getScopeRecordSummary(
  db: PgQueryable,
  scopeRecordId: string,
): Promise<ScopeRecordSummaryRow | null> {
  const normalized = scopeRecordId.trim();
  if (!normalized) {
    return null;
  }

  const result = await db.query<ScopeRecordSummaryRow>(
    `SELECT scope_record_id, product_domain, scope_kind, name, official_set_code, release_date, lifecycle_status
     FROM catalog_scope_records
     WHERE scope_record_id = $1`,
    [normalized],
  );

  return result.rows[0] ?? null;
}

export type ScopeObservationSyncStatus = Readonly<{
  totalObservations: number;
  promotedObservations: number;
}>;

/**
 * Sync/settlement counts for one provider's coordinates within a scope,
 * read from the existing per-provider observation scope summary. Coordinates
 * mirror the coalesce(setId, setName) key the summary table already uses, so
 * this needs no new indexing.
 */
export async function getScopeObservationSyncStatus(
  db: PgQueryable,
  key: Readonly<{
    providerKey: string;
    productLineId: string | null;
    seriesId: string | null;
    setIdOrName: string | null;
  }>,
): Promise<ScopeObservationSyncStatus> {
  const result = await db.query<{ total_observations: string | number; promoted_observations: string | number }>(
    `SELECT
       COALESCE(SUM(total_observations), 0) AS total_observations,
       COALESCE(SUM(promoted_observations), 0) AS promoted_observations
     FROM ${sourceObservationIntegrationScopeSummaryTable}
     WHERE provider_key = $1
       AND COALESCE(product_line_id, '') = COALESCE($2, '')
       AND COALESCE(series_id, '') = COALESCE($3, '')
       AND expansion_id = COALESCE($4, '')`,
    [key.providerKey, key.productLineId ?? "", key.seriesId ?? "", key.setIdOrName ?? ""],
  );

  const row = result.rows[0];
  return {
    totalObservations: Number(row?.total_observations ?? 0),
    promotedObservations: Number(row?.promoted_observations ?? 0),
  };
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}
