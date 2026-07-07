import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type {
  InventoryHoldPurpose,
  InventoryHoldReleaseReason,
  InventoryHoldSourceRef,
} from "@chase-sets/event-core/public-event-payloads";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError, type InventoryHoldId } from "../../../support/runtime-support/common";
import { loadInventoryStockSnapshot } from "../../../support/runtime-support/stock-snapshot";
import {
  decideInventoryItem,
  evolveInventoryItem,
  initialInventoryItemState,
  type InventoryItemEvent,
  type InventoryItemState,
} from "../../inventory-items/domain/domain";
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

export type InventoryHoldPlacementParams = Readonly<{
  holdId?: InventoryHoldId | null;
  accountId: AccountId;
  itemId: string;
  quantity: number;
  reason: string;
  notes?: string | null;
  purpose: InventoryHoldPurpose;
  sourceRef: InventoryHoldSourceRef;
  expiresAt?: string | null;
}>;

export type InventoryHoldPlacementPlan =
  | Readonly<{
      kind: "already-placed";
      holdId: InventoryHoldId;
      version: number;
    }>
  | Readonly<{
      kind: "append";
      holdId: InventoryHoldId;
      append: AppendToStreamInput;
    }>;

const inventorySystemHoldReleaseAuthority = Symbol("inventorySystemHoldReleaseAuthority");

export type InventorySystemHoldReleaseContext = EventStoreContext &
  Readonly<{
    [inventorySystemHoldReleaseAuthority]: true;
  }>;

export function withInventorySystemHoldReleaseAuthority(context: EventStoreContext): InventorySystemHoldReleaseContext {
  return {
    ...context,
    [inventorySystemHoldReleaseAuthority]: true,
  };
}

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
  planCreateHold: (
    params: InventoryHoldPlacementParams,
    context: EventStoreContext,
  ) => Promise<InventoryHoldPlacementPlan>;
  createHold: (
    params: InventoryHoldPlacementParams,
    context: EventStoreContext,
  ) => Promise<{ holdId: InventoryHoldId; version: number }>;
  releaseHold: (
    params: Readonly<{
      accountId: string;
      holdId: string;
      releaseReason: InventoryHoldReleaseReason;
    }>,
    context: EventStoreContext,
  ) => Promise<{ holdId: string; version: number }>;
  getHold: (holdId: string, accountId: string) => ReturnType<typeof getInventoryHold>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInventoryHoldRuntime(deps: InventoryRuntimeDeps): InventoryHoldServices {
  const codec = createPassthroughDomainEventCodec<InventoryHoldEvent>();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec,
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

  const planCreateHold = async (
    params: InventoryHoldPlacementParams,
    context: EventStoreContext,
  ): Promise<InventoryHoldPlacementPlan> => {
    const holdId = params.holdId ?? (createId("hld") as InventoryHoldId);
    const existing = await repository.load(`inventory.hold-${holdId}`);
    if (existing.state.id !== null) {
      if (
        existing.state.status === "active" &&
        existing.state.accountId === params.accountId &&
        existing.state.itemId === params.itemId &&
        existing.state.quantity === params.quantity &&
        existing.state.purpose === params.purpose &&
        JSON.stringify(existing.state.sourceRef) === JSON.stringify(params.sourceRef) &&
        existing.state.expiresAt === (params.expiresAt ?? null)
      ) {
        return {
          kind: "already-placed",
          holdId,
          version: existing.version,
        };
      }

      throw new InventoryHoldPlacementError("hold-id-conflict", "Inventory hold already exists for different stock.");
    }

    const stock = await loadInventoryStockSnapshot({
      db: deps.db,
      itemRepository,
      itemId: params.itemId,
      accountId: params.accountId,
      context,
      missingItemError: () => new InventoryHoldPlacementError("inventory-item-missing", "Inventory item not found."),
    });

    if (stock.availableQuantity < params.quantity) {
      throw new InventoryHoldPlacementError(
        "insufficient-available-quantity",
        "Holds cannot exceed the available quantity for an inventory item.",
      );
    }

    const events = decideInventoryHold(existing.state, {
      type: "PlaceInventoryHold",
      holdId,
      accountId: params.accountId,
      itemId: params.itemId,
      quantity: params.quantity,
      reason: params.reason,
      notes: params.notes ?? null,
      purpose: params.purpose,
      sourceRef: params.sourceRef,
      expiresAt: params.expiresAt ?? null,
    });

    return {
      kind: "append",
      holdId,
      append: {
        streamId: `inventory.hold-${holdId}`,
        expectedVersion: existing.version,
        events: events.map((event) => codec.encode(event)),
        context,
      },
    };
  };

  return {
    commandHandler,
    planCreateHold,
    createHold: async (params, context) => {
      const plan = await planCreateHold(params, context);
      if (plan.kind === "already-placed") {
        return {
          holdId: plan.holdId,
          version: plan.version,
        };
      }

      const storedEvents = await deps.eventStore.appendToStream(plan.append);
      recordCommittedEvents(storedEvents);

      return {
        holdId: plan.holdId,
        version: storedEvents.length === 0 ? 0 : storedEvents[storedEvents.length - 1].streamVersion,
      };
    },
    releaseHold: async (params, context) => {
      const hold = await getInventoryHold(deps.db, params.holdId, params.accountId);
      if (!hold) {
        throw new InventoryDomainError("Inventory hold not found.");
      }
      if (!hasSystemHoldReleaseAuthority(context) && hold.purpose !== "manual") {
        throw new InventoryDomainError("Only manual inventory holds can be released by sellers.");
      }

      const result = await commandHandler({
        streamId: `inventory.hold-${params.holdId}`,
        command: {
          type: "ReleaseInventoryHold",
          releasedAt: new Date().toISOString(),
          releaseReason: params.releaseReason,
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

function hasSystemHoldReleaseAuthority(context: EventStoreContext) {
  return (context as Partial<InventorySystemHoldReleaseContext>)[inventorySystemHoldReleaseAuthority] === true;
}
