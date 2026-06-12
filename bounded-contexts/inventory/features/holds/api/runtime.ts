import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError, type InventoryHoldId } from "../../../support/runtime-support/common";
import { getInventoryItem } from "../../inventory-items/read-model/queries";
import {
  decideInventoryHold,
  evolveInventoryHold,
  initialInventoryHoldState,
  type InventoryHoldCommand,
  type InventoryHoldEvent,
  type InventoryHoldState,
} from "../domain/domain";
import { buildInventoryHoldProjectionHandlers } from "../read-model/projection";
import { getInventoryHold } from "../read-model/queries";

export type InventoryHoldServices = Readonly<{
  commandHandler: CommandHandler<InventoryHoldCommand, InventoryHoldState, InventoryHoldEvent>;
  createHold: (
    params: Readonly<{
      accountId: AccountId;
      itemId: string;
      quantity: number;
      reason: string;
      notes?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ holdId: InventoryHoldId; version: number }>;
  releaseHold: (
    params: Readonly<{
      accountId: string;
      holdId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ holdId: string; version: number }>;
  getHold: (holdId: string, accountId: string) => ReturnType<typeof getInventoryHold>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInventoryHoldRuntime(deps: InventoryRuntimeDeps): InventoryHoldServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<InventoryHoldEvent>(),
    initialState: () => initialInventoryHoldState,
    evolve: evolveInventoryHold,
    decide: decideInventoryHold,
  });

  return {
    commandHandler,
    createHold: async (params, context) => {
      const item = await getInventoryItem(deps.db, params.itemId, params.accountId);
      if (!item) {
        throw new InventoryDomainError("Inventory item not found.");
      }

      if (item.available_quantity < params.quantity) {
        throw new InventoryDomainError("Holds cannot exceed the available quantity for an inventory item.");
      }

      const holdId = createId("hld") as InventoryHoldId;
      const result = await commandHandler({
        streamId: `inventory.hold-${holdId}`,
        command: {
          type: "PlaceInventoryHold",
          holdId,
          accountId: params.accountId,
          itemId: params.itemId,
          quantity: params.quantity,
          reason: params.reason,
          notes: params.notes ?? null,
        },
        context,
      });

      return {
        holdId,
        version: result.version,
      };
    },
    releaseHold: async (params, context) => {
      const hold = await getInventoryHold(deps.db, params.holdId, params.accountId);
      if (!hold) {
        throw new InventoryDomainError("Inventory hold not found.");
      }

      const result = await commandHandler({
        streamId: `inventory.hold-${params.holdId}`,
        command: {
          type: "ReleaseInventoryHold",
          releasedAt: new Date().toISOString(),
        },
        context,
      });

      return {
        holdId: params.holdId,
        version: result.version,
      };
    },
    getHold: (holdId, accountId) => getInventoryHold(deps.db, holdId, accountId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inventory-hold-projection",
        handlers: buildInventoryHoldProjectionHandlers(deps.db),
      }),
    ],
  };
}
