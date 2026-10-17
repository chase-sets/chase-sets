import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { createId, type EventId } from "@chase-sets/primitives/typed-ids";
import type { InventoryExternalChannelSaleRecordedPayload } from "@chase-sets/event-core/public-event-payloads";
import type { InventoryRuntimeDeps } from "../../../support/runtime-support";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import {
  claimInventoryAdjustmentIdempotency,
  completeInventoryAdjustmentIdempotency,
  inventoryAdjustmentCommandFingerprint,
  readInventoryAdjustmentIdempotency,
  releaseInventoryAdjustmentIdempotency,
} from "../../../support/runtime-support/inventory-adjustment-idempotency";
import type { InventoryHoldCollisionServices } from "../../hold-collisions/api/runtime";
import { externalChannelSaleEventCodec } from "../domain/codec";
import {
  EXTERNAL_CHANNEL_SALE_COLLISION_MODE,
  EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REF,
  EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION,
  EXTERNAL_CHANNEL_SALE_EVENT_TYPE,
  EXTERNAL_CHANNEL_SALE_EVENT_VERSION,
  EXTERNAL_CHANNEL_SALE_REASON_CODE,
  externalChannelSaleShortfallKey,
  externalChannelSaleStreamId,
  isCanonicalUtcInstant,
  isClosedExternalChannelSaleEventPayload,
  isStructurallyValidCommittedExternalChannelSale,
  isValidReference,
  normalizeExternalChannelSaleCommand,
  parseExternalChannelSaleKey,
  type NormalizedExternalChannelSaleCommand,
} from "../domain/validation";
import type {
  CommittedExternalChannelSale,
  ExternalChannelSaleConflictField,
  ExternalChannelSaleHistoryFailure,
  ExternalChannelSaleHistoryFailureReason,
  RecordExternalChannelSale,
  RecordExternalChannelSaleCommand,
  RecordExternalChannelSaleConflict,
  RecordExternalChannelSaleOutcome,
  RecordExternalChannelSaleResult,
} from "./contracts";

export type InventoryExternalChannelSaleServices = Readonly<{
  record: (
    command: RecordExternalChannelSaleCommand,
    context: EventStoreContext,
  ) => Promise<RecordExternalChannelSaleOutcome>;
  bind: (context: EventStoreContext) => RecordExternalChannelSale;
}>;

type RehydratedSale = Readonly<{
  payload: InventoryExternalChannelSaleRecordedPayload;
  result: RecordExternalChannelSaleResult;
}>;

type Rehydration =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "valid"; sale: RehydratedSale }>
  | Readonly<{ kind: "invalid"; failure: ExternalChannelSaleHistoryFailure }>;

export function createInventoryExternalChannelSaleRuntime(
  deps: InventoryRuntimeDeps,
  holdCollisions: InventoryHoldCollisionServices,
): InventoryExternalChannelSaleServices {
  async function record(
    rawCommand: RecordExternalChannelSaleCommand,
    context: EventStoreContext,
  ): Promise<RecordExternalChannelSaleOutcome> {
    const command = normalizeExternalChannelSaleCommand(rawCommand);
    if (String(context.audit.forAccountId) !== command.accountId) {
      throw new InventoryDomainError("External channel sale context must be scoped to the command account.");
    }
    const saleStreamId = externalChannelSaleStreamId(command.saleKey);
    const incomingFingerprint = externalChannelSaleCommandFingerprint(command);
    const initial = await rehydrateExternalChannelSale(deps, saleStreamId, command.saleKey);
    const terminal = outcomeFromRehydration(initial, command, incomingFingerprint);
    if (terminal) {
      if ("status" in terminal) {
        await completeRecoveredJournal(deps, saleStreamId, incomingFingerprint, terminal.sale);
      }
      return terminal;
    }

    const claimGeneration = createId("iaj");
    const existingClaim = await claimInventoryAdjustmentIdempotency(deps.db, {
      idempotencyKey: saleStreamId,
      accountId: command.accountId,
      itemId: command.inventoryItemId,
      commandFingerprint: incomingFingerprint,
      claimGeneration,
    });
    const claimOwned = existingClaim === null;
    const saleEventId = createId("evt");
    const inventoryAdjustmentEventId = createId("evt");
    const committedAt = new Date().toISOString();
    let committedSale: CommittedExternalChannelSale | null = null;

    try {
      await holdCollisions.reduceItem(
        {
          accountId: command.accountId,
          itemId: command.inventoryItemId,
          requestedQuantity: command.requestedQuantity,
          reason: "External channel sale",
          reasonCode: EXTERNAL_CHANNEL_SALE_REASON_CODE,
          mode: EXTERNAL_CHANNEL_SALE_COLLISION_MODE,
          actorRole: null,
          externalChannelSale: {
            saleStreamId,
            storageLocationId: command.storageLocationId,
            inventoryAdjustmentEventId: inventoryAdjustmentEventId,
            buildTerminalEvent: ({ appliedQuantity, refusedQuantity, protectedOrderIds }) => {
              assertProtectedOrderIds(protectedOrderIds);
              committedSale = {
                saleKey: command.saleKey,
                saleStreamId,
                saleEventId,
                accountId: command.accountId,
                inventoryItemId: command.inventoryItemId,
                storageLocationId: command.storageLocationId,
                requestedQuantity: command.requestedQuantity,
                appliedQuantity,
                refusedQuantity,
                protectedOrderIds,
                collisionPolicyRef: EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REF,
                collisionPolicyRevision: EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION,
                inventoryAdjustmentEventId: appliedQuantity === 0 ? null : inventoryAdjustmentEventId,
                saleShortfallKey:
                  refusedQuantity === 0 ? null : externalChannelSaleShortfallKey(command.saleKey, incomingFingerprint),
                committedAt,
              };
              const payload = eventPayload(command, incomingFingerprint, committedSale);
              const encoded = externalChannelSaleEventCodec.encode({
                type: EXTERNAL_CHANNEL_SALE_EVENT_TYPE,
                data: payload,
              });
              return {
                ...encoded,
                eventId: saleEventId,
                occurredAt: committedAt as IsoUtcTimestamp,
              };
            },
          },
        },
        context,
      );

      if (!committedSale) {
        throw new InventoryDomainError("External channel sale terminal result was not constructed.");
      }
      if (claimOwned) {
        await completeInventoryAdjustmentIdempotency(deps.db, {
          idempotencyKey: saleStreamId,
          commandFingerprint: incomingFingerprint,
          claimGeneration,
          resultItemId: command.inventoryItemId,
          resultVersion: 1,
          resultCollision: committedSale,
        });
      }
      return { status: "committed", sale: committedSale };
    } catch (error) {
      if (committedSale || isConcurrencyConflict(error)) {
        const concurrent = await rehydrateExternalChannelSale(deps, saleStreamId, command.saleKey);
        const outcome = outcomeFromRehydration(concurrent, command, incomingFingerprint);
        if (outcome) {
          if ("status" in outcome) {
            await completeRecoveredJournal(deps, saleStreamId, incomingFingerprint, outcome.sale);
          } else if (claimOwned) {
            await releaseInventoryAdjustmentIdempotency(deps.db, {
              idempotencyKey: saleStreamId,
              commandFingerprint: incomingFingerprint,
              claimGeneration,
            });
          }
          return outcome;
        }
      }
      if (claimOwned) {
        await releaseInventoryAdjustmentIdempotency(deps.db, {
          idempotencyKey: saleStreamId,
          commandFingerprint: incomingFingerprint,
          claimGeneration,
        });
      }
      throw error;
    }
  }

  return {
    record,
    bind: (context) => (command) => record(command, context),
  };
}

export function externalChannelSaleCommandFingerprint(command: NormalizedExternalChannelSaleCommand): string {
  return inventoryAdjustmentCommandFingerprint({
    externalChannelSale: {
      saleKeyVersion: command.saleKey.version,
      accountId: command.accountId,
      inventoryItemId: command.inventoryItemId,
      storageLocationId: command.storageLocationId,
      requestedQuantity: command.requestedQuantity,
      ...(command.unitPriceAmount !== undefined ? { unitPriceAmount: command.unitPriceAmount } : {}),
      ...(command.currencyCode !== undefined ? { currencyCode: command.currencyCode } : {}),
      ...(command.soldAt !== undefined ? { soldAt: command.soldAt } : {}),
      ...(command.shippingCollectedAmount !== undefined
        ? { shippingCollectedAmount: command.shippingCollectedAmount }
        : {}),
      ...(command.channelFeeAmount !== undefined ? { channelFeeAmount: command.channelFeeAmount } : {}),
      collisionMode: EXTERNAL_CHANNEL_SALE_COLLISION_MODE,
      collisionPolicyRef: EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REF,
      collisionPolicyRevision: EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION,
      reasonCode: EXTERNAL_CHANNEL_SALE_REASON_CODE,
    },
  });
}

function eventPayload(
  command: NormalizedExternalChannelSaleCommand,
  commandFingerprint: string,
  result: CommittedExternalChannelSale,
): InventoryExternalChannelSaleRecordedPayload {
  return {
    eventVersion: EXTERNAL_CHANNEL_SALE_EVENT_VERSION,
    saleKey: command.saleKey,
    commandFingerprint,
    accountId: command.accountId,
    inventoryItemId: command.inventoryItemId,
    storageLocationId: command.storageLocationId,
    requestedQuantity: command.requestedQuantity,
    ...(command.unitPriceAmount !== undefined ? { unitPriceAmount: command.unitPriceAmount } : {}),
    ...(command.currencyCode !== undefined ? { currencyCode: command.currencyCode } : {}),
    ...(command.soldAt !== undefined ? { soldAt: command.soldAt } : {}),
    ...(command.shippingCollectedAmount !== undefined
      ? { shippingCollectedAmount: command.shippingCollectedAmount }
      : {}),
    ...(command.channelFeeAmount !== undefined ? { channelFeeAmount: command.channelFeeAmount } : {}),
    ...(command.connectionAuditReference !== undefined
      ? { connectionAuditReference: command.connectionAuditReference }
      : {}),
    collisionMode: EXTERNAL_CHANNEL_SALE_COLLISION_MODE,
    collisionPolicyRef: EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REF,
    collisionPolicyRevision: EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION,
    reasonCode: EXTERNAL_CHANNEL_SALE_REASON_CODE,
    result,
  };
}

async function rehydrateExternalChannelSale(
  deps: InventoryRuntimeDeps,
  saleStreamId: string,
  expectedKey: NormalizedExternalChannelSaleCommand["saleKey"],
): Promise<Rehydration> {
  let events: readonly StoredEvent[];
  try {
    events = await readCompleteStream(deps.eventStore, { streamId: saleStreamId });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("inclusive read expected") || error.message.includes("non-contiguous stream versions"))
    ) {
      return invalid(saleStreamId, "wrong-order-or-version", 0);
    }
    throw error;
  }
  if (events.length === 0) {
    const stream = await deps.db.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM event_store_streams WHERE stream_id = $1) AS present",
      [saleStreamId],
    );
    if (!stream.rows[0]?.present) {
      return { kind: "absent" };
    }
    // A competing atomic append may commit between the empty read and the
    // existence probe. Re-read once before classifying an existing stream as
    // poisoned, so a concurrent winner is replayed rather than mistaken for
    // an empty aggregate.
    try {
      events = await readCompleteStream(deps.eventStore, { streamId: saleStreamId });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("inclusive read expected") || error.message.includes("non-contiguous stream versions"))
      ) {
        return invalid(saleStreamId, "wrong-order-or-version", 0);
      }
      throw error;
    }
    if (events.length === 0) {
      return invalid(saleStreamId, "empty-existing-stream", null);
    }
  }

  const first = events[0]!;
  if (first.streamVersion !== 1) return invalid(saleStreamId, "wrong-order-or-version", 0);
  if (first.eventType !== EXTERNAL_CHANNEL_SALE_EVENT_TYPE) return invalid(saleStreamId, "unknown-event", 0);
  const candidate = first.payload as Record<string, unknown>;
  if (!candidate || typeof candidate !== "object" || candidate.eventVersion !== EXTERNAL_CHANNEL_SALE_EVENT_VERSION) {
    return invalid(saleStreamId, "unsupported-event-version", 0);
  }
  if (events.length > 1) {
    return invalid(
      saleStreamId,
      events[1]!.eventType === EXTERNAL_CHANNEL_SALE_EVENT_TYPE ? "duplicate-terminal" : "trailing-event",
      1,
    );
  }
  if (!isClosedExternalChannelSaleEventPayload(first.payload)) {
    return invalid(saleStreamId, "malformed-result", 0);
  }
  const payload = first.payload;
  let storedKey;
  try {
    storedKey = parseExternalChannelSaleKey(payload.saleKey);
  } catch {
    return invalid(saleStreamId, "key-stream-mismatch", 0);
  }
  if (externalChannelSaleStreamId(storedKey) !== saleStreamId || !sameJson(storedKey, expectedKey)) {
    return invalid(saleStreamId, "key-stream-mismatch", 0);
  }
  if (!validStoredCommandFacts(payload)) return invalid(saleStreamId, "target-or-profile-mismatch", 0);
  if (!validResultShape(payload.result)) return invalid(saleStreamId, "malformed-result", 0);
  if (!validQuantityLaw(payload)) return invalid(saleStreamId, "quantity-law-failure", 0);
  if (!validResultIdentity(payload, first)) return invalid(saleStreamId, "target-or-profile-mismatch", 0);

  const storedCommand = normalizedCommandFromPayload(payload);
  const recomputedFingerprint = externalChannelSaleCommandFingerprint(storedCommand);
  if (!/^[a-f0-9]{64}$/.test(payload.commandFingerprint) || payload.commandFingerprint !== recomputedFingerprint) {
    return invalid(saleStreamId, "stored-fingerprint-mismatch", 0);
  }
  const expectedShortfallKey =
    payload.result.refusedQuantity === 0
      ? null
      : externalChannelSaleShortfallKey(payload.saleKey, payload.commandFingerprint);
  if (payload.result.saleShortfallKey !== expectedShortfallKey) {
    return invalid(saleStreamId, "malformed-result", 0);
  }
  return { kind: "valid", sale: { payload, result: { status: "committed", sale: payload.result } } };
}

function outcomeFromRehydration(
  rehydrated: Rehydration,
  incoming: NormalizedExternalChannelSaleCommand,
  incomingFingerprint: string,
): RecordExternalChannelSaleOutcome | null {
  if (rehydrated.kind === "absent") return null;
  if (rehydrated.kind === "invalid") return rehydrated.failure;
  const stored = rehydrated.sale.payload;
  if (stored.commandFingerprint === incomingFingerprint) return rehydrated.sale.result;
  return conflict(stored, incoming, incomingFingerprint);
}

function conflict(
  stored: InventoryExternalChannelSaleRecordedPayload,
  incoming: NormalizedExternalChannelSaleCommand,
  incomingFingerprint: string,
): RecordExternalChannelSaleConflict {
  const differences: readonly [ExternalChannelSaleConflictField, unknown, unknown][] = [
    ["accountId", stored.accountId, incoming.accountId],
    ["inventoryItemId", stored.inventoryItemId, incoming.inventoryItemId],
    ["storageLocationId", stored.storageLocationId, incoming.storageLocationId],
    ["requestedQuantity", stored.requestedQuantity, incoming.requestedQuantity],
    ["unitPriceAmount", stored.unitPriceAmount, incoming.unitPriceAmount],
    ["shippingCollectedAmount", stored.shippingCollectedAmount, incoming.shippingCollectedAmount],
    ["channelFeeAmount", stored.channelFeeAmount, incoming.channelFeeAmount],
    ["currencyCode", stored.currencyCode, incoming.currencyCode],
    ["soldAt", stored.soldAt, incoming.soldAt],
    ["collisionPolicyRef", stored.collisionPolicyRef, EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REF],
    ["collisionPolicyRevision", stored.collisionPolicyRevision, EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION],
    ["reasonCode", stored.reasonCode, EXTERNAL_CHANNEL_SALE_REASON_CODE],
  ];
  return {
    code: "external-channel-sale-conflict",
    saleKey: incoming.saleKey,
    saleStreamId: stored.result.saleStreamId,
    existingFingerprint: stored.commandFingerprint,
    incomingFingerprint,
    differingFields: differences.filter(([, left, right]) => left !== right).map(([field]) => field),
  };
}

function validStoredCommandFacts(payload: InventoryExternalChannelSaleRecordedPayload): boolean {
  if (
    payload.collisionMode !== EXTERNAL_CHANNEL_SALE_COLLISION_MODE ||
    payload.collisionPolicyRef !== EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REF ||
    payload.collisionPolicyRevision !== EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION ||
    payload.reasonCode !== EXTERNAL_CHANNEL_SALE_REASON_CODE
  )
    return false;
  try {
    const storedCommand = normalizedCommandFromPayload(payload);
    normalizeExternalChannelSaleCommand(storedCommand);
    return storedCommand.soldAt === undefined || isCanonicalUtcInstant(storedCommand.soldAt);
  } catch {
    return false;
  }
}

function normalizedCommandFromPayload(
  payload: InventoryExternalChannelSaleRecordedPayload,
): NormalizedExternalChannelSaleCommand {
  return {
    accountId: payload.accountId,
    inventoryItemId: payload.inventoryItemId,
    storageLocationId: payload.storageLocationId,
    saleKey: payload.saleKey,
    requestedQuantity: payload.requestedQuantity,
    ...(Object.hasOwn(payload, "unitPriceAmount") ? { unitPriceAmount: payload.unitPriceAmount! } : {}),
    ...(Object.hasOwn(payload, "currencyCode") ? { currencyCode: payload.currencyCode! } : {}),
    ...(Object.hasOwn(payload, "soldAt") ? { soldAt: payload.soldAt! } : {}),
    ...(Object.hasOwn(payload, "shippingCollectedAmount")
      ? { shippingCollectedAmount: payload.shippingCollectedAmount! }
      : {}),
    ...(Object.hasOwn(payload, "channelFeeAmount") ? { channelFeeAmount: payload.channelFeeAmount! } : {}),
    ...(Object.hasOwn(payload, "connectionAuditReference")
      ? { connectionAuditReference: payload.connectionAuditReference! }
      : {}),
  };
}

function validResultShape(result: CommittedExternalChannelSale): boolean {
  return isStructurallyValidCommittedExternalChannelSale(result);
}

function validQuantityLaw(payload: InventoryExternalChannelSaleRecordedPayload): boolean {
  const { requestedQuantity, appliedQuantity, refusedQuantity, inventoryAdjustmentEventId, saleShortfallKey } =
    payload.result;
  return (
    requestedQuantity === payload.requestedQuantity &&
    requestedQuantity > 0 &&
    appliedQuantity >= 0 &&
    refusedQuantity >= 0 &&
    requestedQuantity === appliedQuantity + refusedQuantity &&
    (inventoryAdjustmentEventId === null) === (appliedQuantity === 0) &&
    (saleShortfallKey === null) === (refusedQuantity === 0)
  );
}

function validResultIdentity(payload: InventoryExternalChannelSaleRecordedPayload, event: StoredEvent): boolean {
  const result = payload.result;
  return (
    sameJson(result.saleKey, payload.saleKey) &&
    result.saleStreamId === event.streamId &&
    result.saleEventId === event.eventId &&
    result.accountId === event.forAccountId &&
    result.accountId === payload.accountId &&
    result.inventoryItemId === payload.inventoryItemId &&
    result.storageLocationId === payload.storageLocationId &&
    result.collisionPolicyRef === payload.collisionPolicyRef &&
    result.collisionPolicyRevision === payload.collisionPolicyRevision &&
    result.committedAt === event.occurredAt
  );
}

function assertProtectedOrderIds(orderIds: readonly string[]): void {
  if (orderIds.length > 10_000 || orderIds.some((orderId) => !isValidReference(orderId))) {
    throw new InventoryDomainError(
      "External channel sale protected order evidence is invalid or exceeds 10000 orders.",
    );
  }
  if (new Set(orderIds).size !== orderIds.length) {
    throw new InventoryDomainError("External channel sale protected order evidence must be unique.");
  }
}

async function completeRecoveredJournal(
  deps: InventoryRuntimeDeps,
  saleStreamId: string,
  commandFingerprint: string,
  sale: CommittedExternalChannelSale,
): Promise<void> {
  const row = await readInventoryAdjustmentIdempotency(deps.db, saleStreamId);
  if (row?.status !== "in_progress" || row.command_fingerprint !== commandFingerprint) {
    return;
  }
  await completeInventoryAdjustmentIdempotency(deps.db, {
    idempotencyKey: saleStreamId,
    commandFingerprint,
    claimGeneration: row.claim_generation,
    resultItemId: sale.inventoryItemId,
    resultVersion: 1,
    resultCollision: sale,
  });
}

function invalid(
  saleStreamId: string,
  reason: ExternalChannelSaleHistoryFailureReason,
  eventIndex: number | null,
): Rehydration {
  return {
    kind: "invalid",
    failure: { code: "external-channel-sale-history-invalid", saleStreamId, reason, eventIndex },
  };
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
