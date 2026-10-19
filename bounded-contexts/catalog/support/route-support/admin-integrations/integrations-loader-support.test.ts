import { describe, expect, it, vi } from "vitest";
import type { CatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import {
  buildDailyMergeCandidateQuery,
  importPreviewMatchesSelectedScope,
  loadDailySurfaceForRequest,
} from "./integrations-loader-support";
import {
  profileReview,
  sourceObservationScope,
  sourceObservationListItem,
} from "../../../features/source-observations/ui/primary-workbench-test-fixtures";
import {
  queryCatalogProviderIntegrationOptionsWithCache,
  type CatalogProviderOptionQueryCacheRecord,
} from "../../../features/source-observations/api/providers/provider-option-query-cache";
import { importPreviewMatchesRouteContext } from "../../../features/source-observations/ui/admin-control-plane/import-jobs/import-jobs-module";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import type { SourceObservationIntegrationImportPreview } from "../../../features/source-observations/ui/contracts";
import { scopeContextToObservationFilterScope } from "../../../features/source-observations/ui/primary-workbench-scope-context";

const { mockCreateCatalogRequestApiClient } = vi.hoisted(() => ({ mockCreateCatalogRequestApiClient: vi.fn() }));
vi.mock("../../request-support/api-client", () => ({
  createCatalogRequestApiClient: mockCreateCatalogRequestApiClient,
}));
vi.mock("@chase-sets/platform-runtime/auth", () => ({
  resolveActorFromAuthApi: async () => ({ permissions: ["catalog.manage"] }),
  isTransientAuthResolutionError: () => false,
}));

const baseContext: CatalogPrimaryWorkbenchRouteContext = {
  section: "import-to-promotion",
  providerKey: "tcgplayer",
  unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
  importScope: "en:3:Base Set",
  profileVersion: "2026.06.03",
  sourceObservationFilters: {},
  selectedObservationIds: [],
  reviewOffset: null,
  reviewLimit: null,
  jobId: "job_parent_sync",
  promotionPreviewId: null,
  returnPath: null,
  scope: {
    providerKey: "tcgplayer",
    productId: null,
    languageCode: "en",
    productLineId: "3",
    productLineName: "Pokemon",
    seriesId: null,
    seriesName: null,
    expansionId: "Base Set",
    expansionName: "Base Set",
    status: null,
  },
};

describe("admin integrations loader support", () => {
  it.each(["expansionName=Jungle", "expansionId=base2"])(
    "queries the selected Jungle scope on first load: %s",
    async (selection) => {
      const scope = sourceObservationScope({
        expansion_id: "base2",
        expansion_name: "Jungle",
        observed_observations: 0,
        changed_observations: 0,
        promoted_observations: 1,
        rejected_observations: 0,
        total_observations: 1,
      });
      const observation = sourceObservationListItem({
        observation_id: "synthetic-jungle-pikachu",
        status: "promoted",
        normalized: {
          ...sourceObservationListItem().normalized,
          name: "Pikachu",
          setId: "base2",
          expansionName: "Jungle",
        },
      });
      const list = vi.fn().mockResolvedValue({ items: [observation], total: 1, count: 1 });
      const options = vi.fn().mockRejectedValue(new Error("synthetic unavailable cached options"));
      mockCreateCatalogRequestApiClient.mockReturnValue({
        listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({ items: [scope], total: 1, count: 1 }),
        listSourceObservationProviderProfiles: vi
          .fn()
          .mockResolvedValue({ items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 }),
        getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
        listSourceObservations: list,
        listCatalogMergeCandidates: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
        recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
        listSourceObservationIntegrationOptions: options,
      });
      const loaded = await loadDailySurfaceForRequest(
        new Request(
          `https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&languageCode=en&${selection}`,
        ),
      );
      const query = new URLSearchParams(list.mock.calls[0]![0]);
      const expected = scopeContextToObservationFilterScope(loaded.readModel.sourceScopeWorkset.selectedScope.scope);
      expect(Object.fromEntries(query)).toEqual({ ...expected, provider: "tcgdex", limit: "25", offset: "0" });
      expect(loaded.readModel.sourceObservationReview.rows[0]?.displayName).toBe("Pikachu");
      expect(loaded.readModel.sourceObservationReview.counts.promoted).toBe(1);
      const href = loaded.readModel.sourceScopeWorkset.units.find(
        (unit) => unit.providerKey === "tcgdex",
      )!.currentWorkbenchHref;
      list.mockClear();
      const linked = await loadDailySurfaceForRequest(new Request(new URL(href, "https://admin.example")));
      const linkedQuery = new URLSearchParams(list.mock.calls[0]![0]);
      expect(Object.fromEntries(linkedQuery)).toEqual({
        ...scopeContextToObservationFilterScope(linked.readModel.sourceScopeWorkset.selectedScope.scope),
        provider: "tcgdex",
        limit: "25",
        offset: "0",
      });
      expect(linked.readModel.sourceObservationReview.rows[0]?.displayName).toBe("Pikachu");
      expect(linked.readModel.sourceObservationReview.counts.promoted).toBe(1);
      await linked.deferredSourceOptions;
      await loaded.deferredSourceOptions;
      expect(options.mock.calls.every(([query]) => new URLSearchParams(query).get("cacheOnly") === "true")).toBe(true);
    },
  );
  it.each(["other-scope", "other-provider", "no-provider"])("does not broaden the review for %s", async (selection) => {
    const list = vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 });
    const options = vi.fn().mockRejectedValue(new Error("Synthetic unavailable cached options"));
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: async () => ({
        items: [sourceObservationScope({ expansion_id: "base2", expansion_name: "Jungle", promoted_observations: 1 })],
        total: 1,
        count: 1,
      }),
      listSourceObservationProviderProfiles: async () => ({
        items: [profileReview({ active: true, lifecycle: "active" })],
        total: 1,
        count: 1,
      }),
      getCatalogIntegrationControlPlaneOverview: async () => null,
      listSourceObservations: list,
      listCatalogMergeCandidates: async () => ({ items: [], total: 0, count: 0 }),
      recordCatalogControlPlaneEvent: async () => ({ status: "recorded" }),
      listSourceObservationIntegrationOptions: options,
    });
    const query =
      selection === "no-provider"
        ? "languageCode=en&expansionId=base2"
        : selection === "other-provider"
          ? "providerKey=tcgplayer&languageCode=en&expansionName=Jungle"
          : "providerKey=tcgdex&languageCode=en&expansionId=base3";
    const loaded = await loadDailySurfaceForRequest(new Request(`https://admin.example/catalog/integrations?${query}`));
    expect(loaded.readModel.sourceObservationReview.rows).toEqual([]);
    if (selection === "no-provider") expect(list).not.toHaveBeenCalled();
    else {
      expect(list).toHaveBeenCalledTimes(1);
      const params = new URLSearchParams(list.mock.calls[0]![0]);
      expect(params.get("provider")).toBe(selection === "other-provider" ? "tcgplayer" : "tcgdex");
      if (selection === "other-scope") expect(params.get("expansionId")).toBe("base3");
      expect(loaded.readModel.sourceObservationReview.counts.promoted).toBe(0);
    }
    await loaded.deferredSourceOptions;
    expect(options.mock.calls.every(([params]) => new URLSearchParams(params).get("cacheOnly") === "true")).toBe(true);
  });
  it.each(["missing", "stale"])("keeps selection-driven %s cache degraded without provider calls", async (state) => {
    const providerQuery = vi.fn(async () => []);
    const queries: URLSearchParams[] = [];
    const stale: CatalogProviderOptionQueryCacheRecord = {
      cacheKey: "synthetic-cache-key",
      providerKey: "tcgdex",
      profileKey: "",
      profileVersion: "2026.06.04",
      ingestionUnitKey: "tcgdex:pokemon:card:import",
      queryKind: "languages",
      languageCode: "",
      parentValue: "",
      items: [],
      fetchedAt: "2026-06-09T00:00:00.000Z",
      expiresAt: "2026-06-09T00:15:00.000Z",
      staleUntil: "2026-06-10T00:00:00.000Z",
      diagnosticCode: null,
      diagnosticText: null,
    };
    mockCreateCatalogRequestApiClient.mockReturnValue({
      listSourceObservationIntegrationScopes: vi
        .fn()
        .mockResolvedValue({ items: [sourceObservationScope()], total: 1, count: 1 }),
      listSourceObservationProviderProfiles: vi
        .fn()
        .mockResolvedValue({ items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 }),
      getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
      listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      listCatalogMergeCandidates: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
      recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
      listSourceObservationIntegrationOptions: async (query: string) => {
        const params = new URLSearchParams(query);
        queries.push(params);
        return queryCatalogProviderIntegrationOptionsWithCache({
          request: {
            providerKey: "tcgdex",
            profileVersion: "2026.06.04",
            queryKind: params.get("queryKind") ?? "languages",
            cacheOnly: params.get("cacheOnly") === "true",
            forceRefresh: params.get("forceRefresh") === "true",
          },
          cacheStore: { read: async () => (state === "stale" ? stale : null), write: async () => undefined },
          loadLive: providerQuery,
          now: new Date("2026-06-09T01:00:00.000Z"),
        });
      },
    });
    const loaded = await loadDailySurfaceForRequest(
      new Request(
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&languageCode=ja&profileVersion=2026.06.04",
      ),
    );
    const options = await loaded.deferredSourceOptions;
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query.get("cacheOnly")).toBe("true");
      expect(query.get("forceRefresh")).not.toBe("true");
    }
    expect(providerQuery).not.toHaveBeenCalled();
    expect(["degraded", "unavailable"]).toContain(options.status);
    expect(options.pages.some((page) => page.degraded)).toBe(true);
  });
  it("binds loader and rendered preview identity to the exact selected product, including deselection", () => {
    const context = parseCatalogPrimaryWorkbenchRouteContext(
      "https://admin.example/catalog/integrations?providerKey=ygojson&unitKey=ygojson:yugioh:sealed-product:reference-data&languageCode=en&productId=synthetic-product-A",
    );
    const scope = {
      provider: "ygojson",
      ingestionUnitKey: "ygojson:yugioh:sealed-product:reference-data",
      language: "en",
      productId: "synthetic-product-A",
    };
    const preview: SourceObservationIntegrationImportPreview = {
      action: "import",
      providerKey: "ygojson",
      scope,
      profileSnapshot: null,
      targetCount: 0,
      targets: [],
    };
    expect(importPreviewMatchesSelectedScope(preview, scope)).toBe(true);
    expect(importPreviewMatchesRouteContext(preview, context)).toBe(true);
    for (const productId of ["synthetic-product-B", "synthetic-product-a", undefined]) {
      const stale = { ...preview, scope: { ...scope, productId } };
      expect(importPreviewMatchesSelectedScope(stale, scope)).toBe(false);
      expect(importPreviewMatchesRouteContext(stale, context)).toBe(false);
    }
    expect(importPreviewMatchesSelectedScope(preview, { ...scope, productId: undefined })).toBe(false);
    expect(
      importPreviewMatchesRouteContext(preview, { ...context, scope: { ...context.scope!, productId: null } }),
    ).toBe(false);
  });
  it("queries merge candidates by selected catalog scope instead of only the current parent sync run", () => {
    const params = new URLSearchParams(buildDailyMergeCandidateQuery(baseContext));

    expect(params.get("provider")).toBe("tcgplayer");
    expect(params.get("language")).toBe("en");
    expect(params.get("productLineId")).toBe("3");
    expect(params.get("productLineName")).toBe("Pokemon");
    expect(params.get("setId")).toBe("Base Set");
    expect(params.has("syncRunId")).toBe(false);
  });

  it("keeps sync-run filtering when no catalog scope is selected", () => {
    const params = new URLSearchParams(
      buildDailyMergeCandidateQuery({
        ...baseContext,
        importScope: null,
        scope: undefined,
      }),
    );

    expect(params.get("syncRunId")).toBe("job_parent_sync");
    expect(params.has("productLineId")).toBe(false);
  });

  it("uses canonical Scope Record identity on the scope-first journey", () => {
    const params = new URLSearchParams(
      buildDailyMergeCandidateQuery({
        ...baseContext,
        providerKey: null,
        unitKey: null,
        scopeRecordId: "scope_expansion_paldean_fates",
      }),
    );

    expect(params.get("scopeRecordId")).toBe("scope_expansion_paldean_fates");
    expect(params.has("setId")).toBe(false);
    expect(params.has("syncRunId")).toBe(false);
  });
});
