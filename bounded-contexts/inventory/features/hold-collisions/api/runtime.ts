import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import type {
  InventoryAdjustmentReason,
  InventoryHoldOrderSourceRef,
  InventoryOfflineSaleChannel,
} from "@chase-sets/event-core/public-event-payloads";
import { isInventoryOfflineSaleChannel } from "@chase-sets/event-core/public-event-payloads";
import { normalizeMoneyAmount } from "@chase-sets/primitives/money";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, InventoryItemId } from "@chase-sets/primitives/typed-ids";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import {
  claimInventoryAdjustmentIdempotency,
  completeInventoryAdjustmentIdempotency,
  inventoryAdjustmentCommandFingerprint,
  normalizeInventoryAdjustmentNote,
  normalizeInventoryIdempotencyKey,
  releaseInventoryAdjustmentIdempotency,
  type InventoryAdjustmentIdempotencyRow,
} from "../../../support/runtime-support/inventory-adjustment-idempotency";
import {
  decideInventoryItem,
  evolveInventoryItem,
  initialInventoryItemState,
  type InventoryItemEvent,
} from "../../inventory-items/domain/domain";
import { createInventoryItemAdjustedCsatOutcomeFact } from "../../inventory-items/api/request-support/customer-feedback-outcome-fact";
import type { InventoryOfflineSaleResult } from "../../inventory-items/api/contracts";
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

export type InventoryHoldCollisionResult = InventoryOfflineSaleResult;
export type { InventoryOfflineSaleResult } from "../../inventory-items/api/contracts";

export type InventoryOfflineSaleReduction = Readonly<{
  idempotencyKey: string;
  salePriceAmount: string | null;
  channel: InventoryOfflineSaleChannel;
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
      offlineSale?: InventoryOfflineSaleReduction;
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
      const mode = params.mode ?? "protect-orders";
      const normalizedNote = params.note === undefined ? undefined : normalizeInventoryAdjustmentNote(params.note);
      const offlineSale = normalizeOfflineSaleReduction(params.offlineSale);
      const commandFingerprint = offlineSale
        ? inventoryAdjustmentCommandFingerprint({
            accountId: params.accountId,
            itemId: params.itemId,
            quantityDelta: -params.requestedQuantity,
            reason: "Offline sale",
            reasonCode: "sold-offline",
            note: normalizedNote,
            sourceRef: null,
            salePriceAmount: offlineSale.salePriceAmount,
            channel: offlineSale.channel,
            collisionMode: mode,
          })
        : null;
      let claimOwned = false;

      if (offlineSale && commandFingerprint) {
        const existing = await claimInventoryAdjustmentIdempotency<InventoryHoldCollisionPlan>(deps.db, {
          idempotencyKey: offlineSale.idempotencyKey,
          accountId: params.accountId,
          itemId: params.itemId,
          commandFingerprint,
        });
        if (existing) {
          if (existing.command_fingerprint !== commandFingerprint) {
            throw new InventoryDomainError("Inventory adjustment idempotency key was reused for different input.");
          }
          const completed = completedOfflineSaleResult(existing, params.requestedQuantity);
          if (completed) {
            return completed;
          }
          if (existing.status === "completed") {
            throw new InventoryDomainError("Inventory offline sale idempotency result is incomplete.");
          }
          const recovered = await recoverOfflineSaleResult(deps, {
            existing,
            idempotencyKey: offlineSale.idempotencyKey,
            commandFingerprint,
            accountId: params.accountId,
            itemId: params.itemId,
            requestedQuantity: params.requestedQuantity,
            salePriceAmount: offlineSale.salePriceAmount,
            channel: offlineSale.channel,
            context,
          });
          if (recovered) {
            return recovered;
          }
          throw new InventoryDomainError("Inventory adjustment idempotency key is already being processed.");
        }
        claimOwned = true;
      }

      try {
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
                : decideInventoryItem(
                    item.state,
                    offlineSale
                      ? {
                          type: "RecordOfflineSale",
                          csatOutcomeFact: createInventoryItemAdjustedCsatOutcomeFact({
                            accountId: params.accountId as AccountId,
                            itemId: params.itemId as InventoryItemId,
                            idempotencyKey: offlineSale.idempotencyKey,
                          }),
                          quantity: appliedQuantity,
                          heldQuantity,
                          salePriceAmount: offlineSale.salePriceAmount,
                          channel: offlineSale.channel,
                          ...(normalizedNote !== undefined ? { note: normalizedNote } : {}),
                          recordedAt: new Date().toISOString(),
                        }
                      : {
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
                          ...(normalizedNote !== undefined ? { note: normalizedNote } : {}),
                        },
                  );

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
            const result: InventoryHoldCollisionResult = {
              itemId: params.itemId,
              version: itemStored?.storedEvents.at(-1)?.streamVersion ?? item.version,
              requestedQuantity: params.requestedQuantity,
              appliedQuantity,
              refusedQuantity: collision?.refusedQuantity ?? 0,
              collision,
            };
            if (offlineSale && commandFingerprint) {
              const completed = await completeInventoryAdjustmentIdempotency(deps.db, {
                idempotencyKey: offlineSale.idempotencyKey,
                commandFingerprint,
                resultItemId: result.itemId,
                resultVersion: result.version,
                resultCollision: result.collision,
              });
              if (!completed) {
                claimOwned = false;
                throw new InventoryDomainError(
                  "Inventory offline sale idempotency claim was replaced before completion.",
                );
              }
              claimOwned = false;
            }
            return result;
          } catch (error) {
            if (attempt < 3 && isConcurrencyConflict(error)) {
              continue;
            }
            throw error;
          }
        }
        throw new InventoryDomainError("Inventory stock changed while resolving the hold collision.");
      } catch (error) {
        if (claimOwned && offlineSale) {
          await releaseInventoryAdjustmentIdempotency(deps.db, offlineSale.idempotencyKey);
        }
        throw error;
      }
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

function normalizeOfflineSaleReduction(
  value: InventoryOfflineSaleReduction | undefined,
): InventoryOfflineSaleReduction | null {
  if (!value) {
    return null;
  }
  const idempotencyKey = normalizeInventoryIdempotencyKey(value.idempotencyKey);
  if (!idempotencyKey) {
    throw new InventoryDomainError("Offline sales require a nonblank idempotency key.");
  }
  if (!isInventoryOfflineSaleChannel(value.channel)) {
    throw new InventoryDomainError("Offline sales require a supported channel.");
  }
  return {
    idempotencyKey,
    salePriceAmount: value.salePriceAmount === null ? null : normalizeMoneyAmount(value.salePriceAmount),
    channel: value.channel,
  };
}

function completedOfflineSaleResult(
  existing: InventoryAdjustmentIdempotencyRow<InventoryHoldCollisionPlan>,
  requestedQuantity: number,
): InventoryOfflineSaleResult | null {
  if (existing.status !== "completed" || !existing.result_item_id || existing.result_version === null) {
    return null;
  }
  const collision = parseInventoryHoldCollisionPlan(existing.result_collision);
  if (existing.result_collision !== null && !collision) {
    throw new InventoryDomainError("Inventory offline sale idempotency collision result is invalid.");
  }
  return {
    itemId: existing.result_item_id,
    version: Number(existing.result_version),
    requestedQuantity,
    appliedQuantity: collision?.appliedQuantity ?? requestedQuantity,
    refusedQuantity: collision?.refusedQuantity ?? 0,
    collision,
  };
}

async function recoverOfflineSaleResult(
  deps: InventoryRuntimeDeps,
  input: Readonly<{
    existing: InventoryAdjustmentIdempotencyRow<InventoryHoldCollisionPlan>;
    idempotencyKey: string;
    commandFingerprint: string;
    accountId: string;
    itemId: string;
    requestedQuantity: number;
    salePriceAmount: string | null;
    channel: InventoryOfflineSaleChannel;
    context: EventStoreContext;
  }>,
): Promise<InventoryOfflineSaleResult | null> {
  const collisionResult = await deps.db.query<{ payload: unknown }>(
    `SELECT payload
     FROM event_store_events
     WHERE tenant_id = $1
       AND stream_context_name = 'inventory'
       AND event_type = 'inventory.hold-collision-recorded'
       AND payload ->> 'itemId' = $2
       AND (payload ->> 'requestedQuantity')::integer = $3
       AND recorded_at >= $4
     ORDER BY recorded_at ASC, stream_id ASC
     LIMIT 2`,
    [input.context.tenantId, input.itemId, input.requestedQuantity, input.existing.created_at],
  );
  if (collisionResult.rows.length > 1) {
    throw new InventoryDomainError("Inventory offline sale recovery found ambiguous collision evidence.");
  }
  const collision = parseInventoryHoldCollisionPlan(collisionResult.rows[0]?.payload ?? null);
  if (collisionResult.rows.length === 1 && !collision) {
    throw new InventoryDomainError("Inventory offline sale recovery found invalid collision evidence.");
  }
  const appliedQuantity = collision?.appliedQuantity ?? input.requestedQuantity;
  const createdAt = new Date(input.existing.created_at).getTime();
  const events = await readCompleteStream(deps.eventStore, { streamId: `inventory.item-${input.itemId}` });
  const committed = [...events].reverse().find((event) => {
    if (Number.isFinite(createdAt) && new Date(event.recordedAt).getTime() < createdAt) {
      return false;
    }
    if (appliedQuantity === 0) {
      const payload = event.payload as { itemId?: unknown; operation?: unknown; quantity?: unknown };
      return (
        event.eventType === "inventory.item.stock-authority-claimed" &&
        payload.itemId === input.itemId &&
        payload.operation === "stock-reduction" &&
        payload.quantity === input.requestedQuantity &&
        event.forAccountId === input.accountId
      );
    }
    const payload = event.payload as {
      itemId?: unknown;
      quantity?: unknown;
      salePriceAmount?: unknown;
      channel?: unknown;
    };
    return (
      event.eventType === "inventory.item.offline-sale-recorded" &&
      payload.itemId === input.itemId &&
      payload.quantity === appliedQuantity &&
      (payload.salePriceAmount ?? null) === input.salePriceAmount &&
      payload.channel === input.channel &&
      event.forAccountId === input.accountId
    );
  });
  if (!committed) {
    return null;
  }

  const result: InventoryOfflineSaleResult = {
    itemId: input.itemId,
    version: Number(committed.streamVersion),
    requestedQuantity: input.requestedQuantity,
    appliedQuantity,
    refusedQuantity: collision?.refusedQuantity ?? 0,
    collision,
  };
  const completed = await completeInventoryAdjustmentIdempotency(deps.db, {
    idempotencyKey: input.idempotencyKey,
    commandFingerprint: input.commandFingerprint,
    resultItemId: result.itemId,
    resultVersion: result.version,
    resultCollision: result.collision,
  });
  return completed ? result : null;
}

function parseInventoryHoldCollisionPlan(value: unknown): InventoryHoldCollisionPlan | null {
  if (value === null) {
    return null;
  }
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const plan = candidate as Partial<InventoryHoldCollisionPlan>;
  if (
    (plan.mode !== "protect-orders" && plan.mode !== "honor-offline") ||
    !Number.isInteger(plan.requestedQuantity) ||
    !Number.isInteger(plan.appliedQuantity) ||
    !Number.isInteger(plan.refusedQuantity) ||
    !Number.isInteger(plan.heldQuantity) ||
    !Number.isInteger(plan.availableQuantity) ||
    !Number.isInteger(plan.releasedHoldQuantity) ||
    !Array.isArray(plan.affectedOrders)
  ) {
    return null;
  }
  return plan as InventoryHoldCollisionPlan;
}

function isConcurrencyConflict(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}
