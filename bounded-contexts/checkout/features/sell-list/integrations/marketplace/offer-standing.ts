import { resolveProjectionDb, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export const checkoutBuyerOfferStandingSchemaSql = `CREATE TABLE IF NOT EXISTS checkout_buyer_offer_standing (
  account_id text PRIMARY KEY,
  offers_away boolean NOT NULL,
  away_stream_version integer NOT NULL
);`;

export function buildCheckoutBuyerOfferStandingHandlers(db: PgQueryable): ProjectorHandlerMap {
  const project =
    (offersAway: boolean): ProjectorHandlerMap[string] =>
    async (event, context) => {
      await resolveProjectionDb(context, db).query(
        `INSERT INTO checkout_buyer_offer_standing (account_id, offers_away, away_stream_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET
         offers_away = EXCLUDED.offers_away, away_stream_version = EXCLUDED.away_stream_version
       WHERE checkout_buyer_offer_standing.away_stream_version < EXCLUDED.away_stream_version`,
        [event.data.accountId, offersAway, event.streamVersion],
      );
    };
  return {
    "marketplace.seller-listing-availability.offers-disabled": project(true),
    "marketplace.seller-listing-availability.offers-enabled": project(false),
  };
}
