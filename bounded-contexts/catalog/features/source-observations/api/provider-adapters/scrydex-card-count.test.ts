import { describe, expect, it, vi } from "vitest";
import {
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY as unitKey,
} from "./scrydex-one-piece";
import {
  cacheKeyForProviderOptionQuery,
  type CatalogProviderOptionQueryCacheRecord,
  type CatalogProviderOptionQueryCacheStore,
  type CatalogProviderOptionQueryRequest,
} from "../providers/provider-option-query-cache";
import { queryProviderIntegrationOptions } from "../providers/provider-option-queries";
import { ProviderAdapterRegistry } from "./registry";
import {
  createProviderSendAdmission,
  runCatalogProviderWork,
  type ProviderSendLedger,
} from "../providers/provider-send-admission";
import { SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY } from "./scrydex-one-piece";

const now = new Date("2026-09-30T12:00:00Z");
const request: CatalogProviderOptionQueryRequest = {
  providerKey: "scrydex",
  profileKey: "lorcana-card-print-source-observation",
  profileVersion: "2026.06.23",
  ingestionUnitKey: unitKey,
  queryKind: "cards",
  languageCode: "en",
  parentValue: "TFC",
};
const scope = { unitKey, scopeKey: "expansion-cards", values: { expansionId: "TFC", language: "en" } };
const baseUrl = "https://synthetic.fixture.local/lorcana/v1";

// Synthetic provider envelopes match the existing total_count/page_size validator.
function syntheticPage(page: number, total = 3) {
  const count = Math.min(2, Math.max(0, total - (page - 1) * 2));
  return {
    page,
    page_size: 2,
    total_count: total,
    count,
    data: Array.from({ length: count }, (_, index) => ({
      id: `synthetic-tfc-${page}-${index}`,
      name: `Synthetic card ${page}-${index}`,
      language_code: "en",
      printings: ["TFC"],
      expansion: { id: "TFC", name: "Synthetic TFC" },
    })),
  };
}

function record(patch: Partial<CatalogProviderOptionQueryCacheRecord> = {}): CatalogProviderOptionQueryCacheRecord {
  return {
    cacheKey: cacheKeyForProviderOptionQuery(request),
    providerKey: "scrydex",
    profileKey: request.profileKey!,
    profileVersion: request.profileVersion,
    ingestionUnitKey: unitKey,
    queryKind: "cards",
    languageCode: "en",
    parentValue: "TFC",
    items: Array.from({ length: 3 }, (_, index) => ({
      providerKey: "scrydex",
      queryKind: "cards",
      value: `synthetic-${index}`,
      label: `Synthetic ${index}`,
      description: null,
      parentValue: "TFC",
      imageUrl: null,
      aliases: [],
      metadata: {},
    })),
    itemCount: 3,
    totalCount: 3,
    pageSize: 2,
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 900_000).toISOString(),
    staleUntil: new Date(now.getTime() + 86_400_000).toISOString(),
    diagnosticCode: null,
    diagnosticText: null,
    ...patch,
  };
}

function store(initial: CatalogProviderOptionQueryCacheRecord | null = null) {
  let cached = initial;
  const read = vi.fn(async () => cached);
  const write = vi.fn(async (value: CatalogProviderOptionQueryCacheRecord) => {
    cached = value;
  });
  return { read, write } satisfies CatalogProviderOptionQueryCacheStore;
}

function adapter(cacheStore: CatalogProviderOptionQueryCacheStore, fetch: typeof globalThis.fetch) {
  return createScrydexOnePieceProviderAdapter({
    cacheStore,
    credentials: { apiKey: "synthetic-api-key", teamId: "synthetic-team" },
    lorcanaBaseUrl: baseUrl,
    baseUrl: baseUrl.replace("lorcana", "onepiece"),
    now: () => now,
    fetch,
  });
}

describe("Scrydex exact cached card estimate", () => {
  const binding = { windowId: "synthetic-window", phase: "pass" as const, pass: 1 };
  function guarded(maximum: number | null = null) {
    const ledger: ProviderSendLedger = {
      bind: async () => binding,
      debit: async () => ({ state: "admitted", windowId: binding.windowId, sequence: 1 }),
      settle: async () => undefined,
      stop: async () => undefined,
      maximum: async () => maximum,
    };
    return createProviderSendAdmission({ enabled: true, ledger });
  }
  it("armed Card planning rejects absent and stale exact observations, not a fabricated maximum", async () => {
    for (const observation of [null, record({ fetchedAt: new Date(now.getTime() - 900_001).toISOString() })]) {
      const subject = adapter(store(observation), async () => Response.json({ data: {} }));
      await expect(runCatalogProviderWork(guarded(256), () => subject.planImport(scope))).rejects.toThrow(
        "unknown-request",
      );
    }
  });
  it("ordinal 18 keeps an unavailable estimate distinct from its installed maximum", async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0]) => Response.json({ data: {} }));
    const subject = adapter(store(), fetch);
    const sealedScope = {
      unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "expansion-sealed-products",
      values: { expansionId: "synthetic-ordinal-18", language: "en" },
    };
    await expect(runCatalogProviderWork(guarded(), () => subject.planImport(sealedScope))).rejects.toThrow(
      "unknown-request",
    );
    const plan = await runCatalogProviderWork(guarded(256), () => subject.planImport(sealedScope));
    expect(plan.usageEstimate).toMatchObject({
      estimateState: "estimate-unavailable",
      estimatedRequestCount: null,
      enforcedAdmissionMaximum: { label: "enforced-admission-maximum", requestCount: 256, windowId: binding.windowId },
    });
    expect(fetch.mock.calls.every((call) => String(call[0]).includes("/account/v1/usage"))).toBe(true);
  });
  it.each([3, 0])("estimates validated synthetic count %i using observed size, not requested 250", async (count) => {
    const cache = store(record({ itemCount: count, totalCount: count, items: count === 0 ? [] : record().items }));
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0]) => Response.json({ data: {} }));
    const plan = await adapter(cache, fetch).planImport(scope);
    expect(plan.usageEstimate).toMatchObject({
      estimatedRequestCount: Math.max(1, Math.ceil(count / 2)),
      estimateState: "estimated",
      pageSize: 2,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/account/v1/usage");
    expect(cache.read).toHaveBeenCalledWith(request);
  });

  const invalid: Array<[string, Partial<CatalogProviderOptionQueryCacheRecord> | null]> = [
    ["missing", null],
    ["old display-usable", { fetchedAt: new Date(now.getTime() - 900_001).toISOString() }],
    ["future", { fetchedAt: new Date(now.getTime() + 1).toISOString() }],
    ["malformed timestamp", { fetchedAt: "invalid" }],
    ["expired", { expiresAt: new Date(now.getTime() - 1).toISOString() }],
    ["malformed expiry", { expiresAt: "invalid" }],
    ["incomplete", { itemCount: 2 }],
    ["no count branch", { totalCount: null, pageSize: null }],
    ["wrong query", { parentValue: "OP01" }],
    ["wrong language", { languageCode: "fr" }],
    ["wrong profile", { profileKey: "other" }],
    ["wrong version", { profileVersion: "other" }],
    ["wrong unit", { ingestionUnitKey: "other" }],
    ["wrong provider", { providerKey: "other" }],
    ["wrong kind", { queryKind: "sets" }],
    ["wrong key", { cacheKey: "synthetic-wrong-key" }],
    ["negative", { itemCount: -1, totalCount: -1 }],
    ["fraction", { itemCount: 2.5, totalCount: 2.5 }],
    ["overflow", { itemCount: Number.MAX_SAFE_INTEGER + 1 }],
    ["zero mismatch", { itemCount: 0, totalCount: 0 }],
    ["zero page size", { pageSize: 0 }],
    ["missing size", { pageSize: undefined }],
    ["fractional size", { pageSize: 1.5 }],
  ];
  it.each(invalid)("fails closed for %s with only the existing usage request", async (_label, patch) => {
    const cache = store(patch === null ? null : record(patch));
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      expect(new URL(String(input)).pathname).toBe("/account/v1/usage");
      return Response.json({ data: {} });
    });
    const plan = await adapter(cache, fetch).planImport(scope);
    expect(plan.usageEstimate).toMatchObject({ estimatedRequestCount: null, estimateState: "estimate-unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.write).not.toHaveBeenCalled();
  });

  it("accepts the exact 15-minute boundary but rejects a cache read failure", async () => {
    const cache = store(
      record({ fetchedAt: new Date(now.getTime() - 900_000).toISOString(), expiresAt: now.toISOString() }),
    );
    const subject = adapter(cache, async () => Response.json({ data: {} }));
    expect((await subject.planImport(scope)).usageEstimate?.estimatedRequestCount).toBe(2);
    cache.read.mockRejectedValueOnce(new Error("synthetic cache failure"));
    expect((await subject.planImport(scope)).usageEstimate?.estimatedRequestCount).toBeNull();
  });

  it.each(["complete", "inconsistent", "transport failure", "no metadata", "mixed metadata"])(
    "writes imports only after %s pagination completes",
    async (mode) => {
      const cache = store();
      const subject = adapter(cache, async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/usage")) return Response.json({ data: {} });
        expect(cache.write).not.toHaveBeenCalled();
        expect(url.searchParams.get("q")).toBe("printings:TFC");
        expect(url.searchParams.get("page_size")).toBe("250");
        const page = Number(url.searchParams.get("page"));
        if (page === 2 && mode === "transport failure") throw new Error("synthetic transport failure");
        if (mode === "no metadata") return Response.json({ data: syntheticPage(1).data });
        if (mode === "mixed metadata" && page === 1)
          return Response.json({ data: syntheticPage(1).data, total_pages: 2 });
        return Response.json({
          ...syntheticPage(page),
          ...(page === 2 && mode === "inconsistent" ? { total_count: 4 } : {}),
        });
      });
      const plan = await subject.planImport(scope);
      const consume = async () => {
        for await (const _payload of subject.fetchPayloads(plan)) {
          /* consume synthetic observation */
        }
      };
      if (mode === "inconsistent" || mode === "transport failure") {
        await expect(consume()).rejects.toThrow();
        expect(cache.write).not.toHaveBeenCalled();
      } else {
        await consume();
        expect(cache.write).toHaveBeenCalledTimes(1);
        expect(cache.write.mock.calls[0]?.[0]).toMatchObject({
          ...request,
          itemCount: mode === "no metadata" ? 2 : 3,
          totalCount: mode === "complete" ? 3 : null,
          pageSize: mode === "complete" ? 2 : null,
        });
        expect((await subject.planImport(scope)).usageEstimate?.estimatedRequestCount).toBe(
          mode === "complete" ? 2 : null,
        );
      }
    },
  );

  it.each(["complete", "inconsistent", "no metadata", "total_pages", "has_more", "next_page"])(
    "ordinary options retain only completed count evidence for %s",
    async (mode) => {
      const writes: unknown[][] = [];
      const query = async <Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[],
      ): Promise<{ rows: Row[] }> => {
        if (sql.includes("INSERT INTO catalog_provider_option_query_cache")) writes.push([...(values ?? [])]);
        return { rows: [] };
      };
      const adapterCache = store();
      const subject = adapter(adapterCache, async (input) => {
        expect(writes).toHaveLength(0);
        const page = Number(new URL(String(input)).searchParams.get("page"));
        if (mode === "no metadata") return Response.json({ data: syntheticPage(1).data });
        if (["total_pages", "has_more", "next_page"].includes(mode))
          return Response.json({
            data: syntheticPage(1).data,
            total_pages: mode === "total_pages" ? 1 : undefined,
            has_more: mode === "has_more" ? false : undefined,
            next_page: mode === "next_page" ? null : undefined,
          });
        return Response.json({
          ...syntheticPage(page),
          ...(page === 2 && mode === "inconsistent" ? { count: 0 } : {}),
        });
      });
      const run = () =>
        queryProviderIntegrationOptions(
          { ...request, forceRefresh: true },
          { query },
          null,
          undefined,
          undefined,
          new ProviderAdapterRegistry([subject]),
        );
      if (mode === "inconsistent") {
        await expect(run()).rejects.toThrow("pagination metadata");
        expect(writes).toHaveLength(0);
      } else {
        const page = await run();
        expect(page.items).toHaveLength(mode === "complete" ? 3 : 2);
        expect(writes).toHaveLength(1);
        expect(writes[0]?.[9]).toBe(mode === "complete" ? 3 : 2);
        expect(writes[0]?.slice(15, 17)).toEqual(mode === "complete" ? [3, 2] : [null, null]);
      }
      expect(adapterCache.write).not.toHaveBeenCalled();
    },
  );

  it.each(["complete", "inconsistent"])(
    "unwrapped ordinary card options persist only after %s validation",
    async (mode) => {
      const cache = store();
      const subject = adapter(cache, async (input) => {
        expect(cache.write).not.toHaveBeenCalled();
        const page = Number(new URL(String(input)).searchParams.get("page"));
        return Response.json({
          ...syntheticPage(page),
          ...(mode === "inconsistent" && page === 2 ? { count: 0 } : {}),
        });
      });
      const query = () => subject.listOptions({ unitKey, optionKind: "cards", parentValues: { expansionId: "TFC" } });
      if (mode === "complete") {
        expect((await query()).items).toHaveLength(3);
        expect(cache.write).toHaveBeenCalledTimes(1);
        expect(cache.write.mock.calls[0]?.[0]).toMatchObject({ ...request, itemCount: 3, totalCount: 3, pageSize: 2 });
      } else {
        await expect(query()).rejects.toThrow("pagination metadata");
        expect(cache.write).not.toHaveBeenCalled();
      }
    },
  );
});
