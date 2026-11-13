import {
  catalogAttentionKindCoverage,
  type CatalogAttentionKindCoverage,
  type CatalogAttentionQueueCoverage,
  type CatalogAttentionQueueFreshness,
  type CatalogAttentionQueueReadModel,
  type CatalogDeferredAttentionQueueResult,
} from "../../../features/attention-queue/api/contracts";
import {
  CATALOG_ATTENTION_ITEM_KINDS,
  CATALOG_ATTENTION_KIND_SEVERITIES,
  CATALOG_ATTENTION_MAX_WINDOW_LIMIT,
  CATALOG_ATTENTION_SEVERITIES,
  CATALOG_ATTENTION_TOTAL_KINDS,
  catalogAttentionKindRecord,
  catalogAttentionKindWindow,
  isCatalogAttentionItemKind,
  type CatalogAttentionItem,
  type CatalogAttentionQueueCountBasis,
  type CatalogAttentionQueueCounts,
  type CatalogAttentionQueueWindow,
  type CatalogAttentionResolution,
  type CatalogAttentionSeverity,
} from "../../../features/attention-queue/read-model/attention-item";

// ---------------------------------------------------------------------------
// Catalog attention queue — deferred availability result
//
// The daily home surface streams the "needs-you" attention queue behind an
// Await boundary. A `null` there used to conflate three different facts —
// the API lacks the endpoint, the request failed, or the queue was read but is
// empty — so operators could not tell "nothing needs you" from "the queue could
// not be read". This module closes that into a two-branch result: `ready` carries
// a read model this loader-local parser accepted in full; anything else is
// `unavailable`, which the route view renders as an honest warning while the
// import-to-promotion workflow stays usable.
//
// Validation is deliberately loader-local. The generic Catalog client remains
// transport-only; this is the only place the daily route trusts the attention
// contract, so it is the only place that checks it.
// ---------------------------------------------------------------------------

export type { CatalogDeferredAttentionQueueResult };

export const CATALOG_ATTENTION_QUEUE_UNAVAILABLE: CatalogDeferredAttentionQueueResult = Object.freeze({
  status: "unavailable",
});

// Accept a raw API response only when it matches the attention read model
// exactly (closed key sets, closed enums, nonnegative integer counts,
// timezone-bearing timestamps) and its coverage describes the request window and
// the items returned. The counts, count bases, freshness and emptiness are the
// Catalog API's, taken as returned: the attention runtime derives them, and this
// parser checks their shape, not their arithmetic. Any mismatch is
// `unavailable`: a queue the surface cannot trust must not be rendered as an
// empty or partial inbox.
export function resolveCatalogAttentionQueueResult(value: unknown): CatalogDeferredAttentionQueueResult {
  const readModel = parseCatalogAttentionQueueReadModel(value);
  return readModel ? { status: "ready", readModel } : CATALOG_ATTENTION_QUEUE_UNAVAILABLE;
}

const READ_MODEL_KEYS = [
  "generatedAt",
  "empty",
  "items",
  "counts",
  "countBasis",
  "coverage",
  "window",
  "freshness",
] as const;
const COUNTS_KEYS = ["total", "bySeverity", "byKind"] as const;
const COUNT_BASIS_KEYS = ["total", "bySeverity"] as const;
const WINDOW_KEYS = ["kind", "offset", "limit"] as const;
const COVERAGE_KEYS = ["total", "totalKind", "offset", "limit", "returned", "truncated", "nextOffset"] as const;
const FRESHNESS_KEYS = ["generatedAt", "oldestObservedAt", "newestObservedAt"] as const;
const ITEM_KEYS = [
  "itemKey",
  "kind",
  "severity",
  "titleKey",
  "titleParams",
  "detailKey",
  "detailParams",
  "providerKey",
  "unitKey",
  "observedAt",
  "resolution",
  "secondaryResolutions",
] as const;
const RESOLUTION_REQUIRED_KEYS = ["intent", "mode", "labelKey", "fields"] as const;
const RESOLUTION_OPTIONAL_KEYS = ["requiresReason", "href", "unavailable"] as const;
const RESOLUTION_MODES = ["command", "drawer"] as const;

// ISO-8601 date-time with an explicit offset (`Z` or `±hh:mm`). The queue's
// ordering and age labels compare these lexically, so an offset-less or
// unparseable timestamp would silently misorder the inbox.
const TIMEZONE_BEARING_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseCatalogAttentionQueueReadModel(value: unknown): CatalogAttentionQueueReadModel | null {
  if (!hasExactKeys(value, READ_MODEL_KEYS)) {
    return null;
  }
  const generatedAt = timestamp(value.generatedAt);
  if (generatedAt === null || typeof value.empty !== "boolean" || !Array.isArray(value.items)) {
    return null;
  }

  const items: CatalogAttentionItem[] = [];
  for (const rawItem of value.items) {
    const item = parseItem(rawItem);
    if (!item) {
      return null;
    }
    items.push(item);
  }

  const window = parseWindow(value.window);
  const coverage = window ? parseCoverage(value.coverage, window, items) : null;
  if (!window || !coverage) {
    return null;
  }
  const counts = parseCounts(value.counts);
  const countBasis = parseCountBasis(value.countBasis);
  const freshness = parseFreshness(value.freshness);
  if (!counts || !countBasis || !freshness) {
    return null;
  }

  return { generatedAt, empty: value.empty, items, counts, countBasis, coverage, window, freshness };
}

function parseWindow(value: unknown): CatalogAttentionQueueWindow | null {
  if (!hasExactKeys(value, WINDOW_KEYS)) {
    return null;
  }
  const kind = value.kind === null ? null : isCatalogAttentionItemKind(value.kind) ? value.kind : undefined;
  if (
    kind === undefined ||
    !isNonNegativeInteger(value.offset) ||
    !isNonNegativeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > CATALOG_ATTENTION_MAX_WINDOW_LIMIT
  ) {
    return null;
  }
  return { kind, offset: value.offset, limit: value.limit };
}

// Each kind's coverage must describe the request window and the items actually
// returned for that kind; truncation and the next offset are recomputed.
function parseCoverage(
  value: unknown,
  window: CatalogAttentionQueueWindow,
  items: readonly CatalogAttentionItem[],
): CatalogAttentionQueueCoverage | null {
  if (!hasExactKeys(value, CATALOG_ATTENTION_ITEM_KINDS)) {
    return null;
  }
  const parsed: Partial<Record<CatalogAttentionItem["kind"], CatalogAttentionKindCoverage>> = {};
  for (const kind of CATALOG_ATTENTION_ITEM_KINDS) {
    const coverage = parseKindCoverage(
      value[kind],
      catalogAttentionKindWindow(window, kind),
      items.filter((item) => item.kind === kind).length,
    );
    if (!coverage) {
      return null;
    }
    parsed[kind] = coverage;
  }
  return catalogAttentionKindRecord((kind) => parsed[kind]!);
}

function parseKindCoverage(
  value: unknown,
  window: Readonly<{ offset: number; limit: number }>,
  returned: number,
): CatalogAttentionKindCoverage | null {
  if (
    !hasExactKeys(value, COVERAGE_KEYS) ||
    !isNonNegativeInteger(value.total) ||
    !isOneOf(value.totalKind, CATALOG_ATTENTION_TOTAL_KINDS) ||
    returned > window.limit
  ) {
    return null;
  }
  const expected = catalogAttentionKindCoverage({
    total: value.total,
    totalKind: value.totalKind,
    offset: window.offset,
    limit: window.limit,
    returned,
  });
  const matches =
    value.offset === expected.offset &&
    value.limit === expected.limit &&
    value.returned === expected.returned &&
    value.truncated === expected.truncated &&
    value.nextOffset === expected.nextOffset;
  return matches ? expected : null;
}

function parseCounts(value: unknown): CatalogAttentionQueueCounts | null {
  if (!hasExactKeys(value, COUNTS_KEYS) || !isNonNegativeInteger(value.total)) {
    return null;
  }
  const bySeverity = parseSeverityCounts(value.bySeverity);
  const byKind = parseKindCounts(value.byKind);
  return bySeverity && byKind ? { total: value.total, bySeverity, byKind } : null;
}

function parseKindCounts(value: unknown): CatalogAttentionQueueCounts["byKind"] | null {
  if (
    !hasExactKeys(value, CATALOG_ATTENTION_ITEM_KINDS) ||
    !CATALOG_ATTENTION_ITEM_KINDS.every((kind) => isNonNegativeInteger(value[kind]))
  ) {
    return null;
  }
  return catalogAttentionKindRecord((kind) => value[kind] as number);
}

function parseSeverityCounts(value: unknown): Readonly<Record<CatalogAttentionSeverity, number>> | null {
  if (!hasExactKeys(value, CATALOG_ATTENTION_SEVERITIES)) {
    return null;
  }
  const { critical, warning, info } = value;
  return isNonNegativeInteger(critical) && isNonNegativeInteger(warning) && isNonNegativeInteger(info)
    ? { critical, warning, info }
    : null;
}

function parseCountBasis(value: unknown): CatalogAttentionQueueCountBasis | null {
  if (
    !hasExactKeys(value, COUNT_BASIS_KEYS) ||
    !isOneOf(value.total, CATALOG_ATTENTION_TOTAL_KINDS) ||
    !hasExactKeys(value.bySeverity, CATALOG_ATTENTION_SEVERITIES)
  ) {
    return null;
  }
  const { critical, warning, info } = value.bySeverity;
  return isOneOf(critical, CATALOG_ATTENTION_TOTAL_KINDS) &&
    isOneOf(warning, CATALOG_ATTENTION_TOTAL_KINDS) &&
    isOneOf(info, CATALOG_ATTENTION_TOTAL_KINDS)
    ? { total: value.total, bySeverity: { critical, warning, info } }
    : null;
}

function parseItem(value: unknown): CatalogAttentionItem | null {
  if (!hasExactKeys(value, ITEM_KEYS)) {
    return null;
  }
  const itemKey = nonEmptyString(value.itemKey);
  const titleKey = nonEmptyString(value.titleKey);
  const detailKey = nonEmptyString(value.detailKey);
  const observedAt = timestamp(value.observedAt);
  const titleParams = messageParams(value.titleParams);
  const detailParams = messageParams(value.detailParams);
  const resolution = parseResolution(value.resolution);
  if (
    itemKey === null ||
    titleKey === null ||
    detailKey === null ||
    observedAt === null ||
    titleParams === null ||
    detailParams === null ||
    resolution === null ||
    !isCatalogAttentionItemKind(value.kind) ||
    !isSeverity(value.severity) ||
    // A severity the item's source cannot produce is not a queue item.
    !CATALOG_ATTENTION_KIND_SEVERITIES[value.kind].includes(value.severity) ||
    !isNullableString(value.providerKey) ||
    !isNullableString(value.unitKey) ||
    !Array.isArray(value.secondaryResolutions)
  ) {
    return null;
  }

  const secondaryResolutions: CatalogAttentionResolution[] = [];
  for (const rawResolution of value.secondaryResolutions) {
    const secondary = parseResolution(rawResolution);
    if (!secondary) {
      return null;
    }
    secondaryResolutions.push(secondary);
  }

  return {
    itemKey,
    kind: value.kind,
    severity: value.severity,
    titleKey,
    titleParams,
    detailKey,
    detailParams,
    providerKey: value.providerKey,
    unitKey: value.unitKey,
    observedAt,
    resolution,
    secondaryResolutions,
  };
}

function parseResolution(value: unknown): CatalogAttentionResolution | null {
  if (!hasExactKeys(value, RESOLUTION_REQUIRED_KEYS, RESOLUTION_OPTIONAL_KEYS)) {
    return null;
  }
  const intent = nonEmptyString(value.intent);
  const labelKey = nonEmptyString(value.labelKey);
  const fields = stringRecord(value.fields);
  if (
    intent === null ||
    labelKey === null ||
    fields === null ||
    !isOneOf(value.mode, RESOLUTION_MODES) ||
    !("requiresReason" in value ? typeof value.requiresReason === "boolean" : true) ||
    !("href" in value ? typeof value.href === "string" && value.href.startsWith("/catalog/") : true) ||
    !("unavailable" in value ? value.unavailable === true : true) ||
    ("href" in value && "unavailable" in value)
  ) {
    return null;
  }
  return {
    intent,
    mode: value.mode,
    labelKey,
    fields,
    ...(value.requiresReason !== undefined ? { requiresReason: value.requiresReason === true } : {}),
    ...(typeof value.href === "string" ? { href: value.href } : {}),
    ...(value.unavailable === true ? { unavailable: true } : {}),
  };
}

function parseFreshness(value: unknown): CatalogAttentionQueueFreshness | null {
  if (!hasExactKeys(value, FRESHNESS_KEYS)) {
    return null;
  }
  const generatedAt = timestamp(value.generatedAt);
  const oldestObservedAt = nullableTimestamp(value.oldestObservedAt);
  const newestObservedAt = nullableTimestamp(value.newestObservedAt);
  return generatedAt !== null && oldestObservedAt !== undefined && newestObservedAt !== undefined
    ? { generatedAt, oldestObservedAt, newestObservedAt }
    : null;
}

function hasExactKeys<K extends string, O extends string = never>(
  value: unknown,
  required: readonly K[],
  optional: readonly O[] = [],
): value is Record<K, unknown> & Partial<Record<O, unknown>> {
  if (!isRecord(value)) {
    return false;
  }
  const present = Object.keys(value);
  if (present.some((key) => !required.includes(key as K) && !optional.includes(key as O))) {
    return false;
  }
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isSeverity(value: unknown): value is CatalogAttentionSeverity {
  return isOneOf(value, CATALOG_ATTENTION_SEVERITIES);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && TIMEZONE_BEARING_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  return value === null ? null : (timestamp(value) ?? undefined);
}

function messageParams(value: unknown): Readonly<Record<string, string | number>> | null {
  if (!isRecord(value)) {
    return null;
  }
  const params: Record<string, string | number> = {};
  for (const [key, param] of Object.entries(value)) {
    if (typeof param === "string" || (typeof param === "number" && Number.isFinite(param))) {
      params[key] = param;
    } else {
      return null;
    }
  }
  return params;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) {
    return null;
  }
  const record: Record<string, string> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field !== "string") {
      return null;
    }
    record[key] = field;
  }
  return record;
}
