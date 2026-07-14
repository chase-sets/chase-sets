import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { recordRealtimeProjectionPatch, recordRealtimeProjectionPatches } from "@chase-sets/platform-runtime/realtime";
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
    shipping_destination_snapshot: unknown;
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

async function emitOfferPatch(db: PgQueryable, event: Parameters<ProjectorHandlerMap[string]>[0], offerId: string) {
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
  const offerMatchesBySellerAccountId = await listOfferMatchesForSellers(db, offerId, [...sellerAccountIds]);

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

export function buildMarketplaceOfferProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
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
        shippingDestinationSnapshot: unknown;
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
          shipping_destination_snapshot,
          price_amount,
          quantity_requested,
          status,
          accepted_seller_account_id,
          accepted_at,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'submitted', NULL, NULL, $12, $12
        )
        ON CONFLICT (offer_id) DO UPDATE SET
          buyer_account_id = EXCLUDED.buyer_account_id,
          catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
          product_id = EXCLUDED.product_id,
          item_title = EXCLUDED.item_title,
          item_subtitle = EXCLUDED.item_subtitle,
          selected_options = EXCLUDED.selected_options,
          product_summary = EXCLUDED.product_summary,
          shipping_destination_snapshot = EXCLUDED.shipping_destination_snapshot,
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
          JSON.stringify(data.shippingDestinationSnapshot),
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
        listingId: string;
        inventoryItemId: string;
        listingEvidencePolicyHash: string;
        listingEvidenceSnapshot: { snapshotHash: string };
        acceptedAt: string;
      };

      await db.query(
        `UPDATE marketplace_offer_pages
         SET status = 'accepted',
             accepted_seller_account_id = $2,
             accepted_listing_id = $3,
             accepted_inventory_item_id = $4,
             listing_evidence_policy_hash = $5,
             listing_evidence_snapshot_hash = $6,
             accepted_at = $7,
             updated_at = $7
         WHERE offer_id = $1`,
        [
          data.offerId,
          data.sellerAccountId,
          data.listingId,
          data.inventoryItemId,
          data.listingEvidencePolicyHash,
          data.listingEvidenceSnapshot.snapshotHash,
          data.acceptedAt,
        ],
      );
      await emitOfferPatch(db, event, data.offerId);
    },
    "marketplace.offer.match-declined": async (event) => {
      const data = event.data as {
        sellerAccountId: string;
        buyerAccountId: string;
        listingId: string;
        productId: string;
        offerId: string;
        offerPriceAmount: string;
        listingPriceAmount: string;
        declinedAt: string;
        lowballDeclineCount: number;
        lowballCooldownUntil: string | null;
      };

      await db.query(
        `INSERT INTO marketplace_offer_seller_declines (
          seller_account_id,
          buyer_account_id,
          listing_id,
          product_id,
          offer_id,
          offer_price_amount,
          listing_price_amount,
          declined_at,
          lowball_cooldown_until
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (seller_account_id, listing_id, offer_id) DO UPDATE SET
          declined_at = EXCLUDED.declined_at,
          lowball_cooldown_until = EXCLUDED.lowball_cooldown_until`,
        [
          data.sellerAccountId,
          data.buyerAccountId,
          data.listingId,
          data.productId,
          data.offerId,
          data.offerPriceAmount,
          data.listingPriceAmount,
          data.declinedAt,
          data.lowballCooldownUntil,
        ],
      );
      await db.query(
        `INSERT INTO marketplace_offer_seller_controls (
          seller_account_id,
          buyer_account_id,
          listing_id,
          product_id,
          declined_offer_count,
          lowball_decline_count,
          last_lowball_declined_amount,
          lowball_cooldown_until,
          updated_at
        ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8)
        ON CONFLICT (seller_account_id, buyer_account_id, listing_id) DO UPDATE SET
          product_id = EXCLUDED.product_id,
          declined_offer_count = marketplace_offer_seller_controls.declined_offer_count + 1,
          lowball_decline_count = EXCLUDED.lowball_decline_count,
          last_lowball_declined_amount = COALESCE(
            EXCLUDED.last_lowball_declined_amount,
            marketplace_offer_seller_controls.last_lowball_declined_amount
          ),
          lowball_cooldown_until = COALESCE(
            EXCLUDED.lowball_cooldown_until,
            marketplace_offer_seller_controls.lowball_cooldown_until
          ),
          updated_at = EXCLUDED.updated_at`,
        [
          data.sellerAccountId,
          data.buyerAccountId,
          data.listingId,
          data.productId,
          data.lowballDeclineCount,
          data.lowballCooldownUntil ? data.offerPriceAmount : null,
          data.lowballCooldownUntil,
          data.declinedAt,
        ],
      );
      await emitOfferPatch(db, event, data.offerId);
    },
    "marketplace.offer.buyer-muted": async (event) => {
      const data = event.data as {
        sellerAccountId: string;
        buyerAccountId: string;
        listingId: string;
        productId: string;
        offerId: string | null;
        mutedAt: string;
      };

      await db.query(
        `INSERT INTO marketplace_offer_seller_controls (
          seller_account_id,
          buyer_account_id,
          listing_id,
          product_id,
          muted_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT (seller_account_id, buyer_account_id, listing_id) DO UPDATE SET
          product_id = EXCLUDED.product_id,
          muted_at = EXCLUDED.muted_at,
          updated_at = EXCLUDED.updated_at`,
        [data.sellerAccountId, data.buyerAccountId, data.listingId, data.productId, data.mutedAt],
      );
      if (data.offerId) {
        await emitOfferPatch(db, event, data.offerId);
      }
    },
    "marketplace.offer.buyer-unmuted": async (event) => {
      const data = event.data as {
        sellerAccountId: string;
        buyerAccountId: string;
        listingId: string;
        unmutedAt: string;
      };

      await db.query(
        `UPDATE marketplace_offer_seller_controls
         SET muted_at = NULL,
             updated_at = $4
         WHERE seller_account_id = $1
           AND buyer_account_id = $2
           AND listing_id = $3`,
        [data.sellerAccountId, data.buyerAccountId, data.listingId, data.unmutedAt],
      );
    },
  };
}
