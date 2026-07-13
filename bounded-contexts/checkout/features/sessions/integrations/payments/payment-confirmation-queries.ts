import type { PgQueryable } from "@chase-sets/event-core-postgres";

export type CheckoutPaymentConfirmationProjectionRow = Readonly<{
  payment_id: string;
  amount: string;
  currency_code: string;
  status: string;
  processor_client_secret: string | null;
}>;

export type CheckoutPaymentConfirmation = CheckoutPaymentConfirmationProjectionRow &
  Readonly<{
    processor_publishable_key: string | null;
  }>;

export function exposeCheckoutPaymentConfirmation(
  payment: CheckoutPaymentConfirmationProjectionRow,
  publicConfiguration: Readonly<{ publishableKey: string | null }> | undefined,
): CheckoutPaymentConfirmation {
  const canConfirmWithProcessor = payment.status === "pending-confirmation" && Boolean(payment.processor_client_secret);
  return {
    ...payment,
    processor_client_secret: canConfirmWithProcessor ? payment.processor_client_secret : null,
    processor_publishable_key: canConfirmWithProcessor ? (publicConfiguration?.publishableKey ?? null) : null,
  };
}

/**
 * Composes Checkout-owned session and payment projections so confirmation
 * state is only readable through the buyer's own checkout session.
 */
export async function getCheckoutPaymentConfirmationProjection(
  db: PgQueryable,
  sessionId: string,
  buyerAccountId: string,
): Promise<CheckoutPaymentConfirmationProjectionRow | null> {
  const result = await db.query<CheckoutPaymentConfirmationProjectionRow>(
    `SELECT payment.payment_id,
            payment.amount,
            payment.currency_code,
            payment.status,
            payment.processor_client_secret
       FROM checkout_session_pages AS session
       JOIN checkout_payment_summary_pages AS payment
         ON payment.payment_id = session.payment_id
      WHERE session.session_id = $1
        AND session.buyer_account_id = $2`,
    [sessionId, buyerAccountId],
  );

  return result.rows[0] ?? null;
}
