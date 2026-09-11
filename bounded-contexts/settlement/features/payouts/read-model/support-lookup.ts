import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Support-safe payout lookup for the unified support-reference router.
 * Both entry points are single indexed lookups: `display_reference`
 * carries the unique index added alongside the payout display-reference
 * projection (see `display-reference.ts`), and `payout_id` is the table's
 * primary key.
 */
export type SettlementSupportLookupRow = Readonly<{
  payout_id: string;
  display_reference: string;
  status: string;
  account_id: string;
  /** Historical storage alias for requested_amount. */
  amount: string;
  requested_amount: string;
  fee_amount: string;
  net_amount: string;
  currency_code: string;
  requested_at: string;
}>;

const supportLookupSelect = `
  SELECT
    payout_id,
    display_reference,
    status,
    account_id,
    amount::text AS amount,
    requested_amount::text AS requested_amount,
    fee_amount::text AS fee_amount,
    net_amount::text AS net_amount,
    currency_code,
    requested_at
  FROM settlement_payout_pages
`;

export async function lookupPayoutBySupportReference(
  db: PgQueryable,
  displayReference: string,
): Promise<SettlementSupportLookupRow | null> {
  const result = await db.query<SettlementSupportLookupRow>(`${supportLookupSelect} WHERE display_reference = $1`, [
    displayReference,
  ]);

  return result.rows[0] ?? null;
}

export async function lookupPayoutBySupportId(
  db: PgQueryable,
  payoutId: string,
): Promise<SettlementSupportLookupRow | null> {
  const result = await db.query<SettlementSupportLookupRow>(`${supportLookupSelect} WHERE payout_id = $1`, [payoutId]);

  return result.rows[0] ?? null;
}
