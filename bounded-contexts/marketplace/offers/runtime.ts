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
import type { MarketplaceRuntimeDeps } from "../runtime-support";
import {
  decideMarketplaceOffer,
  evolveMarketplaceOffer,
  initialMarketplaceOfferState,
  type MarketplaceOfferCommand,
  type MarketplaceOfferEvent,
  type MarketplaceOfferState,
} from "./domain";
import { buildMarketplaceOfferProjectionHandlers } from "./projection";
import {
  getBuyerOffer,
  getSellerVisibleOffer,
  listBuyerOffers,
  listSellerVisibleOffers,
} from "./queries";
import {
  createMarketplaceCatalogVersionDescriptor,
  type MarketplaceVersionSchema,
} from "./versioning";

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
      catalogVersionKey: string;
      itemTitle: string;
      itemSubtitle: string | null;
      versionSelection: readonly { dimensionId: string; choiceId: string }[];
      versionSummary: string | null;
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
  listBuyerOffers: (
    params: Parameters<typeof listBuyerOffers>[1],
  ) => ReturnType<typeof listBuyerOffers>;
  getBuyerOffer: (
    offerId: string,
    buyerAccountId: string,
  ) => ReturnType<typeof getBuyerOffer>;
  listSellerVisibleOffers: (
    params: Parameters<typeof listSellerVisibleOffers>[1],
  ) => ReturnType<typeof listSellerVisibleOffers>;
  getSellerVisibleOffer: (
    offerId: string,
    sellerAccountId: string,
  ) => ReturnType<typeof getSellerVisibleOffer>;
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
      item_id: string;
      title: string;
      subtitle: string | null;
      status: string;
      version_schema: unknown;
    }>(
      `SELECT item_id, title, subtitle, status, version_schema
       FROM marketplace_catalog_items
       WHERE item_id = $1`,
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

      const catalogVersion = createMarketplaceCatalogVersionDescriptor({
        catalogItemId: params.catalogItemId,
        versionSchema:
          typeof catalogItem.version_schema === "object" &&
          catalogItem.version_schema !== null
            ? (catalogItem.version_schema as MarketplaceVersionSchema)
            : null,
        selection: params.versionSelection,
      });

      if (params.catalogVersionKey.trim() !== catalogVersion.catalogVersionKey) {
        throw new Error("Offer catalog version key does not match the selected version.");
      }

      const offerId = params.offerId ?? (createId("off") as OfferId);
      const result = await commandHandler({
        streamId: `marketplace.offer-${offerId}`,
        command: {
          type: "SubmitOffer",
          offerId,
          buyerAccountId: params.buyerAccountId,
          catalogItemId: params.catalogItemId,
          catalogVersionKey: catalogVersion.catalogVersionKey,
          itemTitle: params.itemTitle,
          itemSubtitle: params.itemSubtitle,
          versionSelection: catalogVersion.selection,
          versionSummary: params.versionSummary,
          priceAmount: params.priceAmount,
          quantityRequested: params.quantityRequested,
        },
        context,
      });

      return { offerId, version: result.version };
    },
    acceptOffer: async (params, context) => {
      const offer = await getSellerVisibleOffer(
        deps.db,
        params.offerId,
        params.sellerAccountId,
      );

      if (!offer) {
        throw new Error("Offer not found.");
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
    listBuyerOffers: (params) => listBuyerOffers(deps.db, params),
    getBuyerOffer: (offerId, buyerAccountId) =>
      getBuyerOffer(deps.db, offerId, buyerAccountId),
    listSellerVisibleOffers: (params) => listSellerVisibleOffers(deps.db, params),
    getSellerVisibleOffer: (offerId, sellerAccountId) =>
      getSellerVisibleOffer(deps.db, offerId, sellerAccountId),
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

