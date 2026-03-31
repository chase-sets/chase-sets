import { createId } from "@chase-sets/primitives/typed-ids";
import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { InventoryRuntimeDeps } from "../runtime-support";
import { InventoryDomainError, type InventoryStorageLocationId } from "../common";
import {
  decideStorageLocation,
  evolveStorageLocation,
  initialStorageLocationState,
  type StorageLocationCommand,
  type StorageLocationEvent,
  type StorageLocationState,
} from "./domain";
import { buildStorageLocationProjectionHandlers } from "./projection";
import { getStorageLocation, listStorageLocations } from "./queries";

export type StorageLocationServices = Readonly<{
  commandHandler: CommandHandler<
    StorageLocationCommand,
    StorageLocationState,
    StorageLocationEvent
  >;
  createStorageLocation: (
    params: Readonly<{
      accountId: AccountId;
      name: string;
      description?: string | null;
      shipFromCode: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ storageLocationId: InventoryStorageLocationId; version: number }>;
  updateStorageLocation: (
    params: Readonly<{
      storageLocationId: string;
      accountId: string;
      name: string;
      description?: string | null;
      shipFromCode: string;
      isArchived?: boolean;
    }>,
    context: EventStoreContext,
  ) => Promise<{ storageLocationId: string; version: number }>;
  listStorageLocations: (
    params: Parameters<typeof listStorageLocations>[1],
  ) => ReturnType<typeof listStorageLocations>;
  getStorageLocation: (
    storageLocationId: string,
    accountId?: string,
  ) => ReturnType<typeof getStorageLocation>;
  projectors: readonly Projector[];
}>;

export function createStorageLocationRuntime(
  deps: InventoryRuntimeDeps,
): StorageLocationServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<StorageLocationEvent>(),
      initialState: () => initialStorageLocationState,
      evolve: evolveStorageLocation,
    }),
    evolve: evolveStorageLocation,
    decide: decideStorageLocation,
  });

  return {
    commandHandler,
    createStorageLocation: async (params, context) => {
      const storageLocationId = createId("loc") as InventoryStorageLocationId;
      const result = await commandHandler({
        streamId: `inventory.storage-location-${storageLocationId}`,
        command: {
          type: "CreateStorageLocation",
          storageLocationId,
          accountId: params.accountId,
          name: params.name,
          description: params.description,
          shipFromCode: params.shipFromCode,
        },
        context,
      });

      return { storageLocationId, version: result.version };
    },
    updateStorageLocation: async (params, context) => {
      const existing = await getStorageLocation(
        deps.db,
        params.storageLocationId,
        params.accountId,
      );

      if (!existing) {
        throw new InventoryDomainError("Storage location not found.");
      }

      const updated = await commandHandler({
        streamId: `inventory.storage-location-${params.storageLocationId}`,
        command: {
          type: "UpdateStorageLocation",
          name: params.name,
          description: params.description,
          shipFromCode: params.shipFromCode,
        },
        context,
      });

      if (params.isArchived && !existing.is_archived) {
        const archived = await commandHandler({
          streamId: `inventory.storage-location-${params.storageLocationId}`,
          command: {
            type: "ArchiveStorageLocation",
          },
          context,
          expectedVersion: updated.version,
        });

        return {
          storageLocationId: params.storageLocationId,
          version: archived.version,
        };
      }

      return {
        storageLocationId: params.storageLocationId,
        version: updated.version,
      };
    },
    listStorageLocations: (params) => listStorageLocations(deps.db, params),
    getStorageLocation: (storageLocationId, accountId) =>
      getStorageLocation(deps.db, storageLocationId, accountId),
    projectors: [
      createProjector({
        projectorName: "inventory-storage-location-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildStorageLocationProjectionHandlers(deps.db),
      }),
    ],
  };
}
