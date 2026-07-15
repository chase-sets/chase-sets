// Operations attention-queue sources — the pure mappers that turn each owning
// slice's read-model rows into shared attention items. They accept structural
// inputs (only the fields they read) so this read model never imports another
// slice; the composition root adapts the concrete rows. Every mapper is a pure
// function of its rows plus the evaluation context, so severity, deadline, and
// summary decisions are unit-testable without a database or the wall clock.

import {
  buildOperationsAttentionItem,
  type OperationsAttentionContext,
  type OperationsAttentionItem,
} from "./attention-queue";
import {
  OPERATIONS_ATTENTION_SOURCES,
  type OperationsAttentionSourceDescriptor,
  type OperationsAttentionSourceId,
} from "./ordering";

// RBAC: the sources an operator may see, given their permissions. A source the
// operator cannot view is omitted from the queue entirely, so a viewer never
// sees work they lack authority to reach.
export function operationsAttentionSourcesForPermissions(
  permissions: readonly string[],
): readonly OperationsAttentionSourceDescriptor[] {
  const granted = new Set(permissions);
  return OPERATIONS_ATTENTION_SOURCES.filter((source) => granted.has(source.requiredPermission));
}

export function canViewOperationsAttentionSource(
  sourceId: OperationsAttentionSourceId,
  permissions: readonly string[],
): boolean {
  const descriptor = OPERATIONS_ATTENTION_SOURCES.find((source) => source.id === sourceId);
  return descriptor !== undefined && permissions.includes(descriptor.requiredPermission);
}

function isoOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

// ---------------------------------------------------------------------------
// Projection poison events — a failed event application stuck for operator
// diagnosis. Critical: the stream cannot advance past it until resolved.
// ---------------------------------------------------------------------------

export type PoisonEventInput = Readonly<{
  projectionKey: string;
  eventId: string;
  eventType: string;
  streamId: string;
  retryCount: number;
  firstSeenAt: string;
}>;

export function mapPoisonEventsToItems(
  events: readonly PoisonEventInput[],
  context: OperationsAttentionContext,
): readonly OperationsAttentionItem[] {
  return events.map((event) =>
    buildOperationsAttentionItem({
      source: "projection-poison-event",
      entityId: event.eventId,
      severity: "critical",
      summary: {
        code: "poisonEvent",
        params: { eventType: event.eventType, projectionKey: event.projectionKey, retryCount: event.retryCount },
      },
      observedAt: isoOrNull(event.firstSeenAt) ?? context.now,
    }),
  );
}

// ---------------------------------------------------------------------------
// Projection blocked streams — a stream deferring events until a retry or
// rebuild lets that projection continue it. Warning: throughput is degraded but
// not corrupted.
// ---------------------------------------------------------------------------

export type BlockedStreamInput = Readonly<{
  projectionKey: string;
  streamId: string;
  deferredEventCount: number;
}>;

export function mapBlockedStreamsToItems(
  streams: readonly BlockedStreamInput[],
  context: OperationsAttentionContext,
): readonly OperationsAttentionItem[] {
  return streams.map((stream) =>
    buildOperationsAttentionItem({
      source: "projection-blocked-stream",
      entityId: `${stream.projectionKey}:${stream.streamId}`,
      severity: "warning",
      summary: {
        code: "blockedStream",
        params: { projectionKey: stream.projectionKey, deferredEventCount: stream.deferredEventCount },
      },
      // A blocked stream carries no first-blocked timestamp in the read model;
      // it is currently blocked, so the evaluation instant is its age anchor.
      observedAt: context.now,
    }),
  );
}

// ---------------------------------------------------------------------------
// Stalled / failed wake jobs — the wake store's intent tallies. Each non-zero
// tally becomes one summarizing item carrying its count.
// ---------------------------------------------------------------------------

export type WakeStoreInput = Readonly<{
  failedCount: number;
  staleClaimCount: number;
  expiredCount: number;
  oldestQueuedAt: string | null;
  oldestClaimedAt: string | null;
  generatedAt: string;
}>;

export function mapWakeStoreToItems(
  store: WakeStoreInput,
  context: OperationsAttentionContext,
): readonly OperationsAttentionItem[] {
  const observedAt =
    isoOrNull(store.oldestClaimedAt) ?? isoOrNull(store.oldestQueuedAt) ?? isoOrNull(store.generatedAt) ?? context.now;
  const items: OperationsAttentionItem[] = [];

  if (store.failedCount > 0) {
    items.push(
      buildOperationsAttentionItem({
        source: "wake-stalled-job",
        entityId: "failed-intents",
        severity: "critical",
        summary: { code: "wakeFailed", params: { count: store.failedCount } },
        observedAt,
        count: store.failedCount,
      }),
    );
  }

  if (store.staleClaimCount > 0) {
    items.push(
      buildOperationsAttentionItem({
        source: "wake-stalled-job",
        entityId: "stale-claims",
        severity: "warning",
        summary: { code: "wakeStaleClaims", params: { count: store.staleClaimCount } },
        observedAt,
        count: store.staleClaimCount,
      }),
    );
  }

  if (store.expiredCount > 0) {
    items.push(
      buildOperationsAttentionItem({
        source: "wake-stalled-job",
        entityId: "expired-intents",
        severity: "warning",
        summary: { code: "wakeExpired", params: { count: store.expiredCount } },
        observedAt,
        count: store.expiredCount,
      }),
    );
  }

  return items;
}

// ---------------------------------------------------------------------------
// Support requests — the operator support queue ordered by its own deadlines.
// A request whose earliest deadline has passed is critical; one still within
// its window (or held open with no clock) is a warning.
// ---------------------------------------------------------------------------

export type SupportRequestInput = Readonly<{
  support_request_id: string;
  display_reference: string;
  seller_response_due_at: string | null;
  support_review_due_at: string | null;
  seller_condition_attestation_due_at: string | null;
  updated_at: string;
  case_presentation?: string;
}>;

function earliestDeadline(request: SupportRequestInput): string | null {
  const candidates = [
    isoOrNull(request.seller_response_due_at),
    isoOrNull(request.support_review_due_at),
    isoOrNull(request.seller_condition_attestation_due_at),
  ].filter((value): value is string => value !== null);
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((earliest, candidate) =>
    Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest,
  );
}

export function mapSupportRequestsToItems(
  requests: readonly SupportRequestInput[],
  context: OperationsAttentionContext,
): readonly OperationsAttentionItem[] {
  const nowMs = Date.parse(context.now);
  return requests.map((request) => {
    const dueAt = earliestDeadline(request);
    const overdue = (dueAt !== null && Date.parse(dueAt) <= nowMs) || request.case_presentation === "action-required";
    return buildOperationsAttentionItem({
      source: "support-request-deadline",
      entityId: request.support_request_id,
      severity: overdue ? "critical" : "warning",
      summary: { code: "supportRequest", params: { reference: request.display_reference } },
      observedAt: isoOrNull(request.updated_at) ?? context.now,
      dueAt,
    });
  });
}

// ---------------------------------------------------------------------------
// Unreviewed platform feedback — submissions still awaiting operator review.
// Informational: worth reading, never blocking.
// ---------------------------------------------------------------------------

export type PlatformFeedbackInput = Readonly<{
  feedback_id: string;
  topic: string;
  submitted_at: string;
}>;

export function mapPlatformFeedbackToItems(
  feedback: readonly PlatformFeedbackInput[],
  context: OperationsAttentionContext,
): readonly OperationsAttentionItem[] {
  return feedback.map((entry) =>
    buildOperationsAttentionItem({
      source: "platform-feedback-unreviewed",
      entityId: entry.feedback_id,
      severity: "info",
      summary: { code: "feedbackUnreviewed", params: { topic: entry.topic } },
      observedAt: isoOrNull(entry.submitted_at) ?? context.now,
    }),
  );
}
