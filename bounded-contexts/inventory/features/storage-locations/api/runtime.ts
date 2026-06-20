import { createId } from "@chase-sets/primitives/typed-ids";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError, type InventoryStorageLocationId } from "../../../support/runtime-support/common";
import {
  decideStorageLocation,
  evolveStorageLocation,
  initialStorageLocationState,
  type StorageLocationCommand,
  type StorageLocationEvent,
  type StorageLocationState,
} from "../domain/domain";
import { buildStorageLocationProjectionHandlers } from "../read-model/projection";
import { getStorageLocation, listStorageLocations } from "../read-model/queries";

export type StorageLocationServices = Readonly<{
  commandHandler: CommandHandler<StorageLocationCommand, StorageLocationState, StorageLocationEvent>;
  createStorageLocation: (
    params: Readonly<{
      accountId: AccountId;
      name: string;
      description?: string | null;
      shipFromCode: string;
      shipFromAddress: AddressSnapshot;
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
      shipFromAddress: AddressSnapshot;
      isArchived?: boolean;
    }>,
    context: EventStoreContext,
  ) => Promise<{ storageLocationId: string; version: number }>;
  listStorageLocations: (params: Parameters<typeof listStorageLocations>[1]) => ReturnType<typeof listStorageLocations>;
  getStorageLocation: (storageLocationId: string, accountId?: string) => ReturnType<typeof getStorageLocation>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createStorageLocationRuntime(deps: InventoryRuntimeDeps): StorageLocationServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<StorageLocationEvent>(),
    initialState: () => initialStorageLocationState,
    evolve: evolveStorageLocation,
    decide: decideStorageLocation,
  });
  const projectionHandlers = buildStorageLocationProjectionHandlers(deps.db);

  async function projectStoredEvents(storedEvents: Awaited<ReturnType<typeof commandHandler>>["storedEvents"]) {
    for (const storedEvent of storedEvents) {
      await projectionHandlers[storedEvent.eventType]?.(toTransportEvent(storedEvent));
    }
  }

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
          shipFromAddress: params.shipFromAddress,
        },
        context,
      });
      await projectStoredEvents(result.storedEvents);

      return { storageLocationId, version: result.version };
    },
    updateStorageLocation: async (params, context) => {
      const existing = await getStorageLocation(deps.db, params.storageLocationId, params.accountId);

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
          shipFromAddress: params.shipFromAddress,
        },
        context,
      });
      await projectStoredEvents(updated.storedEvents);

      if (params.isArchived && !existing.is_archived) {
        const archived = await commandHandler({
          streamId: `inventory.storage-location-${params.storageLocationId}`,
          command: {
            type: "ArchiveStorageLocation",
          },
          context,
          expectedVersion: updated.version,
        });
        await projectStoredEvents(archived.storedEvents);

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
    getStorageLocation: (storageLocationId, accountId) => getStorageLocation(deps.db, storageLocationId, accountId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inventory-storage-location-projection",
        handlers: projectionHandlers,
      }),
    ],
  };
}
