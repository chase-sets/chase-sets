import { createId } from "@chase-sets/primitives/typed-ids";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, InventoryItemId } from "@chase-sets/primitives/typed-ids";
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
import { getInventoryItem, listInventoryItems } from "../read-model/queries";

export type InventoryItemServices = Readonly<{
  commandHandler: CommandHandler<
    InventoryItemCommand,
    InventoryItemState,
    InventoryItemEvent
  >;
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
    }>,
    context: EventStoreContext,
  ) => Promise<{ itemId: string; version: number }>;
  listItems: (
    params: Parameters<typeof listInventoryItems>[1],
  ) => ReturnType<typeof listInventoryItems>;
  getItem: (
    itemId: string,
    accountId: string,
  ) => ReturnType<typeof getInventoryItem>;
  projectors: readonly Projector[];
}>;

export function createInventoryItemRuntime(
  deps: InventoryRuntimeDeps,
  catalogItems: InventoryCatalogItemServices,
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

  return {
    commandHandler,
    createItem: async (params, context) => {
      const location = await getStorageLocation(
        deps.db,
        params.storageLocationId,
        params.accountId,
      );

      if (!location) {
        throw new InventoryDomainError("Storage location not found.");
      }

      if (location.is_archived) {
        throw new InventoryDomainError(
          "Archived storage locations cannot receive new inventory items.",
        );
      }

      const catalogItem = await catalogItems.getCatalogItem(params.catalogItemId);
      if (!catalogItem) {
        throw new InventoryDomainError("Catalog item not found.");
      }

      if (catalogItem.status !== "active") {
        throw new InventoryDomainError(
          "Inventory items may only reference active catalog items.",
        );
      }

      const catalogVersion = createInventoryProductDescriptor({
        catalogItemId: params.catalogItemId,
        productSchema: catalogItem.product_schema,
        selection: parseSelectedOptionsInput(params.selectedOptions),
      });
      const productSummary = summarizeSelectedOptions(
        catalogItem.product_schema,
        catalogVersion.selection,
      );
      const isGradedCard = productSummary.includes("Form: Graded");

      if (isGradedCard && !params.gradedCard) {
        throw new InventoryDomainError(
          "Graded inventory items require graded card details.",
        );
      }

      if (!isGradedCard && params.gradedCard) {
        throw new InventoryDomainError(
          "Graded card details are only allowed for graded inventory items.",
        );
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
        throw new InventoryDomainError(
          "Adjustments cannot reduce total quantity below active held quantity.",
        );
      }

      const result = await commandHandler({
        streamId: `inventory.item-${params.itemId}`,
        command: {
          type: "AdjustInventoryItemQuantity",
          quantityDelta: params.quantityDelta,
          reason: params.reason,
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
    projectors: [
      createProjector({
        projectorName: "inventory-item-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildInventoryItemProjectionHandlers(deps.db),
      }),
    ],
  };
}
