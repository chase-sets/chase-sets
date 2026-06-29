import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

type CheckoutAffordanceInstrumentPayload = Readonly<{
  instrumentId: string;
  paymentMethodCategory: string;
  displayLabel: string;
  confirmationExperience: string;
  readiness: string;
  checkoutEligible: boolean;
  isDefault: boolean;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

type CheckoutAffordancesPublishedPayload = Readonly<{
  accountId: string;
  savedCheckoutInstruments: readonly CheckoutAffordanceInstrumentPayload[];
  publishedAt: string;
}>;

export function buildCheckoutPaymentAffordanceProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "payments.checkout-affordances-published": async (event) => {
      const data = event.data as CheckoutAffordancesPublishedPayload;
      const streamVersion = event.streamVersion;

      const accountVersion = await db.query(
        `INSERT INTO checkout_payment_affordance_account_snapshots (
           account_id,
           published_at,
           last_stream_version
         ) VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE
         SET published_at = EXCLUDED.published_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE checkout_payment_affordance_account_snapshots.last_stream_version < EXCLUDED.last_stream_version`,
        [data.accountId, data.publishedAt, streamVersion],
      );
      if (accountVersion.rowCount === 0) {
        return;
      }

      await db.query(
        `DELETE FROM checkout_payment_affordance_pages
          WHERE account_id = $1`,
        [data.accountId],
      );

      for (const instrument of data.savedCheckoutInstruments) {
        await db.query(
          `INSERT INTO checkout_payment_affordance_pages (
             account_id,
             instrument_id,
             payment_method_category,
             display_label,
             confirmation_experience,
             readiness,
             checkout_eligible,
             is_default,
             removed_at,
             created_at,
             updated_at,
             published_at,
             last_stream_version
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (account_id, instrument_id) DO UPDATE
           SET payment_method_category = EXCLUDED.payment_method_category,
               display_label = EXCLUDED.display_label,
               confirmation_experience = EXCLUDED.confirmation_experience,
               readiness = EXCLUDED.readiness,
               checkout_eligible = EXCLUDED.checkout_eligible,
               is_default = EXCLUDED.is_default,
               removed_at = EXCLUDED.removed_at,
               created_at = EXCLUDED.created_at,
               updated_at = EXCLUDED.updated_at,
               published_at = EXCLUDED.published_at,
               last_stream_version = EXCLUDED.last_stream_version
           WHERE checkout_payment_affordance_pages.last_stream_version < EXCLUDED.last_stream_version`,
          [
            data.accountId,
            instrument.instrumentId,
            instrument.paymentMethodCategory,
            instrument.displayLabel,
            instrument.confirmationExperience,
            instrument.readiness,
            instrument.checkoutEligible,
            instrument.isDefault,
            instrument.removedAt,
            instrument.createdAt,
            instrument.updatedAt,
            data.publishedAt,
            streamVersion,
          ],
        );
      }
    },
  };
}
