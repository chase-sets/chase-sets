import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId, CatalogItemId, OfferId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceRuntimeDeps } from "../../../support/runtime-support";
import { quoteMarketplaceTerms } from "../../../support/runtime-support/fee-quotes";
import type { MarketplaceListingTermsPreview } from "../../listings/ui/contracts";
import {
  decideMarketplaceOffer,
  evolveMarketplaceOffer,
  initialMarketplaceOfferState,
  type MarketplaceOfferCommand,
  type MarketplaceOfferEvent,
  type MarketplaceOfferState,
} from "../domain/domain";
import {
  assertOfferSubmissionAllowed,
  DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY,
  MarketplaceOfferAbuseControlError,
  type MarketplaceOfferAbusePolicy,
  type MarketplaceOfferListingSubmissionGuard,
} from "../domain/offer-abuse-policy";
import {
  decideMarketplaceOfferSellerControl,
  evolveMarketplaceOfferSellerControl,
  initialMarketplaceOfferSellerControlState,
  type MarketplaceOfferSellerControlCommand,
  type MarketplaceOfferSellerControlEvent,
  type MarketplaceOfferSellerControlState,
} from "../domain/offer-seller-controls";
import { buildMarketplaceOfferProjectionHandlers } from "../read-model/projection";
import {
  getPublicOffer,
  getSubmittedOffer,
  getOfferMatch,
  getOfferBuyerMute,
  listOfferBuyerMutes,
  listSubmittedOffers,
  listOfferMatches,
} from "../read-model/queries";
import { createMarketplaceProductDescriptor, type MarketplaceVersionSchema } from "../domain/versioning";

export class MarketplaceOfferFeeQuoteStaleError extends Error {
  public constructor(public readonly currentQuote: MarketplaceListingTermsPreview) {
    super("Fee quote is stale. Refresh the fee preview before continuing.");
    this.name = "MarketplaceOfferFeeQuoteStaleError";
  }
}

export { MarketplaceOfferAbuseControlError };

export type MarketplaceOfferServices = Readonly<{
  commandHandler: CommandHandler<MarketplaceOfferCommand, MarketplaceOfferState, MarketplaceOfferEvent>;
  sellerControlCommandHandler: CommandHandler<
    MarketplaceOfferSellerControlCommand,
    MarketplaceOfferSellerControlState,
    MarketplaceOfferSellerControlEvent
  >;
  submitOffer: (
    params: Readonly<{
      offerId?: OfferId;
      buyerAccountId: AccountId;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      itemSubtitle: string | null;
      selectedOptions: readonly { dimensionId: string; optionId: string }[];
      productSummary: string | null;
      shippingDestinationSnapshot: AddressSnapshot;
      priceAmount: string;
      quantityRequested: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ offerId: OfferId; version: number }>;
  acceptOffer: (
    params: Readonly<{
      offerId: OfferId;
      sellerAccountId: AccountId;
      feeQuoteFingerprint?: string | null;
      sourceActionKey?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ offerId: OfferId; version: number }>;
  declineOfferMatch: (
    params: Readonly<{
      offerId: OfferId;
      sellerAccountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ offerId: OfferId; version: number }>;
  muteBuyerOffers: (
    params: Readonly<{
      offerId: OfferId;
      sellerAccountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ offerId: OfferId; version: number }>;
  unmuteBuyerOffers: (
    params: Readonly<{
      listingId: string;
      buyerAccountId: AccountId;
      sellerAccountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; buyerAccountId: AccountId; version: number }>;
  previewOfferAcceptanceTerms: (
    params: Readonly<{
      offerId: OfferId;
      sellerAccountId: AccountId;
    }>,
  ) => Promise<MarketplaceListingTermsPreview>;
  listSubmittedOffers: (params: Parameters<typeof listSubmittedOffers>[1]) => ReturnType<typeof listSubmittedOffers>;
  getSubmittedOffer: (offerId: string, buyerAccountId: string) => ReturnType<typeof getSubmittedOffer>;
  getPublicOffer: (offerId: string) => ReturnType<typeof getPublicOffer>;
  listOfferMatches: (params: Parameters<typeof listOfferMatches>[1]) => ReturnType<typeof listOfferMatches>;
  getOfferMatch: (offerId: string, sellerAccountId: string) => ReturnType<typeof getOfferMatch>;
  listOfferBuyerMutes: (sellerAccountId: string) => ReturnType<typeof listOfferBuyerMutes>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createMarketplaceOfferRuntime(deps: MarketplaceRuntimeDeps): MarketplaceOfferServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MarketplaceOfferEvent>(),
    initialState: () => initialMarketplaceOfferState,
    evolve: evolveMarketplaceOffer,
    decide: decideMarketplaceOffer,
  });
  const { commandHandler: sellerControlCommandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MarketplaceOfferSellerControlEvent>(),
    initialState: () => initialMarketplaceOfferSellerControlState,
    evolve: evolveMarketplaceOfferSellerControl,
    decide: decideMarketplaceOfferSellerControl,
  });

  async function getCatalogItemSnapshot(catalogItemId: string) {
    const result = await deps.db.query<{
      catalog_item_id: string;
      title: string;
      subtitle: string | null;
      status: string;
      product_schema: unknown;
    }>(
      `SELECT catalog_item_id, title, subtitle, status, product_schema
       FROM marketplace_catalog_items
       WHERE catalog_item_id = $1`,
      [catalogItemId],
    );

    return result.rows[0] ?? null;
  }

  async function findOwnActiveListingForProduct(buyerAccountId: AccountId, productId: string) {
    const result = await deps.db.query<{ account_id: string }>(
      `SELECT account_id
       FROM marketplace_listing_pages
       WHERE account_id = $1
         AND product_id = $2
         AND status = 'active'
       LIMIT 1`,
      [buyerAccountId, productId],
    );

    return result.rows[0]?.account_id ?? null;
  }

  function offerAbusePolicy(): MarketplaceOfferAbusePolicy {
    return DEFAULT_MARKETPLACE_OFFER_ABUSE_POLICY;
  }

  async function loadSubmissionGuard(
    buyerAccountId: AccountId,
    productId: string,
    offerPriceAmount: string,
    policy: MarketplaceOfferAbusePolicy,
  ) {
    const now = new Date();
    const dailyWindowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const buyerCountResult = await deps.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM marketplace_offer_pages
       WHERE buyer_account_id = $1
         AND created_at >= $2`,
      [buyerAccountId, dailyWindowStart],
    );
    const listingsResult = await deps.db.query<{
      listing_id: string;
      seller_account_id: string;
      listing_price_amount: string;
      buyer_listing_daily_offer_count: string;
      muted_at: string | null;
      lowball_cooldown_until: string | null;
      last_lowball_declined_amount: string | null;
    }>(
      `SELECT
         listing.listing_id,
         listing.account_id AS seller_account_id,
         listing.price_amount::text AS listing_price_amount,
         (
           SELECT COUNT(DISTINCT offer_scope.offer_id)::text
           FROM (
             SELECT offer.offer_id
             FROM marketplace_offer_pages AS offer
             WHERE offer.buyer_account_id = $1
               AND offer.product_id = $2
               AND offer.status = 'submitted'
               AND offer.created_at >= $3
               AND NOT EXISTS (
                 SELECT 1
                 FROM marketplace_offer_seller_declines AS decline
                 WHERE decline.seller_account_id = listing.account_id
                   AND decline.listing_id = listing.listing_id
                   AND decline.offer_id = offer.offer_id
               )
             UNION
             SELECT decline.offer_id
             FROM marketplace_offer_seller_declines AS decline
             WHERE decline.buyer_account_id = $1
               AND decline.listing_id = listing.listing_id
               AND decline.declined_at >= $3
           ) AS offer_scope
         ) AS buyer_listing_daily_offer_count,
         control.muted_at::text,
         control.lowball_cooldown_until::text,
         control.last_lowball_declined_amount::text
       FROM marketplace_listing_pages AS listing
       LEFT JOIN marketplace_offer_seller_controls AS control
         ON control.seller_account_id = listing.account_id
        AND control.buyer_account_id = $1
        AND control.listing_id = listing.listing_id
       WHERE listing.product_id = $2
         AND listing.status = 'active'
         AND listing.account_id <> $1
       ORDER BY listing.price_amount ASC, listing.updated_at DESC, listing.listing_id ASC`,
      [buyerAccountId, productId, dailyWindowStart],
    );

    assertOfferSubmissionAllowed({
      policy,
      now,
      buyerDailySubmissionCount: Number(buyerCountResult.rows[0]?.count ?? 0),
      offerPriceAmount,
      listingGuards: listingsResult.rows.map(
        (row): MarketplaceOfferListingSubmissionGuard => ({
          listingId: row.listing_id,
          sellerAccountId: row.seller_account_id,
          listingPriceAmount: row.listing_price_amount,
          buyerListingDailyOfferCount: Number(row.buyer_listing_daily_offer_count),
          mutedAt: row.muted_at,
          lowballCooldownUntil: row.lowball_cooldown_until,
          lastLowballDeclinedAmount: row.last_lowball_declined_amount,
        }),
      ),
    });
  }

  async function quoteOfferAcceptanceTerms(offerId: OfferId, sellerAccountId: AccountId) {
    const offer = await getOfferMatch(deps.db, offerId, sellerAccountId);
    if (!offer) {
      throw new Error("Offer not found.");
    }

    return quoteMarketplaceTerms(deps.commercialTermsResolver, {
      accountId: sellerAccountId,
      priceAmount: offer.price_amount,
    });
  }

  function assertConfirmedFeeQuote(
    providedFingerprint: string | null | undefined,
    currentQuote: MarketplaceListingTermsPreview,
  ) {
    if (providedFingerprint !== currentQuote.fee_quote_fingerprint) {
      throw new MarketplaceOfferFeeQuoteStaleError(currentQuote);
    }
  }

  return {
    commandHandler,
    sellerControlCommandHandler,
    submitOffer: async (params, context) => {
      const catalogItem = await getCatalogItemSnapshot(params.catalogItemId);
      if (!catalogItem) {
        throw new Error("Catalog item not found.");
      }

      if (catalogItem.status !== "active") {
        throw new Error("Offers may only reference active catalog items.");
      }

      const catalogVersion = createMarketplaceProductDescriptor({
        catalogItemId: params.catalogItemId,
        productSchema:
          typeof catalogItem.product_schema === "object" && catalogItem.product_schema !== null
            ? (catalogItem.product_schema as MarketplaceVersionSchema)
            : null,
        selection: params.selectedOptions,
      });

      if (params.productId.trim() !== catalogVersion.productId) {
        throw new Error("Offer product id does not match the selected options.");
      }
      const ownSellerAccountId = await findOwnActiveListingForProduct(params.buyerAccountId, catalogVersion.productId);
      if (ownSellerAccountId) {
        throw new Error("Accounts cannot offer on their own listings.");
      }
      await loadSubmissionGuard(
        params.buyerAccountId,
        catalogVersion.productId,
        params.priceAmount,
        offerAbusePolicy(),
      );

      const offerId = params.offerId ?? (createId("off") as OfferId);
      const result = await commandHandler({
        streamId: `marketplace.offer-${offerId}`,
        command: {
          type: "SubmitOffer",
          offerId,
          buyerAccountId: params.buyerAccountId,
          sellerAccountId: null,
          catalogItemId: params.catalogItemId as CatalogItemId,
          productId: catalogVersion.productId,
          itemTitle: params.itemTitle,
          itemSubtitle: params.itemSubtitle,
          selectedOptions: catalogVersion.selection,
          productSummary: params.productSummary,
          shippingDestinationSnapshot: params.shippingDestinationSnapshot,
          priceAmount: params.priceAmount,
          quantityRequested: params.quantityRequested,
        },
        context,
      });

      return { offerId, version: result.version };
    },
    declineOfferMatch: async (params, context) => {
      const offer = await getOfferMatch(deps.db, params.offerId, params.sellerAccountId);
      if (!offer) {
        throw new Error("Offer not found.");
      }
      const result = await sellerControlCommandHandler({
        streamId: `marketplace.offer-seller-control-${params.sellerAccountId}-${offer.buyer_account_id}-${offer.listing_id}`,
        command: {
          type: "DeclineOfferMatch",
          sellerAccountId: params.sellerAccountId,
          buyerAccountId: offer.buyer_account_id as AccountId,
          listingId: offer.listing_id,
          productId: offer.product_id,
          offerId: params.offerId,
          offerPriceAmount: offer.price_amount,
          listingPriceAmount: offer.listing_price_amount,
          declinedAt: new Date().toISOString(),
          policy: offerAbusePolicy(),
        },
        context,
      });

      return { offerId: params.offerId, version: result.version };
    },
    muteBuyerOffers: async (params, context) => {
      const offer = await getOfferMatch(deps.db, params.offerId, params.sellerAccountId);
      if (!offer) {
        throw new Error("Offer not found.");
      }
      const result = await sellerControlCommandHandler({
        streamId: `marketplace.offer-seller-control-${params.sellerAccountId}-${offer.buyer_account_id}-${offer.listing_id}`,
        command: {
          type: "MuteBuyerOffers",
          sellerAccountId: params.sellerAccountId,
          buyerAccountId: offer.buyer_account_id as AccountId,
          listingId: offer.listing_id,
          productId: offer.product_id,
          offerId: params.offerId,
          mutedAt: new Date().toISOString(),
        },
        context,
      });

      return { offerId: params.offerId, version: result.version };
    },
    unmuteBuyerOffers: async (params, context) => {
      const mute = await getOfferBuyerMute(deps.db, params);
      if (!mute) {
        throw new Error("Muted buyer not found.");
      }
      const result = await sellerControlCommandHandler({
        streamId: `marketplace.offer-seller-control-${params.sellerAccountId}-${params.buyerAccountId}-${params.listingId}`,
        command: {
          type: "UnmuteBuyerOffers",
          sellerAccountId: params.sellerAccountId,
          buyerAccountId: params.buyerAccountId,
          listingId: params.listingId,
          productId: mute.product_id,
          unmutedAt: new Date().toISOString(),
        },
        context,
      });

      return { listingId: params.listingId, buyerAccountId: params.buyerAccountId, version: result.version };
    },
    previewOfferAcceptanceTerms: async (params) => quoteOfferAcceptanceTerms(params.offerId, params.sellerAccountId),
    acceptOffer: async (params, context) => {
      const current = await repository.load(`marketplace.offer-${params.offerId}`);
      if (current.state.status === "accepted" && current.state.acceptedSellerAccountId === params.sellerAccountId) {
        return { offerId: params.offerId, version: current.version };
      }

      const offer = await getOfferMatch(deps.db, params.offerId, params.sellerAccountId);

      if (!offer) {
        throw new Error("Offer not found.");
      }
      if (offer.buyer_account_id === params.sellerAccountId) {
        throw new Error("Accounts cannot accept their own offers.");
      }
      if (offer.seller_listing_availability_status === "unavailable") {
        throw new Error("Seller listing availability is off.");
      }
      if (!offer.can_fulfill) {
        throw new Error("Seller does not have enough active supply to accept this offer.");
      }
      const quote = await quoteMarketplaceTerms(deps.commercialTermsResolver, {
        accountId: params.sellerAccountId,
        priceAmount: offer.price_amount,
      });
      assertConfirmedFeeQuote(params.feeQuoteFingerprint, quote);

      const result = await commandHandler({
        streamId: `marketplace.offer-${params.offerId}`,
        command: {
          type: "AcceptOffer",
          sellerAccountId: params.sellerAccountId,
          acceptedAt: new Date().toISOString(),
          marketplaceSalesFeePercentageBps: quote.marketplace_sales_fee_percentage_bps,
          marketplaceSalesFeeFixedAmount: quote.marketplace_sales_fee_fixed_amount,
          marketplaceSalesFeeCapAmount: quote.marketplace_sales_fee_cap_amount,
          marketplaceSalesFeeUnitAmount: quote.marketplace_sales_fee_unit_amount,
          sellerNetUnitAmount: quote.seller_net_unit_amount,
          shippingAllowancePercentageBps: quote.shipping_allowance_percentage_bps,
          termsScheduleId: quote.schedule_id,
          termsAgreementId: quote.agreement_id,
          termsResolvedAt: quote.resolved_at,
          feeQuoteFingerprint: quote.fee_quote_fingerprint,
          acceptanceBatchId: null,
          acceptanceBatchSize: null,
        },
        context,
      });

      return { offerId: params.offerId, version: result.version };
    },
    listSubmittedOffers: (params) => listSubmittedOffers(deps.db, params),
    getSubmittedOffer: (offerId, buyerAccountId) => getSubmittedOffer(deps.db, offerId, buyerAccountId),
    getPublicOffer: (offerId) => getPublicOffer(deps.db, offerId),
    listOfferMatches: (params) => listOfferMatches(deps.db, params),
    getOfferMatch: (offerId, sellerAccountId) => getOfferMatch(deps.db, offerId, sellerAccountId),
    listOfferBuyerMutes: (sellerAccountId) => listOfferBuyerMutes(deps.db, sellerAccountId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "marketplace-offer-projection",
        handlers: buildMarketplaceOfferProjectionHandlers(deps.db),
      }),
    ],
  };
}
