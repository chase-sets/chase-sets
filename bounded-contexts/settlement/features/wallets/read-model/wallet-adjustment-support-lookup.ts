import type { PgQueryable } from "@chase-sets/event-core-postgres";

/**
 * Support-safe Wallet Adjustment lookup for the unified support-reference
 * router (mirrors `../../payouts/read-model/support-lookup.ts`). Both entry
 * points are single indexed lookups: `display_reference` carries the unique
 * index added alongside the Wallet Adjustment display-reference projection
 * (see `wallet-adjustment-display-reference.ts`), and `adjustment_id` is the
 * table's primary key. Never returns `explanation` or `evidence_references`
 * -- those may carry operator-only fraud/dispute detail that is not safe to
 * hand to a support operator through the generic reference router; a support
 * operator who needs that detail uses the platform-admin wallet workbench,
 * which is permission-gated separately.
 */
export type SettlementWalletAdjustmentSupportLookupRow = Readonly<{
  adjustment_id: string;
  display_reference: string;
  status: string;
  target_account_id: string;
  direction: string;
  amount: string;
  currency_code: string;
  reason_code: string;
  requested_at: string;
}>;

const supportLookupSelect = `
  SELECT
    adjustment_id,
    display_reference,
    status,
    target_account_id,
    direction,
    amount::text AS amount,
    currency_code,
    reason_code,
    requested_at
  FROM settlement_wallet_adjustment_pages
`;

export async function lookupWalletAdjustmentBySupportReference(
  db: PgQueryable,
  displayReference: string,
): Promise<SettlementWalletAdjustmentSupportLookupRow | null> {
  const result = await db.query<SettlementWalletAdjustmentSupportLookupRow>(
    `${supportLookupSelect} WHERE display_reference = $1`,
    [displayReference],
  );

  return result.rows[0] ?? null;
}

export async function lookupWalletAdjustmentBySupportId(
  db: PgQueryable,
  adjustmentId: string,
): Promise<SettlementWalletAdjustmentSupportLookupRow | null> {
  const result = await db.query<SettlementWalletAdjustmentSupportLookupRow>(
    `${supportLookupSelect} WHERE adjustment_id = $1`,
    [adjustmentId],
  );

  return result.rows[0] ?? null;
}
