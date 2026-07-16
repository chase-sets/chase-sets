import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type SettlementPayoutRow = Readonly<{
  payout_id: string;
  account_id: string;
  amount: string;
  currency_code: string;
  destination_reference: string | null;
  note: string | null;
  display_reference: string;
  status: string;
  provider_transfer_reference: string | null;
  provider_payout_reference: string | null;
  provider_status: string | null;
  provider_failure_code: string | null;
  provider_failure_message: string | null;
  requested_at: string;
  updated_at: string;
  sent_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
  last_provider_event_at: string | null;
  last_reconciled_at: string | null;
  retry_count: number;
  next_retry_at: string | null;
  retry_reason: string | null;
}>;

export type SettlementPayoutRiskSummaryRow = Readonly<{
  failed_payout_count: number;
  stale_requested_payout_count: number;
  in_transit_payout_count: number;
}>;

export type SettlementProviderIdempotencyKeyRow = Readonly<{
  operation_key: string;
  provider_name: string;
  operation_kind: string;
  account_id: string | null;
  payout_id: string | null;
  provider_object_reference: string | null;
  idempotency_key: string;
  created_at: string;
}>;

export type SettlementProviderOperationRow = Readonly<{
  operation_key: string;
  provider_name: string;
  operation_kind: string;
  account_id: string | null;
  payout_id: string | null;
  idempotency_key: string;
  request_json: unknown;
  status: string;
  provider_object_reference: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}>;

export type SettlementReconciliationRunRow = Readonly<{
  reconciliation_run_id: string;
  kind: string;
  checked_count: number;
  reconciled_count: number;
  ignored_count: number;
  skipped_count: number;
  error_count: number;
  status: string;
  summary: unknown;
  started_at: string;
  completed_at: string;
}>;

const payoutSelect = `
  SELECT
    payout_id,
    account_id,
    amount::text AS amount,
    currency_code,
    destination_reference,
    note,
    display_reference,
    status,
    provider_transfer_reference,
    provider_payout_reference,
    provider_status,
    provider_failure_code,
    provider_failure_message,
    requested_at,
    updated_at,
    sent_at,
    completed_at,
    failed_at,
    failure_reason,
    last_provider_event_at,
    last_reconciled_at,
    retry_count,
    next_retry_at,
    retry_reason
  FROM settlement_payout_pages
`;

export async function listPayouts(
  db: PgQueryable,
  params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
): Promise<{ items: SettlementPayoutRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM settlement_payout_pages
       WHERE account_id = $1`,
      [params.accountId],
    ),
    db.query<SettlementPayoutRow>(
      `${payoutSelect}
       WHERE account_id = $1
       ORDER BY updated_at DESC, payout_id DESC
       LIMIT $2 OFFSET $3`,
      [params.accountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function getPayoutByProviderPayoutReference(
  db: PgQueryable,
  providerPayoutReference: string,
): Promise<SettlementPayoutRow | null> {
  const result = await db.query<SettlementPayoutRow>(
    `${payoutSelect}
     WHERE provider_payout_reference = $1`,
    [providerPayoutReference],
  );

  return result.rows[0] ?? null;
}

export async function getPayoutByProviderOperationReference(
  db: PgQueryable,
  providerObjectReference: string,
): Promise<SettlementPayoutRow | null> {
  const result = await db.query<SettlementPayoutRow>(
    `${payoutSelect}
     WHERE payout_id = (
       SELECT payout_id
       FROM settlement_provider_operations
       WHERE provider_object_reference = $1
         AND payout_id IS NOT NULL
       ORDER BY completed_at DESC NULLS LAST, updated_at DESC, operation_key DESC
       LIMIT 1
     )`,
    [providerObjectReference],
  );

  return result.rows[0] ?? null;
}

export async function listPayoutsNeedingReconciliation(
  db: PgQueryable,
  params: Readonly<{
    accountId?: string | null;
    limit?: number;
    filter?: string | null;
    claimOwnerId?: string;
    claimTtlMs?: number;
  }> = {},
): Promise<SettlementPayoutRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const filterSql = (() => {
    switch (params.filter ?? "all") {
      case "missing-provider-reference":
        return "AND provider_payout_reference IS NULL";
      case "in-transit":
        return "AND status = 'in-transit'";
      case "failed":
        return "AND status = 'failed'";
      case "stale-requested":
        return "AND status = 'requested' AND updated_at < NOW() - INTERVAL '15 minutes'";
      default:
        return "";
    }
  })();
  if (params.claimOwnerId) {
    const result = await db.query<SettlementPayoutRow>(
      `WITH candidates AS (
         SELECT payout_id
         FROM settlement_payout_pages
         WHERE (
           status = 'in-transit'
           OR status = 'failed'
           OR (
             status = 'requested'
             AND updated_at < NOW() - INTERVAL '15 minutes'
           )
         )
         AND ($4::text IS NULL OR account_id = $4)
         ${filterSql}
         ORDER BY updated_at ASC, payout_id ASC
         LIMIT $1
       ),
       claimed AS (
         INSERT INTO settlement_work_claims (
           work_kind,
           entity_id,
           owner_id,
           claim_expires_at,
           attempts,
           updated_at
         )
         SELECT
           'payout-reconciliation',
           payout_id,
           $2,
           now() + ($3::text || ' milliseconds')::interval,
           1,
           now()
         FROM candidates
         ON CONFLICT (work_kind, entity_id)
         DO UPDATE SET
           owner_id = EXCLUDED.owner_id,
           claim_expires_at = EXCLUDED.claim_expires_at,
           attempts = settlement_work_claims.attempts + 1,
           updated_at = EXCLUDED.updated_at
         WHERE settlement_work_claims.claim_expires_at <= now()
            OR settlement_work_claims.owner_id = EXCLUDED.owner_id
         RETURNING entity_id
       )
       ${payoutSelect}
       WHERE payout_id IN (SELECT entity_id FROM claimed)
       ORDER BY updated_at ASC, payout_id ASC`,
      [limit, params.claimOwnerId, params.claimTtlMs ?? 120_000, params.accountId ?? null],
    );

    return result.rows;
  }

  const result = await db.query<SettlementPayoutRow>(
    `${payoutSelect}
     WHERE (
       status = 'in-transit'
       OR status = 'failed'
       OR (
         status = 'requested'
         AND updated_at < NOW() - INTERVAL '15 minutes'
       )
     )
     AND ($2::text IS NULL OR account_id = $2)
     ${filterSql}
     ORDER BY updated_at ASC, payout_id ASC
     LIMIT $1`,
    [limit, params.accountId ?? null],
  );

  return result.rows;
}

export async function renewPayoutReconciliationWorkClaim(
  db: PgQueryable,
  params: Readonly<{ payoutId: string; claimOwnerId: string; claimTtlMs: number }>,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE settlement_work_claims
     SET claim_expires_at = now() + ($3::text || ' milliseconds')::interval,
         updated_at = now()
     WHERE work_kind = 'payout-reconciliation'
       AND entity_id = $1
       AND owner_id = $2
       AND claim_expires_at > now()`,
    [params.payoutId, params.claimOwnerId, params.claimTtlMs],
  );

  return Number(result.rowCount ?? 0) > 0;
}

export async function getPayout(
  db: PgQueryable,
  payoutId: string,
  accountId: string,
): Promise<SettlementPayoutRow | null> {
  const result = await db.query<SettlementPayoutRow>(
    `${payoutSelect}
     WHERE payout_id = $1
       AND account_id = $2`,
    [payoutId, accountId],
  );

  return result.rows[0] ?? null;
}

export async function getAccountPayoutRiskSummary(
  db: PgQueryable,
  accountId: string,
): Promise<SettlementPayoutRiskSummaryRow> {
  const result = await db.query<{
    failed_payout_count: string;
    stale_requested_payout_count: string;
    in_transit_payout_count: string;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE status = 'failed'
           AND updated_at > NOW() - INTERVAL '7 days'
       )::text AS failed_payout_count,
       COUNT(*) FILTER (
         WHERE status = 'requested'
           AND updated_at < NOW() - INTERVAL '15 minutes'
       )::text AS stale_requested_payout_count,
       COUNT(*) FILTER (
         WHERE status = 'in-transit'
           AND updated_at < NOW() - INTERVAL '7 days'
       )::text AS in_transit_payout_count
     FROM settlement_payout_pages
     WHERE account_id = $1`,
    [accountId],
  );
  const row = result.rows[0];

  return {
    failed_payout_count: Number(row?.failed_payout_count ?? 0),
    stale_requested_payout_count: Number(row?.stale_requested_payout_count ?? 0),
    in_transit_payout_count: Number(row?.in_transit_payout_count ?? 0),
  };
}

export async function recordSettlementProviderIdempotencyKey(
  db: PgQueryable,
  entry: Readonly<{
    operationKey: string;
    providerName: string;
    operationKind: string;
    accountId?: string | null;
    payoutId?: string | null;
    providerObjectReference?: string | null;
    idempotencyKey: string;
    createdAt?: string;
  }>,
) {
  await db.query(
    `INSERT INTO settlement_provider_idempotency_keys (
       operation_key,
       provider_name,
       operation_kind,
       account_id,
       payout_id,
       provider_object_reference,
       idempotency_key,
       created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (operation_key) DO UPDATE
     SET provider_name = EXCLUDED.provider_name,
         operation_kind = EXCLUDED.operation_kind,
         account_id = EXCLUDED.account_id,
         payout_id = EXCLUDED.payout_id,
         provider_object_reference = EXCLUDED.provider_object_reference,
         idempotency_key = EXCLUDED.idempotency_key`,
    [
      entry.operationKey,
      entry.providerName,
      entry.operationKind,
      entry.accountId ?? null,
      entry.payoutId ?? null,
      entry.providerObjectReference ?? null,
      entry.idempotencyKey,
      entry.createdAt ?? new Date().toISOString(),
    ],
  );
}

export type PayoutRequestIdempotencyRecord = Readonly<{
  payout_id: string;
  requested_amount: string;
  currency_code: string;
}>;

/** Look up an existing payout-request idempotency reservation for this account and key. */
export async function findPayoutRequestIdempotency(
  db: PgQueryable,
  accountId: string,
  idempotencyKey: string,
): Promise<PayoutRequestIdempotencyRecord | null> {
  const result = await db.query<PayoutRequestIdempotencyRecord>(
    `SELECT payout_id, requested_amount::text AS requested_amount, currency_code
     FROM settlement_payout_request_idempotency
     WHERE account_id = $1 AND idempotency_key = $2`,
    [accountId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

/**
 * Reserve (account_id, idempotency_key) for a freshly minted payout. Returns the
 * winning reservation: `reserved` is true when this call inserted the row, false
 * when a concurrent request already owned the key (in which case the returned
 * payout_id is the winner's, and this caller must replay it rather than proceed).
 * A single statement so the decision is atomic under concurrency.
 */
export async function reservePayoutRequestIdempotency(
  db: PgQueryable,
  entry: Readonly<{
    accountId: string;
    idempotencyKey: string;
    payoutId: string;
    requestedAmount: string;
    currencyCode: string;
    createdAt: string;
  }>,
): Promise<PayoutRequestIdempotencyRecord & Readonly<{ reserved: boolean }>> {
  const result = await db.query<PayoutRequestIdempotencyRecord & { reserved: boolean }>(
    `WITH ins AS (
       INSERT INTO settlement_payout_request_idempotency (
         account_id, idempotency_key, payout_id, requested_amount, currency_code, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id, idempotency_key) DO NOTHING
       RETURNING payout_id, requested_amount, currency_code
     )
     SELECT payout_id, requested_amount::text AS requested_amount, currency_code, true AS reserved
     FROM ins
     UNION ALL
     SELECT payout_id, requested_amount::text AS requested_amount, currency_code, false AS reserved
     FROM settlement_payout_request_idempotency
     WHERE account_id = $1 AND idempotency_key = $2 AND NOT EXISTS (SELECT 1 FROM ins)
     LIMIT 1`,
    [entry.accountId, entry.idempotencyKey, entry.payoutId, entry.requestedAmount, entry.currencyCode, entry.createdAt],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Payout request idempotency reservation returned no row.");
  }
  return row;
}

export async function recordSettlementProviderOperationPending(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    providerName: string;
    operationKind: string;
    accountId?: string | null;
    payoutId?: string | null;
    idempotencyKey: string;
    request?: unknown;
    createdAt?: string;
  }>,
) {
  const timestamp = operation.createdAt ?? new Date().toISOString();
  await db.query(
    `INSERT INTO settlement_provider_operations (
       operation_key,
       provider_name,
       operation_kind,
       account_id,
       payout_id,
       idempotency_key,
       request_json,
       status,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending', $8, $8)
     ON CONFLICT (operation_key) DO UPDATE
     SET provider_name = EXCLUDED.provider_name,
         operation_kind = EXCLUDED.operation_kind,
         account_id = EXCLUDED.account_id,
         payout_id = EXCLUDED.payout_id,
         idempotency_key = EXCLUDED.idempotency_key,
         request_json = EXCLUDED.request_json,
         updated_at = EXCLUDED.updated_at`,
    [
      operation.operationKey,
      operation.providerName,
      operation.operationKind,
      operation.accountId ?? null,
      operation.payoutId ?? null,
      operation.idempotencyKey,
      JSON.stringify(operation.request ?? {}),
      timestamp,
    ],
  );
}

export async function recordSettlementProviderOperationSucceeded(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    providerObjectReference: string;
    completedAt?: string;
  }>,
) {
  const timestamp = operation.completedAt ?? new Date().toISOString();
  await db.query(
    `UPDATE settlement_provider_operations
     SET status = 'succeeded',
         provider_object_reference = $2,
         error_message = NULL,
         completed_at = $3,
         updated_at = $3
     WHERE operation_key = $1`,
    [operation.operationKey, operation.providerObjectReference, timestamp],
  );
}

export async function recordSettlementProviderOperationFailed(
  db: PgQueryable,
  operation: Readonly<{
    operationKey: string;
    errorMessage: string;
    completedAt?: string;
  }>,
) {
  const timestamp = operation.completedAt ?? new Date().toISOString();
  await db.query(
    `UPDATE settlement_provider_operations
     SET status = 'failed',
         error_message = $2,
         completed_at = $3,
         updated_at = $3
     WHERE operation_key = $1
       AND status = 'pending'`,
    [operation.operationKey, operation.errorMessage, timestamp],
  );
}

export async function listSettlementProviderOperationsForPayout(
  db: PgQueryable,
  payoutId: string,
): Promise<SettlementProviderOperationRow[]> {
  const result = await db.query<SettlementProviderOperationRow>(
    `SELECT
       operation_key,
       provider_name,
       operation_kind,
       account_id,
       payout_id,
       idempotency_key,
       request_json,
       status,
       provider_object_reference,
       error_message,
       created_at,
       updated_at,
       completed_at
     FROM settlement_provider_operations
     WHERE payout_id = $1
     ORDER BY created_at ASC, operation_key ASC`,
    [payoutId],
  );

  return result.rows;
}

export async function listSettlementProviderIdempotencyKeys(
  db: PgQueryable,
  params: Readonly<{ accountId: string; limit?: number }>,
): Promise<SettlementProviderIdempotencyKeyRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const result = await db.query<SettlementProviderIdempotencyKeyRow>(
    `SELECT
       operation_key,
       provider_name,
       operation_kind,
       account_id,
       payout_id,
       provider_object_reference,
       idempotency_key,
       created_at
     FROM settlement_provider_idempotency_keys
     WHERE account_id = $1
     ORDER BY created_at DESC, operation_key DESC
     LIMIT $2`,
    [params.accountId, limit],
  );

  return result.rows;
}

export async function recordSettlementReconciliationRun(
  db: PgQueryable,
  run: Readonly<{
    reconciliationRunId: string;
    kind: string;
    checked: number;
    reconciled: number;
    ignored: number;
    skipped: number;
    errorCount: number;
    status: string;
    summary?: unknown;
    startedAt: string;
    completedAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO settlement_reconciliation_runs (
       reconciliation_run_id,
       kind,
       checked_count,
       reconciled_count,
       ignored_count,
       skipped_count,
       error_count,
       status,
       summary,
       started_at,
       completed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
     ON CONFLICT (reconciliation_run_id) DO NOTHING`,
    [
      run.reconciliationRunId,
      run.kind,
      run.checked,
      run.reconciled,
      run.ignored,
      run.skipped,
      run.errorCount,
      run.status,
      JSON.stringify(run.summary ?? {}),
      run.startedAt,
      run.completedAt,
    ],
  );
}

export async function listSettlementReconciliationRuns(
  db: PgQueryable,
  params: Readonly<{ limit?: number }> = {},
): Promise<SettlementReconciliationRunRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const result = await db.query<SettlementReconciliationRunRow>(
    `SELECT
       reconciliation_run_id,
       kind,
       checked_count,
       reconciled_count,
       ignored_count,
       skipped_count,
       error_count,
       status,
       summary,
       started_at,
       completed_at
     FROM settlement_reconciliation_runs
     ORDER BY completed_at DESC, reconciliation_run_id DESC
     LIMIT $1`,
    [limit],
  );

  return result.rows;
}
