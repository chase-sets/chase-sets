import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { InventoryRuntimeDeps } from "../runtime-support";
import { InventoryDomainError, type InventoryHoldId } from "../common";
import { getInventoryRecord } from "../records/queries";
import {
  decideInventoryHold,
  evolveInventoryHold,
  initialInventoryHoldState,
  type InventoryHoldCommand,
  type InventoryHoldEvent,
  type InventoryHoldState,
} from "./domain";
import { buildInventoryHoldProjectionHandlers } from "./projection";
import { getInventoryHold } from "./queries";

export type InventoryHoldServices = Readonly<{
  commandHandler: CommandHandler<
    InventoryHoldCommand,
    InventoryHoldState,
    InventoryHoldEvent
  >;
  createHold: (
    params: Readonly<{
      accountId: AccountId;
      recordId: string;
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
  getHold: (
    holdId: string,
    accountId: string,
  ) => ReturnType<typeof getInventoryHold>;
  projectors: readonly Projector[];
}>;

export function createInventoryHoldRuntime(
  deps: InventoryRuntimeDeps,
): InventoryHoldServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<InventoryHoldEvent>(),
      initialState: () => initialInventoryHoldState,
      evolve: evolveInventoryHold,
    }),
    evolve: evolveInventoryHold,
    decide: decideInventoryHold,
  });

  return {
    commandHandler,
    createHold: async (params, context) => {
      const record = await getInventoryRecord(deps.db, params.recordId, params.accountId);
      if (!record) {
        throw new InventoryDomainError("Inventory record not found.");
      }

      if (record.available_quantity < params.quantity) {
        throw new InventoryDomainError(
          "Holds cannot exceed the available quantity for a record.",
        );
      }

      const holdId = createId("hld") as InventoryHoldId;
      const result = await commandHandler({
        streamId: `inventory.hold-${holdId}`,
        command: {
          type: "PlaceInventoryHold",
          holdId,
          accountId: params.accountId,
          recordId: params.recordId,
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
      createProjector({
        projectorName: "inventory-hold-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildInventoryHoldProjectionHandlers(deps.db),
      }),
    ],
  };
}
