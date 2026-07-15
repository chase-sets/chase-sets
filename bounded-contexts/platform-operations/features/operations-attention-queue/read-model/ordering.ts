// Operations attention-queue ordering policy — the operator analog of the Seller
// Desk attention-queue ordering. Nothing tells a platform operator "here is
// everything that needs you, most important first"; the signals exist but are
// buried across the projection console, the support queue, and the feedback
// review routes. This module owns the shared vocabulary the operations queue
// read model and its home surface both consume: the source registry, the
// per-source severity ceiling, the deep-link target for each source, and the
// single total ordering. Modeled deliberately parallel to
// `@chase-sets/seller-desk`'s attention policy so the two "what needs me"
// surfaces cannot drift in behaviour, while owning the operator-specific sources
// (blocked streams, poison events, stalled wake jobs, support deadlines,
// unreviewed feedback) this platform surface aggregates.
//
// Pure data and pure functions only — no React, no fetch, no environment reads —
// so the ordering and the source registry are unit-testable in isolation.

export type OperationsAttentionSeverity = "critical" | "warning" | "info";

// Higher rank sorts first. Explicit (not union order) so the contract is legible.
export const OPERATIONS_ATTENTION_SEVERITY_RANK: Readonly<Record<OperationsAttentionSeverity, number>> = {
  critical: 3,
  warning: 2,
  info: 1,
};

// The operator-facing sources this queue composes. Each is owned by an existing
// platform-operations slice; this queue only re-homes their signals into one
// "needs you" surface.
export type OperationsAttentionSourceId =
  | "projection-poison-event"
  | "projection-blocked-stream"
  | "wake-stalled-job"
  | "support-request-deadline"
  | "platform-feedback-unreviewed";

// The thing that needs an operator's attention.
export type OperationsAttentionEntity =
  | "poison-event"
  | "blocked-stream"
  | "wake-job"
  | "support-request"
  | "platform-feedback";

// The existing admin surface an item routes to, opened in one click.
export type OperationsAttentionSurfaceId = "projection-operations" | "support-operations" | "platform-feedback";

export type OperationsAttentionSourceDescriptor = Readonly<{
  id: OperationsAttentionSourceId;
  // The platform-operations slice that owns the underlying read model.
  ownerSlice: string;
  entity: OperationsAttentionEntity;
  // The admin surface an item deep-links to.
  surface: OperationsAttentionSurfaceId;
  // The highest severity this source may raise.
  peakSeverity: OperationsAttentionSeverity;
  // The operator permission required to see this source's items. RBAC is
  // enforced by omitting a source the operator cannot view, so a viewer never
  // sees work they lack authority to reach.
  requiredPermission: string;
  // Builds the one-click deep link into the owning surface for an entity.
  buildHref: (entityId: string) => string;
}>;

export const OPERATIONS_ATTENTION_SOURCES: readonly OperationsAttentionSourceDescriptor[] = [
  {
    id: "projection-poison-event",
    ownerSlice: "projection-operations",
    entity: "poison-event",
    surface: "projection-operations",
    peakSeverity: "critical",
    requiredPermission: "projection-operations.view",
    buildHref: () => "/projections?tab=blocked",
  },
  {
    id: "projection-blocked-stream",
    ownerSlice: "projection-operations",
    entity: "blocked-stream",
    surface: "projection-operations",
    peakSeverity: "warning",
    requiredPermission: "projection-operations.view",
    buildHref: () => "/projections?tab=blocked",
  },
  {
    id: "wake-stalled-job",
    ownerSlice: "projection-operations",
    entity: "wake-job",
    surface: "projection-operations",
    peakSeverity: "critical",
    requiredPermission: "projection-operations.view",
    buildHref: () => "/projections?tab=wake",
  },
  {
    id: "support-request-deadline",
    ownerSlice: "support-requests",
    entity: "support-request",
    surface: "support-operations",
    peakSeverity: "critical",
    requiredPermission: "support.manage",
    buildHref: (entityId) => `/requests?requestId=${encodeURIComponent(entityId)}`,
  },
  {
    id: "platform-feedback-unreviewed",
    ownerSlice: "platform-feedback",
    entity: "platform-feedback",
    surface: "platform-feedback",
    peakSeverity: "info",
    requiredPermission: "platform-feedback.view",
    buildHref: (entityId) => `/platform-feedback/${encodeURIComponent(entityId)}`,
  },
] as const;

// Tiebreak priority for items of equal severity and deadline. Data integrity
// (a poisoned or blocked projection) and stalled wake work outrank an unreviewed
// feedback note — the policy the operator surface presents.
export const OPERATIONS_ATTENTION_SOURCE_PRIORITY: Readonly<Record<OperationsAttentionSourceId, number>> = {
  "projection-poison-event": 5,
  "projection-blocked-stream": 4,
  "wake-stalled-job": 3,
  "support-request-deadline": 2,
  "platform-feedback-unreviewed": 1,
};

export function operationsAttentionSourceById(
  sourceId: OperationsAttentionSourceId,
): OperationsAttentionSourceDescriptor | undefined {
  return OPERATIONS_ATTENTION_SOURCES.find((source) => source.id === sourceId);
}

// The minimal ordering key each item carries. Structurally compatible with the
// full item shape; the comparator reads only these fields.
export type OperationsAttentionOrderInput = Readonly<{
  severity: OperationsAttentionSeverity;
  source: OperationsAttentionSourceId;
  // ISO-8601 UTC deadline; items with a deadline outrank those without.
  dueAt?: string | null;
  // ISO-8601 UTC time the work first needed attention.
  observedAt: string;
}>;

function toTime(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// The canonical operations attention ordering. Deterministic and total:
//   1. severity rank, descending (critical first);
//   2. presence of a deadline (dated items first), then soonest deadline first;
//   3. source priority, descending (data integrity ahead of feedback);
//   4. oldest `observedAt` first (the work that has waited longest);
//   5. source id, so ties resolve stably.
export function compareOperationsAttentionItems(
  a: OperationsAttentionOrderInput,
  b: OperationsAttentionOrderInput,
): number {
  const severityDelta = OPERATIONS_ATTENTION_SEVERITY_RANK[b.severity] - OPERATIONS_ATTENTION_SEVERITY_RANK[a.severity];
  if (severityDelta !== 0) {
    return severityDelta;
  }

  const aDue = toTime(a.dueAt);
  const bDue = toTime(b.dueAt);
  if (aDue !== bDue) {
    if (aDue === null) {
      return 1;
    }
    if (bDue === null) {
      return -1;
    }
    return aDue - bDue;
  }

  const priorityDelta = OPERATIONS_ATTENTION_SOURCE_PRIORITY[b.source] - OPERATIONS_ATTENTION_SOURCE_PRIORITY[a.source];
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const aObserved = toTime(a.observedAt) ?? 0;
  const bObserved = toTime(b.observedAt) ?? 0;
  if (aObserved !== bObserved) {
    return aObserved - bObserved;
  }

  return a.source.localeCompare(b.source, "en");
}
