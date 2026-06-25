import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION, type EventStoreContext, type GlobalPosition } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError, type InventoryHoldId } from "../../../support/runtime-support/common";
import {
  decideInventoryItem,
  evolveInventoryItem,
  initialInventoryItemState,
  type InventoryItemEvent,
  type InventoryItemState,
} from "../../inventory-items/domain/domain";
import { getInventoryHoldableItem, type InventoryHoldableItemRow } from "../../inventory-items/read-model/queries";
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

type InventoryStockSnapshot = Readonly<{
  itemId: string;
  accountId: AccountId;
  totalQuantity: number;
  heldQuantity: number;
  availableQuantity: number;
}>;

type AggregateHoldSnapshot = Readonly<{
  accountId: AccountId;
  itemId: string;
  quantity: number;
  active: boolean;
}>;

type InventoryItemRepository = Readonly<{
  load: (streamId: string) => Promise<Readonly<{ state: InventoryItemState }>>;
}>;

export type InventoryHoldPlacementFailureKind =
  | "hold-id-conflict"
  | "inventory-item-missing"
  | "insufficient-available-quantity"
  | "inventory-item-projection-missing";

export class InventoryHoldPlacementError extends InventoryDomainError {
  public constructor(
    public readonly kind: InventoryHoldPlacementFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "InventoryHoldPlacementError";
  }
}

export type InventoryHoldServices = Readonly<{
  commandHandler: CommandHandler<InventoryHoldCommand, InventoryHoldState, InventoryHoldEvent>;
  createHold: (
    params: Readonly<{
      holdId?: InventoryHoldId | null;
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
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<InventoryHoldEvent>(),
    initialState: () => initialInventoryHoldState,
    evolve: evolveInventoryHold,
    decide: decideInventoryHold,
  });
  const { repository: itemRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<InventoryItemEvent>(),
    initialState: () => initialInventoryItemState,
    evolve: evolveInventoryItem,
    decide: decideInventoryItem,
  });

  return {
    commandHandler,
    createHold: async (params, context) => {
      const holdId = params.holdId ?? (createId("hld") as InventoryHoldId);
      const existing = await repository.load(`inventory.hold-${holdId}`);
      if (existing.state.id !== null) {
        if (
          existing.state.status === "active" &&
          existing.state.accountId === params.accountId &&
          existing.state.itemId === params.itemId &&
          existing.state.quantity === params.quantity
        ) {
          return {
            holdId,
            version: existing.version,
          };
        }

        throw new InventoryHoldPlacementError("hold-id-conflict", "Inventory hold already exists for different stock.");
      }

      const item = await getInventoryHoldableItem(deps.db, {
        itemId: params.itemId,
        accountId: params.accountId,
      });
      const stock = item
        ? stockSnapshotFromReadModel(item)
        : await loadAggregateStockSnapshot({
            eventStore: deps.eventStore,
            itemRepository,
            itemId: params.itemId,
            accountId: params.accountId,
            context,
          });

      if (stock.availableQuantity < params.quantity) {
        throw new InventoryHoldPlacementError(
          "insufficient-available-quantity",
          "Holds cannot exceed the available quantity for an inventory item.",
        );
      }

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

async function loadAggregateStockSnapshot(input: {
  eventStore: InventoryRuntimeDeps["eventStore"];
  itemRepository: InventoryItemRepository;
  itemId: string;
  accountId: AccountId;
  context: EventStoreContext;
}): Promise<InventoryStockSnapshot> {
  const aggregate = await input.itemRepository.load(`inventory.item-${input.itemId}`);
  if (aggregate.state.id !== input.itemId || aggregate.state.accountId !== input.accountId) {
    throw new InventoryHoldPlacementError("inventory-item-missing", "Inventory item not found.");
  }

  const holds = await loadAggregateHoldSnapshots(input.eventStore, input.context);
  const heldQuantity = [...holds.values()]
    .filter((hold) => hold.active && hold.accountId === input.accountId && hold.itemId === input.itemId)
    .reduce((total, hold) => total + hold.quantity, 0);

  return {
    itemId: input.itemId,
    accountId: input.accountId,
    totalQuantity: aggregate.state.totalQuantity,
    heldQuantity,
    availableQuantity: aggregate.state.totalQuantity - heldQuantity,
  };
}

function stockSnapshotFromReadModel(item: InventoryHoldableItemRow): InventoryStockSnapshot {
  return {
    itemId: item.item_id,
    accountId: item.account_id as AccountId,
    totalQuantity: item.total_quantity,
    heldQuantity: item.held_quantity,
    availableQuantity: item.available_quantity,
  };
}

async function loadAggregateHoldSnapshots(
  eventStore: InventoryRuntimeDeps["eventStore"],
  context: EventStoreContext,
): Promise<Map<string, AggregateHoldSnapshot>> {
  const holds = new Map<string, AggregateHoldSnapshot>();
  let afterGlobalPosition: GlobalPosition = ZERO_GLOBAL_POSITION;
  const limit = 500;

  while (true) {
    const events = await eventStore.readAll({
      afterGlobalPosition,
      tenantId: context.tenantId,
      eventTypes: ["inventory.hold.placed", "inventory.hold.released"],
      streamPrefixes: ["inventory.hold-"],
      limit,
    });
    if (events.length === 0) {
      return holds;
    }

    for (const event of events) {
      afterGlobalPosition = event.globalPosition;

      if (event.eventType === "inventory.hold.placed") {
        const payload = event.payload as {
          holdId?: unknown;
          accountId?: unknown;
          itemId?: unknown;
          quantity?: unknown;
        };
        if (
          typeof payload.holdId !== "string" ||
          typeof payload.accountId !== "string" ||
          typeof payload.itemId !== "string" ||
          typeof payload.quantity !== "number"
        ) {
          continue;
        }

        holds.set(payload.holdId, {
          accountId: payload.accountId as AccountId,
          itemId: payload.itemId,
          quantity: payload.quantity,
          active: true,
        });
        continue;
      }

      if (event.eventType === "inventory.hold.released") {
        const payload = event.payload as { holdId?: unknown };
        if (typeof payload.holdId !== "string") {
          continue;
        }

        const existing = holds.get(payload.holdId);
        if (existing) {
          holds.set(payload.holdId, { ...existing, active: false });
        }
      }
    }

    if (events.length < limit) {
      return holds;
    }
  }
}
