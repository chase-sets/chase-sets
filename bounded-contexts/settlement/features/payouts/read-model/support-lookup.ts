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
  amount: string;
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
