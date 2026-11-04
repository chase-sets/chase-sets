import type {
  CatalogAttentionQueueReadModel,
  CatalogDeferredAttentionQueueResult,
} from "../../../features/attention-queue/api/contracts";
import {
  CATALOG_ATTENTION_ITEM_KINDS,
  type CatalogAttentionItem,
  type CatalogAttentionItemKind,
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

// Accept a raw API response only when it matches the existing attention read
// model exactly (closed key sets, closed enums, timezone-bearing timestamps). Its
// counts and freshness are the API's, computed once by the attention-queue
// assembler; they are shape-checked here, never recomputed. Any mismatch is
// `unavailable`: a queue the surface cannot trust must not be rendered as an
// empty or partial inbox.
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
const RESOLUTION_OPTIONAL_KEYS = ["requiresReason", "href", "unavailable"] as const;
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

  const counts = parseCounts(value.counts);
  const freshness = parseFreshness(value.freshness, generatedAt);
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

function parseCounts(value: unknown): CatalogAttentionQueueReadModel["counts"] | null {
  if (!hasExactKeys(value, COUNTS_KEYS) || !isCount(value.total)) {
    return null;
  }
  const bySeverity = countRecord(value.bySeverity, SEVERITIES);
  const byKind = countRecord(value.byKind, CATALOG_ATTENTION_ITEM_KINDS);
  if (!bySeverity || !byKind) {
    return null;
  }
  return { total: value.total, bySeverity, byKind };
}

function parseFreshness(value: unknown, generatedAt: string): CatalogAttentionQueueReadModel["freshness"] | null {
  if (!hasExactKeys(value, FRESHNESS_KEYS) || value.generatedAt !== generatedAt) {
    return null;
  }
  const oldestObservedAt = nullableTimestamp(value.oldestObservedAt);
  const newestObservedAt = nullableTimestamp(value.newestObservedAt);
  if (oldestObservedAt === undefined || newestObservedAt === undefined) {
    return null;
  }
  return { generatedAt, oldestObservedAt, newestObservedAt };
}

// A closed record of non-negative integer counts, one per allowed key.
function countRecord<K extends string>(value: unknown, keys: readonly K[]): Readonly<Record<K, number>> | null {
  if (!hasExactKeys(value, keys)) {
    return null;
  }
  const record = {} as Record<K, number>;
  for (const key of keys) {
    const count = value[key];
    if (!isCount(count)) {
      return null;
    }
    record[key] = count;
  }
  return record;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// A timezone-bearing timestamp, null, or undefined when the value is neither.
function nullableTimestamp(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return timestamp(value) ?? undefined;
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
