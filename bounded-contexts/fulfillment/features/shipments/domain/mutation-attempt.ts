import { createHash } from "node:crypto";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { LoadedAggregate } from "@chase-sets/event-core/aggregate-repository";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PostageOperationSubjectKind } from "@chase-sets/postage-labels";
import { FulfillmentDomainError } from "./common";
import {
  decideFulfillmentShipment,
  type FulfillmentShipmentCommand,
  type FulfillmentShipmentEvent,
  type FulfillmentShipmentState,
} from "./domain";

export const FULFILLMENT_MUTATION_ATTEMPT_SCHEMA_VERSION = 1;
export const CANONICAL_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type FulfillmentMutationResultClass = "succeeded" | "unchanged" | "failed-safe";

export type FulfillmentMutationAttemptReceipt = Readonly<{
  schemaVersion: 1;
  receiptKind: "fulfillment-attempt";
  commandKind: string;
  subjectKind: PostageOperationSubjectKind;
  subjectId: string;
  target: string | null;
  requestHash: string;
  resultClass: FulfillmentMutationResultClass;
  reason: string;
  subjectVersion: number;
  response: Readonly<{ shipmentId: string; version: number; status: string }>;
}>;

export type FulfillmentMutationAttemptEvent = Readonly<{
  type: "fulfillment.mutation-attempt-closed.v1";
  data: FulfillmentMutationAttemptReceipt;
}>;

export class FulfillmentMutationConflictError extends Error {
  public constructor(message = "Fulfillment mutation attempt conflicts with its immutable receipt.") {
    super(message);
    this.name = "FulfillmentMutationConflictError";
  }
}

export class ShipmentHistoryPoisonedError extends Error {
  public constructor(message = "Shipment mutation authority is unavailable.") {
    super(message);
    this.name = "ShipmentHistoryPoisonedError";
  }
}

export function assertCanonicalFulfillmentMutationId(value: unknown): asserts value is string {
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

export function fulfillmentMutationKeyDigest(
  input: Readonly<{
    tenantId: string;
    sellerAccountId: string;
    subjectKind: PostageOperationSubjectKind;
    key: string;
  }>,
) {
  assertCanonicalFulfillmentMutationId(input.key);
  const scope =
    input.subjectKind === "shipment" ? "shipment-mutation-key/v1" : `fulfillment-${input.subjectKind}-mutation-key/v1`;
  return sha256(`${scope}\n${input.tenantId}\n${input.sellerAccountId}\n${input.key}`);
}

export function fulfillmentMutationRequestHash(input: Readonly<Record<string, unknown>>) {
  return sha256(JSON.stringify(canonicalize({ schemaVersion: 1, ...input })));
}

export function fulfillmentMutationAttemptStreamId(
  input: Readonly<{
    tenantId: string;
    sellerAccountId: string;
    subjectKind: PostageOperationSubjectKind;
    subjectId: string;
    key: string;
  }>,
) {
  const digest = fulfillmentMutationKeyDigest(input);
  const streamNoun = input.subjectKind === "shipment" ? "shipment" : input.subjectKind;
  return `fulfillment.${streamNoun}-mutation-attempt-${input.tenantId}-${input.sellerAccountId}-${digest}`;
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

type LegacyShipmentMutationAttemptReceipt = Readonly<{
  schemaVersion: 1;
  receiptKind: "shipment-attempt";
  commandKind: string;
  shipmentId: string;
  target: string | null;
  requestHash: string;
  resultClass: FulfillmentMutationResultClass;
  reason: string;
  shipmentVersion: number;
  response: Readonly<{ shipmentId: string; version: number; status: string }>;
}>;

function parseAttemptReceipt(
  storedEvents: readonly StoredEvent[],
  expected: Readonly<{
    tenantId: string;
    commandKind: string;
    subjectKind: PostageOperationSubjectKind;
    subjectId: string;
    target: string | null;
    requestHash: string;
  }>,
): FulfillmentMutationAttemptReceipt | null {
  if (storedEvents.length === 0) return null;
  assertCompleteHistoryTenant(storedEvents, expected.tenantId);
  if (
    storedEvents.length !== 1 ||
    !["fulfillment.shipment.mutation-attempt-closed.v1", "fulfillment.mutation-attempt-closed.v1"].includes(
      storedEvents[0]?.eventType ?? "",
    )
  ) {
    throw new ShipmentHistoryPoisonedError();
  }
  const storedReceipt = storedEvents[0].payload as unknown as
    | FulfillmentMutationAttemptReceipt
    | LegacyShipmentMutationAttemptReceipt;
  const receipt: FulfillmentMutationAttemptReceipt =
    storedReceipt.receiptKind === "shipment-attempt"
      ? {
          ...storedReceipt,
          receiptKind: "fulfillment-attempt",
          subjectKind: "shipment",
          subjectId: storedReceipt.shipmentId,
          subjectVersion: storedReceipt.shipmentVersion,
        }
      : storedReceipt;
  if (
    receipt.schemaVersion !== FULFILLMENT_MUTATION_ATTEMPT_SCHEMA_VERSION ||
    receipt.receiptKind !== "fulfillment-attempt" ||
    receipt.commandKind !== expected.commandKind ||
    receipt.subjectKind !== expected.subjectKind ||
    receipt.subjectId !== expected.subjectId ||
    receipt.target !== expected.target ||
    receipt.requestHash !== expected.requestHash ||
    !["succeeded", "unchanged", "failed-safe"].includes(receipt.resultClass) ||
    receipt.response?.shipmentId !== expected.subjectId ||
    receipt.response?.version !== receipt.subjectVersion
  ) {
    throw new FulfillmentMutationConflictError();
  }
  return receipt;
}

type ShipmentLoader = (
  streamId: string,
) => Promise<LoadedAggregate<FulfillmentShipmentState, FulfillmentShipmentEvent>>;

export async function executeFulfillmentMutationAttempt(
  input: Readonly<{
    eventStore: EventStore;
    loadShipment: ShipmentLoader;
    context: EventStoreContext;
    mutationAttemptId: string;
    subjectKind: "shipment";
    subjectId: string;
    sellerAccountId: string;
    commandKind: string;
    target?: string | null;
    request: Readonly<Record<string, unknown>>;
    createCommand: () => FulfillmentShipmentCommand;
    successStatus: string;
  }>,
): Promise<FulfillmentMutationAttemptReceipt & Readonly<{ replayed: boolean }>> {
  assertCanonicalFulfillmentMutationId(input.mutationAttemptId);
  if (!input.eventStore.appendToStreams) {
    throw new Error("Atomic multi-stream append is required for Shipment mutation receipts.");
  }

  const tenantId = String(input.context.tenantId);
  const shipmentStreamId = `fulfillment.shipment-${input.subjectId}`;
  const attemptStreamId = fulfillmentMutationAttemptStreamId({
    tenantId,
    sellerAccountId: input.sellerAccountId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    key: input.mutationAttemptId,
  });
  const target = input.target ?? null;
  const requestHash = fulfillmentMutationRequestHash({
    commandKind: input.commandKind,
    tenantId,
    sellerAccountId: input.sellerAccountId,
    shipmentId: input.subjectId,
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
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      target,
      requestHash,
    });
    if (replay) return { ...replay, replayed: true };

    let shipmentEvents: readonly FulfillmentShipmentEvent[] = [];
    let resultClass: FulfillmentMutationResultClass = "succeeded";
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

    const subjectVersion = loaded.version + shipmentEvents.length;
    const receipt: FulfillmentMutationAttemptReceipt = {
      schemaVersion: 1,
      receiptKind: "fulfillment-attempt",
      commandKind: input.commandKind,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      target,
      requestHash,
      resultClass,
      reason,
      subjectVersion,
      response: {
        shipmentId: input.subjectId,
        version: subjectVersion,
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
              eventType: "fulfillment.mutation-attempt-closed.v1",
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
  throw new FulfillmentMutationConflictError();
}

export async function readFulfillmentMutationAttempt(
  input: Readonly<{
    eventStore: EventStore;
    context: EventStoreContext;
    key: string;
    subjectKind: PostageOperationSubjectKind;
    subjectId: string;
    sellerAccountId: string;
  }>,
) {
  assertCanonicalFulfillmentMutationId(input.key);
  const tenantId = String(input.context.tenantId);
  const streamId = fulfillmentMutationAttemptStreamId({
    tenantId,
    sellerAccountId: input.sellerAccountId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    key: input.key,
  });
  const events = await readCompleteStream(input.eventStore, { streamId });
  if (events.length === 0) return null;
  assertCompleteHistoryTenant(events, tenantId);
  if (
    events.length !== 1 ||
    !["fulfillment.shipment.mutation-attempt-closed.v1", "fulfillment.mutation-attempt-closed.v1"].includes(
      events[0]?.eventType ?? "",
    )
  ) {
    throw new ShipmentHistoryPoisonedError();
  }
  const storedReceipt = events[0].payload as unknown as
    | FulfillmentMutationAttemptReceipt
    | LegacyShipmentMutationAttemptReceipt;
  const receipt: FulfillmentMutationAttemptReceipt =
    storedReceipt.receiptKind === "shipment-attempt"
      ? {
          ...storedReceipt,
          receiptKind: "fulfillment-attempt",
          subjectKind: "shipment",
          subjectId: storedReceipt.shipmentId,
          subjectVersion: storedReceipt.shipmentVersion,
        }
      : storedReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.subjectKind !== input.subjectKind ||
    receipt.subjectId !== input.subjectId ||
    receipt.receiptKind !== "fulfillment-attempt"
  ) {
    throw new FulfillmentMutationConflictError();
  }
  return receipt;
}
