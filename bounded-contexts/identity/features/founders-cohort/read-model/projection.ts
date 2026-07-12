import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { FounderClaim } from "../domain/domain";

export function buildFoundersCohortProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.founders-cohort.founder-number-claimed": async (event) => {
      const claim = event.data as FounderClaim;
      await db.query(
        `INSERT INTO identity_founder_claims (
           account_id,
           founder_number,
           qualifying_act_type,
           qualifying_act_id,
           claimed_at,
           last_stream_version
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id) DO UPDATE
         SET founder_number = EXCLUDED.founder_number,
             qualifying_act_type = EXCLUDED.qualifying_act_type,
             qualifying_act_id = EXCLUDED.qualifying_act_id,
             claimed_at = EXCLUDED.claimed_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE identity_founder_claims.last_stream_version < EXCLUDED.last_stream_version`,
        [
          claim.accountId,
          claim.founderNumber,
          claim.qualifyingActType,
          claim.qualifyingActId,
          claim.claimedAt,
          event.streamVersion,
        ],
      );
    },
  };
}
