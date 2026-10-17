// Synthetic identities only (synthetic.fixture.local, synthetic-api-key). No network.
import { describe, expect, it, vi } from "vitest";
import { listCatalogProviderIntegrationProfileVersions } from "../api/providers/registry";
import { listCatalogProviderProfileVersionReviews } from "../api/providers/provider-profile-review";
import { buildCatalogPrimaryWorkbenchSourceOptionRequests } from "./primary-workbench-read-model";
import {
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../api/provider-adapters/scrydex-one-piece";
import {
  cacheKeyForProviderOptionQuery,
  type CatalogProviderOptionQueryCacheStore,
  type CatalogProviderOptionQueryRequest,
} from "../api/providers/provider-option-query-cache";
import { queryProviderIntegrationOptions } from "../api/providers/provider-option-queries";
import { ProviderAdapterRegistry } from "../api/provider-adapters/registry";
import type { CatalogProviderProfileVersionReview } from "./contracts";

async function reviews() {
  const store = {
    listProfileVersions: async () => listCatalogProviderIntegrationProfileVersions(),
    countProfileVersionReferences: async () => 0,
  };
  return (await listCatalogProviderProfileVersionReviews(
    store as never,
  )) as unknown as readonly CatalogProviderProfileVersionReview[];
}

function syntheticFetch() {
  return vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/usage")) return Response.json({ data: {} });
    return Response.json({
      page: 1,
      page_size: 2,
      total_count: 1,
      count: 1,
      data: [
        {
          id: "synthetic-card-1",
          name: "Synthetic card",
          language_code: "en",
          printings: ["SYN"],
          expansion: { id: "SYN", name: "Synthetic" },
        },
      ],
    });
  });
}

function adapter(cacheStore: CatalogProviderOptionQueryCacheStore, fetch: typeof globalThis.fetch) {
  return createScrydexOnePieceProviderAdapter({
    cacheStore,
    credentials: { apiKey: "synthetic-api-key", teamId: "synthetic-team" },
    lorcanaBaseUrl: "https://synthetic.fixture.local/lorcana/v1",
    baseUrl: "https://synthetic.fixture.local/onepiece/v1",
    now: () => new Date("2026-09-30T12:00:00Z"),
    fetch,
  });
}

describe("Catalog primary workbench source-option census", () => {
  it("census: every product/card declaration across executable profile versions", async () => {
    const all = await reviews();
    const rows: unknown[] = [];
    for (const review of all) {
      for (const kind of review.sourceOptionKinds.filter((candidate) => candidate.scope === "product/card")) {
        const base = new URL("https://admin.example/catalog/integrations");
        base.searchParams.set("providerKey", review.providerKey);
        base.searchParams.set("unitKey", review.ingestionUnitKey);
        base.searchParams.set("profileVersion", review.profileVersion);
        base.searchParams.set("languageCode", "en");
        base.searchParams.set("expansionId", "SYNID");
        base.searchParams.set("expansionName", "Synthetic Set Name");
        const withId = buildCatalogPrimaryWorkbenchSourceOptionRequests({
          requestUrl: base.toString(),
          scopes: [],
          profiles: all,
          cacheOnly: true,
        }).find((request) => request.queryKind === kind.queryKind);
        const nameOnlyUrl = new URL(base);
        nameOnlyUrl.searchParams.delete("expansionId");
        const nameOnly = buildCatalogPrimaryWorkbenchSourceOptionRequests({
          requestUrl: nameOnlyUrl.toString(),
          scopes: [],
          profiles: all,
          cacheOnly: true,
        }).find((request) => request.queryKind === kind.queryKind);
        rows.push({
          providerKey: review.providerKey,
          profileKey: review.profileKey,
          profileVersion: review.profileVersion,
          lifecycle: review.lifecycle,
          active: review.active,
          unit: review.ingestionUnitKey,
          queryKind: kind.queryKind,
          parentScope: kind.parentScope,
          parentRequired: kind.parentRequired,
          parentValueKind: kind.parentValueKind,
          emitted: Boolean(withId),
          parentValue: withId?.parentValue ?? null,
          refreshHasForce: withId?.refreshHref
            ? new URL(withId.refreshHref, base).searchParams.get("forceRefresh")
            : null,
          nameOnlyEmitted: Boolean(nameOnly),
          nameOnlyParentValue: nameOnly?.parentValue ?? null,
          nameOnlyLoaderSkips: nameOnly
            ? Boolean(nameOnly.parentRequired && nameOnly.parentScope !== null && !nameOnly.selectedParentValue)
            : null,
        });
      }
    }
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows as Array<Record<string, unknown>>) {
      expect(row).toMatchObject({
        queryKind: "cards",
        parentScope: "set-name",
        parentRequired: true,
        emitted: true,
        parentValue: "SYNID",
        refreshHasForce: "true",
        nameOnlyParentValue: null,
        nameOnlyLoaderSkips: true,
      });
    }
    // TCGplayer profiles emit no Card request.
    const tcgplayer = all.filter((review) => review.providerKey === "tcgplayer");
    for (const review of tcgplayer) {
      const url = `https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=${encodeURIComponent(
        review.ingestionUnitKey,
      )}&profileVersion=${review.profileVersion}&expansionId=SYNID`;
      const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
        requestUrl: url,
        scopes: [],
        profiles: all,
        cacheOnly: true,
      });
      expect(requests.filter((request) => request.scope === "product/card")).toEqual([]);
    }
  });

  it.each([
    ["lorcana", SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY, "TFC", "The First Chapter"],
    ["one-piece", SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY, "OP01", "Romance Dawn"],
  ])("identity: %s walk-shaped Card refreshHref writes the key #8433 reads", async (_label, unitKey, id, name) => {
    const all = await reviews();
    const walkUrl = `https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(
      unitKey,
    )}&expansionId=${id}&expansionName=${encodeURIComponent(name).replace(/%20/g, "+")}`;
    const card = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl: walkUrl,
      scopes: [],
      profiles: all,
      cacheOnly: true,
    }).find((request) => request.queryKind === "cards");
    expect(card?.parentValue).toBe(id);
    const params = new URL(card!.refreshHref!, walkUrl).searchParams;

    // API side: the same parser fields the /integration-options route reads.
    const writes: unknown[][] = [];
    const selects: unknown[][] = [];
    const query = async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      if (sql.includes("INSERT INTO catalog_provider_option_query_cache")) writes.push([...(values ?? [])]);
      else selects.push([...(values ?? [])]);
      return { rows: [] as Row[] };
    };
    const fetch = syntheticFetch();
    const adapterCache = { read: vi.fn(async () => null), write: vi.fn(async () => undefined) };
    const page = await queryProviderIntegrationOptions(
      {
        providerKey: params.get("providerKey")!,
        profileKey: params.get("profileKey"),
        ingestionUnitKey: params.get("ingestionUnitKey"),
        queryKind: params.get("queryKind")!,
        languageCode: params.get("languageCode"),
        parentValue: params.get("parentValue"),
        cursor: params.get("cursor"),
        limit: Number(params.get("limit")),
        forceRefresh: params.get("forceRefresh") === "true",
      },
      { query },
      null,
      undefined,
      undefined,
      new ProviderAdapterRegistry([adapter(adapterCache, fetch)]),
    );

    // #8433 side: the estimate's cache read during planImport.
    const reads: CatalogProviderOptionQueryRequest[] = [];
    const estimateCache = {
      read: vi.fn(async (request: CatalogProviderOptionQueryRequest) => {
        reads.push(request);
        return null;
      }),
      write: vi.fn(async () => undefined),
    };
    await adapter(estimateCache, syntheticFetch()).planImport({
      unitKey,
      scopeKey: "expansion-cards",
      values: { expansionId: id, language: "en" },
    });
    const estimateKey = cacheKeyForProviderOptionQuery(reads[0]!);
    const result = {
      label: _label,
      refreshHref: card!.refreshHref,
      apiCacheKey: page.cache?.cacheKey,
      writtenCacheKey: writes[0]?.[0] ?? null,
      estimateRead: reads[0],
      estimateKey,
      equal: page.cache?.cacheKey === estimateKey,
    };
    expect(reads).toHaveLength(1);
    expect(page.cache?.cacheKey).toBe(estimateKey);
  });
});
