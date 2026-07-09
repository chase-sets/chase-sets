import type { PgQueryable } from "@chase-sets/event-core-postgres";
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

export async function listAcceptedProviderScopeMappingsByScopeRecord(
  db: PgQueryable,
  scopeRecordId: string,
): Promise<readonly ProviderScopeMappingRow[]> {
  const normalizedScopeRecordId = scopeRecordId.trim();
  if (!normalizedScopeRecordId) {
    return [];
  }

  const result = await db.query<ProviderScopeMappingRow>(
    `SELECT *
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
    `SELECT *
     FROM catalog_provider_scope_mappings
     WHERE provider_key = $1
       AND unit_key = $2
       AND review_status IN ('accepted', 'auto-accepted')
     ORDER BY scope_record_id ASC, set_name ASC NULLS LAST, set_id ASC NULLS LAST`,
    [identity.providerKey, identity.unitKey],
  );

  return result.rows;
}
