import { describe, expect, it, vi } from "vitest";
import {
  CatalogProviderOptionQueryUnavailableError,
  cacheKeyForProviderOptionQuery,
  queryCatalogProviderIntegrationOptionsWithCache,
  type CatalogProviderOptionQueryCacheRecord,
  type CatalogProviderOptionQueryCacheStore,
  type CatalogProviderOptionQueryRequest,
} from "./provider-option-query-cache";
import type { CatalogProviderIntegrationOption } from "./provider-option-query-resolver";

describe("queryCatalogProviderIntegrationOptionsWithCache", () => {
  it("caches live results and returns cursor pagination metadata", async () => {
    const store = memoryStore();
    const request = optionRequest({ limit: 1 });
    const loadLive = vi.fn(async () => [option("swsh"), option("sv")]);

    const result = await queryCatalogProviderIntegrationOptionsWithCache({
      request,
      cacheStore: store,
      loadLive,
      now: new Date("2026-06-08T10:00:00.000Z"),
    });

    expect(result.items.map((item) => item.value)).toEqual(["swsh"]);
    expect(result.total).toBe(2);
    expect(result.page).toMatchObject({ limit: 1, nextCursor: "offset:1", hasMore: true });
    expect(result.cache).toMatchObject({ status: "miss", source: "live", degraded: false });
    expect(loadLive).toHaveBeenCalledTimes(1);
    await expect(store.read(request)).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ value: "sv" })]),
    });
  });

  it("uses fresh cached results without calling live transport", async () => {
    const store = memoryStore([
      cacheRecord(optionRequest(), {
        items: [option("cached")],
        fetchedAt: "2026-06-08T09:59:00.000Z",
        expiresAt: "2026-06-08T10:10:00.000Z",
        staleUntil: "2026-06-09T10:00:00.000Z",
      }),
    ]);
    const loadLive = vi.fn(async () => [option("live")]);

    const result = await queryCatalogProviderIntegrationOptionsWithCache({
      request: optionRequest(),
      cacheStore: store,
      loadLive,
      now: new Date("2026-06-08T10:00:00.000Z"),
    });

    expect(result.items.map((item) => item.value)).toEqual(["cached"]);
    expect(result.cache).toMatchObject({ status: "fresh", source: "cache", degraded: false });
    expect(loadLive).not.toHaveBeenCalled();
  });

  it("falls back to stale cache when live transport fails", async () => {
    const store = memoryStore([
      cacheRecord(optionRequest(), {
        items: [option("stale")],
        fetchedAt: "2026-06-08T08:00:00.000Z",
        expiresAt: "2026-06-08T09:00:00.000Z",
        staleUntil: "2026-06-09T10:00:00.000Z",
      }),
    ]);

    const result = await queryCatalogProviderIntegrationOptionsWithCache({
      request: optionRequest(),
      cacheStore: store,
      loadLive: async () => {
        throw new Error("provider rate limited");
      },
      now: new Date("2026-06-08T10:00:00.000Z"),
    });

    expect(result.items.map((item) => item.value)).toEqual(["stale"]);
    expect(result.cache).toMatchObject({ status: "stale", source: "cache", degraded: true });
    expect(result.cache.diagnostics[0]).toMatchObject({
      code: "provider-option-query-stale-cache-used",
      severity: "warning",
    });
  });

  it("blocks cache-only mode when no cached page exists", async () => {
    await expect(
      queryCatalogProviderIntegrationOptionsWithCache({
        request: optionRequest({ cacheOnly: true }),
        cacheStore: memoryStore(),
        loadLive: async () => [option("live")],
        now: new Date("2026-06-08T10:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(CatalogProviderOptionQueryUnavailableError);
  });

  it("separates same-provider option caches by profile key and ingestion unit", async () => {
    const pokemonRequest = optionRequest({
      profileKey: "pokemon-tcg",
      ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
    });
    const magicRequest = optionRequest({
      profileKey: "magic-card-profile",
      ingestionUnitKey: "tcgdex:mtg:single-card:source-observation-import",
    });
    const store = memoryStore([
      cacheRecord(pokemonRequest, {
        items: [option("pokemon")],
        fetchedAt: "2026-06-08T09:59:00.000Z",
        expiresAt: "2026-06-08T10:10:00.000Z",
        staleUntil: "2026-06-09T10:00:00.000Z",
      }),
    ]);

    expect(cacheKeyForProviderOptionQuery(pokemonRequest)).not.toBe(cacheKeyForProviderOptionQuery(magicRequest));
    await expect(store.read(magicRequest)).resolves.toBeNull();
  });
});

function optionRequest(patch: Partial<CatalogProviderOptionQueryRequest> = {}): CatalogProviderOptionQueryRequest {
  return {
    providerKey: "tcgdex",
    profileVersion: "2026.06.03",
    queryKind: "series",
    languageCode: "en",
    parentValue: null,
    ...patch,
  };
}

function option(value: string): CatalogProviderIntegrationOption {
  return {
    providerKey: "tcgdex",
    queryKind: "series",
    value,
    label: value.toUpperCase(),
    description: null,
    parentValue: null,
    imageUrl: null,
    aliases: [],
    metadata: {},
  };
}

function cacheRecord(
  request: CatalogProviderOptionQueryRequest,
  patch: Pick<CatalogProviderOptionQueryCacheRecord, "items" | "fetchedAt" | "expiresAt" | "staleUntil">,
): CatalogProviderOptionQueryCacheRecord {
  return {
    cacheKey: cacheKeyForProviderOptionQuery(request),
    providerKey: request.providerKey,
    profileKey: request.profileKey ?? "",
    profileVersion: request.profileVersion,
    ingestionUnitKey: request.ingestionUnitKey ?? "",
    queryKind: request.queryKind,
    languageCode: request.languageCode ?? "en",
    parentValue: request.parentValue ?? "",
    diagnosticCode: null,
    diagnosticText: null,
    ...patch,
  };
}

function memoryStore(
  records: readonly CatalogProviderOptionQueryCacheRecord[] = [],
): CatalogProviderOptionQueryCacheStore {
  const recordsByKey = new Map(records.map((record) => [record.cacheKey, record]));
  return {
    async read(request) {
      return recordsByKey.get(cacheKeyForProviderOptionQuery(request)) ?? null;
    },
    async write(record) {
      recordsByKey.set(record.cacheKey, record);
    },
  };
}
