import { createHash } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogProviderIntegrationOption } from "./provider-option-query-resolver";

export type CatalogProviderOptionQueryCacheStatus = "fresh" | "stale" | "miss" | "bypass" | "unavailable";

export type CatalogProviderOptionQueryDiagnostic = Readonly<{
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  retryAfterSeconds: number | null;
}>;

export type CatalogProviderOptionQueryRequest = Readonly<{
  providerKey: string;
  profileKey?: string | null;
  profileVersion: string;
  ingestionUnitKey?: string | null;
  queryKind: string;
  languageCode?: string | null;
  parentValue?: string | null;
  cursor?: string | null;
  limit?: number | null;
  forceRefresh?: boolean | null;
  cacheOnly?: boolean | null;
}>;

export type CatalogProviderOptionQueryCacheSummary = Readonly<{
  status: CatalogProviderOptionQueryCacheStatus;
  source: "cache" | "live" | "none";
  cacheKey: string;
  fetchedAt: string | null;
  expiresAt: string | null;
  staleUntil: string | null;
  cacheOnly: boolean;
  forceRefresh: boolean;
  degraded: boolean;
  diagnostics: readonly CatalogProviderOptionQueryDiagnostic[];
}>;

export type CatalogProviderOptionQueryPage = Readonly<{
  items: readonly CatalogProviderIntegrationOption[];
  total: number;
  count: number;
  page: Readonly<{
    cursor: string | null;
    nextCursor: string | null;
    limit: number;
    hasMore: boolean;
  }>;
  cache: CatalogProviderOptionQueryCacheSummary;
}>;

export type CatalogProviderOptionQueryCacheRecord = Readonly<{
  cacheKey: string;
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  ingestionUnitKey: string;
  queryKind: string;
  languageCode: string;
  parentValue: string;
  items: readonly CatalogProviderIntegrationOption[];
  fetchedAt: string;
  expiresAt: string;
  staleUntil: string;
  diagnosticCode: string | null;
  diagnosticText: string | null;
}>;

export type CatalogProviderOptionQueryCacheStore = Readonly<{
  read: (request: CatalogProviderOptionQueryRequest) => Promise<CatalogProviderOptionQueryCacheRecord | null>;
  write: (record: CatalogProviderOptionQueryCacheRecord) => Promise<void>;
}>;

export class CatalogProviderOptionQueryUnavailableError extends Error {
  readonly code = "catalog_provider_option_query_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "CatalogProviderOptionQueryUnavailableError";
  }
}

const DEFAULT_FRESH_TTL_SECONDS = 15 * 60;
const DEFAULT_STALE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

export function createPgCatalogProviderOptionQueryCacheStore(
  db: PgQueryable | null | undefined,
): CatalogProviderOptionQueryCacheStore | null {
  if (!db || typeof db.query !== "function") {
    return null;
  }

  return {
    async read(request) {
      const cacheKey = cacheKeyForProviderOptionQuery(request);
      const result = await db.query<{
        cache_key: string;
        provider_key: string;
        profile_key: string;
        profile_version: string;
        ingestion_unit_key: string;
        query_kind: string;
        language_code: string;
        parent_value: string;
        items_json: unknown;
        fetched_at: string | Date;
        expires_at: string | Date;
        stale_until: string | Date;
        diagnostic_code: string | null;
        diagnostic_text: string | null;
      }>(
        `SELECT
           cache_key,
           provider_key,
           profile_key,
           profile_version,
           ingestion_unit_key,
           query_kind,
           language_code,
           parent_value,
           items_json,
           fetched_at,
           expires_at,
           stale_until,
           diagnostic_code,
           diagnostic_text
         FROM catalog_provider_option_query_cache
         WHERE cache_key = $1`,
        [cacheKey],
      );
      const row = result.rows[0];
      if (!row || !isProviderOptionArray(row.items_json)) {
        return null;
      }

      return {
        cacheKey: row.cache_key,
        providerKey: row.provider_key,
        profileKey: row.profile_key,
        profileVersion: row.profile_version,
        ingestionUnitKey: row.ingestion_unit_key,
        queryKind: row.query_kind,
        languageCode: row.language_code,
        parentValue: row.parent_value,
        items: row.items_json,
        fetchedAt: isoDate(row.fetched_at),
        expiresAt: isoDate(row.expires_at),
        staleUntil: isoDate(row.stale_until),
        diagnosticCode: row.diagnostic_code,
        diagnosticText: row.diagnostic_text,
      };
    },
    async write(record) {
      await db.query(
        `INSERT INTO catalog_provider_option_query_cache (
         cache_key,
         provider_key,
         profile_key,
         profile_version,
         ingestion_unit_key,
         query_kind,
           language_code,
           parent_value,
           items_json,
           item_count,
           fetched_at,
           expires_at,
           stale_until,
           diagnostic_code,
           diagnostic_text,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::timestamptz, $12::timestamptz, $13::timestamptz, $14, $15, now())
         ON CONFLICT (cache_key) DO UPDATE SET
           items_json = EXCLUDED.items_json,
           item_count = EXCLUDED.item_count,
           fetched_at = EXCLUDED.fetched_at,
           expires_at = EXCLUDED.expires_at,
           stale_until = EXCLUDED.stale_until,
           diagnostic_code = EXCLUDED.diagnostic_code,
           diagnostic_text = EXCLUDED.diagnostic_text,
           updated_at = now()`,
        [
          record.cacheKey,
          record.providerKey,
          record.profileKey,
          record.profileVersion,
          record.ingestionUnitKey,
          record.queryKind,
          record.languageCode,
          record.parentValue,
          JSON.stringify(record.items),
          record.items.length,
          record.fetchedAt,
          record.expiresAt,
          record.staleUntil,
          record.diagnosticCode,
          record.diagnosticText,
        ],
      );
    },
  };
}

export async function queryCatalogProviderIntegrationOptionsWithCache(input: {
  request: CatalogProviderOptionQueryRequest;
  cacheStore: CatalogProviderOptionQueryCacheStore | null;
  loadLive: () => Promise<readonly CatalogProviderIntegrationOption[]>;
  now?: Date;
  freshTtlSeconds?: number;
  staleTtlSeconds?: number;
}): Promise<CatalogProviderOptionQueryPage> {
  const now = input.now ?? new Date();
  const request = normalizeRequest(input.request);
  const cacheKey = cacheKeyForProviderOptionQuery(request);
  const cached = await input.cacheStore?.read(request);
  const forceRefresh = request.forceRefresh === true;
  const cacheOnly = request.cacheOnly === true;

  if (cached && !forceRefresh && isFresh(cached, now)) {
    return pageFromItems(cached.items, request, {
      status: "fresh",
      source: "cache",
      cacheKey,
      fetchedAt: cached.fetchedAt,
      expiresAt: cached.expiresAt,
      staleUntil: cached.staleUntil,
      cacheOnly,
      forceRefresh,
      degraded: false,
      diagnostics: [],
    });
  }

  if (cacheOnly) {
    if (cached && isUsableStale(cached, now)) {
      return pageFromItems(cached.items, request, staleCacheSummary(cached, request, "cache-only"));
    }
    throw new CatalogProviderOptionQueryUnavailableError("Provider option query cache is empty for cache-only mode.");
  }

  try {
    const liveItems = await input.loadLive();
    const fetchedAt = now.toISOString();
    const expiresAt = addSeconds(now, input.freshTtlSeconds ?? DEFAULT_FRESH_TTL_SECONDS).toISOString();
    const staleUntil = addSeconds(now, input.staleTtlSeconds ?? DEFAULT_STALE_TTL_SECONDS).toISOString();
    await input.cacheStore?.write({
      cacheKey,
      providerKey: request.providerKey,
      profileKey: request.profileKey ?? "",
      profileVersion: request.profileVersion,
      ingestionUnitKey: request.ingestionUnitKey ?? "",
      queryKind: request.queryKind,
      languageCode: normalizedLanguageCode(request.languageCode),
      parentValue: normalizedParentValue(request.parentValue),
      items: liveItems,
      fetchedAt,
      expiresAt,
      staleUntil,
      diagnosticCode: null,
      diagnosticText: null,
    });

    return pageFromItems(liveItems, request, {
      status: forceRefresh ? "bypass" : "miss",
      source: "live",
      cacheKey,
      fetchedAt,
      expiresAt,
      staleUntil,
      cacheOnly,
      forceRefresh,
      degraded: false,
      diagnostics: [],
    });
  } catch (error) {
    if (cached && isUsableStale(cached, now)) {
      return pageFromItems(cached.items, request, staleCacheSummary(cached, request, messageForError(error)));
    }
    throw error;
  }
}

export function cacheKeyForProviderOptionQuery(request: CatalogProviderOptionQueryRequest): string {
  const normalized = {
    providerKey: normalizeKey(request.providerKey),
    profileKey: normalizeKey(request.profileKey ?? ""),
    profileVersion: request.profileVersion.trim(),
    ingestionUnitKey: normalizeKey(request.ingestionUnitKey ?? ""),
    queryKind: normalizeKey(request.queryKind),
    languageCode: normalizedLanguageCode(request.languageCode),
    parentValue: normalizedParentValue(request.parentValue),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

function normalizeRequest(request: CatalogProviderOptionQueryRequest): CatalogProviderOptionQueryRequest {
  return {
    ...request,
    providerKey: normalizeKey(request.providerKey),
    profileKey: normalizeKey(request.profileKey ?? ""),
    queryKind: normalizeKey(request.queryKind),
    profileVersion: request.profileVersion.trim(),
    ingestionUnitKey: normalizeKey(request.ingestionUnitKey ?? ""),
    languageCode: normalizedLanguageCode(request.languageCode),
    parentValue: normalizedParentValue(request.parentValue),
    cursor: normalizeCursor(request.cursor),
    limit: normalizeLimit(request.limit),
    forceRefresh: request.forceRefresh === true,
    cacheOnly: request.cacheOnly === true,
  };
}

function pageFromItems(
  items: readonly CatalogProviderIntegrationOption[],
  request: CatalogProviderOptionQueryRequest,
  cache: CatalogProviderOptionQueryCacheSummary,
): CatalogProviderOptionQueryPage {
  const limit = normalizeLimit(request.limit);
  const offset = cursorOffset(request.cursor);
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  const hasMore = nextOffset < items.length;
  return {
    items: pageItems,
    total: items.length,
    count: pageItems.length,
    page: {
      cursor: normalizeCursor(request.cursor),
      nextCursor: hasMore ? `offset:${nextOffset}` : null,
      limit,
      hasMore,
    },
    cache,
  };
}

function staleCacheSummary(
  cached: CatalogProviderOptionQueryCacheRecord,
  request: CatalogProviderOptionQueryRequest,
  reason: string,
): CatalogProviderOptionQueryCacheSummary {
  return {
    status: "stale",
    source: "cache",
    cacheKey: cached.cacheKey,
    fetchedAt: cached.fetchedAt,
    expiresAt: cached.expiresAt,
    staleUntil: cached.staleUntil,
    cacheOnly: request.cacheOnly === true,
    forceRefresh: request.forceRefresh === true,
    degraded: true,
    diagnostics: [
      {
        code: "provider-option-query-stale-cache-used",
        severity: "warning",
        message: reason,
        retryAfterSeconds: null,
      },
    ],
  };
}

function isFresh(record: CatalogProviderOptionQueryCacheRecord, now: Date): boolean {
  return Date.parse(record.expiresAt) >= now.getTime();
}

function isUsableStale(record: CatalogProviderOptionQueryCacheRecord, now: Date): boolean {
  return Date.parse(record.staleUntil) >= now.getTime();
}

function isProviderOptionArray(value: unknown): value is readonly CatalogProviderIntegrationOption[] {
  return Array.isArray(value) && value.every(isProviderOption);
}

function isProviderOption(value: unknown): value is CatalogProviderIntegrationOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.providerKey === "string" &&
    typeof record.queryKind === "string" &&
    typeof record.value === "string" &&
    typeof record.label === "string" &&
    (typeof record.description === "string" || record.description === null) &&
    (typeof record.parentValue === "string" || record.parentValue === null) &&
    (typeof record.imageUrl === "string" || record.imageUrl === null) &&
    (record.aliases === undefined || Array.isArray(record.aliases)) &&
    typeof record.metadata === "object" &&
    record.metadata !== null &&
    !Array.isArray(record.metadata)
  );
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizedLanguageCode(value: string | null | undefined): string {
  return normalizeKey(value || "en");
}

function normalizedParentValue(value: string | null | undefined): string {
  return value?.trim() || "";
}

function normalizeCursor(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeLimit(value: number | null | undefined): number {
  if (!Number.isInteger(value) || !value || value < 1) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(value, MAX_PAGE_LIMIT);
}

function cursorOffset(cursor: string | null | undefined): number {
  const normalized = normalizeCursor(cursor);
  if (!normalized) {
    return 0;
  }
  const parsed = /^offset:(\d+)$/.exec(normalized);
  return parsed ? Number(parsed[1]) : 0;
}

function addSeconds(value: Date, seconds: number): Date {
  return new Date(value.getTime() + seconds * 1000);
}

function isoDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function messageForError(error: unknown): string {
  return error instanceof Error ? error.message : "Provider option query failed.";
}
