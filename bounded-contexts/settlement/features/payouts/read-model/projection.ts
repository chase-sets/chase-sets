import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PayoutId } from "@chase-sets/primitives/typed-ids";
import { withPayoutDisplayReference } from "./display-reference";

export function buildPayoutProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "settlement.payout.requested": async (event) => {
      const data = event.data as {
        payoutId: string;
        accountId: string;
        amount: string;
        currencyCode: string;
        destinationReference: string | null;
        note: string | null;
        requestedAt: string;
      };

      await withPayoutDisplayReference(data.payoutId as PayoutId, (displayReference) =>
        db.query(
          `INSERT INTO settlement_payout_pages (
             payout_id,
             account_id,
             amount,
             currency_code,
             destination_reference,
             note,
             display_reference,
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
             retry_reason,
             last_stream_version
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, 'requested', NULL, NULL, NULL, NULL, NULL, $8, $8, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, $9
           )
           ON CONFLICT (payout_id) DO UPDATE
           SET account_id = EXCLUDED.account_id,
               amount = EXCLUDED.amount,
               currency_code = EXCLUDED.currency_code,
               destination_reference = EXCLUDED.destination_reference,
               note = EXCLUDED.note,
               display_reference = EXCLUDED.display_reference,
               status = EXCLUDED.status,
               requested_at = EXCLUDED.requested_at,
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
            displayReference,
            data.requestedAt,
            event.streamVersion,
          ],
        ),
      );
    },
    "settlement.payout.provider-references-recorded": async (event) => {
      const data = event.data as {
        payoutId: string;
        providerTransferReference?: string | null;
        providerPayoutReference?: string | null;
        providerStatus?: string | null;
        recordedAt: string;
      };

      await db.query(
        `UPDATE settlement_payout_pages
         SET provider_transfer_reference = COALESCE($2, provider_transfer_reference),
             provider_payout_reference = COALESCE($3, provider_payout_reference),
             provider_status = COALESCE($4, provider_status),
             provider_failure_code = NULL,
             provider_failure_message = NULL,
             updated_at = $5,
             last_provider_event_at = $5,
             retry_reason = NULL,
             next_retry_at = NULL,
             last_stream_version = $6
         WHERE payout_id = $1
           AND last_stream_version < $6`,
        [
          data.payoutId,
          data.providerTransferReference ?? null,
          data.providerPayoutReference ?? null,
          data.providerStatus ?? null,
          data.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "settlement.payout.in-transit-recorded": async (event) => {
      const data = event.data as {
        payoutId: string;
        providerTransferReference?: string | null;
        providerPayoutReference?: string | null;
        providerStatus?: string | null;
        sentAt: string;
      };

      await db.query(
        `UPDATE settlement_payout_pages
         SET status = 'in-transit',
             provider_transfer_reference = COALESCE($2, provider_transfer_reference),
             provider_payout_reference = COALESCE($3, provider_payout_reference),
             provider_status = COALESCE($4, provider_status),
             provider_failure_code = NULL,
             provider_failure_message = NULL,
             sent_at = $5,
             updated_at = $5,
             last_provider_event_at = $5,
             retry_reason = NULL,
             next_retry_at = NULL,
             last_stream_version = $6
         WHERE payout_id = $1
           AND last_stream_version < $6`,
        [
          data.payoutId,
          data.providerTransferReference ?? null,
          data.providerPayoutReference ?? null,
          data.providerStatus ?? null,
          data.sentAt,
          event.streamVersion,
        ],
      );
    },
    "settlement.payout.completed": async (event) => {
      const data = event.data as {
        payoutId: string;
        providerStatus?: string | null;
        completedAt: string;
      };

      await db.query(
        `UPDATE settlement_payout_pages
         SET status = 'completed',
             provider_status = COALESCE($2, provider_status),
             provider_failure_code = NULL,
             provider_failure_message = NULL,
             completed_at = $3,
             updated_at = $3,
             failed_at = NULL,
             failure_reason = NULL,
             last_provider_event_at = $3,
             last_reconciled_at = $3,
             retry_reason = NULL,
             next_retry_at = NULL,
             last_stream_version = $4
         WHERE payout_id = $1
           AND last_stream_version < $4`,
        [data.payoutId, data.providerStatus ?? null, data.completedAt, event.streamVersion],
      );
    },
    "settlement.payout.failed": async (event) => {
      const data = event.data as {
        payoutId: string;
        failureReason: string | null;
        providerStatus?: string | null;
        providerFailureCode?: string | null;
        providerFailureMessage?: string | null;
        failedAt: string;
      };

      await db.query(
        `UPDATE settlement_payout_pages
         SET status = 'failed',
             provider_status = COALESCE($2, provider_status),
             provider_failure_code = $3,
             provider_failure_message = $4,
             failed_at = $5,
             failure_reason = $6,
             updated_at = $5,
             last_provider_event_at = $5,
             last_reconciled_at = $5,
             retry_count = retry_count + 1,
             next_retry_at = $5::timestamptz + INTERVAL '15 minutes',
             retry_reason = COALESCE($4, $6),
             last_stream_version = $7
         WHERE payout_id = $1
           AND last_stream_version < $7`,
        [
          data.payoutId,
          data.providerStatus ?? null,
          data.providerFailureCode ?? null,
          data.providerFailureMessage ?? null,
          data.failedAt,
          data.failureReason,
          event.streamVersion,
        ],
      );
    },
  };
}
