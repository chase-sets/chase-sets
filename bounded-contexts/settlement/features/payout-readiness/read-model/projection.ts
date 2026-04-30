import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildPayoutReadinessProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "settlement.payout-readiness.recorded": async (event) => {
      const data = event.data as unknown as {
        accountId: string;
        status: string;
        missingRequirements: readonly string[];
        providerReference: string | null;
        recordedAt: string;
      };

      await db.query(
        `INSERT INTO settlement_payout_readiness_pages (
           account_id,
           status,
           missing_requirements,
           provider_reference,
           updated_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id) DO UPDATE
         SET status = EXCLUDED.status,
             missing_requirements = EXCLUDED.missing_requirements,
             provider_reference = EXCLUDED.provider_reference,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE settlement_payout_readiness_pages.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.accountId,
          data.status,
          JSON.stringify(Array.isArray(data.missingRequirements) ? data.missingRequirements : []),
          data.providerReference,
          data.recordedAt,
          event.streamVersion,
        ],
      );
    },
  };
}
