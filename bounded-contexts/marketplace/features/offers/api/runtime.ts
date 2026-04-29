import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, OfferId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceRuntimeDeps } from "../../../support/runtime-support";
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
  addBuyerOfferMatchSellListItem,
  getSubmittedBuyerOffer,
  getBuyerOfferMatch,
  listBuyerOfferMatchSellList,
  listSubmittedBuyerOffers,
  listBuyerOfferMatches,
  removeBuyerOfferMatchSellListItems,
} from "../read-model/queries";
import {
  createMarketplaceProductDescriptor,
  type MarketplaceVersionSchema,
} from "../domain/versioning";

export type MarketplaceOfferServices = Readonly<{
  commandHandler: CommandHandler<
    MarketplaceOfferCommand,
    MarketplaceOfferState,
    MarketplaceOfferEvent
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
      priceAmount: string;
      quantityRequested: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ offerId: OfferId; version: number }>;
  acceptOffer: (
    params: Readonly<{
      offerId: OfferId;
      sellerAccountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ offerId: OfferId; version: number }>;
  addBuyerOfferMatchSellListItem: (
    params: Readonly<{
      offerId: OfferId;
      sellerAccountId: AccountId;
    }>,
  ) => Promise<void>;
  listBuyerOfferMatchSellList: (
    sellerAccountId: string,
  ) => ReturnType<typeof listBuyerOfferMatchSellList>;
  acceptBuyerOfferMatchSellList: (
    params: Readonly<{
      sellerAccountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{
    acceptedOfferIds: readonly OfferId[];
    skipped: readonly { offerId: string; reason: string }[];
  }>;
  listSubmittedBuyerOffers: (
    params: Parameters<typeof listSubmittedBuyerOffers>[1],
  ) => ReturnType<typeof listSubmittedBuyerOffers>;
  getSubmittedBuyerOffer: (
    offerId: string,
    buyerAccountId: string,
  ) => ReturnType<typeof getSubmittedBuyerOffer>;
  listBuyerOfferMatches: (
    params: Parameters<typeof listBuyerOfferMatches>[1],
  ) => ReturnType<typeof listBuyerOfferMatches>;
  getBuyerOfferMatch: (
    offerId: string,
    sellerAccountId: string,
  ) => ReturnType<typeof getBuyerOfferMatch>;
  projectors: readonly Projector[];
}>;

export function createMarketplaceOfferRuntime(
  deps: MarketplaceRuntimeDeps,
): MarketplaceOfferServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<MarketplaceOfferEvent>(),
      initialState: () => initialMarketplaceOfferState,
      evolve: evolveMarketplaceOffer,
    }),
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
          typeof catalogItem.product_schema === "object" &&
          catalogItem.product_schema !== null
            ? (catalogItem.product_schema as MarketplaceVersionSchema)
            : null,
        selection: params.selectedOptions,
      });

      if (params.productId.trim() !== catalogVersion.productId) {
        throw new Error("Offer product id does not match the selected options.");
      }

      const offerId = params.offerId ?? (createId("off") as OfferId);
      const result = await commandHandler({
        streamId: `marketplace.offer-${offerId}`,
        command: {
          type: "SubmitOffer",
          offerId,
          buyerAccountId: params.buyerAccountId,
          catalogItemId: params.catalogItemId,
          productId: catalogVersion.productId,
          itemTitle: params.itemTitle,
          itemSubtitle: params.itemSubtitle,
          selectedOptions: catalogVersion.selection,
          productSummary: params.productSummary,
          priceAmount: params.priceAmount,
          quantityRequested: params.quantityRequested,
        },
        context,
      });

      return { offerId, version: result.version };
    },
    acceptOffer: async (params, context) => {
      const offer = await getBuyerOfferMatch(
        deps.db,
        params.offerId,
        params.sellerAccountId,
      );

      if (!offer) {
        throw new Error("Offer not found.");
      }
      if (!offer.can_fulfill) {
        throw new Error("Seller does not have enough active supply to accept this offer.");
      }

      const result = await commandHandler({
        streamId: `marketplace.offer-${params.offerId}`,
        command: {
          type: "AcceptOffer",
          sellerAccountId: params.sellerAccountId,
          acceptedAt: new Date().toISOString(),
        },
        context,
      });

      return { offerId: params.offerId, version: result.version };
    },
    addBuyerOfferMatchSellListItem: async (params) => {
      await addBuyerOfferMatchSellListItem(deps.db, {
        sellerAccountId: params.sellerAccountId,
        offerId: params.offerId,
        addedAt: new Date().toISOString(),
      });
    },
    listBuyerOfferMatchSellList: (sellerAccountId) =>
      listBuyerOfferMatchSellList(deps.db, sellerAccountId),
    acceptBuyerOfferMatchSellList: async (params, context) => {
      const items = await listBuyerOfferMatchSellList(deps.db, params.sellerAccountId);
      const acceptedOfferIds: OfferId[] = [];
      const skipped: Array<{ offerId: string; reason: string }> = [];

      for (const item of items) {
        if (item.status !== "submitted") {
          skipped.push({ offerId: item.offer_id, reason: "Offer is no longer submitted." });
          continue;
        }
        if (!item.can_fulfill) {
          skipped.push({ offerId: item.offer_id, reason: "Not enough active supply." });
          continue;
        }

        try {
          await commandHandler({
            streamId: `marketplace.offer-${item.offer_id}`,
            command: {
              type: "AcceptOffer",
              sellerAccountId: params.sellerAccountId,
              acceptedAt: new Date().toISOString(),
            },
            context,
          });
          acceptedOfferIds.push(item.offer_id as OfferId);
        } catch (error) {
          skipped.push({
            offerId: item.offer_id,
            reason: error instanceof Error ? error.message : "Offer could not be accepted.",
          });
        }
      }

      await removeBuyerOfferMatchSellListItems(deps.db, {
        sellerAccountId: params.sellerAccountId,
        offerIds: acceptedOfferIds,
      });

      return { acceptedOfferIds, skipped };
    },
    listSubmittedBuyerOffers: (params) => listSubmittedBuyerOffers(deps.db, params),
    getSubmittedBuyerOffer: (offerId, buyerAccountId) =>
      getSubmittedBuyerOffer(deps.db, offerId, buyerAccountId),
    listBuyerOfferMatches: (params) => listBuyerOfferMatches(deps.db, params),
    getBuyerOfferMatch: (offerId, sellerAccountId) =>
      getBuyerOfferMatch(deps.db, offerId, sellerAccountId),
    projectors: [
      createProjector({
        projectorName: "marketplace-offer-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildMarketplaceOfferProjectionHandlers(deps.db),
      }),
    ],
  };
}
