import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { deriveCatalogScopeSyncUnitState, type CatalogScopeSyncUnitObservedStatus } from "../domain/state";

export type CatalogScopeSyncUnitStateUpsertInput = Readonly<{
  scopeKey: string;
  providerKey: string;
  unitKey: string;
  productDomain: string;
  productForm: string | null;
  languageCode: string | null;
  referenceKind: string | null;
  referenceId: string | null;
  referenceName: string | null;
  displayName: string;
  role: string;
  requirement: string;
  childExecutionScope: Readonly<Record<string, string>>;
  status: CatalogScopeSyncUnitObservedStatus;
  syncRunId: string | null;
  jobId: string | null;
  operatorStatus: string | null;
  observedCount?: number | null;
  changedCount?: number | null;
  requestedCount?: number | null;
  failedCount?: number | null;
  errorMessage: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt: string;
}>;

export type CatalogScopeSyncUnitStateRow = Readonly<{
  scope_key: string;
  provider_key: string;
  unit_key: string;
  product_domain: string;
  product_form: string | null;
  language_code: string | null;
  reference_kind: string | null;
  reference_id: string | null;
  reference_name: string | null;
  display_name: string;
  role: string;
  requirement: string;
  child_execution_scope: unknown;
  state: string;
  last_sync_run_id: string | null;
  last_job_id: string | null;
  last_operator_status: string | null;
  observed_count: number | null;
  changed_count: number | null;
  requested_count: number | null;
  failed_count: number | null;
  error_message: string | null;
  last_started_at: string | null;
  last_completed_at: string | null;
  updated_at: string;
}>;

// One provider unit's durable sync state within a scope, projected from
// `CatalogScopeSyncUnitStateRow`. This is what survives across runs: a fresh
// `enqueueCatalogSyncRun` reads it back to decide whether a unit can fast
// -forward, and the scope page reads it to render state that outlives any
// single in-flight run.
export async function upsertCatalogScopeSyncUnitState(
  db: PgQueryable,
  input: CatalogScopeSyncUnitStateUpsertInput,
): Promise<void> {
  const state = deriveCatalogScopeSyncUnitState(input.status);

  await db.query(
    `INSERT INTO catalog_scope_sync_state (
       scope_key,
       provider_key,
       unit_key,
       product_domain,
       product_form,
       language_code,
       reference_kind,
       reference_id,
       reference_name,
       display_name,
       role,
       requirement,
       child_execution_scope,
       state,
       last_sync_run_id,
       last_job_id,
       last_operator_status,
       observed_count,
       changed_count,
       requested_count,
       failed_count,
       error_message,
       last_started_at,
       last_completed_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23::timestamptz, $24::timestamptz, $25::timestamptz)
     ON CONFLICT (scope_key, provider_key, unit_key) DO UPDATE SET
       product_domain = EXCLUDED.product_domain,
       product_form = EXCLUDED.product_form,
       language_code = EXCLUDED.language_code,
       reference_kind = EXCLUDED.reference_kind,
       reference_id = EXCLUDED.reference_id,
       reference_name = EXCLUDED.reference_name,
       display_name = EXCLUDED.display_name,
       role = EXCLUDED.role,
       requirement = EXCLUDED.requirement,
       child_execution_scope = EXCLUDED.child_execution_scope,
       state = EXCLUDED.state,
       last_sync_run_id = EXCLUDED.last_sync_run_id,
       last_job_id = EXCLUDED.last_job_id,
       last_operator_status = EXCLUDED.last_operator_status,
       observed_count = COALESCE(EXCLUDED.observed_count, catalog_scope_sync_state.observed_count),
       changed_count = COALESCE(EXCLUDED.changed_count, catalog_scope_sync_state.changed_count),
       requested_count = COALESCE(EXCLUDED.requested_count, catalog_scope_sync_state.requested_count),
       failed_count = COALESCE(EXCLUDED.failed_count, catalog_scope_sync_state.failed_count),
       error_message = EXCLUDED.error_message,
       last_started_at = COALESCE(EXCLUDED.last_started_at, catalog_scope_sync_state.last_started_at),
       last_completed_at = COALESCE(EXCLUDED.last_completed_at, catalog_scope_sync_state.last_completed_at),
       updated_at = EXCLUDED.updated_at`,
    [
      input.scopeKey,
      input.providerKey,
      input.unitKey,
      input.productDomain,
      input.productForm,
      input.languageCode,
      input.referenceKind,
      input.referenceId,
      input.referenceName,
      input.displayName,
      input.role,
      input.requirement,
      JSON.stringify(input.childExecutionScope),
      state,
      input.syncRunId,
      input.jobId,
      input.operatorStatus,
      input.observedCount ?? null,
      input.changedCount ?? null,
      input.requestedCount ?? null,
      input.failedCount ?? null,
      input.errorMessage,
      input.startedAt ?? null,
      input.completedAt ?? null,
      input.updatedAt,
    ],
  );
}

export async function listCatalogScopeSyncState(
  db: PgQueryable,
  scopeKey: string,
): Promise<readonly CatalogScopeSyncUnitStateRow[]> {
  const result = await db.query<CatalogScopeSyncUnitStateRow>(
    `SELECT *
     FROM catalog_scope_sync_state
     WHERE scope_key = $1
     ORDER BY provider_key ASC, unit_key ASC`,
    [scopeKey],
  );

  return result.rows;
}

export async function readCatalogScopeSyncUnitState(
  db: PgQueryable,
  input: Readonly<{ scopeKey: string; providerKey: string; unitKey: string }>,
): Promise<CatalogScopeSyncUnitStateRow | null> {
  const result = await db.query<CatalogScopeSyncUnitStateRow>(
    `SELECT *
     FROM catalog_scope_sync_state
     WHERE scope_key = $1
       AND provider_key = $2
       AND unit_key = $3`,
    [input.scopeKey, input.providerKey, input.unitKey],
  );

  return result.rows[0] ?? null;
}
