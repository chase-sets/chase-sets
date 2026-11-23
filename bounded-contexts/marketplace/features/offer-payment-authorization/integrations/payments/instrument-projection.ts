import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PaymentsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { instrumentCategorySchema } from "../../domain/contracts";

export const buyerPaymentInstrumentProjectionName = "marketplace.buyer-payment-instrument-projection";
export const buyerPaymentInstrumentMirrored = "marketplace.buyer-payment-instrument.mirrored";

export function buildInstrumentProjection(
  recordCommittedHandoff: (db: PgQueryable, event: TransportEvent) => Promise<void>,
): ProjectorHandlerMap {
  return defineProjectorHandlers<Pick<PaymentsEventPayloads, "payments.checkout-affordances-published">>({
    "payments.checkout-affordances-published": async (event, context) => {
      const db = context?.db as PgQueryable | undefined;
      if (!db) throw new Error("Buyer payment instrument projection requires a transaction.");
      const { accountId, publishedAt, savedCheckoutInstruments } = event.data;
      const snapshot = await db.query(
        `INSERT INTO marketplace_buyer_payment_instrument_snapshots (account_id, published_at, last_stream_version)
         VALUES ($1,$2,$3) ON CONFLICT (account_id) DO UPDATE SET
           published_at = EXCLUDED.published_at, last_stream_version = EXCLUDED.last_stream_version
         WHERE marketplace_buyer_payment_instrument_snapshots.last_stream_version < EXCLUDED.last_stream_version`,
        [accountId, publishedAt, event.streamVersion],
      );
      if (snapshot.rowCount === 0) return;
      await db.query(`DELETE FROM marketplace_buyer_payment_instruments WHERE account_id = $1`, [accountId]);
      for (const saved of savedCheckoutInstruments) {
        await db.query(
          `INSERT INTO marketplace_buyer_payment_instruments
             (account_id, instrument_id, category, readiness, checkout_eligible, display_label, removed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            accountId,
            saved.instrumentId,
            saved.paymentMethodCategory,
            saved.readiness,
            saved.checkoutEligible,
            saved.displayLabel,
            saved.removedAt,
          ],
        );
      }
      // The local event is only visible to reconciliation when this mirror transaction commits.
      await recordCommittedHandoff(db, event);
    },
  });
}

type MirroredInstrument = Readonly<{
  instrument_id: string;
  category: string;
  readiness: string;
  checkout_eligible: boolean;
  display_label: string;
  removed_at: Date | string | null;
}>;

export async function readBuyerInstruments(db: PgQueryable, accountId: string, instrumentId?: string) {
  const result = await db.query<MirroredInstrument>(
    `SELECT instrument_id, category, readiness, checkout_eligible, display_label, removed_at
       FROM marketplace_buyer_payment_instruments WHERE account_id = $1
       ${instrumentId === undefined ? "" : "AND instrument_id = $2"} ORDER BY instrument_id`,
    instrumentId === undefined ? [accountId] : [accountId, instrumentId],
  );
  return result.rows.flatMap((row) => {
    const category = instrumentCategorySchema.safeParse(row.category);
    return category.success
      ? [
          {
            instrumentId: row.instrument_id,
            category: category.data,
            displayLabel: row.display_label,
            readiness: row.readiness,
            checkoutEligible: row.checkout_eligible,
            removedAt: row.removed_at,
          },
        ]
      : [];
  });
}

export function isEligibleInstrument(instrument: Awaited<ReturnType<typeof readBuyerInstruments>>[number], now: Date) {
  return (
    instrument.readiness === "ready" &&
    instrument.checkoutEligible &&
    (instrument.removedAt === null || new Date(instrument.removedAt) > now)
  );
}
