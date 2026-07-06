import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId, OfferId } from "@chase-sets/primitives/typed-ids";
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
import { buildMarketplaceOfferProjectionHandlers } from "../read-model/projection";
import {
  getPublicOffer,
  getSubmittedOffer,
  getOfferMatch,
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

export type MarketplaceOfferServices = Readonly<{
  commandHandler: CommandHandler<MarketplaceOfferCommand, MarketplaceOfferState, MarketplaceOfferEvent>;
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

      const offerId = params.offerId ?? (createId("off") as OfferId);
      const result = await commandHandler({
        streamId: `marketplace.offer-${offerId}`,
        command: {
          type: "SubmitOffer",
          offerId,
          buyerAccountId: params.buyerAccountId,
          sellerAccountId: ownSellerAccountId as AccountId | null,
          catalogItemId: params.catalogItemId,
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
    projectors: [
      createProjectionHandlerSet({
        projectionName: "marketplace-offer-projection",
        handlers: buildMarketplaceOfferProjectionHandlers(deps.db),
      }),
    ],
  };
}
