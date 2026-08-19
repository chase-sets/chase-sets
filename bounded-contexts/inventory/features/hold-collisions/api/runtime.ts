import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  InventoryAdjustmentReason,
  InventoryHoldOrderSourceRef,
} from "@chase-sets/event-core/public-event-payloads";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, InventoryItemId } from "@chase-sets/primitives/typed-ids";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import {
  decideInventoryItem,
  evolveInventoryItem,
  initialInventoryItemState,
  type InventoryItemEvent,
} from "../../inventory-items/domain/domain";
import { createInventoryItemAdjustedCsatOutcomeFact } from "../../inventory-items/api/request-support/customer-feedback-outcome-fact";
import {
  decideInventoryHold,
  evolveInventoryHold,
  initialInventoryHoldState,
  type InventoryHoldEvent,
} from "../../holds/domain/domain";
import {
  decideInventoryReservation,
  evolveInventoryReservation,
  initialInventoryReservationState,
  type InventoryReservationEvent,
} from "../../reservations/domain/domain";
import {
  decideInventoryHoldCollision,
  evolveInventoryHoldCollision,
  initialInventoryHoldCollisionState,
  planInventoryHoldCollision,
  type ActiveInventoryHoldForCollision,
  type InventoryHoldCollisionMode,
  type InventoryHoldCollisionPlan,
  type InventoryHoldCollisionRecordedEvent,
} from "../domain/domain";
import { buildInventoryHoldCollisionProjectionHandlers } from "../read-model/projection";

type ActiveHoldRow = Readonly<{
  hold_id: string;
  quantity: string | number;
  purpose: string;
  source_ref: unknown;
  committed_at: string | Date;
}>;

export type InventoryHoldCollisionResult = Readonly<{
  itemId: string;
  version: number;
  collision: InventoryHoldCollisionPlan | null;
}>;

export type InventoryHoldCollisionServices = Readonly<{
  reduceItem: (
    params: Readonly<{
      accountId: string;
      itemId: string;
      requestedQuantity: number;
      reason: string;
      reasonCode?: InventoryAdjustmentReason;
      note?: string | null;
      mode?: InventoryHoldCollisionMode;
      actorRole?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<InventoryHoldCollisionResult>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createInventoryHoldCollisionRuntime(deps: InventoryRuntimeDeps): InventoryHoldCollisionServices {
  const itemCodec = createPassthroughDomainEventCodec<InventoryItemEvent>();
  const holdCodec = createPassthroughDomainEventCodec<InventoryHoldEvent>();
  const reservationCodec = createPassthroughDomainEventCodec<InventoryReservationEvent>();
  const collisionCodec = createPassthroughDomainEventCodec<InventoryHoldCollisionRecordedEvent>();
  const { repository: itemRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: itemCodec,
    initialState: () => initialInventoryItemState,
    evolve: evolveInventoryItem,
    decide: decideInventoryItem,
  });
  const { repository: holdRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: holdCodec,
    initialState: () => initialInventoryHoldState,
    evolve: evolveInventoryHold,
    decide: decideInventoryHold,
  });
  const { repository: reservationRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: reservationCodec,
    initialState: () => initialInventoryReservationState,
    evolve: evolveInventoryReservation,
    decide: decideInventoryReservation,
  });
  const appendToStreams = deps.eventStore.appendToStreams;
  if (!appendToStreams) {
    throw new Error("Inventory hold collisions require atomic multi-stream appends.");
  }

  return {
    reduceItem: async (params, context) => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const item = await itemRepository.load(`inventory.item-${params.itemId}`);
          if (item.state.id !== params.itemId || item.state.accountId !== params.accountId) {
            throw new InventoryDomainError("Inventory item not found.");
          }
          if (!Number.isInteger(params.requestedQuantity) || params.requestedQuantity <= 0) {
            throw new InventoryDomainError("Inventory reductions require a positive whole-number quantity.");
          }
          if (params.requestedQuantity > item.state.totalQuantity) {
            throw new InventoryDomainError("Inventory quantity cannot fall below zero.");
          }

          const activeHolds = await loadActiveHolds(deps, params, context);
          const mode = params.mode ?? "protect-orders";
          if (mode === "honor-offline" && params.reasonCode !== undefined && params.reasonCode !== "sold-offline") {
            throw new InventoryDomainError("Honor offline requires reasonCode sold-offline.");
          }
          const reasonCode = mode === "honor-offline" ? "sold-offline" : params.reasonCode;
          const collision = planInventoryHoldCollision({
            totalQuantity: item.state.totalQuantity,
            requestedQuantity: params.requestedQuantity,
            mode,
            actorRole: params.actorRole ?? null,
            activeHolds,
          });
          const releasedHoldQuantity = collision?.releasedHoldQuantity ?? 0;
          const appliedQuantity = collision?.appliedQuantity ?? params.requestedQuantity;
          const heldQuantity = activeHolds.reduce((total, hold) => total + hold.quantity, 0) - releasedHoldQuantity;
          const itemEvents =
            appliedQuantity === 0
              ? []
              : decideInventoryItem(item.state, {
                  type: "AdjustInventoryItemQuantity",
                  csatOutcomeFact: createInventoryItemAdjustedCsatOutcomeFact({
                    accountId: params.accountId as AccountId,
                    itemId: params.itemId as InventoryItemId,
                    idempotencyKey: `inventory:hold-collision:${params.itemId}:${attempt}:${Date.now()}`,
                  }),
                  quantityDelta: -appliedQuantity,
                  heldQuantity,
                  reason: params.reason,
                  ...(reasonCode !== undefined ? { reasonCode } : {}),
                  ...(params.note !== undefined ? { note: params.note } : {}),
                });

          const appends: AppendToStreamInput[] = [
            ...(itemEvents.length > 0
              ? [
                  {
                    streamId: `inventory.item-${params.itemId}`,
                    expectedVersion: item.version,
                    events: itemEvents.map((event) => itemCodec.encode(event)),
                    context,
                  },
                ]
              : []),
          ];

          if (collision?.mode === "honor-offline") {
            for (const affected of collision.affectedOrders) {
              const hold = await holdRepository.load(`inventory.hold-${affected.holdId}`);
              const reservation = await reservationRepository.load(
                `inventory.reservation-${affected.reservationRequestId}`,
              );
              const releasedAt = new Date().toISOString();
              const holdEvents = decideInventoryHold(hold.state, {
                type: "ReleaseInventoryHold",
                releasedAt,
                releaseReason: "hold-collision",
              });
              const reservationEvents = decideInventoryReservation(reservation.state, {
                type: "ReleaseInventoryReservation",
                releasedAt,
                releaseReason: "hold-collision",
              });
              appends.push(
                {
                  streamId: `inventory.hold-${affected.holdId}`,
                  expectedVersion: hold.version,
                  events: holdEvents.map((event) => holdCodec.encode(event)),
                  context,
                },
                {
                  streamId: `inventory.reservation-${affected.reservationRequestId}`,
                  expectedVersion: reservation.version,
                  events: reservationEvents.map((event) => reservationCodec.encode(event)),
                  context,
                },
              );
            }
          }

          if (collision) {
            const collisionId = createId("ihc");
            const recordedAt = new Date().toISOString();
            const collisionEvents = decideInventoryHoldCollision(initialInventoryHoldCollisionState, {
              type: "RecordInventoryHoldCollision",
              collisionId,
              accountId: params.accountId,
              itemId: params.itemId,
              storageLocationId: item.state.storageLocationId!,
              reason: params.reason,
              recordedAt,
              totalQuantityBefore: item.state.totalQuantity,
              plan: collision,
            });
            appends.push({
              streamId: `inventory.hold-collision-${collisionId}`,
              expectedVersion: "no_stream",
              events: collisionEvents.map((event) => collisionCodec.encode(event)),
              context,
            });
          }

          // A zero-available protect-orders collision still advances the item
          // authority stream so a simultaneous hold placement cannot commit
          // against the snapshot used for this decision.
          if (itemEvents.length === 0) {
            const authorityEvents = decideInventoryItem(item.state, {
              type: "ClaimInventoryStockAuthority",
              authorityRef: collision ? `collision:${params.itemId}` : `reduction:${params.itemId}`,
              operation: "stock-reduction",
              quantity: params.requestedQuantity,
            });
            appends.unshift({
              streamId: `inventory.item-${params.itemId}`,
              expectedVersion: item.version,
              events: authorityEvents.map((event) => itemCodec.encode(event)),
              context,
            });
          }

          const results = await appendToStreams(appends);
          const stored = results.flatMap((result) => result.storedEvents);
          recordCommittedEvents(stored);
          const itemStored = results.find((result) => result.streamId === `inventory.item-${params.itemId}`);
          return {
            itemId: params.itemId,
            version: itemStored?.storedEvents.at(-1)?.streamVersion ?? item.version,
            collision,
          };
        } catch (error) {
          if (attempt < 3 && isConcurrencyConflict(error)) {
            continue;
          }
          throw error;
        }
      }
      throw new InventoryDomainError("Inventory stock changed while resolving the hold collision.");
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "inventory-hold-collision-projection",
        handlers: buildInventoryHoldCollisionProjectionHandlers(deps.db),
      }),
    ],
  };
}

async function loadActiveHolds(
  deps: InventoryRuntimeDeps,
  params: Readonly<{ accountId: string; itemId: string }>,
  context: EventStoreContext,
): Promise<readonly ActiveInventoryHoldForCollision[]> {
  const result = await deps.db.query<ActiveHoldRow>(
    `WITH placed AS (
       SELECT stream_id, payload, recorded_at
       FROM event_store_events
       WHERE tenant_id = $1
         AND stream_context_name = 'inventory'
         AND stream_category = 'inventory.hold'
         AND event_type = 'inventory.hold.placed'
         AND payload ->> 'accountId' = $2
         AND payload ->> 'itemId' = $3
     )
     SELECT
       placed.payload ->> 'holdId' AS hold_id,
       placed.payload ->> 'quantity' AS quantity,
       COALESCE(converted.payload ->> 'purpose', placed.payload ->> 'purpose', 'manual') AS purpose,
       COALESCE(converted.payload -> 'sourceRef', placed.payload -> 'sourceRef') AS source_ref,
       COALESCE(converted.recorded_at, placed.recorded_at) AS committed_at
     FROM placed
     LEFT JOIN LATERAL (
       SELECT event.payload, event.recorded_at
       FROM event_store_events AS event
       WHERE event.tenant_id = $1
         AND event.stream_id = placed.stream_id
         AND event.event_type = 'inventory.hold.converted'
       ORDER BY event.stream_version DESC
       LIMIT 1
     ) AS converted ON true
     WHERE NOT EXISTS (
       SELECT 1
       FROM event_store_events AS terminal
       WHERE terminal.tenant_id = $1
         AND terminal.stream_id = placed.stream_id
         AND terminal.event_type IN ('inventory.hold.released', 'inventory.hold.expired', 'inventory.hold.consumed')
     )
     ORDER BY placed.recorded_at ASC, placed.stream_id ASC`,
    [context.tenantId, params.accountId, params.itemId],
  );

  return result.rows.map((row) => {
    const quantity = Number(row.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new InventoryDomainError("Inventory hold quantity is invalid.");
    }
    return {
      holdId: row.hold_id,
      quantity,
      purpose: row.purpose,
      sourceRef: orderSourceRef(row.source_ref),
      committedAt: new Date(row.committed_at).toISOString(),
    };
  });
}

function orderSourceRef(value: unknown): InventoryHoldOrderSourceRef | null {
  if (!value || typeof value !== "object" || !("orderId" in value) || !("reservationRequestId" in value)) {
    return null;
  }
  return {
    orderId: String(value.orderId),
    reservationRequestId: String(value.reservationRequestId),
  };
}

function isConcurrencyConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}
