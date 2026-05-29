import { createId } from "@chase-sets/primitives/typed-ids";
import { createHash } from "node:crypto";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, InventoryItemId } from "@chase-sets/primitives/typed-ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { InventoryCatalogItemServices } from "../integrations/catalog/runtime";
import {
  createInventoryProductDescriptor,
  parseSelectedOptionsInput,
  summarizeSelectedOptions,
  type InventorySelectedOptionEntry,
} from "../integrations/catalog/versioning";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import { getStorageLocation } from "../../storage-locations/read-model/queries";
import type { StorageLocationServices } from "../../storage-locations/api/runtime";
import {
  decideInventoryItem,
  evolveInventoryItem,
  initialInventoryItemState,
  type GradedCardDetails,
  type InventoryItemCommand,
  type InventoryItemEvent,
  type InventoryItemState,
} from "../domain/domain";
import { buildInventoryItemProjectionHandlers } from "../read-model/projection";
import { getInventoryItem, getInventoryItemForListingStock, listInventoryItems } from "../read-model/queries";
import type { InventoryEnsuredListingStock } from "./contracts";

const LISTING_STOCK_LOCATION_NAME = "Listing stock";
const LISTING_STOCK_LOCATION_DESCRIPTION = "Auto-managed stock backing standard marketplace listings.";

function createListingStockInventoryItemId(
  input: Readonly<{
    accountId: string;
    catalogItemId: string;
    productId: string;
    selectedOptions: readonly InventorySelectedOptionEntry[];
    gradedCard: GradedCardDetails | null;
    storageLocationId: string;
  }>,
) {
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);

  return `inv_listing_stock_${hash}` as InventoryItemId;
}

export type InventoryItemServices = Readonly<{
  commandHandler: CommandHandler<InventoryItemCommand, InventoryItemState, InventoryItemEvent>;
  createItem: (
    params: Readonly<{
      accountId: AccountId;
      catalogItemId: string;
      selectedOptions: readonly InventorySelectedOptionEntry[];
      gradedCard?: GradedCardDetails | null;
      storageLocationId: string;
      totalQuantity: number;
      acquisitionCostAmount?: string | null;
      itemIdOverride?: InventoryItemId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ itemId: InventoryItemId; version: number }>;
  adjustItem: (
    params: Readonly<{
      accountId: string;
      itemId: string;
      quantityDelta: number;
      reason: string;
      idempotencyKey?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ itemId: string; version: number }>;
  listItems: (params: Parameters<typeof listInventoryItems>[1]) => ReturnType<typeof listInventoryItems>;
  getItem: (itemId: string, accountId: string) => ReturnType<typeof getInventoryItem>;
  ensureListingStock: (
    params: Readonly<{
      accountId: AccountId;
      catalogItemId: string;
      selectedOptions: readonly InventorySelectedOptionEntry[];
      gradedCard?: GradedCardDetails | null;
      quantity: number;
      shipFromCode?: string | null;
      shipFromAddress?: AddressSnapshot | null;
    }>,
    context: EventStoreContext,
  ) => Promise<InventoryEnsuredListingStock>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInventoryItemRuntime(
  deps: InventoryRuntimeDeps,
  catalogItems: InventoryCatalogItemServices,
  storageLocations: StorageLocationServices,
): InventoryItemServices {
  const repository = createAggregateRepository({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<InventoryItemEvent>(),
    initialState: () => initialInventoryItemState,
    evolve: evolveInventoryItem,
  });
  const commandHandler = createCommandHandler({
    repository,
    evolve: evolveInventoryItem,
    decide: decideInventoryItem,
  });

  async function findDefaultListingStockLocation(accountId: string) {
    const locations = await storageLocations.listStorageLocations({
      accountId,
      includeArchived: false,
    });

    return locations.find((location) => location.name === LISTING_STOCK_LOCATION_NAME) ?? null;
  }

  async function upsertStorageLocationReadModel(
    params: Readonly<{
      storageLocationId: string;
      accountId: string;
      shipFromCode: string;
      shipFromAddress: AddressSnapshot;
    }>,
  ) {
    await deps.db.query(
      `INSERT INTO inventory_storage_locations (
         storage_location_id,
         account_id,
         name,
         description,
         ship_from_code,
         ship_from_address,
         is_archived,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, false, now())
       ON CONFLICT (storage_location_id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         ship_from_code = EXCLUDED.ship_from_code,
         ship_from_address = EXCLUDED.ship_from_address,
         is_archived = false,
         updated_at = EXCLUDED.updated_at`,
      [
        params.storageLocationId,
        params.accountId,
        LISTING_STOCK_LOCATION_NAME,
        LISTING_STOCK_LOCATION_DESCRIPTION,
        params.shipFromCode,
        JSON.stringify(params.shipFromAddress),
      ],
    );
  }

  return {
    commandHandler,
    createItem: async (params, context) => {
      const location = await getStorageLocation(deps.db, params.storageLocationId, params.accountId);

      if (!location) {
        throw new InventoryDomainError("Storage location not found.");
      }

      if (location.is_archived) {
        throw new InventoryDomainError("Archived storage locations cannot receive new inventory items.");
      }

      const catalogItem = await catalogItems.getCatalogItem(params.catalogItemId);
      if (!catalogItem) {
        throw new InventoryDomainError("Catalog item not found.");
      }

      if (catalogItem.status !== "active") {
        throw new InventoryDomainError("Inventory items may only reference active catalog items.");
      }

      const catalogVersion = createInventoryProductDescriptor({
        catalogItemId: params.catalogItemId,
        productSchema: catalogItem.product_schema,
        selection: parseSelectedOptionsInput(params.selectedOptions),
      });
      const productSummary = summarizeSelectedOptions(catalogItem.product_schema, catalogVersion.selection);
      const isGradedCard = productSummary.includes("Form: Graded");

      if (isGradedCard && !params.gradedCard) {
        throw new InventoryDomainError("Graded inventory items require graded card details.");
      }

      if (!isGradedCard && params.gradedCard) {
        throw new InventoryDomainError("Graded card details are only allowed for graded inventory items.");
      }

      const itemId = params.itemIdOverride ?? (createId("inv") as InventoryItemId);
      const streamId = `inventory.item-${itemId}`;
      const existing = await repository.load(streamId);
      if (existing.state.id !== null) {
        return {
          itemId,
          version: existing.version,
        };
      }

      const result = await commandHandler({
        streamId,
        command: {
          type: "CreateInventoryItem",
          itemId,
          accountId: params.accountId,
          catalogItemId: params.catalogItemId,
          productId: catalogVersion.productId,
          selectedOptions: catalogVersion.selection,
          gradedCard: params.gradedCard ?? null,
          storageLocationId: params.storageLocationId,
          totalQuantity: params.totalQuantity,
          acquisitionCostAmount: params.acquisitionCostAmount ?? null,
        },
        context,
      });

      return {
        itemId,
        version: result.version,
      };
    },
    adjustItem: async (params, context) => {
      const item = await getInventoryItem(deps.db, params.itemId, params.accountId);
      if (!item) {
        throw new InventoryDomainError("Inventory item not found.");
      }

      const nextTotalQuantity = item.total_quantity + params.quantityDelta;
      if (nextTotalQuantity < item.held_quantity) {
        throw new InventoryDomainError("Adjustments cannot reduce total quantity below active held quantity.");
      }

      const result = await commandHandler({
        streamId: `inventory.item-${params.itemId}`,
        command: {
          type: "AdjustInventoryItemQuantity",
          quantityDelta: params.quantityDelta,
          reason: params.reason,
          idempotencyKey: params.idempotencyKey ?? null,
        },
        context,
      });

      return {
        itemId: params.itemId,
        version: result.version,
      };
    },
    listItems: (params) => listInventoryItems(deps.db, params),
    getItem: (itemId, accountId) => getInventoryItem(deps.db, itemId, accountId),
    ensureListingStock: async (params, context) => {
      if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
        throw new InventoryDomainError("Listing stock quantity must be a positive whole number.");
      }

      const catalogItem = await catalogItems.getCatalogItem(params.catalogItemId);
      if (!catalogItem) {
        throw new InventoryDomainError("Catalog item not found.");
      }

      if (catalogItem.status !== "active") {
        throw new InventoryDomainError("Listing stock may only reference active catalog items.");
      }

      const catalogVersion = createInventoryProductDescriptor({
        catalogItemId: params.catalogItemId,
        productSchema: catalogItem.product_schema,
        selection: parseSelectedOptionsInput(params.selectedOptions),
      });
      const productSummary = summarizeSelectedOptions(catalogItem.product_schema, catalogVersion.selection);
      const gradedCard = params.gradedCard ?? null;
      const isGradedCard = productSummary.includes("Form: Graded");

      if (isGradedCard && !gradedCard) {
        throw new InventoryDomainError("Graded listing stock requires graded card details.");
      }

      if (!isGradedCard && gradedCard) {
        throw new InventoryDomainError("Graded card details are only allowed for graded listing stock.");
      }

      let location = await findDefaultListingStockLocation(params.accountId);
      let createdStorageLocation = false;

      if (!location) {
        if (!params.shipFromAddress) {
          throw new InventoryDomainError("Ship-from address is required before creating listing stock.");
        }

        const created = await storageLocations.createStorageLocation(
          {
            accountId: params.accountId,
            name: LISTING_STOCK_LOCATION_NAME,
            description: LISTING_STOCK_LOCATION_DESCRIPTION,
            shipFromCode: params.shipFromCode?.trim() || "LISTING-STOCK",
            shipFromAddress: params.shipFromAddress,
          },
          context,
        );
        createdStorageLocation = true;
        await upsertStorageLocationReadModel({
          storageLocationId: created.storageLocationId,
          accountId: params.accountId,
          shipFromCode: params.shipFromCode?.trim() || "LISTING-STOCK",
          shipFromAddress: params.shipFromAddress,
        });
        location = await getStorageLocation(deps.db, created.storageLocationId, params.accountId);
      }

      if (!location) {
        throw new InventoryDomainError("Listing stock location could not be loaded.");
      }

      const existingItem = await getInventoryItemForListingStock(deps.db, {
        itemId: createListingStockInventoryItemId({
          accountId: params.accountId,
          catalogItemId: params.catalogItemId,
          productId: catalogVersion.productId,
          selectedOptions: catalogVersion.selection,
          gradedCard,
          storageLocationId: location.storage_location_id,
        }),
        accountId: params.accountId,
        catalogItemId: params.catalogItemId,
        productId: catalogVersion.productId,
        selectedOptions: catalogVersion.selection,
        gradedCard,
        storageLocationId: location.storage_location_id,
      });

      let inventoryItemId = existingItem?.item_id ?? null;
      let createdInventoryItem = false;
      let adjustedQuantityBy = 0;
      let totalQuantity = existingItem?.total_quantity ?? 0;
      let availableQuantity = existingItem?.available_quantity ?? 0;

      if (!inventoryItemId) {
        const itemId = createListingStockInventoryItemId({
          accountId: params.accountId,
          catalogItemId: params.catalogItemId,
          productId: catalogVersion.productId,
          selectedOptions: catalogVersion.selection,
          gradedCard,
          storageLocationId: location.storage_location_id,
        });
        await commandHandler({
          streamId: `inventory.item-${itemId}`,
          command: {
            type: "CreateInventoryItem",
            itemId,
            accountId: params.accountId,
            catalogItemId: params.catalogItemId,
            productId: catalogVersion.productId,
            selectedOptions: catalogVersion.selection,
            gradedCard,
            storageLocationId: location.storage_location_id,
            totalQuantity: params.quantity,
            acquisitionCostAmount: null,
          },
          context,
        });
        inventoryItemId = itemId;
        createdInventoryItem = true;
        totalQuantity = params.quantity;
        availableQuantity = params.quantity;
      } else if (availableQuantity < params.quantity) {
        adjustedQuantityBy = params.quantity - availableQuantity;
        await commandHandler({
          streamId: `inventory.item-${inventoryItemId}`,
          command: {
            type: "AdjustInventoryItemQuantity",
            quantityDelta: adjustedQuantityBy,
            reason: "Automatic listing stock",
          },
          context,
        });
        totalQuantity += adjustedQuantityBy;
        availableQuantity += adjustedQuantityBy;
      }

      if (!inventoryItemId) {
        throw new InventoryDomainError("Listing stock item could not be created.");
      }

      return {
        inventoryItemId,
        storageLocationId: location.storage_location_id,
        createdStorageLocation,
        createdInventoryItem,
        adjustedQuantityBy,
        snapshot: {
          inventoryItemId,
          catalogItemId: params.catalogItemId,
          productId: catalogVersion.productId,
          selectedOptions: catalogVersion.selection,
          gradedCard,
          storageLocationId: location.storage_location_id,
          storageLocationName: location.name,
          shipFromCode: location.ship_from_code,
          shipFromAddress: location.ship_from_address,
          totalQuantity,
          availableQuantity,
          acquisitionCostAmount: null,
        },
      };
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inventory-item-projection",
        handlers: buildInventoryItemProjectionHandlers(deps.db),
      }),
    ],
  };
}
