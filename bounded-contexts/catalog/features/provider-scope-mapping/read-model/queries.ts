import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  catalogIsoUtcTimestamp,
  catalogIsoUtcTimestampColumns,
} from "../../../support/runtime-support/iso-utc-timestamp";
import type {
  CatalogAttentionSourcePage,
  CatalogAttentionSourceWindow,
} from "../../attention-queue/read-model/attention-item";
import { catalogAttentionItemParkedSql } from "../../attention-queue/read-model/dismissal-queries";
import {
  normalizeProviderScopeMappingIdentity,
  type ProviderScopeMappingConfidenceTier,
  type ProviderScopeMappingReviewStatus,
} from "../domain/mapping";

export type ProviderScopeMappingRow = Readonly<{
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
}>;

// The columns an attention-queue unmapped-scope item needs, and no evidence or provenance.
export type ProviderScopeMappingAttentionRow = Pick<
  ProviderScopeMappingRow,
  | "mapping_id"
  | "scope_record_id"
  | "provider_key"
  | "unit_key"
  | "set_id"
  | "set_name"
  | "confidence"
  | "review_status"
  | "proposed_at"
>;

// Attention queue: provider scope mappings still awaiting review. A
// `proposed` mapping is a scope a provider unit produced that no operator has
// accepted or rejected yet — the "unmapped scope" that needs a human. Counts the
// whole unparked cohort and reads one window, oldest first.
export async function readProposedProviderScopeMappingAttentionWindow(
  db: PgQueryable,
  window: CatalogAttentionSourceWindow,
): Promise<CatalogAttentionSourcePage<ProviderScopeMappingAttentionRow>> {
  const cohort = `FROM catalog_provider_scope_mappings scope_mapping
     WHERE scope_mapping.review_status = 'proposed'
       AND NOT ${catalogAttentionItemParkedSql("'unmapped-scope:' || scope_mapping.mapping_id", "$1")}`;
  const [count, page] = await Promise.all([
    db.query<{ total: number }>(`SELECT COUNT(*)::integer AS total ${cohort}`, [window.now]),
    window.limit > 0
      ? db.query<ProviderScopeMappingAttentionRow>(
          `SELECT scope_mapping.mapping_id, scope_mapping.scope_record_id,
                  scope_mapping.provider_key, scope_mapping.unit_key,
                  scope_mapping.set_id, scope_mapping.set_name,
                  scope_mapping.confidence, scope_mapping.review_status,
                  ${catalogIsoUtcTimestamp("scope_mapping.proposed_at", "proposed_at")}
           ${cohort}
           ORDER BY scope_mapping.proposed_at ASC, scope_mapping.mapping_id ASC
           LIMIT $2 OFFSET $3`,
          [window.now, window.limit, window.offset],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  return { total: count.rows[0]?.total ?? 0, rows: page.rows };
}

export async function listAcceptedProviderScopeMappingsByScopeRecord(
  db: PgQueryable,
  scopeRecordId: string,
): Promise<readonly ProviderScopeMappingRow[]> {
  const normalizedScopeRecordId = scopeRecordId.trim();
  if (!normalizedScopeRecordId) {
    return [];
  }

  const result = await db.query<ProviderScopeMappingRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("proposed_at", "reviewed_at", "updated_at")}
     FROM catalog_provider_scope_mappings
     WHERE scope_record_id = $1
       AND review_status IN ('accepted', 'auto-accepted')
     ORDER BY provider_key ASC, unit_key ASC, set_name ASC NULLS LAST, set_id ASC NULLS LAST`,
    [normalizedScopeRecordId],
  );

  return result.rows;
}

export async function listAcceptedProviderScopeMappingsByProviderUnit(
  db: PgQueryable,
  input: Readonly<{ providerKey: string; unitKey: string }>,
): Promise<readonly ProviderScopeMappingRow[]> {
  const identity = normalizeProviderScopeMappingIdentity({
    scopeRecordId: "scope-record-placeholder",
    providerKey: input.providerKey,
    unitKey: input.unitKey,
  });

  const result = await db.query<ProviderScopeMappingRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("proposed_at", "reviewed_at", "updated_at")}
     FROM catalog_provider_scope_mappings
     WHERE provider_key = $1
       AND unit_key = $2
       AND review_status IN ('accepted', 'auto-accepted')
     ORDER BY scope_record_id ASC, set_name ASC NULLS LAST, set_id ASC NULLS LAST`,
    [identity.providerKey, identity.unitKey],
  );

  return result.rows;
}

export async function listAcceptedProviderScopeMappingsForProviders(
  db: PgQueryable,
  providerKeys: readonly string[],
): Promise<readonly ProviderScopeMappingRow[]> {
  const normalizedProviderKeys = [...new Set(providerKeys.map((key) => key.trim().toLowerCase()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right),
  );
  if (normalizedProviderKeys.length === 0) {
    return [];
  }

  const result = await db.query<ProviderScopeMappingRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("proposed_at", "reviewed_at", "updated_at")}
     FROM catalog_provider_scope_mappings
     WHERE provider_key = ANY($1::text[])
       AND review_status IN ('accepted', 'auto-accepted')
     ORDER BY provider_key ASC, unit_key ASC, scope_record_id ASC`,
    [normalizedProviderKeys],
  );

  return result.rows;
}

/**
 * Every mapping row for one canonical scope record, regardless of review
 * status. The coverage matrix needs the full history (proposed / accepted /
 * rejected / revoked) per provider, not only the currently-accepted set.
 */
export async function listProviderScopeMappingsByScopeRecord(
  db: PgQueryable,
  scopeRecordId: string,
): Promise<readonly ProviderScopeMappingRow[]> {
  const normalizedScopeRecordId = scopeRecordId.trim();
  if (!normalizedScopeRecordId) {
    return [];
  }

  const result = await db.query<ProviderScopeMappingRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("proposed_at", "reviewed_at", "updated_at")}
     FROM catalog_provider_scope_mappings
     WHERE scope_record_id = $1
     ORDER BY provider_key ASC, unit_key ASC, catalog_provider_scope_mappings.updated_at DESC`,
    [normalizedScopeRecordId],
  );

  return result.rows;
}

export async function getProviderScopeMapping(
  db: PgQueryable,
  mappingId: string,
): Promise<ProviderScopeMappingRow | null> {
  const normalizedMappingId = mappingId.trim();
  if (!normalizedMappingId) {
    return null;
  }

  const result = await db.query<ProviderScopeMappingRow>(
    `SELECT *, ${catalogIsoUtcTimestampColumns("proposed_at", "reviewed_at", "updated_at")}
     FROM catalog_provider_scope_mappings WHERE mapping_id = $1`,
    [normalizedMappingId],
  );

  return result.rows[0] ?? null;
}
