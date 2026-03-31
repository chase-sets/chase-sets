import { createId } from "@chase-sets/primitives/typed-ids";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, InventoryRecordId } from "@chase-sets/primitives/typed-ids";
import type { InventoryCatalogItemServices } from "../catalog-items/runtime";
import {
  parseVersionSelectionInput,
  validateVersionSelection,
  type InventoryVersionSelectionEntry,
} from "../catalog-items/versioning";
import type { InventoryRuntimeDeps } from "../runtime-support";
import { InventoryDomainError } from "../common";
import { getStorageLocation } from "../storage-locations/queries";
import {
  decideInventoryRecord,
  evolveInventoryRecord,
  initialInventoryRecordState,
  type InventoryRecordCommand,
  type InventoryRecordEvent,
  type InventoryRecordState,
} from "./domain";
import { buildInventoryRecordProjectionHandlers } from "./projection";
import { getInventoryRecord, listInventoryRecords } from "./queries";

export type InventoryRecordServices = Readonly<{
  commandHandler: CommandHandler<
    InventoryRecordCommand,
    InventoryRecordState,
    InventoryRecordEvent
  >;
  createRecord: (
    params: Readonly<{
      accountId: AccountId;
      catalogItemId: string;
      versionSelection: readonly InventoryVersionSelectionEntry[];
      condition: string;
      storageLocationId: string;
      totalQuantity: number;
      acquisitionCostAmount?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ recordId: InventoryRecordId; version: number }>;
  adjustRecord: (
    params: Readonly<{
      accountId: string;
      recordId: string;
      quantityDelta: number;
      reason: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ recordId: string; version: number }>;
  listRecords: (
    params: Parameters<typeof listInventoryRecords>[1],
  ) => ReturnType<typeof listInventoryRecords>;
  getRecord: (
    recordId: string,
    accountId: string,
  ) => ReturnType<typeof getInventoryRecord>;
  projectors: readonly Projector[];
}>;

export function createInventoryRecordRuntime(
  deps: InventoryRuntimeDeps,
  catalogItems: InventoryCatalogItemServices,
): InventoryRecordServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<InventoryRecordEvent>(),
      initialState: () => initialInventoryRecordState,
      evolve: evolveInventoryRecord,
    }),
    evolve: evolveInventoryRecord,
    decide: decideInventoryRecord,
  });

  return {
    commandHandler,
    createRecord: async (params, context) => {
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
          "Archived storage locations cannot receive new inventory records.",
        );
      }

      const catalogItem = await catalogItems.getCatalogItem(params.catalogItemId);
      if (!catalogItem) {
        throw new InventoryDomainError("Catalog item not found.");
      }

      if (catalogItem.status !== "active") {
        throw new InventoryDomainError(
          "Inventory records may only reference active catalog items.",
        );
      }

      const versionSelection = validateVersionSelection(
        catalogItem.version_schema,
        parseVersionSelectionInput(params.versionSelection),
      );

      const recordId = createId("inv") as InventoryRecordId;
      const result = await commandHandler({
        streamId: `inventory.record-${recordId}`,
        command: {
          type: "CreateInventoryRecord",
          recordId,
          accountId: params.accountId,
          catalogItemId: params.catalogItemId,
          versionSelection,
          condition: params.condition,
          storageLocationId: params.storageLocationId,
          totalQuantity: params.totalQuantity,
          acquisitionCostAmount: params.acquisitionCostAmount ?? null,
        },
        context,
      });

      return {
        recordId,
        version: result.version,
      };
    },
    adjustRecord: async (params, context) => {
      const record = await getInventoryRecord(deps.db, params.recordId, params.accountId);
      if (!record) {
        throw new InventoryDomainError("Inventory record not found.");
      }

      const nextTotalQuantity = record.total_quantity + params.quantityDelta;
      if (nextTotalQuantity < record.held_quantity) {
        throw new InventoryDomainError(
          "Adjustments cannot reduce total quantity below active held quantity.",
        );
      }

      const result = await commandHandler({
        streamId: `inventory.record-${params.recordId}`,
        command: {
          type: "AdjustInventoryRecordQuantity",
          quantityDelta: params.quantityDelta,
          reason: params.reason,
        },
        context,
      });

      return {
        recordId: params.recordId,
        version: result.version,
      };
    },
    listRecords: (params) => listInventoryRecords(deps.db, params),
    getRecord: (recordId, accountId) => getInventoryRecord(deps.db, recordId, accountId),
    projectors: [
      createProjector({
        projectorName: "inventory-record-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildInventoryRecordProjectionHandlers(deps.db),
      }),
    ],
  };
}
