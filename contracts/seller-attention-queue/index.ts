// Seller attention-queue read model — the transport-agnostic "what needs me"
// aggregation for the Seller Desk.
//
// Nothing tells a seller "here is everything that needs you, most important
// first"; the signals exist but are buried per surface — shipments needing a
// label by their ship-by deadline, blocked payouts, unresolved import rows,
// offers awaiting a response, listings needing action. This module is the shared
// spine that both the Seller Desk home and the MCP seller tools consume, so the
// two facades can never diverge.
//
// Each owning context ships a plain query module (no HTTP, no UI) that maps its
// own read model into the shared item shape defined here; this module composes
// those sources at the seller edge. It owns only the item shape, the aggregation,
// per-source degradation, and rollup counts. The ordering and severity policy is
// the Seller Desk blueprint's — imported, never re-declared — so the queue and
// the blueprint cannot drift.

import {
  compareSellerAttentionItems,
  SELLER_ATTENTION_SEVERITY_RANK,
  SELLER_ATTENTION_SOURCE_PRIORITY,
  SELLER_ATTENTION_SOURCES,
  sellerSurfaceById,
  type SellerAttentionSeverity,
  type SellerAttentionSource as SellerAttentionSourceDescriptor,
  type SellerAttentionSourceId,
  type SellerDeskSurfaceId,
  type SellerEntityId,
} from "@chase-sets/seller-desk";

// Re-export the blueprint's ordering vocabulary so consumers of the read model
// import one module, not two, and always get the canonical policy.
export {
  compareSellerAttentionItems,
  SELLER_ATTENTION_SEVERITY_RANK,
  SELLER_ATTENTION_SOURCE_PRIORITY,
  SELLER_ATTENTION_SOURCES,
  type SellerAttentionSeverity,
  type SellerAttentionSourceId,
};

// ---------------------------------------------------------------------------
// The shared item shape. Every source returns items of exactly this shape; the
// aggregation enforces it so a malformed source degrades instead of corrupting
// the queue. Structurally a superset of the blueprint's ordering key, so
// `compareSellerAttentionItems` sorts items directly.
// ---------------------------------------------------------------------------

// A localization-ready descriptor. The read model stays presentation-free: it
// carries a stable semantic `code` (owned by the emitting source) plus typed
// interpolation `params`; the web surface and the MCP tool each render their own
// copy from the same code, so neither owns queue wording the other lacks.
export type SellerAttentionSummary = Readonly<{
  code: string;
  params: Readonly<Record<string, string | number>>;
}>;

// The forward step into the entity that needs work. `surface` is the target
// Seller Desk surface (blueprint source of truth); `href` is the concrete link
// both facades navigate to.
export type SellerAttentionDeepLink = Readonly<{
  surface: SellerDeskSurfaceId;
  href: string;
}>;

export type SellerAttentionItem = Readonly<{
  // Stable across reloads (`${source}:${entityId}`): dedupe, React keys, MCP ids.
  id: string;
  source: SellerAttentionSourceId;
  entity: SellerEntityId;
  severity: SellerAttentionSeverity;
  summary: SellerAttentionSummary;
  deepLink: SellerAttentionDeepLink;
  // ISO-8601 UTC deadline; dated items outrank undated. `null` when the work has
  // no clock (blocked money has no deadline, only urgency).
  dueAt: string | null;
  // ISO-8601 UTC time the work first needed attention; drives the age tiebreak.
  observedAt: string;
}>;

// ---------------------------------------------------------------------------
// Deep-link resolution — reuses the blueprint's surface routes and per-source
// targets so a link can never point at a surface the blueprint did not define.
// ---------------------------------------------------------------------------

const SELLER_HOME_SURFACE_ID: SellerDeskSurfaceId = "seller-home";

function sourceDescriptor(sourceId: SellerAttentionSourceId): SellerAttentionSourceDescriptor {
  const descriptor = SELLER_ATTENTION_SOURCES.find((source) => source.id === sourceId);
  if (descriptor === undefined) {
    throw new Error(`Unknown seller attention source: ${sourceId}`);
  }
  return descriptor;
}

// Resolve the deep link for one item. Page targets substitute the entity id into
// the surface route; drawer targets (no route of their own) open over the Desk
// home, since a blocker resolves in a drawer and never as a cross-surface detour.
export function resolveSellerAttentionDeepLink(
  sourceId: SellerAttentionSourceId,
  entityId: string,
): SellerAttentionDeepLink {
  const descriptor = sourceDescriptor(sourceId);
  const surface = sellerSurfaceById(descriptor.target);
  if (surface === undefined) {
    throw new Error(`Unknown target surface for source ${sourceId}: ${descriptor.target}`);
  }

  if (surface.routePath !== null) {
    const href = surface.routePath.replace(/:[A-Za-z][A-Za-z0-9]*/, encodeURIComponent(entityId));
    return { surface: surface.id, href };
  }

  const home = sellerSurfaceById(SELLER_HOME_SURFACE_ID);
  if (home === undefined || home.routePath === null) {
    throw new Error("Seller Desk home surface is missing a route");
  }
  const href = `${home.routePath}?drawer=${surface.id}&entity=${encodeURIComponent(entityId)}`;
  return { surface: surface.id, href };
}

// ---------------------------------------------------------------------------
// Item construction — the one helper every source uses so id and deep link are
// derived identically and each emitted item is conformance-checked at the seam.
// ---------------------------------------------------------------------------

export type BuildSellerAttentionItemInput = Readonly<{
  source: SellerAttentionSourceId;
  entityId: string;
  severity: SellerAttentionSeverity;
  summary: SellerAttentionSummary;
  observedAt: string;
  dueAt?: string | null;
}>;

// Build a conformant item. Severity may not exceed the source's declared peak
// (the blueprint caps how loud each source can be), the entity is taken from the
// source descriptor, and the deep link is resolved from the blueprint routes.
export function buildSellerAttentionItem(input: BuildSellerAttentionItemInput): SellerAttentionItem {
  const descriptor = sourceDescriptor(input.source);
  if (SELLER_ATTENTION_SEVERITY_RANK[input.severity] > SELLER_ATTENTION_SEVERITY_RANK[descriptor.peakSeverity]) {
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
    deepLink: resolveSellerAttentionDeepLink(input.source, input.entityId),
    dueAt: input.dueAt ?? null,
    observedAt: input.observedAt,
  };
}

// ---------------------------------------------------------------------------
// Source contract — a transport-agnostic query module. `load` returns this
// account's items for one source; the owning context supplies the read query.
// ---------------------------------------------------------------------------

export type SellerAttentionContext = Readonly<{
  accountId: string;
  // ISO-8601 UTC evaluation instant, so severity/deadline decisions are
  // deterministic and testable rather than reading the wall clock.
  now: string;
}>;

export type SellerAttentionSource = Readonly<{
  id: SellerAttentionSourceId;
  load: (context: SellerAttentionContext) => Promise<readonly SellerAttentionItem[]>;
}>;

// ---------------------------------------------------------------------------
// Conformance — the aggregation validates every returned item so one source that
// emits the wrong shape (or another source's items) degrades rather than
// poisoning the queue.
// ---------------------------------------------------------------------------

const SEVERITIES = new Set<SellerAttentionSeverity>(["critical", "warning", "info"]);

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function isSellerAttentionItem(
  value: unknown,
  expectedSource: SellerAttentionSourceId,
): value is SellerAttentionItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Partial<SellerAttentionItem>;
  const descriptor = SELLER_ATTENTION_SOURCES.find((source) => source.id === expectedSource);
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
  if (SELLER_ATTENTION_SEVERITY_RANK[item.severity] > SELLER_ATTENTION_SEVERITY_RANK[descriptor.peakSeverity]) {
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
    item.deepLink.surface !== descriptor.target ||
    typeof item.deepLink.href !== "string" ||
    item.deepLink.href.length === 0
  ) {
    return false;
  }
  if (!isIsoTimestamp(item.observedAt)) {
    return false;
  }
  if (item.dueAt !== null && !isIsoTimestamp(item.dueAt)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Aggregation — compose the sources per account, degrade per source, sort by the
// blueprint policy, and roll up counts from the same items the queue renders.
// ---------------------------------------------------------------------------

export type SellerAttentionSourceStatus = "available" | "unavailable";

export type SellerAttentionSourceHealth = Readonly<{
  id: SellerAttentionSourceId;
  status: SellerAttentionSourceStatus;
  itemCount: number;
  // Present only when unavailable — the visible "source unavailable" marker.
  reason?: string;
}>;

export type SellerAttentionRollup = Readonly<{
  total: number;
  bySeverity: Readonly<Record<SellerAttentionSeverity, number>>;
  bySource: Readonly<Record<SellerAttentionSourceId, number>>;
}>;

export type SellerAttentionQueue = Readonly<{
  // Sorted by the blueprint's total ordering.
  items: readonly SellerAttentionItem[];
  rollup: SellerAttentionRollup;
  // One entry per source, in the order the sources were supplied.
  sources: readonly SellerAttentionSourceHealth[];
  // True when any source is unavailable — the surface shows a degraded banner.
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
  health: SellerAttentionSourceHealth;
  items: readonly SellerAttentionItem[];
}>;

async function loadSource(source: SellerAttentionSource, context: SellerAttentionContext): Promise<LoadedSource> {
  try {
    const loaded = await source.load(context);
    if (!Array.isArray(loaded) || !loaded.every((item) => isSellerAttentionItem(item, source.id))) {
      return {
        health: { id: source.id, status: "unavailable", itemCount: 0, reason: "source returned a non-conforming item" },
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

function emptyBySource(): Record<SellerAttentionSourceId, number> {
  const counts = {} as Record<SellerAttentionSourceId, number>;
  for (const source of SELLER_ATTENTION_SOURCES) {
    counts[source.id] = 0;
  }
  return counts;
}

function rollup(items: readonly SellerAttentionItem[]): SellerAttentionRollup {
  const bySeverity: Record<SellerAttentionSeverity, number> = { critical: 0, warning: 0, info: 0 };
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
// blueprint ordering and the rollup is computed from exactly those items, so the
// count strip can never disagree with the list.
export async function aggregateSellerAttentionQueue(
  sources: readonly SellerAttentionSource[],
  context: SellerAttentionContext,
): Promise<SellerAttentionQueue> {
  const loaded = await Promise.all(sources.map((source) => loadSource(source, context)));

  const items = loaded
    .flatMap((entry) => entry.items)
    .slice()
    .sort(compareSellerAttentionItems);

  const health = loaded.map((entry) => entry.health);

  return {
    items,
    rollup: rollup(items),
    sources: health,
    degraded: health.some((entry) => entry.status === "unavailable"),
  };
}
