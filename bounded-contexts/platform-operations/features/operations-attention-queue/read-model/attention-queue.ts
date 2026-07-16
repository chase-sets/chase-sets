// Operations attention-queue read model — the transport-agnostic "what needs me"
// aggregation for the platform operator. Each owning slice's signals are mapped
// into the shared item shape defined here (see `sources.ts`); this module owns
// only the item shape, the aggregation, per-source degradation, and the rollup
// counts. The ordering and severity policy is `ordering.ts` — imported, never
// re-declared — so the queue and the policy cannot drift.

import {
  compareOperationsAttentionItems,
  OPERATIONS_ATTENTION_SEVERITY_RANK,
  OPERATIONS_ATTENTION_SOURCES,
  operationsAttentionSourceById,
  type OperationsAttentionEntity,
  type OperationsAttentionSeverity,
  type OperationsAttentionSourceId,
  type OperationsAttentionSurfaceId,
} from "./ordering";

export {
  compareOperationsAttentionItems,
  OPERATIONS_ATTENTION_SEVERITY_RANK,
  OPERATIONS_ATTENTION_SOURCES,
  type OperationsAttentionSeverity,
  type OperationsAttentionSourceId,
};

// A localization-ready descriptor. The read model stays presentation-free: it
// carries a stable semantic `code` (owned by the emitting source) plus typed
// interpolation `params`; the operator surface renders its own copy from the
// same code.
export type OperationsAttentionSummary = Readonly<{
  code: string;
  params: Readonly<Record<string, string | number>>;
}>;

// The forward step into the surface that resolves the work. `surface` is the
// owning admin surface; `href` is the concrete one-click link.
export type OperationsAttentionDeepLink = Readonly<{
  surface: OperationsAttentionSurfaceId;
  href: string;
}>;

export type OperationsAttentionItem = Readonly<{
  // Stable across reloads (`${source}:${entityId}`): dedupe, React keys.
  id: string;
  source: OperationsAttentionSourceId;
  entity: OperationsAttentionEntity;
  severity: OperationsAttentionSeverity;
  summary: OperationsAttentionSummary;
  deepLink: OperationsAttentionDeepLink;
  // Optional badge count when one item summarizes several occurrences (e.g. a
  // wake-store failed-intent tally).
  count?: number;
  // ISO-8601 UTC deadline; dated items outrank undated. `null` when the work has
  // no clock (a poisoned event has urgency but no deadline).
  dueAt: string | null;
  // ISO-8601 UTC time the work first needed attention; drives the age tiebreak.
  observedAt: string;
}>;

// ---------------------------------------------------------------------------
// Item construction — the one helper every source uses so id and deep link are
// derived identically and each emitted item is checked against its source's
// declared ceiling at the seam.
// ---------------------------------------------------------------------------

export type BuildOperationsAttentionItemInput = Readonly<{
  source: OperationsAttentionSourceId;
  entityId: string;
  severity: OperationsAttentionSeverity;
  summary: OperationsAttentionSummary;
  observedAt: string;
  dueAt?: string | null;
  count?: number;
}>;

export function buildOperationsAttentionItem(input: BuildOperationsAttentionItemInput): OperationsAttentionItem {
  const descriptor = operationsAttentionSourceById(input.source);
  if (descriptor === undefined) {
    throw new Error(`Unknown operations attention source: ${input.source}`);
  }
  if (
    OPERATIONS_ATTENTION_SEVERITY_RANK[input.severity] > OPERATIONS_ATTENTION_SEVERITY_RANK[descriptor.peakSeverity]
  ) {
    throw new Error(
      `Source ${input.source} may not raise ${input.severity}; its peak severity is ${descriptor.peakSeverity}`,
    );
  }

  return {
    id: `${input.source}:${input.entityId}`,
    source: input.source,
    entity: descriptor.entity,
    severity: input.severity,
    summary: input.summary,
    deepLink: { surface: descriptor.surface, href: descriptor.buildHref(input.entityId) },
    count: input.count,
    dueAt: input.dueAt ?? null,
    observedAt: input.observedAt,
  };
}

// ---------------------------------------------------------------------------
// Source contract — a transport-agnostic query module. `load` returns this
// source's items; the owning surface supplies the read.
// ---------------------------------------------------------------------------

export type OperationsAttentionContext = Readonly<{
  // ISO-8601 UTC evaluation instant, so severity/deadline decisions are
  // deterministic and testable rather than reading the wall clock.
  now: string;
}>;

export type OperationsAttentionSource = Readonly<{
  id: OperationsAttentionSourceId;
  load: (context: OperationsAttentionContext) => Promise<readonly OperationsAttentionItem[]>;
}>;

// ---------------------------------------------------------------------------
// Conformance — the aggregation validates every returned item so one source that
// emits the wrong shape (or another source's items) degrades rather than
// poisoning the queue.
// ---------------------------------------------------------------------------

const SEVERITIES = new Set<OperationsAttentionSeverity>(["critical", "warning", "info"]);

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function isOperationsAttentionItem(
  value: unknown,
  expectedSource: OperationsAttentionSourceId,
): value is OperationsAttentionItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Partial<OperationsAttentionItem>;
  const descriptor = operationsAttentionSourceById(expectedSource);
  if (descriptor === undefined) {
    return false;
  }
  if (
    item.source !== expectedSource ||
    item.entity !== descriptor.entity ||
    typeof item.id !== "string" ||
    item.id.length === 0
  ) {
    return false;
  }
  if (item.severity === undefined || !SEVERITIES.has(item.severity)) {
    return false;
  }
  if (OPERATIONS_ATTENTION_SEVERITY_RANK[item.severity] > OPERATIONS_ATTENTION_SEVERITY_RANK[descriptor.peakSeverity]) {
    return false;
  }
  if (
    typeof item.summary !== "object" ||
    item.summary === null ||
    typeof item.summary.code !== "string" ||
    typeof item.summary.params !== "object" ||
    item.summary.params === null
  ) {
    return false;
  }
  if (
    typeof item.deepLink !== "object" ||
    item.deepLink === null ||
    item.deepLink.surface !== descriptor.surface ||
    typeof item.deepLink.href !== "string" ||
    item.deepLink.href.length === 0
  ) {
    return false;
  }
  if (!isIsoTimestamp(item.observedAt)) {
    return false;
  }
  if (item.dueAt !== null && item.dueAt !== undefined && !isIsoTimestamp(item.dueAt)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Aggregation — compose the sources, degrade per source, sort by the ordering
// policy, and roll up counts from the same items the queue renders.
// ---------------------------------------------------------------------------

export type OperationsAttentionSourceStatus = "available" | "unavailable";

export type OperationsAttentionSourceHealth = Readonly<{
  id: OperationsAttentionSourceId;
  status: OperationsAttentionSourceStatus;
  itemCount: number;
  // Present only when unavailable — the visible "source unavailable" marker.
  reason?: string;
}>;

export type OperationsAttentionRollup = Readonly<{
  total: number;
  bySeverity: Readonly<Record<OperationsAttentionSeverity, number>>;
  bySource: Readonly<Record<OperationsAttentionSourceId, number>>;
}>;

export type OperationsAttentionQueue = Readonly<{
  // Sorted by the ordering policy's total ordering.
  items: readonly OperationsAttentionItem[];
  rollup: OperationsAttentionRollup;
  // One entry per source, in the order the sources were supplied.
  sources: readonly OperationsAttentionSourceHealth[];
  // True when any source is unavailable — the surface shows a degraded marker.
  degraded: boolean;
}>;

function reasonFrom(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "source unavailable";
}

type LoadedSource = Readonly<{
  health: OperationsAttentionSourceHealth;
  items: readonly OperationsAttentionItem[];
}>;

async function loadSource(
  source: OperationsAttentionSource,
  context: OperationsAttentionContext,
): Promise<LoadedSource> {
  try {
    const loaded = await source.load(context);
    if (!Array.isArray(loaded) || !loaded.every((item) => isOperationsAttentionItem(item, source.id))) {
      return {
        health: {
          id: source.id,
          status: "unavailable",
          itemCount: 0,
          reason: "source returned a non-conforming item",
        },
        items: [],
      };
    }
    return {
      health: { id: source.id, status: "available", itemCount: loaded.length },
      items: loaded,
    };
  } catch (error) {
    return {
      health: { id: source.id, status: "unavailable", itemCount: 0, reason: reasonFrom(error) },
      items: [],
    };
  }
}

function emptyBySource(): Record<OperationsAttentionSourceId, number> {
  const counts = {} as Record<OperationsAttentionSourceId, number>;
  for (const source of OPERATIONS_ATTENTION_SOURCES) {
    counts[source.id] = 0;
  }
  return counts;
}

function rollup(items: readonly OperationsAttentionItem[]): OperationsAttentionRollup {
  const bySeverity: Record<OperationsAttentionSeverity, number> = { critical: 0, warning: 0, info: 0 };
  const bySource = emptyBySource();
  for (const item of items) {
    bySeverity[item.severity] += 1;
    bySource[item.source] += 1;
  }
  return { total: items.length, bySeverity, bySource };
}

// Compose the queue. Sources load concurrently and independently: one that
// throws or returns a bad shape is marked unavailable with a reason and
// contributes no items, but never blanks the others. Items are sorted by the
// ordering policy and the rollup is computed from exactly those items, so the
// count strip can never disagree with the list.
export async function aggregateOperationsAttentionQueue(
  sources: readonly OperationsAttentionSource[],
  context: OperationsAttentionContext,
): Promise<OperationsAttentionQueue> {
  const loaded = await Promise.all(sources.map((source) => loadSource(source, context)));

  const items = loaded
    .flatMap((entry) => entry.items)
    .slice()
    .sort(compareOperationsAttentionItems);

  const health = loaded.map((entry) => entry.health);

  return {
    items,
    rollup: rollup(items),
    sources: health,
    degraded: health.some((entry) => entry.status === "unavailable"),
  };
}
