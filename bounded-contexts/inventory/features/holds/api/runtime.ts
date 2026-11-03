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
import { InventoryDomainError, normalizeLabel, type InventoryHoldId } from "../../../support/runtime-support/common";
import { loadAuthoritativeInventoryStockSnapshot } from "../../../support/runtime-support/stock-snapshot";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { foldInventoryStockHold } from "../../../support/runtime-support/stock-history";
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
import { getInventoryCheckoutHold, getInventoryHold } from "../read-model/queries";

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
      accountId?: string;
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
  getCheckoutHold: (holdId: string, checkoutSessionId: string) => ReturnType<typeof getInventoryCheckoutHold>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInventoryHoldRuntime(deps: InventoryRuntimeDeps): InventoryHoldServices {
  const codec = createPassthroughDomainEventCodec<InventoryHoldEvent>();
  const itemCodec = createPassthroughDomainEventCodec<InventoryItemEvent>();
  const { commandHandler: rawCommandHandler, repository } = createAggregateCommandHandler({
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

  // Consumption is the one Hold command that changes two aggregate streams.
  // Keep the public command shape, but replace the single-stream handler with
  // an all-or-nothing pair append so a consumed hold can never leave on-hand
  // quantity unchanged.
  const commandHandler: CommandHandler<InventoryHoldCommand, InventoryHoldState, InventoryHoldEvent> = async (
    input,
  ) => {
    if (input.command.type !== "ConsumeInventoryHold") {
      return rawCommandHandler(input);
    }

    return consumeInventoryHoldAtomically({
      deps,
      input,
      repository,
      itemRepository,
      codec,
      itemCodec,
    });
  };

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
      eventStore: deps.eventStore,
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
      const streamId = `inventory.hold-${params.holdId}`;
      foldInventoryStockHold({
        events: await readCompleteStream(deps.eventStore, { streamId }),
        streamId,
        accountId: params.accountId,
        itemId: hold.item_id,
        tenantId: context.tenantId,
      });

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
           AND ($3::text IS NULL OR account_id = $3)
         ORDER BY expires_at ASC, hold_id ASC
         LIMIT $2`,
        [now, limit, params.accountId ?? null],
      );
      const expired: { holdId: string; version: number }[] = [];

      for (const row of due.rows) {
        const expire = (childContext: EventStoreContext) =>
          commandHandler({
            streamId: `inventory.hold-${row.hold_id}`,
            command: {
              type: "ExpireInventoryHold",
              expiredAt: now,
            },
            context: childContext,
          });
        const result =
          deps.mutationChild && params.accountId
            ? await deps.mutationChild(
                `expire-${expired.length}`,
                "hold-release",
                row.hold_id,
                { accountId: params.accountId, holdId: row.hold_id, releaseReason: "checkout-expired" },
                context,
                expire,
              )
            : await expire(context);
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
    getCheckoutHold: (holdId, checkoutSessionId) => getInventoryCheckoutHold(deps.db, holdId, checkoutSessionId),
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

async function consumeInventoryHoldAtomically(
  input: Readonly<{
    deps: InventoryRuntimeDeps;
    input: Parameters<CommandHandler<InventoryHoldCommand, InventoryHoldState, InventoryHoldEvent>>[0];
    repository: Readonly<{
      load: (streamId: string) => Promise<Readonly<{ state: InventoryHoldState; version: number }>>;
    }>;
    itemRepository: Readonly<{
      load: (streamId: string) => Promise<Readonly<{ state: InventoryItemState; version: number }>>;
    }>;
    codec: ReturnType<typeof createPassthroughDomainEventCodec<InventoryHoldEvent>>;
    itemCodec: ReturnType<typeof createPassthroughDomainEventCodec<InventoryItemEvent>>;
  }>,
): Promise<Awaited<ReturnType<CommandHandler<InventoryHoldCommand, InventoryHoldState, InventoryHoldEvent>>>> {
  const { input: commandInput } = input;
  const { command } = commandInput;
  if (command.type !== "ConsumeInventoryHold") {
    throw new InventoryDomainError("Only hold consumption uses the atomic consumption path.");
  }
  const holdId = commandInput.streamId.replace(/^inventory\.hold-/, "");
  if (!holdId || commandInput.streamId !== `inventory.hold-${holdId}`) {
    throw new InventoryDomainError("Consumed inventory hold stream is invalid.");
  }

  const holdAggregate = await input.repository.load(commandInput.streamId);
  if (holdAggregate.state.id === null) {
    throw new InventoryDomainError("Inventory hold not found.");
  }

  // A retry of the same terminal command is a no-op. A different terminal
  // command remains a domain conflict and is rejected by the normal decider.
  if (holdAggregate.state.status === "consumed") {
    const history = await readCompleteStream(input.deps.eventStore, { streamId: commandInput.streamId });
    const consumed = history.find((event) => event.eventType === "inventory.hold.consumed");
    const payload = consumed?.payload as { consumedAt?: unknown; consumptionReason?: unknown } | undefined;
    // Compare with the identity the decider stored, which trims the reason.
    if (
      payload?.consumedAt !== command.consumedAt ||
      payload?.consumptionReason !== normalizeLabel(command.consumptionReason)
    ) {
      throw new InventoryDomainError("Inventory hold consumption conflicts with the retained terminal identity.");
    }
    return {
      state: holdAggregate.state,
      version: holdAggregate.version,
      newEvents: [],
      storedEvents: [],
    };
  }

  const holdEvents = decideInventoryHold(holdAggregate.state, commandInput.command);
  const itemId = holdAggregate.state.itemId;
  const accountId = holdAggregate.state.accountId;
  const quantity = holdAggregate.state.quantity;
  if (!itemId || !accountId || !quantity || holdAggregate.state.purpose !== "order") {
    throw new InventoryDomainError("Only active order holds with complete provenance can be consumed.");
  }

  const itemStreamId = `inventory.item-${itemId}`;
  if (commandInput.expectedVersion !== undefined && commandInput.expectedVersion !== holdAggregate.version) {
    throw new InventoryDomainError("Consumed inventory hold version is stale.");
  }
  const itemAggregate = await input.itemRepository.load(itemStreamId);
  const stock = await loadAuthoritativeInventoryStockSnapshot({
    db: input.deps.db,
    eventStore: input.deps.eventStore,
    itemRepository: input.itemRepository,
    itemId,
    accountId: accountId as AccountId,
    context: commandInput.context,
    itemAggregate,
  });
  if (stock.heldQuantity < quantity) {
    throw new InventoryDomainError("Inventory hold history is unavailable; reconciliation is required.");
  }

  if (itemAggregate.state.totalQuantity < quantity) {
    throw new InventoryDomainError("Inventory quantity cannot fall below zero.");
  }
  const itemEvents: readonly InventoryItemEvent[] = [
    {
      type: "inventory.item.adjusted",
      data: {
        itemId: itemAggregate.state.id!,
        quantityDelta: -quantity,
        reason: "Stock consumed",
        reasonCode: "sale-consumed",
        sourceRef: holdAggregate.state.sourceRef,
      },
    },
  ];
  const holdVersion = holdAggregate.version + 1;
  const itemVersion = itemAggregate.version + 1;
  const pairId = `inventory-consumption:${holdId}:${holdVersion}:${itemVersion}`;
  const holdRecords = holdEvents.map((event) => ({
    ...input.codec.encode(event),
    metadata: {
      inventoryConsumptionPair: {
        pairId,
        pairedStreamId: itemStreamId,
        pairedStreamVersion: itemVersion,
      },
    },
  }));
  const itemRecords = itemEvents.map((event) => ({
    ...input.itemCodec.encode(event),
    metadata: {
      inventoryConsumptionPair: {
        pairId,
        pairedStreamId: commandInput.streamId,
        pairedStreamVersion: holdVersion,
      },
    },
  }));
  const appendToStreams = input.deps.eventStore.appendToStreams;
  if (!appendToStreams) {
    throw new InventoryDomainError("Consumed inventory holds require atomic stock authority.");
  }
  const results = await appendToStreams([
    {
      streamId: itemStreamId,
      expectedVersion: itemAggregate.version,
      events: itemRecords,
      context: commandInput.context,
    },
    {
      streamId: commandInput.streamId,
      expectedVersion: commandInput.expectedVersion ?? holdAggregate.version,
      events: holdRecords,
      context: commandInput.context,
    },
  ]);
  const storedEvents = results.find((result) => result.streamId === commandInput.streamId)?.storedEvents ?? [];
  recordCommittedEvents(results.flatMap((result) => result.storedEvents));
  return {
    state: evolveInventoryHold(holdAggregate.state, holdEvents[0]!),
    version: storedEvents.at(-1)?.streamVersion ?? holdAggregate.version,
    newEvents: holdEvents,
    storedEvents,
  };
}

function isConcurrencyConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}
