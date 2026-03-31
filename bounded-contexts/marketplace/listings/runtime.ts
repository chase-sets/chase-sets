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
import type { InventoryRuntimeDeps } from "../../inventory/runtime-support";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
} from "./domain";
import { buildMarketplaceListingProjectionHandlers } from "./projection";
import {
  getActiveQuantityCapForInventoryRecord,
  getInventoryRecordSupply,
  getMarketSummaryForItem,
  getSellerListing,
  listActiveListingsForInventoryRecord,
  listItemListings,
  listSellerListings,
} from "./queries";

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
    }>,
    context: EventStoreContext,
  ) => Promise<{ listingId: ListingId; version: number }>;
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
  projectors: readonly Projector[];
}>;

export function createMarketplaceListingRuntime(
  deps: InventoryRuntimeDeps,
): MarketplaceListingServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<MarketplaceListingEvent>(),
      initialState: () => initialMarketplaceListingState,
      evolve: evolveMarketplaceListing,
    }),
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

  return {
    commandHandler,
    createListing: async (params, context) => {
      const supply = await getInventoryRecordSupply(
        deps.db,
        params.inventoryRecordId,
        params.accountId,
      );
      assert(supply, "Inventory record not found.");

      const listingId = createId("lst") as ListingId;
      const result = await commandHandler({
        streamId: `marketplace.listing-${listingId}`,
        command: {
          type: "CreateListing",
          listingId,
          accountId: params.accountId,
          inventoryRecordId: supply.record_id,
          catalogItemId: supply.catalog_item_id,
          itemTitle: supply.item_title,
          itemSubtitle: supply.item_subtitle,
          versionSelection: supply.version_selection,
          versionSummary: supply.version_summary,
          condition: supply.condition,
          storageLocationName: supply.storage_location_name,
          shipFromCode: supply.ship_from_code,
          priceAmount: params.priceAmount,
          quantityCap: params.quantityCap,
        },
        context,
      });

      return { listingId, version: result.version };
    },
    updateListingPrice: async (params, context) => {
      const listing = await getSellerListing(deps.db, params.listingId, params.accountId);
      assert(listing, "Listing not found.");

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: {
          type: "UpdateListingPrice",
          priceAmount: params.priceAmount,
        },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    updateListingQuantityCap: async (params, context) => {
      const listing = await getSellerListing(deps.db, params.listingId, params.accountId);
      assert(listing, "Listing not found.");

      if (listing.status === "active") {
        await ensureActiveCapacity(
          listing.inventory_record_id,
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
      const listing = await getSellerListing(deps.db, params.listingId, params.accountId);
      assert(listing, "Listing not found.");

      await ensureActiveCapacity(
        listing.inventory_record_id,
        listing.quantity_cap,
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
      const listing = await getSellerListing(deps.db, params.listingId, params.accountId);
      assert(listing, "Listing not found.");

      const result = await commandHandler({
        streamId: `marketplace.listing-${params.listingId}`,
        command: { type: "PauseListing" },
        context,
      });

      return { listingId: params.listingId, version: result.version };
    },
    withdrawListing: async (params, context) => {
      const listing = await getSellerListing(deps.db, params.listingId, params.accountId);
      assert(listing, "Listing not found.");

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
    projectors: [
      createProjector({
        projectorName: "marketplace-listing-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildMarketplaceListingProjectionHandlers(deps.db),
      }),
      createProjector({
        projectorName: "marketplace-listing-inventory-capacity-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: {
          "inventory.record.adjusted": async (event) => {
            const { recordId } = event.data as { recordId: string };
            await reconcileInventoryCapacity(recordId);
          },
          "inventory.hold.placed": async (event) => {
            const { recordId } = event.data as { recordId: string };
            await reconcileInventoryCapacity(recordId);
          },
          "inventory.hold.released": async (event) => {
            const holdId = event.streamId.replace("inventory.hold-", "");
            const result = await deps.db.query<{ record_id: string }>(
              `SELECT record_id FROM inventory_holds WHERE hold_id = $1`,
              [holdId],
            );
            const recordId = result.rows[0]?.record_id;
            if (recordId) {
              await reconcileInventoryCapacity(recordId);
            }
          },
        },
      }),
    ],
  };
}
