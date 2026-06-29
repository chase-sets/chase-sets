import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type CheckoutSavedPaymentInstrumentRow = Readonly<{
  instrument_id: string;
  payment_method_category: string;
  display_label: string;
  confirmation_experience: string;
  readiness: string;
  is_default: boolean;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}>;

export async function listCheckoutSavedPaymentInstruments(
  db: PgQueryable,
  accountId: string,
): Promise<CheckoutSavedPaymentInstrumentRow[]> {
  const result = await db.query<CheckoutSavedPaymentInstrumentRow>(
    `SELECT instrument_id,
            payment_method_category,
            display_label,
            confirmation_experience,
            readiness,
            is_default,
            removed_at,
            created_at,
            updated_at
       FROM checkout_payment_affordance_pages
      WHERE account_id = $1
        AND checkout_eligible = true
        AND readiness = 'ready'
        AND removed_at IS NULL
      ORDER BY is_default DESC, updated_at DESC, instrument_id ASC`,
    [accountId],
  );

  return result.rows;
}
