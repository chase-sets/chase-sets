import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { WalletAdjustmentActivityWindow } from "../domain/wallet-adjustment-limits-policy";

export type SettlementWalletAdjustmentRow = Readonly<{
  adjustment_id: string;
  status: "requested" | "approved" | "rejected" | "posted" | "reversed";
  target_account_id: string;
  /** Support-safe, account-facing reference (`WAD-...`); empty string for legacy rows written before this column existed. */
  display_reference: string;
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
    display_reference,
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

/**
 * The account-facing Wallet Adjustment detail shape: deliberately narrower
 * than {@link SettlementWalletAdjustmentRow}. It never carries the raw
 * `adjustment_id`/ledger-entry id, the operator's free-text `explanation`,
 * `evidence_references`, actor ids (`requested_by`/`approved_by`/etc.), or
 * internal governance detail (elevation reasons, policy thresholds,
 * self-benefiting/negative-balance flags, rejection reason) -- those are
 * operator-only per the account-facing money-UI rule and ADR 0020's
 * customer-safe/operator-only distinction. Linked reversal entries are
 * exposed only by their own support-safe display reference, never their raw
 * id, so an account holder can navigate the link without ever seeing an
 * internal identifier.
 */
export type SettlementWalletAdjustmentAccountDetailRow = Readonly<{
  status: "requested" | "approved" | "rejected" | "posted" | "reversed";
  display_reference: string;
  direction: "credit" | "debit";
  amount: string;
  currency_code: string;
  reason_code: string;
  requested_at: string;
  posted_at: string | null;
  available_balance_before: string | null;
  available_balance_after: string | null;
  reversed_at: string | null;
  /** The original adjustment's display reference, present only when this row is itself a reversal's correcting entry. */
  reversal_of_display_reference: string | null;
  /** The correcting reversal's display reference, present only once this adjustment has been reversed. */
  reversed_by_display_reference: string | null;
}>;

const walletAdjustmentAccountDetailSelect = `
  SELECT
    adjustment.status,
    adjustment.display_reference,
    adjustment.direction,
    adjustment.amount::text AS amount,
    adjustment.currency_code,
    adjustment.reason_code,
    adjustment.requested_at,
    adjustment.posted_at,
    adjustment.available_balance_before::text AS available_balance_before,
    adjustment.available_balance_after::text AS available_balance_after,
    adjustment.reversed_at,
    original.display_reference AS reversal_of_display_reference,
    reversal.display_reference AS reversed_by_display_reference
  FROM settlement_wallet_adjustment_pages adjustment
  LEFT JOIN settlement_wallet_adjustment_pages original
    ON original.adjustment_id = adjustment.reversal_of_adjustment_id
  LEFT JOIN settlement_wallet_adjustment_pages reversal
    ON reversal.adjustment_id = adjustment.reversed_by_adjustment_id
`;

/**
 * Self-scoped lookup for the account-facing adjustment detail surface: the
 * account holder pastes or follows a link to their own `WAD-...` reference
 * (or the raw typed id, from a server-rendered link), and this returns null
 * -- the same as "not found" -- for any adjustment that does not belong to
 * `accountId`. Account holders authorize by owning the account, never by a
 * platform permission, so a mismatch must never distinguish "exists on
 * someone else's account" from "does not exist." The result is redacted at
 * the SQL layer (see {@link SettlementWalletAdjustmentAccountDetailRow}), not
 * merely at the route boundary.
 */
export async function getWalletAdjustmentForAccount(
  db: PgQueryable,
  params: Readonly<{ reference: string; accountId: string }>,
): Promise<SettlementWalletAdjustmentAccountDetailRow | null> {
  const reference = params.reference.trim();
  if (!reference) {
    return null;
  }

  const isTypedId = /^wad_/i.test(reference);
  // A typed Wallet Adjustment id is a ULID (`wad_` + uppercase Crockford body)
  // stored verbatim, so it must be matched with its exact case -- lowercasing
  // it would corrupt the ULID body and miss every real adjustment. A display
  // reference (`WAD-...`) is uppercased so an account holder can paste it in
  // any case.
  const normalizedReference = isTypedId ? reference : reference.toUpperCase();
  const result = await db.query<SettlementWalletAdjustmentAccountDetailRow>(
    `${walletAdjustmentAccountDetailSelect}
     WHERE ${isTypedId ? "adjustment.adjustment_id = $1" : "adjustment.display_reference = $1"}
       AND adjustment.target_account_id = $2`,
    [normalizedReference, params.accountId],
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
