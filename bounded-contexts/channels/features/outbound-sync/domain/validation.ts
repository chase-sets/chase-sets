import { createHash } from "node:crypto";
import {
  assertChannelPublicationDraft,
  assertChannelPublicationResult,
} from "../../publication-port/domain/validation";
import {
  channelPublicationRejectionCodes,
  type ChannelPublicationResult,
} from "../../publication-port/domain/contracts";
import {
  OutboundSyncError,
  outboundClaimantKinds,
  outboundOperationKinds,
  type ClaimedOperationClaimant,
  type ClaimedOperationOutcome,
  type EnqueueOutboundOperation,
  type OutboundOperationPayload,
} from "./contracts";

export const OUTBOUND_CLAIM_LEASE_MIN_MS = 60_000;
export const OUTBOUND_CLAIM_LEASE_MAX_MS = 7_200_000;

export function assertOutboundClaimLeaseMs(value: unknown): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < OUTBOUND_CLAIM_LEASE_MIN_MS ||
    Number(value) > OUTBOUND_CLAIM_LEASE_MAX_MS
  ) {
    invalid(`leaseMs must be an integer from ${OUTBOUND_CLAIM_LEASE_MIN_MS} to ${OUTBOUND_CLAIM_LEASE_MAX_MS}.`);
  }
}

export function assertEnqueueOutboundOperation(
  value: unknown,
  assertDelistDirective: (value: unknown) => void,
): asserts value is EnqueueOutboundOperation {
  const input = closed(
    value,
    [
      "connectionId",
      "channelListingId",
      "listingId",
      "operationKind",
      "listingRevision",
      "desiredStateSequence",
      "desiredStateHash",
      "payload",
      "envelope",
    ],
    "outbound desired state",
  );
  opaque(input.connectionId, "connectionId");
  opaque(input.channelListingId, "channelListingId");
  opaque(input.listingId, "listingId");
  if (!outboundOperationKinds.includes(input.operationKind as never)) invalid("operationKind is invalid.");
  safePositive(input.listingRevision, "listingRevision");
  safePositive(input.desiredStateSequence, "desiredStateSequence");
  digest(input.desiredStateHash, "desiredStateHash");
  assertOutboundOperationPayload(
    input.payload,
    input.operationKind as EnqueueOutboundOperation["operationKind"],
    assertDelistDirective,
  );
  if (
    input.payload.kind === "draft" &&
    (input.payload.draft.channelListingId !== input.channelListingId ||
      input.payload.draft.listingRevision !== input.listingRevision)
  ) {
    invalid("draft identity must equal the desired-state identity.");
  }
  const envelope = closed(
    input.envelope,
    ["sourceEventId", "sourceStreamId", "sourceStreamVersion", "sourceGlobalPosition", "sourceOccurredAt"],
    "envelope",
  );
  opaque(envelope.sourceEventId, "sourceEventId");
  opaque(envelope.sourceStreamId, "sourceStreamId");
  safePositive(envelope.sourceStreamVersion, "sourceStreamVersion");
  if (envelope.sourceStreamVersion !== input.desiredStateSequence) {
    invalid("desiredStateSequence must equal the producer event stream version.");
  }
  if (typeof envelope.sourceGlobalPosition !== "string" || !/^(0|[1-9]\d*)$/.test(envelope.sourceGlobalPosition)) {
    invalid("sourceGlobalPosition is invalid.");
  }
  instant(envelope.sourceOccurredAt, "sourceOccurredAt");
}

export function assertOutboundOperationPayload(
  value: unknown,
  operationKind: "publish" | "update" | "delist",
  assertDelistDirective: (value: unknown) => void,
): asserts value is OutboundOperationPayload {
  const payload = closed(value, ["kind", "draft", "delist"], "payload");
  if (operationKind === "delist") {
    closed(payload, ["kind", "delist"], "payload");
    if (payload.kind !== "delist") invalid("delist operations require a delist payload.");
    assertDelistDirective(payload.delist);
    return;
  }
  closed(payload, ["kind", "draft"], "payload");
  if (payload.kind !== "draft") invalid("publish and update operations require a draft payload.");
  assertChannelPublicationDraft(payload.draft);
}

export function assertClaimedOperationClaimant(value: unknown): asserts value is ClaimedOperationClaimant {
  const claimant = closed(value, ["claimantKind", "claimantId"], "claimant");
  if (!outboundClaimantKinds.slice(1).includes(claimant.claimantKind as never)) invalid("claimantKind is invalid.");
  opaque(claimant.claimantId, "claimantId");
}

export function assertClaimedOperationOutcome(value: unknown): asserts value is ClaimedOperationOutcome {
  const report = closed(
    value,
    ["operationId", "attemptId", "claimGeneration", "desiredStateSequence", "outcome"],
    "claimed outcome",
  );
  opaque(report.operationId, "operationId");
  opaque(report.attemptId, "attemptId");
  safePositive(report.claimGeneration, "claimGeneration");
  safePositive(report.desiredStateSequence, "desiredStateSequence");
  const outcome = closed(report.outcome, ["kind", "result", "code", "reason"], "outcome");
  switch (outcome.kind) {
    case "applied":
      closed(outcome, ["kind", "result"], "outcome");
      assertChannelPublicationResult(outcome.result);
      if ((outcome.result as ChannelPublicationResult).kind !== "succeeded")
        invalid("applied requires a successful result.");
      return;
    case "rejected":
      closed(outcome, ["kind", "code"], "outcome");
      if (!channelPublicationRejectionCodes.includes(outcome.code as never)) invalid("rejection code is invalid.");
      return;
    case "outcome-unknown":
      closed(outcome, ["kind"], "outcome");
      return;
    case "abandoned":
      closed(outcome, ["kind", "reason"], "outcome");
      if (!["released", "superseded-basis", "claimant-cancelled"].includes(String(outcome.reason)))
        invalid("abandonment reason is invalid.");
      return;
    default:
      invalid("outcome kind is invalid.");
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  invalid("canonical JSON contains an unsupported value.");
}

export function payloadDigest(payload: OutboundOperationPayload): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function closed(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) if (!allowed.has(key)) invalid(`${label}.${key} is unknown.`);
  return record;
}

function opaque(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || !scalar(value))
    invalid(`${label} is invalid.`);
}

function safePositive(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(`${label} must be a positive safe integer.`);
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    invalid(`${label} must be a lowercase SHA-256 digest.`);
}

function instant(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    invalid(`${label} must be an RFC 3339 timezone-bearing instant.`);
}

function scalar(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}

function invalid(message: string): never {
  throw new OutboundSyncError("invalid-input", message);
}
