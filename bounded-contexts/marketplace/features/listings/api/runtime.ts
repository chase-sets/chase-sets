import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, ListingId } from "@chase-sets/primitives/typed-ids";
import type { CommercialTermsResolver } from "../../../api";
import type { MarketplaceRuntimeDeps } from "../../../support/runtime-support";
import type { MarketplaceListingTermsPreview } from "../ui/contracts";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
} from "../domain/domain";
import { buildMarketplaceListingProjectionHandlers } from "../read-model/projection";
import {
  getActiveQuantityCapForInventoryRecord,
  getInventoryRecordSupply,
  getMarketSummaryForItem,
  getSellerListing,
  listActiveListingsForInventoryRecord,
  listItemListings,
  listSellerListings,
} from "../read-model/queries";

const MARKETPLACE_SYSTEM_TENANT_ID = "tnt_marketplace_system" as never;
const MARKETPLACE_SYSTEM_USER_ID = "usr_marketplace_system" as never;

function createMarketplaceSystemContext(accountId: string): EventStoreContext {
  return {
    tenantId: MARKETPLACE_SYSTEM_TENANT_ID,
    audit: {
      performedByUserId: MARKETPLACE_SYSTEM_USER_ID,
      forAccountId: accountId as never,
    },
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export type MarketplaceListingServices = Readonly<{
  commandHandler: CommandHandler<
    MarketplaceListingCommand,
    MarketplaceListingState,
    MarketplaceListingEvent
  >;
  createListing: (
    params: Readonly<{
      accountId: AccountId;
      inventoryRecordId: string;
      priceAmount: string;
      quantityCap: number;
      listingIdOverride?: ListingId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: ListingId; version: number }>;
  previewListingTerms: (
    params: Readonly<{ accountId: string; priceAmount: string }>,
  ) => Promise<MarketplaceListingTermsPreview>;
  updateListingPrice: (
    params: Readonly<{ accountId: string; listingId: string; priceAmount: string }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  updateListingQuantityCap: (
    params: Readonly<{ accountId: string; listingId: string; quantityCap: number }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  publishListing: (
    params: Readonly<{ accountId: string; listingId: string }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  pauseListing: (
    params: Readonly<{ accountId: string; listingId: string }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  withdrawListing: (
    params: Readonly<{ accountId: string; listingId: string }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: string; version: number }>;
  listSellerListings: (
    params: Parameters<typeof listSellerListings>[1],
  ) => ReturnType<typeof listSellerListings>;
  getSellerListing: (
    listingId: string,
    accountId: string,
  ) => ReturnType<typeof getSellerListing>;
  getMarketSummaryForItem: (
    itemId: string,
  ) => ReturnType<typeof getMarketSummaryForItem>;
  listItemListings: (itemId: string) => ReturnType<typeof listItemListings>;
  getInventoryRecordSupply: (
    recordId: string,
    accountId?: string,
  ) => ReturnType<typeof getInventoryRecordSupply>;
  reconcileInventoryCapacity: (inventoryRecordId: string) => Promise<void>;
  projectors: readonly Projector[];
}>;

type ListingRuntimeDeps = MarketplaceRuntimeDeps & Readonly<{
  commercialTermsResolver: CommercialTermsResolver;
}>;

export function createMarketplaceListingRuntime(
  deps: ListingRuntimeDeps,
): MarketplaceListingServices {
  const repository = createAggregateRepository({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MarketplaceListingEvent>(),
    initialState: () => initialMarketplaceListingState,
    evolve: evolveMarketplaceListing,
  });
  const commandHandler = createCommandHandler({
    repository,
    evolve: evolveMarketplaceListing,
    decide: decideMarketplaceListing,
  });

  async function ensureActiveCapacity(
    inventoryRecordId: string,
    requestedQuantityCap: number,
    excludeListingId?: string,
  ) {
    const supply = await getInventoryRecordSupply(deps.db, inventoryRecordId);
    assert(supply, "Inventory record not found.");

    const activeQuantityCap = await getActiveQuantityCapForInventoryRecord(
      deps.db,
      inventoryRecordId,
      excludeListingId,
    );
    assert(
      activeQuantityCap + requestedQuantityCap <= supply.available_quantity,
      "Active listing quantity caps cannot exceed current sellable inventory.",
    );
  }

  async function reconcileInventoryCapacity(inventoryRecordId: string) {
    const supply = await getInventoryRecordSupply(deps.db, inventoryRecordId);
    if (!supply) {
      return;
    }

    const activeListings = await listActiveListingsForInventoryRecord(
      deps.db,
      inventoryRecordId,
    );
    let activeTotal = activeListings.reduce(
      (sum, listing) => sum + listing.quantity_cap,
      0,
    );

    for (const listing of activeListings) {
      if (activeTotal <= supply.available_quantity) {
        break;
      }

      await commandHandler({
        streamId: `marketplace.listing-${listing.listing_id}`,
        command: { type: "PauseListing" },
        context: createMarketplaceSystemContext(listing.account_id),
      });
      activeTotal -= listing.quantity_cap;
    }
  }

  async function loadOwnedListingState(listingId: string, accountId: string) {
    const aggregate = await repository.load(`marketplace.listing-${listingId}`);
    const listing = aggregate.state;

    assert(
      listing.listingId !== null && listing.accountId === accountId,
      "Listing not found.",
    );

    return listing;
  }

  return {
    commandHandler,
    createListing: async (params, context) => {
      const supply = await getInventoryRecordSupply(
        deps.db,
        params.inventoryRecordId,
        params.accountId,
      );
      assert(supply, "Inventory record not found.");
      const terms = await deps.commercialTermsResolver.resolveListingTerms({
        sellerAccountId: params.accountId,
        amount: params.priceAmount,
      });

      const listingId = params.listingIdOverride ?? (createId("lst") as ListingId);
      const result = await commandHandler({
        streamId: `marketplace.listing-${listingId}`,
        command: {
          type: "CreateListing",
          listingId,
          accountId: params.accountId,
          inventoryRecordId: supply.record_id,
          catalogItemId: supply.catalog_item_id,
          catalogVersionKey: supply.catalog_version_key as never,
          itemTitle: supply.item_title,
          itemSubtitle: supply.item_subtitle,
          versionSelection: supply.version_selection,
          versionSummary: supply.version_summary,
          storageLocationName: supply.storage_location_name,
          shipFromCode: supply.ship_from_code,
          priceAmount: params.priceAmount,
          marketplaceFeeAmount: terms.marketplaceFeeAmount,
          paymentFeeAmount: terms.paymentFeeAmount,
          sellerNetAmount: terms.sellerNetAmount,
          termsScheduleId: terms.scheduleId,
          termsAgreementId: terms.agreementId,
          termsResolvedAt: terms.resolvedAt,
          quantityCap: params.quantityCap,
        },
        context,
      });

      return { listingId, version: result.version };
    },
    previewListingTerms: async (params) => {
      const terms = await deps.commercialTermsResolver.resolveListingTerms({
        sellerAccountId: params.accountId,
        amount: params.priceAmount,
      });

      return {
        account_type: terms.accountType,
        basis_amount: terms.basisAmount,
        marketplace_fee_amount: terms.marketplaceFeeAmount,
        payment_fee_amount: terms.paymentFeeAmount,
        seller_net_amount: terms.sellerNetAmount,
        schedule_id: terms.scheduleId,
        agreement_id: terms.agreementId,
        resolved_at: terms.resolvedAt,
      };
    },
    updateListingPrice: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);
      const terms = await deps.commercialTermsResolver.resolveListingTerms({
        sellerAccountId: params.accountId,
        amount: params.priceAmount,
      });

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "UpdateListingPrice",
          priceAmount: params.priceAmount,
          marketplaceFeeAmount: terms.marketplaceFeeAmount,
          paymentFeeAmount: terms.paymentFeeAmount,
          sellerNetAmount: terms.sellerNetAmount,
          termsScheduleId: terms.scheduleId,
          termsAgreementId: terms.agreementId,
          termsResolvedAt: terms.resolvedAt,
        },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    updateListingQuantityCap: async (params, context) => {
      const listing = await loadOwnedListingState(params.listingId, params.accountId);

      if (listing.status === "active") {
        assert(listing.inventoryRecordId, "Listing inventory record is missing.");
        await ensureActiveCapacity(
          listing.inventoryRecordId,
          params.quantityCap,
          params.listingId,
        );
      }

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "UpdateListingQuantityCap",
          quantityCap: params.quantityCap,
        },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    publishListing: async (params, context) => {
      const listing = await loadOwnedListingState(params.listingId, params.accountId);
      assert(listing.inventoryRecordId, "Listing inventory record is missing.");

      await ensureActiveCapacity(
        listing.inventoryRecordId,
        listing.quantityCap,
        params.listingId,
      );

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "PublishListing" },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    pauseListing: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "PauseListing" },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    withdrawListing: async (params, context) => {
      await loadOwnedListingState(params.listingId, params.accountId);

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "WithdrawListing" },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    listSellerListings: (params) => listSellerListings(deps.db, params),
    getSellerListing: (listingId, accountId) =>
      getSellerListing(deps.db, listingId, accountId),
    getMarketSummaryForItem: (itemId) => getMarketSummaryForItem(deps.db, itemId),
    listItemListings: (itemId) => listItemListings(deps.db, itemId),
    getInventoryRecordSupply: (recordId, accountId) =>
      getInventoryRecordSupply(deps.db, recordId, accountId),
    reconcileInventoryCapacity,
    projectors: [
      createProjector({
        projectorName: "marketplace-listing-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildMarketplaceListingProjectionHandlers(deps.db),
      }),
    ],
  };
}
