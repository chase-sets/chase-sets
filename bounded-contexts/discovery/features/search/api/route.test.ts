import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createDiscoveryItemSearchRuntime, type DiscoveryItemSearchServices } from "./runtime";
import { discoveryItemSearchRoutes } from "./route";
import { DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS } from "../domain/normalization";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { Hono } from "hono";

// Plays the Search Index for one relevance Result Set: an exact first row and one other,
// applying the emitted keyset and LIMIT/OFFSET bindings.
function scriptedSearchDb() {
  const listCalls: Array<readonly unknown[]> = [];
  const row = (id: string, title: string, tier: number) => ({
    catalog_item_id: id,
    slug: id,
    title,
    subtitle: null,
    updated_at: "2026-05-16T00:00:00.000Z",
    lowest_price_amount: null,
    lowest_price_currency_code: null,
    visible_quantity: null,
    search_rank: tier === 1 ? 0.1 : 0.9,
    search_base_match: true,
    search_exact_tier: tier,
    search_title_identity: title.toLowerCase(),
  });
  const rowsFor = (sql: string, values: readonly unknown[]): unknown[] => {
    if (sql.startsWith("SELECT COUNT(*) AS count")) return [{ count: "2" }];
    if (sql.includes("AS slug, COUNT(DISTINCT")) return [{ slug: "cards", count: 2 }];
    if (!sql.startsWith("SELECT * FROM (")) return [];
    listCalls.push(values);
    const exact = row("cat_exact", "Charizard ex", 1);
    const other = row("cat_other", "Charizard ex Box", 0);
    const ordered = sql.includes("search_rank) < (") ? [other] : [exact, other];
    const offset = sql.includes("OFFSET $") ? Number(values.at(-1)) : 0;
    return ordered.slice(offset, offset + Number(values.at(sql.includes("OFFSET $") ? -2 : -1)));
  };
  const db: PgQueryable = {
    query: async <Row>(sql: string, values: readonly unknown[] = []) => {
      const rows = rowsFor(sql, values);
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };
  return { db, listCalls };
}

function decodeCursorJson(cursor: unknown): unknown {
  return JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
}

const legacyRelevanceCursor = Buffer.from(JSON.stringify({ id: "cat_old", title: "Old", rank: 0.9 })).toString(
  "base64url",
);

function createServices(): DiscoveryItemSearchServices {
  return {
    suggestItems: vi.fn(async () => []),
    searchItems: vi.fn(async () => ({
      items: [],
      facets: [],
      category_counts: [],
      total: 0,
      nextCursor: null,
      retrievalMode: "lexical" as const,
      lexicalCount: 0,
      cursorState: "fresh" as const,
      queryHash: "",
      resultSetKey: "",
    })),
    previewBulkAdd: vi.fn(async () => ({
      totalMatches: 0,
      eligibleCount: 0,
      skippedCount: 0,
      overLimit: false,
      limit: 250,
      lines: [],
      skippedItems: [],
    })),
    rebuildSearchIndex: vi.fn(async () => undefined),
    publishSearchOutcome: vi.fn(async () => undefined),
    projectors: [],
  };
}

describe("discovery item search routes", () => {
  it("exposes corrected mode through the real runtime and HTTP route without raw query telemetry", async () => {
    const statements: string[] = [];
    const db: PgQueryable = {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        statements.push(sql);
        const rows = sql.startsWith("SELECT EXISTS")
          ? [{ literal: false, prefix: false, candidates: ["charizard"] }]
          : sql.startsWith("SELECT * FROM (") && String(values[1]).includes("charizard")
            ? [
                {
                  catalog_item_id: "right",
                  slug: "right",
                  title: "Charizard",
                  subtitle: "Base Set",
                  lowest_price_amount: null,
                  lowest_price_currency_code: null,
                  visible_quantity: null,
                },
              ]
            : [];
        return { rows: rows as Row[], rowCount: rows.length };
      },
    };
    const recordSearchQuery = vi.fn();
    const runtime = createDiscoveryItemSearchRuntime(
      { db, eventStore: {} as never, checkpointStore: {} as never },
      { recordSearchQuery },
    );
    const response = await discoveryItemSearchRoutes(runtime).request("/?search=chraizard&limit=1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ catalog_item_id: "right" }],
      retrievalMode: "corrected",
      lexicalCount: 0,
      total: 1,
      count: 1,
      nextCursor: null,
      facets: [],
      category_counts: [],
    });
    expect(statements.filter((sql) => sql.startsWith("SELECT EXISTS"))).toHaveLength(1);
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ retrievalMode: "corrected", queryEmbeddingOutcome: "not-attempted", resultCount: 1 }),
    );
    expect(JSON.stringify(recordSearchQuery.mock.calls)).not.toContain("chraizard");
  });
  it.each(["price_asc", "price_desc"])(
    "selected price cursor restarts over HTTP then continues pv=2: %s",
    async (sort) => {
      const calls: string[] = [];
      const db: PgQueryable = {
        query: async <Row>(sql: string) => {
          calls.push(sql);
          const rows = sql.startsWith("SELECT COUNT(*)")
            ? [{ count: "2" }]
            : sql.includes("AS slug, COUNT(DISTINCT")
              ? [{ slug: "cards", count: 2 }]
              : sql.startsWith("SELECT catalog_item_id")
                ? sql.includes("selected_market.lowest_price_amount IS NULL AND")
                  ? [{ catalog_item_id: "b", title: "B", lowest_price_amount: null }]
                  : [
                      { catalog_item_id: "a", title: "A", lowest_price_amount: null },
                      { catalog_item_id: "b", title: "B", lowest_price_amount: null },
                    ]
                : [];
          return { rows: rows as Row[], rowCount: rows.length };
        },
      };
      const app = discoveryItemSearchRoutes(
        createDiscoveryItemSearchRuntime({ db, eventStore: {} as never, checkpointStore: {} as never }),
      );
      const query = `sort=${sort}&dimension.finish=foil&limit=1`;
      const legacy = Buffer.from(JSON.stringify({ id: "old", lowestPriceAmount: "2" })).toString("base64url");
      const restarted = await (await app.request(`/?${query}&cursor=${legacy}&offset=40`)).json();
      expect(restarted).toMatchObject({
        cursorRestarted: true,
        total: 2,
        category_counts: [{ slug: "cards", count: 2 }],
      });
      expect(decodeCursorJson(restarted.nextCursor)).toMatchObject({ pv: 2, id: "a", lowestPriceAmount: null });
      expect(calls.some((sql) => sql.includes("OFFSET $"))).toBe(false);
      const next = await (await app.request(`/?${query}&cursor=${restarted.nextCursor}`)).json();
      expect(next).not.toHaveProperty("cursorRestarted");
      expect(next).toMatchObject({ total: null, category_counts: [], nextCursor: null });
      expect(next.items[0].catalog_item_id).toBe("b");
    },
  );
  it("threads HTTP cancellation to the runtime without changing the response contract", async () => {
    const controller = new AbortController();
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);
    const request = new Request("http://localhost/?search=pikachu", { signal: controller.signal });
    await app.request(request);
    const signal = vi.mocked(services.searchItems).mock.calls[0]?.[1]?.signal;
    expect(signal).toBe(request.signal);
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("threads the active trace correlation to search retrieval", async () => {
    const services = createServices();
    const app = new Hono<AuthenticatedApiEnv>();
    app.use("*", async (c, next) => {
      c.set("context", { trace: { traceId: "0123456789abcdef0123456789abcdef" } } as never);
      await next();
    });
    app.route("/", discoveryItemSearchRoutes(services));

    const response = await app.request("/?search=pikachu");
    expect(response.status).toBe(200);
    expect(vi.mocked(services.searchItems).mock.calls[0]?.[1]).toMatchObject({
      signal: expect.any(AbortSignal),
      correlationId: "0123456789abcdef0123456789abcdef",
    });
  });
  it.each([
    ["typo plus PSA 10", "charzard psa 10", "charzard", "corrected"],
    ["nickname plus grade", "zard psa 10", "zard", "lexical"],
  ])(
    "direct API and canonical URL return the same final rows for %s",
    async (_name, search, remainingQuery, retrievalMode) => {
      const company = "dimension.dim_seed_grading_company";
      const grade = "dimension.dim_seed_grade";
      const vocabularyReads: string[] = [];
      const db: PgQueryable = {
        query: async <Row>(sql: string, values: readonly unknown[] = []) => {
          let rows: unknown[] = [];
          if (sql.includes("FROM discovery_search_catalog_dimension_options")) {
            vocabularyReads.push(sql);
            rows = [
              {
                dimension_id: "dim_seed_grading_company",
                option_id: "psa",
                code: "psa",
                label: "PSA",
                numeric_value: null,
              },
              {
                dimension_id: "dim_seed_grade",
                option_id: "gm10",
                code: "gem-mint-10",
                label: "Gem Mint 10",
                numeric_value: "10",
              },
              {
                dimension_id: "dim_seed_grade",
                option_id: "p10",
                code: "pristine-10",
                label: "Pristine 10",
                numeric_value: "10.5",
              },
            ];
          } else if (sql.startsWith("SELECT EXISTS")) {
            rows = [{ literal: false, prefix: false, candidates: ["charizard"] }];
          } else if (
            sql.startsWith("SELECT * FROM (") &&
            values.includes("dim_seed_grade") &&
            String(values[1]).includes("charizard")
          ) {
            rows = [{ catalog_item_id: "charizard-psa-10", slug: "charizard-psa-10", title: "Charizard" }];
          }
          return { rows: rows as Row[], rowCount: rows.length };
        },
      };
      const app = discoveryItemSearchRoutes(
        createDiscoveryItemSearchRuntime({ db, eventStore: {} as never, checkpointStore: {} as never }),
      );

      const direct = await (await app.request(`/?${new URLSearchParams({ search, limit: "24" })}`)).json();
      expect(direct).toMatchObject({
        retrievalMode,
        nextCursor: null,
        interpretation: {
          remainingQuery,
          applied: [
            { param: company, optionId: "psa", label: "PSA" },
            { param: grade, optionId: "gm10", label: "Gem Mint 10" },
          ],
        },
      });
      expect(vocabularyReads).toHaveLength(1);

      const canonical = new URLSearchParams({
        search: remainingQuery,
        limit: "24",
        interpreted: `${company},${grade}`,
      });
      canonical.append(company, "psa");
      canonical.append(grade, "gm10");
      const marked = await (await app.request(`/?${canonical}`)).json();
      expect(marked).not.toHaveProperty("interpretation");
      expect(marked.items).toEqual(direct.items);
      expect(marked.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).toEqual([
        "charizard-psa-10",
      ]);
      expect(vocabularyReads).toHaveLength(1);
    },
  );

  it("returns interpretation metadata only when the runtime interpreted the request", async () => {
    const services = createServices();
    const interpretation = {
      remainingQuery: "charizard",
      applied: [{ param: "language" as const, language: "ja", label: "Japanese" }],
    };
    vi.mocked(services.searchItems).mockResolvedValueOnce({
      ...(await services.searchItems()),
      interpretation,
    });
    const app = discoveryItemSearchRoutes(services);
    await expect((await app.request("/?search=charizard%20japanese")).json()).resolves.toMatchObject({
      interpretation,
    });
    await expect((await app.request("/?search=charizard")).json()).resolves.not.toHaveProperty("interpretation");
    expect(vi.mocked(services.searchItems).mock.calls.at(-1)?.[0]).not.toHaveProperty("interpreted", true);
    await app.request("/?search=charizard&interpreted=language");
    expect(vi.mocked(services.searchItems).mock.calls.at(-1)?.[0]).toMatchObject({ interpreted: true });
  });

  it("preserves runtime query and Result Set identities in the search JSON response", async () => {
    const services = createServices();
    const queryHash = "a".repeat(64);
    const resultSetKey = "b".repeat(64);
    vi.mocked(services.searchItems).mockResolvedValue({
      items: [],
      facets: [],
      category_counts: [],
      total: 0,
      nextCursor: null,
      retrievalMode: "lexical",
      lexicalCount: 0,
      cursorState: "fresh",
      queryHash,
      resultSetKey,
    });
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request("/?search=pikachu");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      queryHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      resultSetKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(services.searchItems).toHaveBeenCalledWith(expect.objectContaining({ search: "pikachu" }), {
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps lexical observations and bounded interpretation outcomes out of the HTTP envelope", async () => {
    const recordSearchQuery = vi.fn();
    const { db } = scriptedSearchDb();
    const app = discoveryItemSearchRoutes(
      createDiscoveryItemSearchRuntime(
        { db, eventStore: {} as never, checkpointStore: {} as never },
        { recordSearchQuery },
      ),
    );
    const response = await app.request("/?search=Charizard%20ex&includeTotal=true");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual([
      "category_counts",
      "count",
      "facets",
      "items",
      "lexicalCount",
      "nextCursor",
      "queryHash",
      "resultSetKey",
      "retrievalMode",
      "total",
    ]);
    expect(body).toMatchObject({ retrievalMode: "lexical", lexicalCount: 2, total: 2 });
    expect(recordSearchQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ lexicalZero: false, zeroResults: false, interpretation: "not-applied" }),
    );
  });

  it("returns bounded active-item prefix suggestions", async () => {
    const services = createServices();
    vi.mocked(services.suggestItems).mockResolvedValue([
      {
        catalogItemId: "cat_1",
        title: "Charizard ex",
        subtitle: "Obsidian Flames 125/197",
        slug: "charizard-ex-cat-1",
        category: "Pokemon TCG",
      },
    ]);
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request("/suggest?q=char&limit=1000");

    expect(response.status).toBe(200);
    expect(services.suggestItems).toHaveBeenCalledWith("char", 1000);
    expect(await response.json()).toEqual({
      items: [
        {
          catalogItemId: "cat_1",
          title: "Charizard ex",
          subtitle: "Obsidian Flames 125/197",
          slug: "charizard-ex-cat-1",
          category: "Pokemon TCG",
        },
      ],
      count: 1,
    });
  });

  it("forwards synonym suggestion text unchanged", async () => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);
    const response = await app.request("/suggest?q=zard%204%2F102");
    expect(response.status).toBe(200);
    expect(services.suggestItems).toHaveBeenCalledWith("zard 4/102", undefined);
  });

  it("returns an empty suggestion list for an empty query", async () => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request("/suggest?q=");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], count: 0 });
  });

  it("caps suggestion query length by Unicode code point", async () => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);
    const query = "検索".repeat(100);

    const response = await app.request(`/suggest?q=${encodeURIComponent(query)}`);

    expect(response.status).toBe(200);
    const boundedQuery = vi.mocked(services.suggestItems).mock.calls[0]?.[0] ?? "";
    expect([...boundedQuery]).toHaveLength(80);
  });

  it.each([
    { path: "/?status=draft&search=leak", serviceName: "searchItems" as const },
    { path: "/?status=archived&search=leak", serviceName: "searchItems" as const },
    { path: "/bulk-cart-preview?status=draft&search=leak", serviceName: "previewBulkAdd" as const },
  ])("forces public $path searches to active catalog items", async ({ path, serviceName }) => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request(path);

    expect(response.status).toBe(200);
    expect(services[serviceName]).toHaveBeenCalledWith(
      expect.objectContaining({ search: "leak", status: "active" }),
      ...(serviceName === "searchItems" ? [{ signal: expect.any(AbortSignal) }] : []),
    );
  });

  it("parses price range, in-stock, and price-sort query state", async () => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request("/?priceMin=10.25&priceMax=50&inStock=true&sort=price_asc");

    expect(response.status).toBe(200);
    expect(services.searchItems).toHaveBeenCalledWith(
      expect.objectContaining({
        priceMin: "10.25",
        priceMax: "50",
        inStock: true,
        sort: "price_asc",
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("passes total requests only for first pages", async () => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);

    await app.request("/?search=pikachu&includeTotal=true");
    await app.request("/?search=pikachu&cursor=next-page");

    expect(services.searchItems).toHaveBeenNthCalledWith(1, expect.objectContaining({ includeTotal: true }), {
      signal: expect.any(AbortSignal),
    });
    expect(services.searchItems).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "next-page", includeTotal: false }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("ignores malformed price and in-stock query values", async () => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request("/?priceMin=-1&priceMax=12.345&inStock=yes");

    expect(response.status).toBe(200);
    expect(services.searchItems).toHaveBeenCalledWith(
      expect.objectContaining({ priceMin: undefined, priceMax: undefined, inStock: false }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    {
      label: "10 KB Latin text",
      search: "a".repeat(10_000),
      expected: "a".repeat(DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS),
    },
    {
      label: "5 KB CJK text",
      search: "検索".repeat(2_500),
      expected: "検索".repeat(DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS / 2),
    },
    {
      label: "tsquery metacharacters",
      search: `Charizard' & :* "quoted"`,
      expected: `Charizard' & :* "quoted"`,
    },
  ])("bounds and preserves well-formed $label search input", async ({ search, expected }) => {
    const services = createServices();
    const app = discoveryItemSearchRoutes(services);

    const response = await app.request(`/?search=${encodeURIComponent(search)}`);

    expect(response.status).toBe(200);
    expect(services.searchItems).toHaveBeenCalledWith(expect.objectContaining({ search: expected }), {
      signal: expect.any(AbortSignal),
    });
    expect([...expected]).toHaveLength(Math.min([...search].length, DISCOVERY_SEARCH_QUERY_MAX_CODE_POINTS));
  });

  it.each([
    ["an unversioned legacy cursor", legacyRelevanceCursor, ""],
    ["an unversioned legacy cursor with an offset", legacyRelevanceCursor, "&offset=1"],
    ["a malformed cursor", "not-a-cursor", ""],
    ["array JSON", Buffer.from(JSON.stringify([0, 1, 0.9, "Old", "cat_old"])).toString("base64url"), ""],
  ])("legacy or invalid relevance cursor restarts with metadata over HTTP: %s", async (_, rejectedCursor, extra) => {
    const { db, listCalls } = scriptedSearchDb();
    const app = discoveryItemSearchRoutes(
      createDiscoveryItemSearchRuntime({ db, eventStore: {} as never, checkpointStore: {} as never }),
    );

    // A load-more request: a cursor and no includeTotal.
    const restarted = await (
      await app.request(`/?search=Charizard%20ex&limit=1&cursor=${rejectedCursor}${extra}`)
    ).json();

    expect(restarted).toMatchObject({
      cursorRestarted: true,
      total: 2,
      category_counts: [{ slug: "cards", count: 2 }],
      count: 1,
      retrievalMode: "lexical",
    });
    expect(restarted.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).toEqual(["cat_exact"]);
    expect(restarted.items[0]).not.toHaveProperty("search_exact_tier");
    expect(restarted.items[0]).not.toHaveProperty("search_title_identity");
    expect(decodeCursorJson(restarted.nextCursor)).toMatchObject({ v: 2, id: "cat_exact", tier: 1 });
    expect(listCalls[0]).toEqual(["active", "Charizard ex", "Charizard ex", "Charizard ex", 2]);

    // The v2 continuation pages on without a restart marker or first-page metadata.
    const next = await (await app.request(`/?search=Charizard%20ex&limit=1&cursor=${restarted.nextCursor}`)).json();

    expect(next).not.toHaveProperty("cursorRestarted");
    expect(next).toMatchObject({ total: null, category_counts: [], facets: [], nextCursor: null });
    expect(next.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).toEqual(["cat_other"]);
    expect(listCalls[1]).toEqual([
      "active",
      "Charizard ex",
      "Charizard ex",
      "Charizard ex",
      1,
      1,
      0.1,
      "Charizard ex",
      "cat_exact",
      2,
    ]);
  });

  it("keeps an intentional offset page without a cursor or restart marker", async () => {
    const { db, listCalls } = scriptedSearchDb();
    const app = discoveryItemSearchRoutes(
      createDiscoveryItemSearchRuntime({ db, eventStore: {} as never, checkpointStore: {} as never }),
    );

    const page = await (await app.request("/?search=Charizard%20ex&limit=1&offset=1")).json();

    expect(page).not.toHaveProperty("cursorRestarted");
    expect(page).toMatchObject({ total: 2, nextCursor: null });
    expect(page.items.map((item: { catalog_item_id: string }) => item.catalog_item_id)).toEqual(["cat_other"]);
    expect(listCalls[0]).toEqual(["active", "Charizard ex", "Charizard ex", "Charizard ex", 1, 1]);
  });

  it("omits cursorRestarted from fresh first pages", async () => {
    const { db } = scriptedSearchDb();
    const app = discoveryItemSearchRoutes(
      createDiscoveryItemSearchRuntime({ db, eventStore: {} as never, checkpointStore: {} as never }),
    );

    const fresh = await (await app.request("/?search=Charizard%20ex&limit=1&includeTotal=true")).json();

    expect(fresh).not.toHaveProperty("cursorRestarted");
    expect(fresh).toMatchObject({ total: 2, category_counts: [{ slug: "cards", count: 2 }] });
  });
});
