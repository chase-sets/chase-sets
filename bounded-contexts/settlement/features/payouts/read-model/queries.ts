import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type SettlementPayoutRow = Readonly<{
  payout_id: string;
  account_id: string;
  amount: string;
  currency_code: string;
  destination_reference: string | null;
  note: string | null;
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

const payoutSelect = `
  SELECT
    payout_id,
    account_id,
    amount::text AS amount,
    currency_code,
    destination_reference,
    note,
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

export async function listPayoutsNeedingReconciliation(
  db: PgQueryable,
  params: Readonly<{ limit?: number; filter?: string | null }> = {},
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
     ${filterSql}
     ORDER BY updated_at ASC, payout_id ASC
     LIMIT $1`,
    [limit],
  );

  return result.rows;
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
