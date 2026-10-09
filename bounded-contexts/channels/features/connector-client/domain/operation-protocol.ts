import {
  outboundOperationKinds,
  type ClaimedSubjectOutcome,
  type ClaimedSubjectOperation,
  type ClaimedOperationReservation,
  type OutboundOperationKind,
  type OutboundOperationPayload,
} from "../../outbound-sync/domain/contracts";
import {
  assertClaimedOperationOutcome,
  assertOutboundOperationPayload,
  canonicalJson,
} from "../../outbound-sync/domain/validation";
import { assertChannelListingDelistDirective } from "../../listing-composition/domain/codecs";
import { assertChannelProviderIdentity } from "../../publication-port/domain/validation";
import { assertConnectorRunSettlement, type ConnectorRunSettlement } from "../../connector-feed/domain/run-settlement";
import type { ConnectorReport } from "../../connector-feed/domain/transport";
import { utcInstant, safeRevision } from "./extension-records";
import {
  assertClaimedOrderPullOutcome,
  assertOrderPullPayloadStructure,
  type OrderPullPayload,
} from "../../outbound-sync/domain/order-pull-codec";
import {
  assertHandoffOutcome,
  browserCheckpointDigest,
  parseOrderPullHandoff,
  type OrderPullHandoff,
} from "./order-pull-handoff";
import type { OrderPullExecution } from "./order-pull-execution";
import { OperationProtocolError, identifier, record, refuse } from "./operation-codec";
export { OperationProtocolError, identifier, record, refuse } from "./operation-codec";

export const operationStates = [
  "prepared",
  "dispatched",
  "receipt-captured",
  "outcome-unknown",
  "reported",
  "acked",
] as const;
export type OperationState = (typeof operationStates)[number];
export const journalLimit = 4096;
export type ExecutorResult = Readonly<{
  outcomes: readonly ClaimedSubjectOutcome[];
  runSettlement?: ConnectorRunSettlement;
}>;
export type OperationAttempt = Readonly<{
  schemaVersion: 1;
  connectionId: string;
  revision: number;
  operationId: string;
  attemptId: string;
  claimGeneration: number;
  reservationId: string;
  leaseExpiresAt: string;
  payloadDigest: string;
  state: OperationState;
  preparedAt: string;
  dispatchedAt?: string;
  receipt?: ExecutorResult;
  unknownReason?: "interrupted" | "unprovable-response" | "incomplete-rebind";
}> &
  (
    | Readonly<{
        operationKind: OutboundOperationKind;
        payload: OutboundOperationPayload;
        desiredStateSequence: number;
      }>
    | Readonly<{
        operationKind: "tcgplayer-order-pull";
        payload: OrderPullPayload;
        scheduleGeneration: number;
        handoff?: OrderPullHandoff;
      }>
  );
export type OperationReservation = Readonly<{
  schemaVersion: 1;
  connectionId: string;
  revision: number;
  reservationId: string;
  executorKey: string;
  reservedAt: string;
  leaseExpiresAt: string;
  memberOperationIds: readonly string[];
  phase: OperationState;
  reportEnvelope?: ConnectorReport;
  reportedAt?: string;
  ackedAt?: string;
  lastRefusal?: "transport" | "authorization" | "stale-fence" | "invalid-result";
}>;
export type OperationUnit = Readonly<{ reservation: OperationReservation; members: readonly OperationAttempt[] }>;
export type ConnectorExecutor = Readonly<{
  key: string;
  accepts: readonly (readonly [
    OutboundOperationKind | "tcgplayer-order-pull",
    OutboundOperationPayload["kind"] | "order-pull",
  ])[];
  unit: "operation" | "reservation";
  dispatchDeadlineMs: number;
  prepare(unit: OperationUnit): Promise<Readonly<{ ready: true }> | Readonly<{ ready: false; result: ExecutorResult }>>;
  dispatchOnce(unit: OperationUnit, signal: AbortSignal, pull?: OrderPullExecution): Promise<ExecutorResult>;
  reconcileAmbiguous?(unit: OperationUnit, pull?: OrderPullExecution): Promise<ExecutorResult | null>;
}>;

function positive(value: unknown): void {
  if (!safeRevision(value) || value < 1) refuse();
}
function instant(value: unknown): void {
  if (!utcInstant(value)) refuse();
}
function digest(value: unknown): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) refuse();
}
function state(value: unknown): void {
  if (!operationStates.some((candidate) => candidate === value)) refuse();
}
function payload(value: unknown, kind: unknown): asserts value is OutboundOperationPayload | OrderPullPayload {
  if (kind === "tcgplayer-order-pull") {
    assertOrderPullPayloadStructure(value);
    return;
  }
  if (!outboundOperationKinds.some((candidate) => candidate === kind)) refuse();
  assertOutboundOperationPayload(value, kind as OutboundOperationKind, assertChannelListingDelistDirective);
}
export async function browserPayloadDigest(
  value: OutboundOperationPayload | OrderPullPayload,
  crypto: Crypto = globalThis.crypto,
): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export function parseExecutorResult(value: unknown): ExecutorResult {
  const row = record(value, ["outcomes"], ["runSettlement"]);
  if (!Array.isArray(row.outcomes) || row.outcomes.length < 1 || row.outcomes.length > journalLimit) refuse();
  const ids = new Set<string>();
  for (const outcome of row.outcomes) {
    if (outcome && typeof outcome === "object" && "operationKind" in outcome) assertClaimedOrderPullOutcome(outcome);
    else assertClaimedOperationOutcome(outcome);
    if (ids.has(outcome.operationId) || new TextEncoder().encode(canonicalJson(outcome)).length > 16384) refuse();
    ids.add(outcome.operationId);
  }
  if (Object.hasOwn(row, "runSettlement")) assertConnectorRunSettlement(row.runSettlement);
  return structuredClone(row) as ExecutorResult;
}
export function parseOperationAttempt(value: unknown): OperationAttempt {
  const row = record(
    value,
    [
      "schemaVersion",
      "connectionId",
      "revision",
      "operationId",
      "attemptId",
      "claimGeneration",
      "reservationId",
      "leaseExpiresAt",
      "operationKind",
      "payload",
      "payloadDigest",
      "state",
      "preparedAt",
    ],
    ["dispatchedAt", "receipt", "unknownReason", "desiredStateSequence", "scheduleGeneration", "handoff"],
  );
  if (row.schemaVersion !== 1) throw new OperationProtocolError("upgrade-required");
  if (!safeRevision(row.revision)) refuse();
  for (const key of ["connectionId", "operationId", "attemptId", "reservationId"]) identifier(row[key]);
  positive(row.claimGeneration);
  if (row.operationKind === "tcgplayer-order-pull") {
    if (Object.hasOwn(row, "desiredStateSequence")) refuse();
    positive(row.scheduleGeneration);
  } else {
    if (Object.hasOwn(row, "scheduleGeneration") || Object.hasOwn(row, "handoff")) refuse();
    positive(row.desiredStateSequence);
  }
  instant(row.leaseExpiresAt);
  instant(row.preparedAt);
  state(row.state);
  digest(row.payloadDigest);
  payload(row.payload, row.operationKind);
  if (row.payload.kind === "order-pull") {
    if (row.payload.connectionId !== row.connectionId) refuse();
    if (Object.hasOwn(row, "handoff")) parseOrderPullHandoff(row.handoff, row.payload);
    if (row.state === "prepared" && row.handoff !== undefined) refuse();
  }
  if (Object.hasOwn(row, "dispatchedAt")) instant(row.dispatchedAt);
  if (Object.hasOwn(row, "receipt")) parseExecutorResult(row.receipt);
  if (
    Object.hasOwn(row, "unknownReason") &&
    !["interrupted", "unprovable-response", "incomplete-rebind"].includes(String(row.unknownReason))
  )
    refuse();
  if (
    row.state === "prepared" &&
    (row.dispatchedAt !== undefined || row.receipt !== undefined || row.unknownReason !== undefined)
  )
    refuse();
  if (
    ["dispatched", "outcome-unknown", "receipt-captured"].includes(String(row.state)) &&
    row.dispatchedAt === undefined
  )
    refuse();
  if (row.state === "receipt-captured" && row.receipt === undefined) refuse();
  if (row.state === "outcome-unknown" && row.unknownReason === undefined) refuse();
  return structuredClone(row) as OperationAttempt;
}
export function parseOperationReservation(value: unknown): OperationReservation {
  const row = record(
    value,
    [
      "schemaVersion",
      "connectionId",
      "revision",
      "reservationId",
      "executorKey",
      "reservedAt",
      "leaseExpiresAt",
      "memberOperationIds",
      "phase",
    ],
    ["reportEnvelope", "reportedAt", "ackedAt", "lastRefusal"],
  );
  if (row.schemaVersion !== 1) throw new OperationProtocolError("upgrade-required");
  if (!safeRevision(row.revision)) refuse();
  for (const key of ["connectionId", "reservationId", "executorKey"]) identifier(row[key]);
  instant(row.reservedAt);
  instant(row.leaseExpiresAt);
  state(row.phase);
  if (
    !Array.isArray(row.memberOperationIds) ||
    row.memberOperationIds.length < 1 ||
    row.memberOperationIds.length > journalLimit
  )
    refuse();
  row.memberOperationIds.forEach(identifier);
  if (new Set(row.memberOperationIds).size !== row.memberOperationIds.length) refuse();
  if (Object.hasOwn(row, "reportEnvelope")) {
    const envelope = record(row.reportEnvelope, ["reservationId", "outcomes"], ["runSettlement"]);
    if (envelope.reservationId !== row.reservationId) refuse();
    parseExecutorResult({
      outcomes: envelope.outcomes,
      ...(Object.hasOwn(envelope, "runSettlement") ? { runSettlement: envelope.runSettlement } : {}),
    });
  }
  if (Object.hasOwn(row, "reportedAt")) instant(row.reportedAt);
  if (Object.hasOwn(row, "ackedAt")) instant(row.ackedAt);
  if (
    Object.hasOwn(row, "lastRefusal") &&
    !["transport", "authorization", "stale-fence", "invalid-result"].includes(String(row.lastRefusal))
  )
    refuse();
  if (["reported", "acked"].includes(String(row.phase)) && (!row.reportEnvelope || !row.reportedAt)) refuse();
  if (row.phase === "acked" && !row.ackedAt) refuse();
  return structuredClone(row) as OperationReservation;
}
export async function parseOperationClaim(
  value: unknown,
  connectionId: string,
): Promise<ClaimedOperationReservation<ClaimedSubjectOperation>> {
  const row = record(value, [
    "reservationId",
    "connectionId",
    "providerIdentity",
    "claimant",
    "reservedAt",
    "leaseExpiresAt",
    "operations",
  ]);
  identifier(row.reservationId);
  if (row.connectionId !== connectionId) refuse();
  assertChannelProviderIdentity(row.providerIdentity);
  const claimant = record(row.claimant, ["claimantKind", "claimantId"]);
  if (claimant.claimantKind !== "connector") refuse();
  identifier(claimant.claimantId);
  instant(row.reservedAt);
  instant(row.leaseExpiresAt);
  if (Date.parse(String(row.reservedAt)) >= Date.parse(String(row.leaseExpiresAt))) refuse();
  if (!Array.isArray(row.operations) || row.operations.length < 1) refuse();
  if (row.operations.length > journalLimit) throw new OperationProtocolError("incomplete-authority");
  const ids = new Set<string>();
  for (const member of row.operations) {
    if (member && typeof member === "object" && member.operationKind === "tcgplayer-order-pull") {
      const operation = record(member, [
        "operationId",
        "attemptId",
        "claimGeneration",
        "connectionId",
        "providerIdentity",
        "subject",
        "operationKind",
        "pullId",
        "scheduleGeneration",
        "payload",
        "payloadDigest",
        "enqueuedAt",
      ]);
      if (
        row.operations.length !== 1 ||
        operation.connectionId !== connectionId ||
        canonicalJson(operation.providerIdentity) !== canonicalJson(row.providerIdentity)
      )
        refuse();
      for (const key of ["operationId", "attemptId"]) identifier(operation[key]);
      positive(operation.claimGeneration);
      positive(operation.scheduleGeneration);
      instant(operation.enqueuedAt);
      const subject = record(operation.subject, ["kind", "connectionId"]);
      if (subject.kind !== "connection" || subject.connectionId !== connectionId) refuse();
      assertOrderPullPayloadStructure(operation.payload);
      if (
        operation.payload.connectionId !== connectionId ||
        operation.payload.pullId !== operation.pullId ||
        (await browserCheckpointDigest(operation.payload)) !== operation.payload.checkpointDigest ||
        (await browserPayloadDigest(operation.payload)) !== operation.payloadDigest
      )
        refuse();
      continue;
    }
    const operation = record(member, [
      "operationId",
      "attemptId",
      "claimGeneration",
      "connectionId",
      "providerIdentity",
      "channelListingId",
      "listingId",
      "operationKind",
      "listingRevision",
      "desiredStateSequence",
      "payload",
      "payloadDigest",
      "sourceOccurredAt",
      "enqueuedAt",
    ]);
    for (const key of ["operationId", "attemptId", "channelListingId", "listingId"]) identifier(operation[key]);
    if (
      operation.connectionId !== connectionId ||
      canonicalJson(operation.providerIdentity) !== canonicalJson(row.providerIdentity) ||
      ids.has(operation.operationId as string)
    )
      refuse();
    ids.add(operation.operationId as string);
    positive(operation.claimGeneration);
    positive(operation.listingRevision);
    positive(operation.desiredStateSequence);
    instant(operation.sourceOccurredAt);
    instant(operation.enqueuedAt);
    digest(operation.payloadDigest);
    payload(operation.payload, operation.operationKind);
    if (
      operation.payload.kind === "draft" &&
      (operation.payload.draft.channelListingId !== operation.channelListingId ||
        operation.payload.draft.listingRevision !== operation.listingRevision)
    )
      refuse();
    if ((await browserPayloadDigest(operation.payload)) !== operation.payloadDigest) refuse();
  }
  return structuredClone(row) as ClaimedOperationReservation<ClaimedSubjectOperation>;
}
export function assertTotalResult(result: ExecutorResult, members: readonly OperationAttempt[]): void {
  parseExecutorResult(result);
  if (result.outcomes.length !== members.length) refuse();
  for (const member of members) {
    const outcome = result.outcomes.find((candidate) => candidate.operationId === member.operationId);
    if (!outcome || outcome.attemptId !== member.attemptId || outcome.claimGeneration !== member.claimGeneration)
      refuse();
    if (member.operationKind === "tcgplayer-order-pull") {
      if (!("operationKind" in outcome) || outcome.payloadDigest !== member.payloadDigest) refuse();
      assertHandoffOutcome(outcome, member.payload, member.handoff);
    } else if ("operationKind" in outcome || outcome.desiredStateSequence !== member.desiredStateSequence) refuse();
  }
}
export function nextRevision(revision: number): number {
  if (!safeRevision(revision) || revision === Number.MAX_SAFE_INTEGER)
    throw new OperationProtocolError("incomplete-authority");
  return revision + 1;
}
