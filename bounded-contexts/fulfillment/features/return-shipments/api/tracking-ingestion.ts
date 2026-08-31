import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createHash, randomUUID } from "node:crypto";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PostageProviderWebhookEvent } from "@chase-sets/postage-labels";
import type { ReturnShipmentExceptionType } from "../domain/common";
import type { ReturnShipmentCommand, ReturnShipmentEvent, ReturnShipmentState } from "../domain/domain";
import { findReturnShipmentForTracking, type ReturnShipmentTrackingMatch } from "../read-model/queries";

/**
 * The semantic reverse-tracking milestone a normalized carrier status maps to.
 *
 * The carrier's raw provider status is deliberately collapsed to a small, explicit
 * vocabulary. Ambiguous or unrecognized statuses map to `ignored` rather than being
 * mapped optimistically onto a custody advance — an unknown scan must never advance
 * custody or satisfy a refund trigger. `carrier-accepted` is only reachable from a
 * possession/acceptance scan, never from label creation (which is not a tracking
 * event at all), so label issuance can never satisfy a carrier-acceptance trigger.
 */
export type ReturnShipmentTrackingSemantic =
  | Readonly<{ kind: "carrier-accepted" }>
  | Readonly<{ kind: "in-transit" }>
  | Readonly<{ kind: "delivered" }>
  | Readonly<{ kind: "exception"; exceptionType: ReturnShipmentExceptionType }>
  | Readonly<{ kind: "ignored" }>;

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Classifies a normalized carrier status/detail into a reverse-tracking milestone.
 * Exception detection is checked before optimistic custody advances so a "delivered
 * but damaged" or "held" scan raises an exception instead of silently maturing the
 * custody chain.
 */
export function classifyReturnShipmentTrackingStatus(
  rawStatus: string | null | undefined,
  rawDetail: string | null | undefined,
): ReturnShipmentTrackingSemantic {
  const status = normalize(rawStatus);
  const detail = normalize(rawDetail);

  // A bounced return (buyer → platform label that could not be delivered) is an
  // exception, not a delivery.
  if (status === "return_to_sender" || detail.includes("return to sender")) {
    return { kind: "exception", exceptionType: "delivery-failed" };
  }

  if (isExceptionStatus(status, detail)) {
    return { kind: "exception", exceptionType: classifyReturnException(status, detail) };
  }

  if (status === "delivered") {
    return { kind: "delivered" };
  }

  if (
    status === "accepted" ||
    status === "acceptance" ||
    status === "picked_up" ||
    status === "pickup" ||
    status === "pre_transit" ||
    detail.includes("accepted") ||
    detail.includes("picked up") ||
    detail.includes("possession")
  ) {
    return { kind: "carrier-accepted" };
  }

  if (status === "in_transit" || status === "out_for_delivery" || status === "available_for_pickup") {
    return { kind: "in-transit" };
  }

  return { kind: "ignored" };
}

function isExceptionStatus(status: string, detail: string): boolean {
  return (
    status === "failure" ||
    status === "error" ||
    status === "exception" ||
    detail.includes("lost") ||
    detail.includes("damage") ||
    detail.includes("exception") ||
    detail.includes("unable") ||
    detail.includes("delayed") ||
    detail.includes("undeliverable") ||
    detail.includes("refused") ||
    detail.includes("held")
  );
}

function classifyReturnException(status: string, detail: string): ReturnShipmentExceptionType {
  if (detail.includes("lost")) {
    return "lost-in-transit";
  }
  if (detail.includes("damage")) {
    return "damaged-in-transit";
  }
  if (detail.includes("undeliverable") || detail.includes("refused") || detail.includes("unable")) {
    return "delivery-failed";
  }
  if (detail.includes("delay") || detail.includes("held") || status === "failure") {
    return "carrier-delay";
  }
  return "other";
}

/** Deterministic idempotency key: one provider tracking event is applied at most once. */
export function returnTrackingIdempotencyKey(providerEventId: string): string {
  return `return-tracking:${providerEventId}`;
}

/**
 * Builds the domain command for a classified milestone, correlated to the reverse
 * shipment's remedy. Returns `null` for an ignored status. The command carries
 * fact metadata correlated to the shipment's remedy so the aggregate accepts it;
 * the aggregate's own monotonic stage guard then discards duplicate or out-of-order
 * scans, so this adapter never has to reason about ordering itself.
 */
export function buildReturnShipmentTrackingCommand(
  semantic: ReturnShipmentTrackingSemantic,
  input: Readonly<{
    match: ReturnShipmentTrackingMatch;
    providerEventId: string;
    occurredAt: string;
    detail: string | null;
  }>,
): ReturnShipmentCommand | null {
  const metadata = {
    correlationRemedyId: input.match.remedy_id as never,
    causationId: input.providerEventId,
    idempotencyKey: returnTrackingIdempotencyKey(input.providerEventId),
    policyVersion: input.match.policy_version,
  };
  switch (semantic.kind) {
    case "carrier-accepted":
      return {
        type: "RecordReturnShipmentCarrierAccepted",
        detail: input.detail,
        metadata,
        occurredAt: input.occurredAt,
      };
    case "in-transit":
      return { type: "RecordReturnShipmentInTransit", detail: input.detail, metadata, occurredAt: input.occurredAt };
    case "delivered":
      return { type: "RecordReturnShipmentDelivered", detail: input.detail, metadata, occurredAt: input.occurredAt };
    case "exception":
      return {
        type: "RaiseReturnShipmentException",
        exceptionType: semantic.exceptionType,
        notes: input.detail,
        metadata,
        raisedAt: input.occurredAt,
      };
    case "ignored":
      return null;
  }
}

export type ReturnShipmentTrackingIngestionResult = Readonly<{
  status: "ignored" | "unmatched" | "duplicate" | "recorded" | "quarantined";
  providerEventId: string;
  returnShipmentId: string | null;
  processingResult: string;
}>;

export type ReturnShipmentTrackingIngestionDeps = Readonly<{
  db: PgQueryable;
  commandHandler: CommandHandler<ReturnShipmentCommand, ReturnShipmentState, ReturnShipmentEvent>;
  streamIdFor: (returnShipmentId: string) => string;
}>;

function compareCodePointStrings(left: string, right: string) {
  const leftCodePoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightCodePoints = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftCodePoints.length, rightCodePoints.length); index += 1) {
    const difference = leftCodePoints[index]! - rightCodePoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Return tracking payload contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodePointStrings(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Return tracking payload contains an unsupported value.");
}

function returnTrackingPayloadHash(event: PostageProviderWebhookEvent) {
  const required = {
    providerEventId: event.providerEventId,
    providerName: event.providerName,
    providerMode: event.providerMode,
    eventKind: event.eventKind,
    providerObjectReference: event.providerObjectReference,
    occurredAt: event.occurredAt,
  };
  for (const [field, value] of Object.entries(required)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Return tracking ${field} must be a non-empty normalized string.`);
    }
  }
  if (Number.isNaN(new Date(event.occurredAt).getTime())) {
    throw new Error("Return tracking occurredAt must be a normalized timestamp.");
  }
  const optional = {
    providerShipmentId: event.providerShipmentId,
    trackingIdentifier: event.trackingIdentifier,
    status: event.status,
    statusDetail: event.statusDetail,
    message: event.message,
  };
  for (const [field, value] of Object.entries(optional)) {
    if (value !== null && value !== undefined && typeof value !== "string") {
      throw new Error(`Return tracking ${field} must be a normalized string or null.`);
    }
  }
  return createHash("sha256")
    .update(
      `return-tracking-webhook/v1\n${canonicalJson({
        providerName: event.providerName,
        providerMode: event.providerMode,
        eventKind: event.eventKind,
        providerObjectReference: event.providerObjectReference,
        providerShipmentId: event.providerShipmentId ?? null,
        trackingIdentifier: event.trackingIdentifier ?? null,
        status: event.status ?? null,
        statusDetail: event.statusDetail ?? null,
        message: event.message ?? null,
        occurredAt: event.occurredAt,
      })}`,
    )
    .digest("hex");
}

async function reserveReturnTrackingEvent(db: PgQueryable, event: PostageProviderWebhookEvent) {
  const payloadHash = returnTrackingPayloadHash(event);
  const result = await db.query<{
    payload_hash: string | null;
    handoff_state: string;
    processing_result: string;
    inserted: boolean;
  }>(
    `WITH inserted AS (
       INSERT INTO fulfillment_return_shipment_provider_events (
         provider_event_id, provider_name, provider_mode, event_kind, provider_object_reference,
         return_shipment_id, tracking_identifier, status, status_detail, semantic_milestone,
         occurred_at, received_at, processing_result, payload_json, payload_hash, handoff_state
       ) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,NULL,$9,$10,'reserved',$11::jsonb,$12,'reserved')
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING payload_hash, handoff_state, processing_result, true AS inserted
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT payload_hash, handoff_state, processing_result, false AS inserted
     FROM fulfillment_return_shipment_provider_events
     WHERE provider_event_id = $1 AND NOT EXISTS (SELECT 1 FROM inserted)`,
    [
      event.providerEventId,
      event.providerName,
      event.providerMode,
      event.eventKind,
      event.providerObjectReference,
      event.trackingIdentifier ?? null,
      event.status ?? null,
      event.statusDetail ?? null,
      event.occurredAt,
      event.receivedAt ?? new Date().toISOString(),
      JSON.stringify(event.payload ?? {}),
      payloadHash,
    ],
  );
  const receipt = result.rows[0];
  if (!receipt) throw new Error("Return tracking receipt reservation failed.");
  return { ...receipt, payloadHash };
}

async function recordProcessedReturnTrackingEvent(
  db: PgQueryable,
  event: PostageProviderWebhookEvent,
  match: ReturnShipmentTrackingMatch | null,
  semantic: ReturnShipmentTrackingSemantic,
  processingResult: string,
  payloadHash: string,
  claimToken: string,
): Promise<void> {
  await db.query(
    `INSERT INTO fulfillment_return_shipment_provider_events (
       provider_event_id, provider_name, provider_mode, event_kind, provider_object_reference,
       return_shipment_id, tracking_identifier, status, status_detail, semantic_milestone,
       occurred_at, received_at, processing_result, payload_json
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::timestamptz, $13, $14::jsonb)
     ON CONFLICT (provider_event_id) DO UPDATE
     SET return_shipment_id = EXCLUDED.return_shipment_id,
         status = EXCLUDED.status,
         status_detail = EXCLUDED.status_detail,
         semantic_milestone = EXCLUDED.semantic_milestone,
         processing_result = EXCLUDED.processing_result,
         payload_json = EXCLUDED.payload_json,
         handoff_state = CASE WHEN EXCLUDED.processing_result = 'unmatched' THEN 'unmatched' ELSE 'completed' END,
         claim_token = NULL,
         claim_expires_at = NULL
     WHERE fulfillment_return_shipment_provider_events.payload_hash = $15
       AND fulfillment_return_shipment_provider_events.claim_token = $16`,
    [
      event.providerEventId,
      event.providerName,
      event.providerMode,
      event.eventKind,
      event.providerObjectReference,
      match?.return_shipment_id ?? null,
      event.trackingIdentifier ?? null,
      event.status ?? null,
      event.statusDetail ?? null,
      semantic.kind,
      event.occurredAt,
      event.receivedAt ?? new Date().toISOString(),
      processingResult,
      JSON.stringify(event.payload ?? {}),
      payloadHash,
      claimToken,
    ],
  );
}

/**
 * Ingests one normalized carrier tracking event for a reverse shipment.
 *
 * The same function backs both live provider webhooks and the scheduled
 * reconciliation/poll path: a poll re-emits an event with the same
 * `providerEventId`, so the provider-event dedup ledger and the aggregate's
 * monotonic custody guard together guarantee a milestone becomes a domain fact at
 * most once, no matter how many times a webhook or poll observes it. Events that
 * arrive before the return shipment's tracking identifier is projected are recorded
 * as `unmatched` and left retryable so a later poll repairs the miss.
 */
export async function processReturnShipmentTrackingEvent(
  deps: ReturnShipmentTrackingIngestionDeps,
  event: PostageProviderWebhookEvent,
  context: EventStoreContext,
): Promise<ReturnShipmentTrackingIngestionResult> {
  if (event.eventKind !== "tracking-status") {
    return {
      status: "ignored",
      providerEventId: event.providerEventId,
      returnShipmentId: null,
      processingResult: "not-tracking",
    };
  }

  const reservation = await reserveReturnTrackingEvent(deps.db, event);
  if (reservation.payload_hash !== reservation.payloadHash) {
    return {
      status: "quarantined",
      providerEventId: event.providerEventId,
      returnShipmentId: null,
      processingResult: "payload-hash-mismatch",
    };
  }
  if (!reservation.inserted && reservation.handoff_state === "completed") {
    return {
      status: "duplicate",
      providerEventId: event.providerEventId,
      returnShipmentId: null,
      processingResult: "duplicate",
    };
  }

  const claimToken = randomUUID();
  const now = new Date();
  const claim = await deps.db.query<{ provider_event_id: string }>(
    `UPDATE fulfillment_return_shipment_provider_events
     SET claim_token = $3, claim_generation = claim_generation + 1,
         claim_expires_at = $4, handoff_state = 'reserved'
     WHERE provider_event_id = $1 AND payload_hash = $2
       AND handoff_state IN ('reserved', 'unmatched')
       AND (claim_token IS NULL OR claim_expires_at <= $5)
     RETURNING provider_event_id`,
    [
      event.providerEventId,
      reservation.payloadHash,
      claimToken,
      new Date(now.getTime() + 60_000).toISOString(),
      now.toISOString(),
    ],
  );
  if (!claim.rows[0]) {
    return {
      status: "duplicate",
      providerEventId: event.providerEventId,
      returnShipmentId: null,
      processingResult: "pending",
    };
  }

  const match = await findReturnShipmentForTracking(deps.db, {
    trackingIdentifier: event.trackingIdentifier,
    providerShipmentId: event.providerShipmentId,
  });
  const semantic = classifyReturnShipmentTrackingStatus(event.status, event.statusDetail);

  if (!match) {
    await recordProcessedReturnTrackingEvent(
      deps.db,
      event,
      null,
      semantic,
      "unmatched",
      reservation.payloadHash,
      claimToken,
    );
    return {
      status: "unmatched",
      providerEventId: event.providerEventId,
      returnShipmentId: null,
      processingResult: "unmatched",
    };
  }

  const detail = event.statusDetail?.trim() || event.message?.trim() || null;
  const command = buildReturnShipmentTrackingCommand(semantic, {
    match,
    providerEventId: event.providerEventId,
    occurredAt: event.occurredAt,
    detail,
  });

  let processingResult = semantic.kind;
  if (command) {
    await deps.commandHandler({ streamId: deps.streamIdFor(match.return_shipment_id), command, context });
  } else {
    processingResult = "ignored";
  }

  await recordProcessedReturnTrackingEvent(
    deps.db,
    event,
    match,
    semantic,
    processingResult,
    reservation.payloadHash,
    claimToken,
  );
  return {
    status: "recorded",
    providerEventId: event.providerEventId,
    returnShipmentId: match.return_shipment_id,
    processingResult,
  };
}
