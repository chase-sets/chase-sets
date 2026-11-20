import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { emitBuyerOfferPatches } from "./projection";

export function buildDiscoveryBuyerOfferStandingHandlers(db: PgQueryable): ProjectorHandlerMap {
  const project =
    (offersAway: boolean): ProjectorHandlerMap[string] =>
    async (event, context) => {
      const projectionDb = resolveProjectionDb(context, db);
      const accountId = String(event.data.accountId);
      const updated = await projectionDb.query(
        `WITH previous AS (
         SELECT offers_away FROM discovery_buyer_offer_standing WHERE account_id = $1
       ), updated AS (
         INSERT INTO discovery_buyer_offer_standing (account_id, offers_away, away_stream_version)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET
           offers_away = EXCLUDED.offers_away, away_stream_version = EXCLUDED.away_stream_version
         WHERE discovery_buyer_offer_standing.away_stream_version < EXCLUDED.away_stream_version
         RETURNING account_id, offers_away
       )
       SELECT account_id FROM updated
       WHERE offers_away <> COALESCE((SELECT offers_away FROM previous), FALSE)`,
        [accountId, offersAway, event.streamVersion],
      );
      if (updated.rows.length > 0) await emitBuyerOfferPatches(projectionDb, event, accountId, "offer-away");
    };
  return {
    "marketplace.seller-listing-availability.offers-disabled": project(true),
    "marketplace.seller-listing-availability.offers-enabled": project(false),
  };
}
