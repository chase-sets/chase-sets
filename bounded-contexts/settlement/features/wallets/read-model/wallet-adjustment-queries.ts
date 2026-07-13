import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { WalletAdjustmentActivityWindow } from "../domain/wallet-adjustment-limits-policy";

export type SettlementWalletAdjustmentRow = Readonly<{
  adjustment_id: string;
  status: "requested" | "approved" | "rejected" | "posted" | "reversed";
  target_account_id: string;
  direction: "credit" | "debit";
  amount: string;
  currency_code: string;
  reason_code: string;
  explanation: string | null;
  evidence_references: readonly string[];
  reversal_of_adjustment_id: string | null;
  reversed_by_adjustment_id: string | null;
  requested_by: string;
  requested_at: string;
  self_benefiting: boolean;
  approved_by: string | null;
  approved_at: string | null;
  elevation_required: boolean;
  elevation_reasons: readonly string[];
  elevation_approved_by: string | null;
  creates_or_increases_negative_balance: boolean;
  reversal_after_funds_settled: boolean;
  high_value_credit_threshold_amount: string | null;
  high_value_debit_threshold_amount: string | null;
  recent_auth_max_age_minutes: number | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  posted_ledger_entry_id: string | null;
  posted_at: string | null;
  available_balance_before: string | null;
  available_balance_after: string | null;
  reversed_at: string | null;
  updated_at: string;
}>;

const walletAdjustmentSelect = `
  SELECT
    adjustment_id,
    status,
    target_account_id,
    direction,
    amount::text AS amount,
    currency_code,
    reason_code,
    explanation,
    evidence_references,
    reversal_of_adjustment_id,
    reversed_by_adjustment_id,
    requested_by,
    requested_at,
    self_benefiting,
    approved_by,
    approved_at,
    elevation_required,
    elevation_reasons,
    elevation_approved_by,
    creates_or_increases_negative_balance,
    reversal_after_funds_settled,
    high_value_credit_threshold_amount::text AS high_value_credit_threshold_amount,
    high_value_debit_threshold_amount::text AS high_value_debit_threshold_amount,
    recent_auth_max_age_minutes,
    rejected_by,
    rejected_at,
    rejection_reason,
    posted_ledger_entry_id,
    posted_at,
    available_balance_before::text AS available_balance_before,
    available_balance_after::text AS available_balance_after,
    reversed_at,
    updated_at
  FROM settlement_wallet_adjustment_pages
`;

export async function getWalletAdjustment(
  db: PgQueryable,
  adjustmentId: string,
): Promise<SettlementWalletAdjustmentRow | null> {
  const result = await db.query<SettlementWalletAdjustmentRow>(
    `${walletAdjustmentSelect}
     WHERE adjustment_id = $1`,
    [adjustmentId],
  );
  return result.rows[0] ?? null;
}

export async function listWalletAdjustments(
  db: PgQueryable,
  params: Readonly<{
    targetAccountId?: string;
    status?: SettlementWalletAdjustmentRow["status"];
    limit?: number;
    offset?: number;
  }> = {},
): Promise<{ items: SettlementWalletAdjustmentRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const filters: string[] = [];
  const values: unknown[] = [];

  if (params.targetAccountId) {
    values.push(params.targetAccountId);
    filters.push(`target_account_id = $${values.length}`);
  }
  if (params.status) {
    values.push(params.status);
    filters.push(`status = $${values.length}`);
  }
  const whereClause = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM settlement_wallet_adjustment_pages
       ${whereClause}`,
      values,
    ),
    db.query<SettlementWalletAdjustmentRow>(
      `${walletAdjustmentSelect}
       ${whereClause}
       ORDER BY requested_at DESC, adjustment_id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

/**
 * Wallet Adjustments that were approved but whose ledger posting has not yet
 * been confirmed (or that are still awaiting approval). This is the observable
 * incomplete-status surface a durable retry sweeper polls so an approval can
 * never silently fail to post its wallet entry.
 */
/**
 * Rolling-window activity for a target account: the money-moving `postedAmount`
 * (posted/reversed adjustments only -- money that actually moved) and the
 * `requestedCount` (every request regardless of terminal status, to bound
 * request churn). Feeds `evaluateWalletAdjustmentLimits` at request time.
 */
export async function sumWalletAdjustmentTargetAccountActivity(
  db: PgQueryable,
  targetAccountId: string,
  sinceIso: string,
): Promise<WalletAdjustmentActivityWindow> {
  const [postedResult, requestedResult] = await Promise.all([
    db.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM settlement_wallet_adjustment_pages
       WHERE target_account_id = $1
         AND status IN ('posted', 'reversed')
         AND posted_at >= $2`,
      [targetAccountId, sinceIso],
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM settlement_wallet_adjustment_pages
       WHERE target_account_id = $1
         AND requested_at >= $2`,
      [targetAccountId, sinceIso],
    ),
  ]);
  return {
    postedAmount: postedResult.rows[0]?.total ?? "0.00",
    requestedCount: Number(requestedResult.rows[0]?.count ?? 0),
  };
}

/** Same shape as {@link sumWalletAdjustmentTargetAccountActivity}, scoped to the requesting operator. */
export async function sumWalletAdjustmentOperatorActivity(
  db: PgQueryable,
  requestedBy: string,
  sinceIso: string,
): Promise<WalletAdjustmentActivityWindow> {
  const [postedResult, requestedResult] = await Promise.all([
    db.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total
       FROM settlement_wallet_adjustment_pages
       WHERE requested_by = $1
         AND status IN ('posted', 'reversed')
         AND posted_at >= $2`,
      [requestedBy, sinceIso],
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM settlement_wallet_adjustment_pages
       WHERE requested_by = $1
         AND requested_at >= $2`,
      [requestedBy, sinceIso],
    ),
  ]);
  return {
    postedAmount: postedResult.rows[0]?.total ?? "0.00",
    requestedCount: Number(requestedResult.rows[0]?.count ?? 0),
  };
}

export async function listIncompleteWalletAdjustments(
  db: PgQueryable,
  params: Readonly<{ limit?: number }> = {},
): Promise<SettlementWalletAdjustmentRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const result = await db.query<SettlementWalletAdjustmentRow>(
    `${walletAdjustmentSelect}
     WHERE status IN ('requested', 'approved')
     ORDER BY requested_at ASC, adjustment_id ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}
