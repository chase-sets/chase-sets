import type {
  CatalogAttentionQueueReadModel,
  CatalogDeferredAttentionQueueResult,
} from "../../../features/attention-queue/api/contracts";
import {
  CATALOG_ATTENTION_ITEM_KINDS,
  summarizeCatalogAttentionItems,
  type CatalogAttentionItem,
  type CatalogAttentionItemKind,
  type CatalogAttentionResolution,
  type CatalogAttentionSeverity,
} from "../../../features/attention-queue/read-model/attention-item";

// ---------------------------------------------------------------------------
// Catalog attention queue — deferred availability result (#7845)
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

// Accept a raw API response only when it matches the existing attention read
// model exactly (closed key sets, closed enums, timezone-bearing timestamps) and
// its derived facts agree with its items. Any mismatch is `unavailable`: a queue
// the surface cannot trust must not be rendered as an empty or partial inbox.
export function resolveCatalogAttentionQueueResult(value: unknown): CatalogDeferredAttentionQueueResult {
  const readModel = parseCatalogAttentionQueueReadModel(value);
  return readModel ? { status: "ready", readModel } : CATALOG_ATTENTION_QUEUE_UNAVAILABLE;
}

const READ_MODEL_KEYS = ["generatedAt", "empty", "items", "counts", "freshness"] as const;
const COUNTS_KEYS = ["total", "bySeverity", "byKind"] as const;
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
const RESOLUTION_OPTIONAL_KEYS = ["requiresReason"] as const;
const SEVERITIES = ["critical", "warning", "info"] as const satisfies readonly CatalogAttentionSeverity[];
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
  if (value.empty !== (items.length === 0)) {
    return null;
  }

  const counts = parseCounts(value.counts, items);
  const freshness = parseFreshness(value.freshness, generatedAt, items);
  if (!counts || !freshness) {
    return null;
  }

  return { generatedAt, empty: value.empty, items, counts, freshness };
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
    !isItemKind(value.kind) ||
    !isSeverity(value.severity) ||
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
    !("requiresReason" in value ? typeof value.requiresReason === "boolean" : true)
  ) {
    return null;
  }
  return "requiresReason" in value
    ? { intent, mode: value.mode, labelKey, fields, requiresReason: value.requiresReason === true }
    : { intent, mode: value.mode, labelKey, fields };
}

// Counts are re-derived from the accepted items; the response's own counts must
// match that recomputation exactly or the queue is not trusted.
function parseCounts(value: unknown, items: readonly CatalogAttentionItem[]) {
  if (!hasExactKeys(value, COUNTS_KEYS)) {
    return null;
  }
  const expected = summarizeCatalogAttentionItems(items);
  if (
    value.total !== expected.total ||
    !countRecordMatches(value.bySeverity, SEVERITIES, expected.bySeverity) ||
    !countRecordMatches(value.byKind, CATALOG_ATTENTION_ITEM_KINDS, expected.byKind)
  ) {
    return null;
  }
  return expected;
}

function parseFreshness(value: unknown, generatedAt: string, items: readonly CatalogAttentionItem[]) {
  if (!hasExactKeys(value, FRESHNESS_KEYS) || value.generatedAt !== generatedAt) {
    return null;
  }
  const expectedOldest = items.length > 0 ? extremeObservedAt(items, "oldest") : null;
  const expectedNewest = items.length > 0 ? extremeObservedAt(items, "newest") : null;
  if (value.oldestObservedAt !== expectedOldest || value.newestObservedAt !== expectedNewest) {
    return null;
  }
  return { generatedAt, oldestObservedAt: expectedOldest, newestObservedAt: expectedNewest };
}

// Same lexical comparison the assembler uses, so a queue it produced round-trips.
function extremeObservedAt(items: readonly CatalogAttentionItem[], edge: "oldest" | "newest"): string {
  return items.reduce((current, item) => {
    const delta = item.observedAt.localeCompare(current);
    return (edge === "oldest" ? delta < 0 : delta > 0) ? item.observedAt : current;
  }, items[0]!.observedAt);
}

function countRecordMatches<K extends string>(
  value: unknown,
  keys: readonly K[],
  expected: Readonly<Record<K, number>>,
): boolean {
  if (!hasExactKeys(value, keys)) {
    return false;
  }
  return keys.every((key) => {
    const count = value[key];
    return typeof count === "number" && Number.isInteger(count) && count === expected[key];
  });
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

function isItemKind(value: unknown): value is CatalogAttentionItemKind {
  return isOneOf(value, CATALOG_ATTENTION_ITEM_KINDS);
}

function isSeverity(value: unknown): value is CatalogAttentionSeverity {
  return isOneOf(value, SEVERITIES);
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
