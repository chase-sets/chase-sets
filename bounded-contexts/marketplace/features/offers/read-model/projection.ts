import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  recordRealtimeProjectionPatch,
  recordRealtimeProjectionPatches,
} from "@chase-sets/platform-runtime/realtime";
import {
  createMarketplaceOfferMatchPatch,
  createMarketplaceOfferPatch,
} from "../../../support/realtime-support/projection-patches";
import { marketplaceRealtimeTopics } from "../../../support/realtime-support/topics";
import { listOfferMatchesForSellers } from "./queries";

async function loadRealtimeOffer(db: PgQueryable, offerId: string) {
  const result = await db.query<{
    offer_id: string;
    buyer_account_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    item_title: string;
    item_subtitle: string | null;
    selected_options: unknown;
    product_summary: string | null;
    price_amount: string;
    quantity_requested: number;
    status: string;
    accepted_seller_account_id: string | null;
    accepted_at: string | null;
    created_at: string;
    updated_at: string;
  }>("SELECT * FROM marketplace_offer_pages WHERE offer_id = $1", [offerId]);
  const row = result.rows[0];

  return row
    ? {
        ...row,
        selected_options: Array.isArray(row.selected_options) ? row.selected_options : [],
      }
    : null;
}

async function loadInterestedSellerAccountIds(db: PgQueryable, productId: string) {
  const result = await db.query<{ account_id: string }>(
    `SELECT DISTINCT account_id
     FROM marketplace_listing_pages
     WHERE product_id = $1
       AND status = 'active'`,
    [productId],
  );

  return result.rows.map((row) => row.account_id);
}

async function emitOfferPatch(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  offerId: string,
) {
  const offer = await loadRealtimeOffer(db, offerId);
  if (!offer) {
    return;
  }

  const buyerTopics = [marketplaceRealtimeTopics.accountOffers(offer.buyer_account_id)];

  await recordRealtimeProjectionPatch(db, {
    sourceGlobalPosition: event.globalPosition,
    projectionName: "marketplace-offer-projection",
    patchKey: `offer:${offerId}`,
    topics: buyerTopics,
    recordedAt: event.timing.recordedAt,
    patch: createMarketplaceOfferPatch(buyerTopics, offer),
  });

  const sellerAccountIds = new Set(await loadInterestedSellerAccountIds(db, offer.product_id));
  if (offer.accepted_seller_account_id) {
    sellerAccountIds.add(offer.accepted_seller_account_id);
  }
  const offerMatchesBySellerAccountId = await listOfferMatchesForSellers(
    db,
    offerId,
    [...sellerAccountIds],
  );

  await recordRealtimeProjectionPatches(
    db,
    [...sellerAccountIds].map((sellerAccountId) => {
      const topic = marketplaceRealtimeTopics.accountOffers(sellerAccountId);
      const offerMatch = offerMatchesBySellerAccountId.get(sellerAccountId);
      return {
        sourceGlobalPosition: event.globalPosition,
        projectionName: "marketplace-offer-projection",
        patchKey: `offer-match:${offerId}:${sellerAccountId}`,
        topics: [topic],
        recordedAt: event.timing.recordedAt,
        patch: createMarketplaceOfferMatchPatch([topic], offerId, offerMatch ?? null),
      };
    }),
  );
}

export function buildMarketplaceOfferProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "marketplace.offer.submitted": async (event) => {
      const data = event.data as {
        offerId: string;
        buyerAccountId: string;
        catalogItemId: string;
        productId: string;
        itemTitle: string;
        itemSubtitle: string | null;
        selectedOptions: unknown;
        productSummary: string | null;
        priceAmount: string;
        quantityRequested: number;
      };

      await db.query(
        `INSERT INTO marketplace_offer_pages (
          offer_id,
          buyer_account_id,
          catalog_catalog_item_id,
          product_id,
          item_title,
          item_subtitle,
          selected_options,
          product_summary,
          price_amount,
          quantity_requested,
          status,
          accepted_seller_account_id,
          accepted_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'submitted', NULL, NULL, $11, $11
        )
        ON CONFLICT (offer_id) DO UPDATE SET
          buyer_account_id = EXCLUDED.buyer_account_id,
          catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
          product_id = EXCLUDED.product_id,
          item_title = EXCLUDED.item_title,
          item_subtitle = EXCLUDED.item_subtitle,
          selected_options = EXCLUDED.selected_options,
          product_summary = EXCLUDED.product_summary,
          price_amount = EXCLUDED.price_amount,
          quantity_requested = EXCLUDED.quantity_requested,
          status = EXCLUDED.status,
          accepted_seller_account_id = EXCLUDED.accepted_seller_account_id,
          accepted_at = EXCLUDED.accepted_at,
          updated_at = EXCLUDED.updated_at`,
        [
          data.offerId,
          data.buyerAccountId,
          data.catalogItemId,
          data.productId,
          data.itemTitle,
          data.itemSubtitle,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.productSummary,
          data.priceAmount,
          data.quantityRequested,
          event.timing.recordedAt,
        ],
      );
      await emitOfferPatch(db, event, data.offerId);
    },
    "marketplace.offer.accepted": async (event) => {
      const data = event.data as {
        offerId: string;
        sellerAccountId: string;
        acceptedAt: string;
      };

      await db.query(
        `UPDATE marketplace_offer_pages
         SET status = 'accepted',
             accepted_seller_account_id = $2,
             accepted_at = $3,
             updated_at = $3
         WHERE offer_id = $1`,
        [data.offerId, data.sellerAccountId, data.acceptedAt],
      );
      await emitOfferPatch(db, event, data.offerId);
    },
  };
}
