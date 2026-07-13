import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { createEmptyWalletSummary } from "../../../support/runtime-support/common";

export type SettlementWalletRow = Readonly<{
  account_id: string;
  currency_code: string;
  pending_balance_amount: string;
  available_balance_amount: string;
  total_credited_amount: string;
  total_debited_amount: string;
  negative_balance_status: "in-good-standing" | "negative" | "collections";
  negative_balance_started_at: string | null;
  collections_escalated_at: string | null;
  opened_at: string | null;
  updated_at: string | null;
}>;

export type SettlementLedgerEntryRow = Readonly<{
  ledger_entry_id: string;
  account_id: string;
  kind: string;
  direction: string;
  amount: string;
  currency_code: string;
  funds_status: string;
  order_id: string | null;
  payment_id: string | null;
  payout_id: string | null;
  description: string | null;
  posted_at: string;
  available_at: string | null;
  updated_at: string;
  /**
   * Wallet Adjustment linkage (ADR 0020), present only when `kind` is
   * `"adjustment"` -- `null` for every other ledger entry kind. Joined in
   * from `settlement_wallet_adjustment_pages` so the account-facing ledger
   * can present a Wallet Adjustment detail link and reversal status without
   * exposing the raw `description` free text, which may carry an operator's
   * internal explanation. `listWalletEntries` is the only query that
   * populates these; every other reader of `SettlementLedgerEntryRow` leaves
   * them `undefined` at the type level via the optional modifier below.
   */
  adjustment_id?: string | null;
  adjustment_display_reference?: string | null;
  adjustment_status?: "requested" | "approved" | "rejected" | "posted" | "reversed" | null;
  adjustment_reason_code?: string | null;
  adjustment_reversal_of_adjustment_id?: string | null;
  adjustment_reversed_by_adjustment_id?: string | null;
}>;

const walletSelect = `
  SELECT
    account_id,
    currency_code,
    pending_balance_amount::text AS pending_balance_amount,
    available_balance_amount::text AS available_balance_amount,
    total_credited_amount::text AS total_credited_amount,
    total_debited_amount::text AS total_debited_amount,
    negative_balance_status,
    negative_balance_started_at,
    collections_escalated_at,
    opened_at,
    updated_at
  FROM settlement_wallet_pages
`;

function normalizeWalletRow(row: SettlementWalletRow): SettlementWalletRow {
  return {
    ...row,
    negative_balance_status: row.negative_balance_status ?? "in-good-standing",
    negative_balance_started_at: row.negative_balance_started_at ?? null,
    collections_escalated_at: row.collections_escalated_at ?? null,
  };
}

export async function getWallet(db: PgQueryable, accountId: string): Promise<SettlementWalletRow> {
  const result = await db.query<SettlementWalletRow>(
    `${walletSelect}
     WHERE account_id = $1`,
    [accountId],
  );

  const row = result.rows[0];
  if (row) {
    return normalizeWalletRow(row);
  }

  const empty = createEmptyWalletSummary(accountId as AccountId);
  return {
    account_id: empty.accountId,
    currency_code: empty.currencyCode,
    pending_balance_amount: empty.pendingBalanceAmount,
    available_balance_amount: empty.availableBalanceAmount,
    total_credited_amount: empty.totalCreditedAmount,
    total_debited_amount: empty.totalDebitedAmount,
    negative_balance_status: "in-good-standing",
    negative_balance_started_at: null,
    collections_escalated_at: null,
    opened_at: empty.openedAt,
    updated_at: empty.updatedAt,
  };
}

export async function listNegativeBalanceAccounts(
  db: PgQueryable,
  params: Readonly<{ limit?: number; offset?: number }> = {},
): Promise<{ items: SettlementWalletRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM settlement_wallet_pages
       WHERE negative_balance_status <> 'in-good-standing'`,
    ),
    db.query<SettlementWalletRow>(
      `${walletSelect}
       WHERE negative_balance_status <> 'in-good-standing'
       ORDER BY negative_balance_started_at ASC NULLS LAST, account_id ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows.map(normalizeWalletRow),
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function listNegativeBalanceCollectionsCandidates(
  db: PgQueryable,
  params: Readonly<{
    now: string;
    thresholdAmount: string;
    gracePeriodDays: number;
    limit?: number;
  }>,
): Promise<SettlementWalletRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 250, 1000));
  const result = await db.query<SettlementWalletRow>(
    `${walletSelect}
     WHERE negative_balance_status = 'negative'
       AND available_balance_amount <= -($2::numeric)
       AND negative_balance_started_at <= ($1::timestamptz - ($3::text || ' days')::interval)
     ORDER BY negative_balance_started_at ASC, account_id ASC
     LIMIT $4`,
    [params.now, params.thresholdAmount, params.gracePeriodDays, limit],
  );

  return result.rows.map(normalizeWalletRow);
}

export async function listWalletEntries(
  db: PgQueryable,
  params: Readonly<{ accountId: string; limit?: number; offset?: number }>,
): Promise<{ items: SettlementLedgerEntryRow[]; total: number }> {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);

  const [countResult, itemsResult] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM settlement_ledger_entry_pages
       WHERE account_id = $1`,
      [params.accountId],
    ),
    db.query<SettlementLedgerEntryRow>(
      `SELECT
         entry.ledger_entry_id,
         entry.account_id,
         entry.kind,
         entry.direction,
         entry.amount::text AS amount,
         entry.currency_code,
         entry.funds_status,
         entry.order_id,
         entry.payment_id,
         entry.payout_id,
         entry.description,
         entry.posted_at,
         entry.available_at,
         entry.updated_at,
         adjustment.adjustment_id AS adjustment_id,
         adjustment.display_reference AS adjustment_display_reference,
         adjustment.status AS adjustment_status,
         adjustment.reason_code AS adjustment_reason_code,
         adjustment.reversal_of_adjustment_id AS adjustment_reversal_of_adjustment_id,
         adjustment.reversed_by_adjustment_id AS adjustment_reversed_by_adjustment_id
       FROM settlement_ledger_entry_pages entry
       LEFT JOIN settlement_wallet_adjustment_pages adjustment
         ON adjustment.posted_ledger_entry_id = entry.ledger_entry_id
       WHERE entry.account_id = $1
       ORDER BY entry.posted_at DESC, entry.ledger_entry_id DESC
       LIMIT $2 OFFSET $3`,
      [params.accountId, limit, offset],
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: Number(countResult.rows[0]?.count ?? 0),
  };
}

export async function listPendingCreditEntriesMaturedBy(
  db: PgQueryable,
  params: Readonly<{
    now: string;
    /** Settlement clearance policy's base clearance days (see `../domain/clearance-policy.ts`) -- resolved by the caller, not defaulted here. */
    baseClearanceDays: number;
    /** Settlement clearance policy's extended clearance days. */
    extendedClearanceDays: number;
    /** Settlement clearance policy's high-value threshold amount (decimal string). */
    highValueThresholdAmount: string;
    limit?: number;
    claimOwnerId?: string;
    claimTtlMs?: number;
  }>,
): Promise<SettlementLedgerEntryRow[]> {
  const limit = Math.max(1, Math.min(params.limit ?? 250, 1000));
  if (params.claimOwnerId) {
    const result = await db.query<SettlementLedgerEntryRow>(
      `WITH candidates AS (
         SELECT ledger_entry_id
         FROM settlement_ledger_entry_pages
       WHERE direction = 'credit'
         AND funds_status = 'pending'
         AND kind IN ('sale', 'rebate')
         AND posted_at <= ($1::timestamptz - ($2::text || ' days')::interval)
         AND EXISTS (
           SELECT 1
           FROM settlement_order_fulfillment_sources fulfillment
           WHERE fulfillment.order_id = settlement_ledger_entry_pages.order_id
             AND fulfillment.seller_account_id = settlement_ledger_entry_pages.account_id
             AND fulfillment.status = 'delivered'
             AND fulfillment.delivered_at IS NOT NULL
             AND fulfillment.delivered_at <= (
               $1::timestamptz - CASE
                 WHEN COALESCE((
                   SELECT risk.manual_payout_review
                   FROM settlement_account_risk_sources risk
                   WHERE risk.account_id = settlement_ledger_entry_pages.account_id
                 ), FALSE)
                   OR NOT COALESCE((
                     SELECT risk.trusted_seller
                     FROM settlement_account_risk_sources risk
                     WHERE risk.account_id = settlement_ledger_entry_pages.account_id
                   ), FALSE)
                   OR COALESCE((
                     SELECT risk.review_count
                     FROM settlement_account_risk_sources risk
                     WHERE risk.account_id = settlement_ledger_entry_pages.account_id
                   ), 0) = 0
                   OR COALESCE((
                     SELECT risk.shared_instrument_cluster_count
                     FROM settlement_account_risk_sources risk
                     WHERE risk.account_id = settlement_ledger_entry_pages.account_id
                   ), 0) > 0
                   OR COALESCE((
                     SELECT risk.shared_address_cluster_count
                     FROM settlement_account_risk_sources risk
                     WHERE risk.account_id = settlement_ledger_entry_pages.account_id
                   ), 0) > 0
                   OR NOT EXISTS (
                     SELECT 1
                     FROM settlement_order_trust_signal_sources trust_source
                     WHERE trust_source.order_id = settlement_ledger_entry_pages.order_id
                       AND trust_source.seller_account_id = settlement_ledger_entry_pages.account_id
                       AND trust_source.trust_signal_eligible = TRUE
                   )
                   OR EXISTS (
                     SELECT 1
                     FROM settlement_ledger_entry_pages order_sale
                     WHERE order_sale.order_id = settlement_ledger_entry_pages.order_id
                       AND order_sale.account_id = settlement_ledger_entry_pages.account_id
                       AND order_sale.direction = 'credit'
                       AND order_sale.kind = 'sale'
                       AND order_sale.amount >= $4::numeric
                   )
                 THEN ($3::text || ' days')::interval
                 ELSE ($2::text || ' days')::interval
               END
             )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM settlement_support_holds support_hold
           WHERE support_hold.order_id = settlement_ledger_entry_pages.order_id
             AND support_hold.seller_account_id = settlement_ledger_entry_pages.account_id
             AND support_hold.active = TRUE
         )
         ORDER BY posted_at ASC, ledger_entry_id ASC
         LIMIT $5
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
           'seller-funds-release',
           ledger_entry_id,
           $6,
           now() + ($7::text || ' milliseconds')::interval,
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
       SELECT
         ledger_entry_id,
         account_id,
         kind,
         direction,
         amount::text AS amount,
         currency_code,
         funds_status,
         order_id,
         payment_id,
         payout_id,
         description,
         posted_at,
         available_at,
         updated_at
       FROM settlement_ledger_entry_pages
       WHERE ledger_entry_id IN (SELECT entity_id FROM claimed)
       ORDER BY posted_at ASC, ledger_entry_id ASC`,
      [
        params.now,
        params.baseClearanceDays,
        params.extendedClearanceDays,
        params.highValueThresholdAmount,
        limit,
        params.claimOwnerId,
        params.claimTtlMs ?? 120_000,
      ],
    );

    return result.rows;
  }

  const result = await db.query<SettlementLedgerEntryRow>(
    `SELECT
       ledger_entry_id,
       account_id,
       kind,
       direction,
       amount::text AS amount,
       currency_code,
       funds_status,
       order_id,
       payment_id,
       payout_id,
       description,
       posted_at,
       available_at,
       updated_at
     FROM settlement_ledger_entry_pages
     WHERE direction = 'credit'
       AND funds_status = 'pending'
       AND kind IN ('sale', 'rebate')
       AND posted_at <= ($1::timestamptz - ($2::text || ' days')::interval)
       AND EXISTS (
         SELECT 1
         FROM settlement_order_fulfillment_sources fulfillment
         WHERE fulfillment.order_id = settlement_ledger_entry_pages.order_id
           AND fulfillment.seller_account_id = settlement_ledger_entry_pages.account_id
           AND fulfillment.status = 'delivered'
           AND fulfillment.delivered_at IS NOT NULL
           AND fulfillment.delivered_at <= (
             $1::timestamptz - CASE
               WHEN COALESCE((
                 SELECT risk.manual_payout_review
                 FROM settlement_account_risk_sources risk
                 WHERE risk.account_id = settlement_ledger_entry_pages.account_id
               ), FALSE)
                 OR NOT COALESCE((
                   SELECT risk.trusted_seller
                   FROM settlement_account_risk_sources risk
                   WHERE risk.account_id = settlement_ledger_entry_pages.account_id
                 ), FALSE)
                 OR COALESCE((
                   SELECT risk.review_count
                   FROM settlement_account_risk_sources risk
                   WHERE risk.account_id = settlement_ledger_entry_pages.account_id
                 ), 0) = 0
                 OR COALESCE((
                   SELECT risk.shared_instrument_cluster_count
                   FROM settlement_account_risk_sources risk
                   WHERE risk.account_id = settlement_ledger_entry_pages.account_id
                 ), 0) > 0
                 OR COALESCE((
                   SELECT risk.shared_address_cluster_count
                   FROM settlement_account_risk_sources risk
                   WHERE risk.account_id = settlement_ledger_entry_pages.account_id
                 ), 0) > 0
                 OR NOT EXISTS (
                   SELECT 1
                   FROM settlement_order_trust_signal_sources trust_source
                   WHERE trust_source.order_id = settlement_ledger_entry_pages.order_id
                     AND trust_source.seller_account_id = settlement_ledger_entry_pages.account_id
                     AND trust_source.trust_signal_eligible = TRUE
                 )
                 OR EXISTS (
                   SELECT 1
                   FROM settlement_ledger_entry_pages order_sale
                   WHERE order_sale.order_id = settlement_ledger_entry_pages.order_id
                     AND order_sale.account_id = settlement_ledger_entry_pages.account_id
                     AND order_sale.direction = 'credit'
                     AND order_sale.kind = 'sale'
                     AND order_sale.amount >= $4::numeric
                 )
               THEN ($3::text || ' days')::interval
               ELSE ($2::text || ' days')::interval
             END
           )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM settlement_support_holds support_hold
         WHERE support_hold.order_id = settlement_ledger_entry_pages.order_id
           AND support_hold.seller_account_id = settlement_ledger_entry_pages.account_id
           AND support_hold.active = TRUE
       )
     ORDER BY posted_at ASC, ledger_entry_id ASC
     LIMIT $5`,
    [params.now, params.baseClearanceDays, params.extendedClearanceDays, params.highValueThresholdAmount, limit],
  );

  return result.rows;
}

export async function getAccountActiveSupportHoldAmount(db: PgQueryable, accountId: string): Promise<string> {
  const result = await db.query<{ amount: string }>(
    `SELECT COALESCE(SUM(entry.amount), 0)::text AS amount
     FROM settlement_ledger_entry_pages entry
     WHERE entry.account_id = $1
       AND entry.direction = 'credit'
       AND entry.funds_status = 'available'
       AND entry.kind IN ('sale', 'rebate')
       AND EXISTS (
         SELECT 1
         FROM settlement_support_holds support_hold
         WHERE support_hold.order_id = entry.order_id
           AND support_hold.seller_account_id = entry.account_id
           AND support_hold.active = TRUE
       )`,
    [accountId],
  );

  return Number.parseFloat(result.rows[0]?.amount ?? "0").toFixed(2);
}

/**
 * SUM of every 'sale' credit ledger entry posted within a calendar month --
 * the settlement-ledger side of platform-operations' tape-vs-ledger GMV
 * reconciliation drift alarm.
 *
 * This is NOT expected to equal pricing's gross Platform Daily Rollup GMV
 * for the same month: 'sale' credits are posted net of the marketplace
 * sales fee (see wallets/integrations/payment-source/payment-source-projection.ts,
 * which posts `payout.sellerItemNetAmount`), so the ledger total is
 * systematically lower than gross tape GMV by roughly the platform's take
 * rate, plus settlement-timing lag near the month boundary. The
 * reconciliation check this feeds compares the two against an expected
 * drift band, not equality -- see platform-operations'
 * insights-dashboards/read-model/reconciliation.ts.
 */
export async function getLedgerSaleCreditTotalForMonth(
  db: PgQueryable,
  params: Readonly<{ /** YYYY-MM */ yearMonth: string }>,
): Promise<string> {
  const result = await db.query<{ amount: string | null }>(
    `SELECT COALESCE(SUM(amount), 0)::numeric(14, 2) AS amount
     FROM settlement_ledger_entry_pages
     WHERE direction = 'credit'
       AND kind = 'sale'
       AND date_trunc('month', posted_at) = to_date($1, 'YYYY-MM')`,
    [params.yearMonth],
  );

  return result.rows[0]?.amount ?? "0.00";
}
