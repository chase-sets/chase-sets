import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  csatOutcomeFactSchemaVersion,
  isCsatWorkflowOutcomeCode,
  sourceContextForOutcomeCode,
  type CsatOutcomeFactV1,
} from "@chase-sets/customer-feedback/server";
import { nowIsoUtcTimestamp, parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { EventId } from "@chase-sets/primitives/typed-ids";

export const AUTH_CSAT_OUTCOME_FACT_EVENT_TYPE = "auth.csat-outcome-fact.published" as const;

export async function publishAuthenticationCsatOutcomeFact(
  eventStore: EventStore,
  context: EventStoreContext,
  input: Readonly<{
    subjectAccountId: string;
    sessionId: string;
    outcomeOccurredAt?: string;
    correlationId?: string | null;
  }>,
): Promise<CsatOutcomeFactV1> {
  const outcomeCode = "authentication.completed";
  if (!isCsatWorkflowOutcomeCode(outcomeCode)) {
    throw new Error(`Unsupported CSAT workflow outcome code '${outcomeCode}'.`);
  }
  if (sourceContextForOutcomeCode(outcomeCode) !== "auth") {
    throw new Error(`CSAT workflow outcome code '${outcomeCode}' is not owned by auth.`);
  }
  if (!input.subjectAccountId.trim() || !input.sessionId.trim()) {
    throw new Error("Authentication CSAT outcome facts require server-derived account and session references.");
  }

  const idempotencyKey = `auth:authentication:${input.sessionId}`;
  const outcomeOccurredAt = parseIsoUtcTimestamp(input.outcomeOccurredAt ?? nowIsoUtcTimestamp());
  const fact: CsatOutcomeFactV1 = {
    factSchemaVersion: csatOutcomeFactSchemaVersion,
    outcomeCode,
    sourceContext: "auth",
    subjectAccountId: input.subjectAccountId,
    subjectKind: "account",
    subject: { entityType: "session", entityId: input.sessionId },
    outcomeOccurredAt,
    idempotencyKey,
    correlationId: input.correlationId ?? context.trace?.traceId ?? null,
  };
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");

  const streamId = `auth.csat-outcome-fact-${digest}`;
  try {
    await eventStore.appendToStream({
      streamId,
      expectedVersion: "any",
      events: [
        {
          eventId: `evt_csat_${digest}` as EventId,
          eventType: AUTH_CSAT_OUTCOME_FACT_EVENT_TYPE,
          payload: fact,
          occurredAt: outcomeOccurredAt,
        },
      ],
      context,
    });
  } catch (error) {
    if (isConcurrencyConflict(error)) {
      const existing = await eventStore.readStream({ streamId, limit: 1 });
      const payload = existing[0]?.payload;
      if (existing[0]?.eventType === AUTH_CSAT_OUTCOME_FACT_EVENT_TYPE && isSameOutcome(payload, fact)) {
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
