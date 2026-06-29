import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type CheckoutPaymentSummaryRow = Readonly<{
  payment_id: string;
  amount: string;
  currency_code: string;
  status: string;
}>;

export async function getCheckoutPaymentSummary(
  db: PgQueryable,
  paymentId: string,
): Promise<CheckoutPaymentSummaryRow | null> {
  const result = await db.query<CheckoutPaymentSummaryRow>(
    `SELECT payment_id,
            amount,
            currency_code,
            status
       FROM checkout_payment_summary_pages
      WHERE payment_id = $1`,
    [paymentId],
  );

  return result.rows[0] ?? null;
}
