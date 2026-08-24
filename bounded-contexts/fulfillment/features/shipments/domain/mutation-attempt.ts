import { createHash } from "node:crypto";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { LoadedAggregate } from "@chase-sets/event-core/aggregate-repository";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { FulfillmentDomainError } from "./common";
import {
  decideFulfillmentShipment,
  type FulfillmentShipmentCommand,
  type FulfillmentShipmentEvent,
  type FulfillmentShipmentState,
} from "./domain";

export const SHIPMENT_MUTATION_ATTEMPT_SCHEMA_VERSION = 1;
export const CANONICAL_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ShipmentMutationResultClass = "succeeded" | "unchanged" | "failed-safe";

export type ShipmentMutationAttemptReceipt = Readonly<{
  schemaVersion: 1;
  receiptKind: "shipment-attempt";
  commandKind: string;
  shipmentId: string;
  target: string | null;
  requestHash: string;
  resultClass: ShipmentMutationResultClass;
  reason: string;
  shipmentVersion: number;
  response: Readonly<{ shipmentId: string; version: number; status: string }>;
}>;

export type ShipmentMutationAttemptEvent = Readonly<{
  type: "fulfillment.shipment.mutation-attempt-closed.v1";
  data: ShipmentMutationAttemptReceipt;
}>;

export class ShipmentMutationConflictError extends Error {
  public constructor(message = "Shipment mutation attempt conflicts with its immutable receipt.") {
    super(message);
    this.name = "ShipmentMutationConflictError";
  }
}

export class ShipmentHistoryPoisonedError extends Error {
  public constructor(message = "Shipment mutation authority is unavailable.") {
    super(message);
    this.name = "ShipmentHistoryPoisonedError";
  }
}

export function assertCanonicalShipmentMutationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CANONICAL_UUID_V4_PATTERN.test(value)) {
    throw new FulfillmentDomainError("A canonical UUIDv4 Idempotency-Key is required.");
  }
}

function compareCodePointStrings(left: string, right: string) {
  const leftCodePoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightCodePoints = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftCodePoints.length, rightCodePoints.length); index += 1) {
    const difference = leftCodePoints[index]! - rightCodePoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodePointStrings(left, right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function shipmentMutationKeyDigest(input: Readonly<{ tenantId: string; sellerAccountId: string; key: string }>) {
  assertCanonicalShipmentMutationId(input.key);
  return sha256(`shipment-mutation-key/v1\n${input.tenantId}\n${input.sellerAccountId}\n${input.key}`);
}

export function shipmentMutationRequestHash(input: Readonly<Record<string, unknown>>) {
  return sha256(JSON.stringify(canonicalize({ schemaVersion: 1, ...input })));
}

export function shipmentMutationAttemptStreamId(
  input: Readonly<{
    tenantId: string;
    sellerAccountId: string;
    key: string;
  }>,
) {
  const digest = shipmentMutationKeyDigest(input);
  return `fulfillment.shipment-mutation-attempt-${input.tenantId}-${input.sellerAccountId}-${digest}`;
}

export function assertCompleteHistoryTenant(
  storedEvents: readonly StoredEvent[],
  tenantId: string,
  options: Readonly<{ allowEmpty?: boolean }> = {},
) {
  if (storedEvents.length === 0) {
    if (options.allowEmpty) return;
    throw new ShipmentHistoryPoisonedError();
  }
  if (storedEvents.some((event) => !event.tenantId || String(event.tenantId) !== tenantId)) {
    throw new ShipmentHistoryPoisonedError();
  }
}

function stableFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("quantity") || message.includes("line")) return "inventory-mismatch";
  if (message.includes("cancel")) return "shipment-cancelled";
  if (message.includes("closed") || message.includes("already")) return "closed-state";
  return "validation-failed";
}

function parseAttemptReceipt(
  storedEvents: readonly StoredEvent[],
  expected: Readonly<{
    tenantId: string;
    commandKind: string;
    shipmentId: string;
    target: string | null;
    requestHash: string;
  }>,
): ShipmentMutationAttemptReceipt | null {
  if (storedEvents.length === 0) return null;
  assertCompleteHistoryTenant(storedEvents, expected.tenantId);
  if (storedEvents.length !== 1 || storedEvents[0]?.eventType !== "fulfillment.shipment.mutation-attempt-closed.v1") {
    throw new ShipmentHistoryPoisonedError();
  }
  const receipt = storedEvents[0].payload as unknown as ShipmentMutationAttemptReceipt;
  if (
    receipt.schemaVersion !== SHIPMENT_MUTATION_ATTEMPT_SCHEMA_VERSION ||
    receipt.receiptKind !== "shipment-attempt" ||
    receipt.commandKind !== expected.commandKind ||
    receipt.shipmentId !== expected.shipmentId ||
    receipt.target !== expected.target ||
    receipt.requestHash !== expected.requestHash ||
    !["succeeded", "unchanged", "failed-safe"].includes(receipt.resultClass) ||
    receipt.response?.shipmentId !== expected.shipmentId ||
    receipt.response?.version !== receipt.shipmentVersion
  ) {
    throw new ShipmentMutationConflictError();
  }
  return receipt;
}

type ShipmentLoader = (
  streamId: string,
) => Promise<LoadedAggregate<FulfillmentShipmentState, FulfillmentShipmentEvent>>;

export async function executeShipmentMutationAttempt(
  input: Readonly<{
    eventStore: EventStore;
    loadShipment: ShipmentLoader;
    context: EventStoreContext;
    mutationAttemptId: string;
    shipmentId: string;
    sellerAccountId: string;
    commandKind: string;
    target?: string | null;
    request: Readonly<Record<string, unknown>>;
    createCommand: () => FulfillmentShipmentCommand;
    successStatus: string;
  }>,
): Promise<ShipmentMutationAttemptReceipt & Readonly<{ replayed: boolean }>> {
  assertCanonicalShipmentMutationId(input.mutationAttemptId);
  if (!input.eventStore.appendToStreams) {
    throw new Error("Atomic multi-stream append is required for Shipment mutation receipts.");
  }

  const tenantId = String(input.context.tenantId);
  const shipmentStreamId = `fulfillment.shipment-${input.shipmentId}`;
  const attemptStreamId = shipmentMutationAttemptStreamId({
    tenantId,
    sellerAccountId: input.sellerAccountId,
    key: input.mutationAttemptId,
  });
  const target = input.target ?? null;
  const requestHash = shipmentMutationRequestHash({
    commandKind: input.commandKind,
    tenantId,
    sellerAccountId: input.sellerAccountId,
    shipmentId: input.shipmentId,
    target,
    ...input.request,
  });

  for (let retry = 0; retry < 3; retry += 1) {
    const loaded = await input.loadShipment(shipmentStreamId);
    assertCompleteHistoryTenant(loaded.storedEvents, tenantId);
    if (String(loaded.state.sellerAccountId) !== input.sellerAccountId) {
      throw new FulfillmentDomainError("Shipment not found.");
    }

    const attemptEvents = await readCompleteStream(input.eventStore, { streamId: attemptStreamId });
    const replay = parseAttemptReceipt(attemptEvents, {
      tenantId,
      commandKind: input.commandKind,
      shipmentId: input.shipmentId,
      target,
      requestHash,
    });
    if (replay) return { ...replay, replayed: true };

    let shipmentEvents: readonly FulfillmentShipmentEvent[] = [];
    let resultClass: ShipmentMutationResultClass = "succeeded";
    let reason = "applied";
    try {
      shipmentEvents = decideFulfillmentShipment(loaded.state, input.createCommand());
      if (shipmentEvents.length === 0) {
        resultClass = "unchanged";
        reason = "already-equivalent";
      }
    } catch (error) {
      if (!(error instanceof FulfillmentDomainError)) throw error;
      resultClass = "failed-safe";
      reason = stableFailureReason(error);
    }

    const shipmentVersion = loaded.version + shipmentEvents.length;
    const receipt: ShipmentMutationAttemptReceipt = {
      schemaVersion: 1,
      receiptKind: "shipment-attempt",
      commandKind: input.commandKind,
      shipmentId: input.shipmentId,
      target,
      requestHash,
      resultClass,
      reason,
      shipmentVersion,
      response: {
        shipmentId: input.shipmentId,
        version: shipmentVersion,
        status: resultClass === "succeeded" ? input.successStatus : resultClass,
      },
    };

    try {
      await input.eventStore.appendToStreams([
        {
          streamId: shipmentStreamId,
          expectedVersion: loaded.version,
          context: input.context,
          events: shipmentEvents.map((event) => ({
            eventType: event.type,
            payload: event.data,
          })),
        },
        {
          streamId: attemptStreamId,
          expectedVersion: "no_stream",
          context: input.context,
          events: [
            {
              eventType: "fulfillment.shipment.mutation-attempt-closed.v1",
              payload: receipt as never,
            },
          ],
        },
      ]);
      return { ...receipt, replayed: false };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code !== "concurrency_conflict" || retry === 2) throw error;
    }
  }
  throw new ShipmentMutationConflictError();
}

export async function readShipmentMutationAttempt(
  input: Readonly<{
    eventStore: EventStore;
    context: EventStoreContext;
    key: string;
    shipmentId: string;
    sellerAccountId: string;
  }>,
) {
  assertCanonicalShipmentMutationId(input.key);
  const tenantId = String(input.context.tenantId);
  const streamId = shipmentMutationAttemptStreamId({
    tenantId,
    sellerAccountId: input.sellerAccountId,
    key: input.key,
  });
  const events = await readCompleteStream(input.eventStore, { streamId });
  if (events.length === 0) return null;
  assertCompleteHistoryTenant(events, tenantId);
  if (events.length !== 1 || events[0]?.eventType !== "fulfillment.shipment.mutation-attempt-closed.v1") {
    throw new ShipmentHistoryPoisonedError();
  }
  const receipt = events[0].payload as unknown as ShipmentMutationAttemptReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.shipmentId !== input.shipmentId ||
    receipt.receiptKind !== "shipment-attempt"
  ) {
    throw new ShipmentMutationConflictError();
  }
  return receipt;
}
