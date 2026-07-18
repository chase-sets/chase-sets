import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type {
  InventoryHoldOrderSourceRef,
  InventoryHoldPurpose,
  InventoryHoldReleaseReason,
  InventoryHoldSourceRef,
} from "@chase-sets/event-core/public-event-payloads";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError, type InventoryHoldId } from "../../../support/runtime-support/common";
import { loadAuthoritativeInventoryStockSnapshot } from "../../../support/runtime-support/stock-snapshot";
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
      appends: readonly AppendToStreamInput[];
    }>;

export type InventoryHoldConversionPlan =
  | Readonly<{
      kind: "already-converted";
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
  planConvertCheckoutHold: (
    params: Readonly<{
      holdId: InventoryHoldId;
      accountId: AccountId;
      itemId: string;
      quantity: number;
      orderId: string;
      reservationRequestId: string;
    }>,
    context: EventStoreContext,
  ) => Promise<InventoryHoldConversionPlan>;
  expireDueCheckoutHolds: (
    params: Readonly<{
      now?: string;
      limit?: number;
    }>,
    context: EventStoreContext,
  ) => Promise<readonly { holdId: string; version: number }[]>;
  extendCheckoutHold: (
    params: Readonly<{
      accountId: string;
      holdId: string;
      expiresAt: string;
      maxExtensionCount: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ holdId: string; version: number }>;
  getHold: (holdId: string, accountId: string) => ReturnType<typeof getInventoryHold>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInventoryHoldRuntime(deps: InventoryRuntimeDeps): InventoryHoldServices {
  const codec = createPassthroughDomainEventCodec<InventoryHoldEvent>();
  const itemCodec = createPassthroughDomainEventCodec<InventoryItemEvent>();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec,
    initialState: () => initialInventoryHoldState,
    evolve: evolveInventoryHold,
    decide: decideInventoryHold,
  });
  const { repository: itemRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: itemCodec,
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

    const itemAggregate = await itemRepository.load(`inventory.item-${params.itemId}`);
    const stock = await loadAuthoritativeInventoryStockSnapshot({
      db: deps.db,
      itemRepository,
      itemId: params.itemId,
      accountId: params.accountId,
      context,
      itemAggregate,
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
    const authorityEvents = decideInventoryItem(itemAggregate.state, {
      type: "ClaimInventoryStockAuthority",
      authorityRef: holdId,
      operation: "hold-placement",
      quantity: params.quantity,
    });

    return {
      kind: "append",
      holdId,
      appends: [
        {
          streamId: `inventory.item-${params.itemId}`,
          expectedVersion: itemAggregate.version,
          events: authorityEvents.map((event) => itemCodec.encode(event)),
          context,
        },
        {
          streamId: `inventory.hold-${holdId}`,
          expectedVersion: existing.version,
          events: events.map((event) => codec.encode(event)),
          context,
        },
      ],
    };
  };

  const planConvertCheckoutHold: InventoryHoldServices["planConvertCheckoutHold"] = async (params, context) => {
    const streamId = `inventory.hold-${params.holdId}`;
    const existing = await repository.load(streamId);
    const orderSourceRef: InventoryHoldOrderSourceRef = {
      orderId: params.orderId,
      reservationRequestId: params.reservationRequestId,
    };

    if (existing.state.id === null) {
      throw new InventoryDomainError("Checkout inventory hold not found.");
    }

    if (
      existing.state.status === "active" &&
      existing.state.accountId === params.accountId &&
      existing.state.itemId === params.itemId &&
      existing.state.quantity === params.quantity &&
      existing.state.purpose === "order" &&
      JSON.stringify(existing.state.sourceRef) === JSON.stringify(orderSourceRef) &&
      existing.state.expiresAt === null
    ) {
      return {
        kind: "already-converted",
        holdId: params.holdId,
        version: existing.version,
      };
    }

    if (
      existing.state.status !== "active" ||
      existing.state.accountId !== params.accountId ||
      existing.state.itemId !== params.itemId ||
      existing.state.quantity !== params.quantity ||
      existing.state.purpose !== "checkout"
    ) {
      throw new InventoryDomainError("Checkout inventory hold cannot be converted for this order.");
    }

    const events = decideInventoryHold(existing.state, {
      type: "ConvertInventoryHold",
      convertedAt: new Date().toISOString(),
      orderId: params.orderId,
      reservationRequestId: params.reservationRequestId,
    });

    return {
      kind: "append",
      holdId: params.holdId,
      append: {
        streamId,
        expectedVersion: existing.version,
        events: events.map((event) => codec.encode(event)),
        context,
      },
    };
  };

  return {
    commandHandler,
    planCreateHold,
    planConvertCheckoutHold,
    createHold: async (params, context) => {
      const appendToStreams = deps.eventStore.appendToStreams;
      if (!appendToStreams) {
        throw new InventoryDomainError("Inventory hold placement requires atomic stock authority.");
      }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const plan = await planCreateHold(params, context);
        if (plan.kind === "already-placed") {
          return {
            holdId: plan.holdId,
            version: plan.version,
          };
        }

        try {
          const results = await appendToStreams(plan.appends);
          const storedEvents = results.flatMap((result) => result.storedEvents);
          recordCommittedEvents(storedEvents);
          const holdEvents =
            results.find((result) => result.streamId === `inventory.hold-${plan.holdId}`)?.storedEvents ?? [];

          return {
            holdId: plan.holdId,
            version: holdEvents.length === 0 ? 0 : holdEvents[holdEvents.length - 1].streamVersion,
          };
        } catch (error) {
          if (attempt < 3 && isConcurrencyConflict(error)) {
            continue;
          }
          throw error;
        }
      }
      throw new InventoryDomainError("Inventory stock changed while placing the hold.");
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
    expireDueCheckoutHolds: async (params, context) => {
      const now = params.now ?? new Date().toISOString();
      const limit = Math.max(1, Math.min(500, Math.trunc(params.limit ?? 100)));
      const due = await deps.db.query<{ hold_id: string }>(
        `SELECT hold_id
         FROM inventory_holds
         WHERE status = 'active'
           AND purpose = 'checkout'
           AND expires_at IS NOT NULL
           AND expires_at <= $1
         ORDER BY expires_at ASC, hold_id ASC
         LIMIT $2`,
        [now, limit],
      );
      const expired: { holdId: string; version: number }[] = [];

      for (const row of due.rows) {
        const result = await commandHandler({
          streamId: `inventory.hold-${row.hold_id}`,
          command: {
            type: "ExpireInventoryHold",
            expiredAt: now,
          },
          context,
        });
        expired.push({ holdId: row.hold_id, version: result.version });
      }

      return expired;
    },
    extendCheckoutHold: async (params, context) => {
      const hold = await getInventoryHold(deps.db, params.holdId, params.accountId);
      if (!hold) {
        throw new InventoryDomainError("Inventory hold not found.");
      }
      if (hold.purpose !== "checkout" || hold.status !== "active") {
        throw new InventoryDomainError("Only active checkout inventory holds can be extended.");
      }

      const result = await commandHandler({
        streamId: `inventory.hold-${params.holdId}`,
        command: {
          type: "ExtendInventoryHold",
          extendedAt: new Date().toISOString(),
          expiresAt: params.expiresAt,
          maxExtensionCount: params.maxExtensionCount,
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

function isConcurrencyConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}
