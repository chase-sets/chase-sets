import type { CommandHandler } from "@chase-sets/event-core/command-handler";
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
  status: "ignored" | "unmatched" | "duplicate" | "recorded";
  providerEventId: string;
  returnShipmentId: string | null;
  processingResult: string;
}>;

export type ReturnShipmentTrackingIngestionDeps = Readonly<{
  db: PgQueryable;
  commandHandler: CommandHandler<ReturnShipmentCommand, ReturnShipmentState, ReturnShipmentEvent>;
  streamIdFor: (returnShipmentId: string) => string;
}>;

async function hasProcessedReturnTrackingEvent(db: PgQueryable, providerEventId: string): Promise<boolean> {
  const result = await db.query<{ provider_event_id: string }>(
    `SELECT provider_event_id
     FROM fulfillment_return_shipment_provider_events
     WHERE provider_event_id = $1
       AND processing_result <> 'unmatched'
     LIMIT 1`,
    [providerEventId],
  );
  return result.rows.length > 0;
}

async function recordProcessedReturnTrackingEvent(
  db: PgQueryable,
  event: PostageProviderWebhookEvent,
  match: ReturnShipmentTrackingMatch | null,
  semantic: ReturnShipmentTrackingSemantic,
  processingResult: string,
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
         payload_json = EXCLUDED.payload_json`,
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

  if (await hasProcessedReturnTrackingEvent(deps.db, event.providerEventId)) {
    return {
      status: "duplicate",
      providerEventId: event.providerEventId,
      returnShipmentId: null,
      processingResult: "duplicate",
    };
  }

  const match = await findReturnShipmentForTracking(deps.db, {
    trackingIdentifier: event.trackingIdentifier,
    providerShipmentId: event.providerShipmentId,
  });
  const semantic = classifyReturnShipmentTrackingStatus(event.status, event.statusDetail);

  if (!match) {
    await recordProcessedReturnTrackingEvent(deps.db, event, null, semantic, "unmatched");
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

  await recordProcessedReturnTrackingEvent(deps.db, event, match, semantic, processingResult);
  return {
    status: "recorded",
    providerEventId: event.providerEventId,
    returnShipmentId: match.return_shipment_id,
    processingResult,
  };
}
