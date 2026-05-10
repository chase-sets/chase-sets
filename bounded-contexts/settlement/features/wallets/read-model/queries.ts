import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createEmptyWalletSummary } from "../../../support/runtime-support/common";

export type SettlementWalletRow = Readonly<{
  account_id: string;
  currency_code: string;
  pending_balance_amount: string;
  available_balance_amount: string;
  total_credited_amount: string;
  total_debited_amount: string;
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
}>;

const walletSelect = `
  SELECT
    account_id,
    currency_code,
    pending_balance_amount::text AS pending_balance_amount,
    available_balance_amount::text AS available_balance_amount,
    total_credited_amount::text AS total_credited_amount,
    total_debited_amount::text AS total_debited_amount,
    opened_at,
    updated_at
  FROM settlement_wallet_pages
`;

export async function getWallet(
  db: PgQueryable,
  accountId: string,
): Promise<SettlementWalletRow> {
  const result = await db.query<SettlementWalletRow>(
    `${walletSelect}
     WHERE account_id = $1`,
    [accountId],
  );

  const row = result.rows[0];
  if (row) {
    return row;
  }

  const empty = createEmptyWalletSummary(accountId as never);
  return {
    account_id: empty.accountId,
    currency_code: empty.currencyCode,
    pending_balance_amount: empty.pendingBalanceAmount,
    available_balance_amount: empty.availableBalanceAmount,
    total_credited_amount: empty.totalCreditedAmount,
    total_debited_amount: empty.totalDebitedAmount,
    opened_at: empty.openedAt,
    updated_at: empty.updatedAt,
  };
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
       WHERE account_id = $1
       ORDER BY posted_at DESC, ledger_entry_id DESC
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
         AND kind = 'sale'
         AND posted_at <= ($1::timestamptz - INTERVAL '2 days')
         AND NOT EXISTS (
           SELECT 1
           FROM settlement_support_holds support_hold
           WHERE support_hold.order_id = settlement_ledger_entry_pages.order_id
             AND support_hold.seller_account_id = settlement_ledger_entry_pages.account_id
             AND support_hold.active = TRUE
         )
         ORDER BY posted_at ASC, ledger_entry_id ASC
         LIMIT $2
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
           $3,
           now() + ($4::text || ' milliseconds')::interval,
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
      [params.now, limit, params.claimOwnerId, params.claimTtlMs ?? 120_000],
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
       AND kind = 'sale'
       AND posted_at <= ($1::timestamptz - INTERVAL '2 days')
       AND NOT EXISTS (
         SELECT 1
         FROM settlement_support_holds support_hold
         WHERE support_hold.order_id = settlement_ledger_entry_pages.order_id
           AND support_hold.seller_account_id = settlement_ledger_entry_pages.account_id
           AND support_hold.active = TRUE
       )
     ORDER BY posted_at ASC, ledger_entry_id ASC
     LIMIT $2`,
    [params.now, limit],
  );

  return result.rows;
}

export async function getAccountActiveSupportHoldAmount(
  db: PgQueryable,
  accountId: string,
): Promise<string> {
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
