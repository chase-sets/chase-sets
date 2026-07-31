import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  csatOutcomeFactSchemaVersion,
  isCsatWorkflowOutcomeCode,
  sourceContextForOutcomeCode,
  type CsatOutcomeFactV1,
  type OutcomeSubjectKind,
} from "@chase-sets/customer-feedback/server";
import { nowIsoUtcTimestamp, parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { EventId } from "@chase-sets/primitives/typed-ids";

export const IDENTITY_CSAT_OUTCOME_FACT_EVENT_TYPE = "identity.csat-outcome-fact.published" as const;

type PublishCsatOutcomeFactInput = Readonly<{
  outcomeCode: string;
  subjectAccountId: string;
  subjectKind: OutcomeSubjectKind;
  subject: CsatOutcomeFactV1["subject"];
  idempotencyKey: string;
  outcomeOccurredAt?: string;
  correlationId?: string | null;
}>;

function stableEventId(idempotencyKey: string): EventId {
  return `evt_csat_${createHash("sha256").update(idempotencyKey).digest("hex")}` as EventId;
}

function stableStreamId(idempotencyKey: string) {
  return `identity.csat-outcome-fact-${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

export async function publishIdentityCsatOutcomeFact(
  eventStore: EventStore,
  context: EventStoreContext,
  input: PublishCsatOutcomeFactInput,
): Promise<CsatOutcomeFactV1> {
  const outcomeCode = input.outcomeCode.trim();
  if (!isCsatWorkflowOutcomeCode(outcomeCode)) {
    throw new Error(`Unsupported CSAT workflow outcome code '${outcomeCode}'.`);
  }
  if (sourceContextForOutcomeCode(outcomeCode) !== "identity") {
    throw new Error(`CSAT workflow outcome code '${outcomeCode}' is not owned by identity.`);
  }
  if (!input.subjectAccountId.trim() || !input.subject.entityId.trim() || !input.idempotencyKey.trim()) {
    throw new Error("CSAT outcome facts require server-derived account, subject, and idempotency references.");
  }

  const outcomeOccurredAt = parseIsoUtcTimestamp(input.outcomeOccurredAt ?? nowIsoUtcTimestamp());
  const fact: CsatOutcomeFactV1 = {
    factSchemaVersion: csatOutcomeFactSchemaVersion,
    outcomeCode,
    sourceContext: "identity",
    subjectAccountId: input.subjectAccountId,
    subjectKind: input.subjectKind,
    subject: input.subject,
    outcomeOccurredAt,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId ?? context.trace?.traceId ?? null,
  };

  const streamId = stableStreamId(input.idempotencyKey);
  try {
    await eventStore.appendToStream({
      streamId,
      expectedVersion: "any",
      events: [
        {
          eventId: stableEventId(input.idempotencyKey),
          eventType: IDENTITY_CSAT_OUTCOME_FACT_EVENT_TYPE,
          payload: fact,
          occurredAt: outcomeOccurredAt,
        },
      ],
      context,
    });
  } catch (error) {
    if (isConcurrencyConflict(error)) {
      // @stream-read-contract bounded-contexts/identity/support/request-support/csat-outcome-facts.test.ts
      const existing = await eventStore.readStream({ streamId, limit: 1 });
      const payload = existing[0]?.payload;
      if (existing[0]?.eventType === IDENTITY_CSAT_OUTCOME_FACT_EVENT_TYPE && isSameOutcome(payload, fact)) {
        return payload as CsatOutcomeFactV1;
      }
    }
    throw error;
  }

  return fact;
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}

function isSameOutcome(payload: unknown, fact: CsatOutcomeFactV1): payload is CsatOutcomeFactV1 {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "idempotencyKey" in payload &&
    payload.idempotencyKey === fact.idempotencyKey
  );
}
