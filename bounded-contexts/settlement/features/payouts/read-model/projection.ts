import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildPayoutProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "settlement.payout.scheduled": async (event) => {
      const data = event.data as {
        payoutId: string;
        accountId: string;
        amount: string;
        currencyCode: string;
        destinationReference: string | null;
        note: string | null;
        scheduledAt: string;
      };

      await db.query(
        `INSERT INTO settlement_payout_pages (
           payout_id,
           account_id,
           amount,
           currency_code,
           destination_reference,
           note,
           status,
           scheduled_at,
           updated_at,
           sent_at,
           completed_at,
           failed_at,
           failure_reason,
           last_stream_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 'scheduled', $7, $7, NULL, NULL, NULL, NULL, $8
         )
         ON CONFLICT (payout_id) DO UPDATE
         SET account_id = EXCLUDED.account_id,
             amount = EXCLUDED.amount,
             currency_code = EXCLUDED.currency_code,
             destination_reference = EXCLUDED.destination_reference,
             note = EXCLUDED.note,
             status = EXCLUDED.status,
             scheduled_at = EXCLUDED.scheduled_at,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE settlement_payout_pages.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.payoutId,
          data.accountId,
          data.amount,
          data.currencyCode,
          data.destinationReference,
          data.note,
          data.scheduledAt,
          event.streamVersion,
        ],
      );
    },
    "settlement.payout.in-transit-recorded": async (event) => {
      const data = event.data as {
        payoutId: string;
        sentAt: string;
      };

      await db.query(
        `UPDATE settlement_payout_pages
         SET status = 'in-transit',
             sent_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE payout_id = $1
           AND last_stream_version < $3`,
        [data.payoutId, data.sentAt, event.streamVersion],
      );
    },
    "settlement.payout.completed": async (event) => {
      const data = event.data as {
        payoutId: string;
        completedAt: string;
      };

      await db.query(
        `UPDATE settlement_payout_pages
         SET status = 'completed',
             completed_at = $2,
             updated_at = $2,
             failed_at = NULL,
             failure_reason = NULL,
             last_stream_version = $3
         WHERE payout_id = $1
           AND last_stream_version < $3`,
        [data.payoutId, data.completedAt, event.streamVersion],
      );
    },
    "settlement.payout.failed": async (event) => {
      const data = event.data as {
        payoutId: string;
        failureReason: string | null;
        failedAt: string;
      };

      await db.query(
        `UPDATE settlement_payout_pages
         SET status = 'failed',
             failed_at = $2,
             failure_reason = $3,
             updated_at = $2,
             last_stream_version = $4
         WHERE payout_id = $1
           AND last_stream_version < $4`,
        [data.payoutId, data.failedAt, data.failureReason, event.streamVersion],
      );
    },
  };
}
