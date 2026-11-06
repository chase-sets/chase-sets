import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceObservationRouteServices } from "../route";
import { buildApp, mutableProfileStore, viewOnlyActor } from "./route-test-harness";
import {
  buildDailyMergeCandidateQuery,
  MAX_SOURCE_OPTION_CONTINUATION_PAGES,
} from "../admin/primary-workbench-surface-read";
import type { CatalogPrimaryWorkbenchRouteContext } from "../primary-workbench-admin-contracts";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../ui/primary-workbench-read-model";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../ui/primary-workbench-route-context";
import {
  controlPlaneOverview,
  sourceObservationListItem,
  sourceObservationScope,
} from "../../ui/primary-workbench-test-fixtures";

const NOW = "2026-07-14T12:00:00.000Z";
const TCGDEX_UNIT = "tcgdex:pokemon:single-card:source-observation-import";
const POKEMON_UNIT = "tcgplayer:pokemon:single-card:source-observation-import";

function readinessUnit(unitKey: string, providerKey: string, profileVersion: string) {
  return {
    unitKey,
    providerKey,
    displayName: unitKey,
    productDomain: "pokemon",
    productForm: "single-card",
    ingestionPurpose: "source-observation-import",
    profileVersion,
    semanticReadiness: "ready",
    credentialReadiness: "ready",
    credentialReadinessState: "configured",
    credentialRequirement: "required",
    credentialDiagnosticCode: null,
    transportReadiness: "ready",
    fixtureValidationStatus: "ready",
    dryRunStatus: "completed",
    observationFacts: 1,
    diagnosticCounts: { info: 0, warning: 0, error: 0 },
    diagnostics: [],
    latestDiagnosticText: null,
    dryRunEvidence: [],
  };
}

function readiness(units: readonly ReturnType<typeof readinessUnit>[]) {
  const base = controlPlaneOverview().readiness;
  return {
    ...base,
    generatedAt: NOW,
    providerUsage: [],
    rolloutControls: { ...base.rolloutControls, generatedAt: NOW },
    units,
  };
}

function surfaceServices(overrides: Partial<Record<keyof SourceObservationRouteServices, unknown>> = {}) {
  return {
    listIntegrationScopes: vi.fn(async () => [sourceObservationScope({ provider_key: "tcgdex" })]),
    getCatalogIntegrationControlPlaneReadiness: vi.fn(async () =>
      readiness([readinessUnit(TCGDEX_UNIT, "tcgdex", "2026.06.03")]),
    ),
    listRecentIntegrationJobs: vi.fn(async () => []),
    listActiveIntegrationJobs: vi.fn(async () => []),
    listSourceObservations: vi.fn(async () => ({ items: [sourceObservationListItem()], total: 1 })),
    listCatalogMergeCandidates: vi.fn(async () => ({ items: [], total: 0, count: 0 })),
    ...overrides,
  } as unknown as SourceObservationRouteServices;
}

function surfacePath(surface: string, location: string): string {
  return `/source-observations/workbench-surfaces/${surface}?${new URLSearchParams({ location })}`;
}

async function getJson(app: ReturnType<typeof buildApp>, path: string) {
  const response = await app.request(path);
  expect(response.status, path).toBe(200);
  return response.json();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Catalog primary workbench surface routes", () => {
  it.each([
    ["governance", "/catalog/integrations/governance"],
    ["health", "/catalog/integrations/health"],
  ])("composes the %s surface the admin loader composed from the per-projection routes", async (surface, location) => {
    const app = buildApp(surfaceServices(), mutableProfileStore());

    const body = await getJson(app, surfacePath(surface, location));
    const expected = buildCatalogPrimaryWorkbenchReadModelForSurface(surface as "governance" | "health", {
      requestUrl: new URL(location, "https://admin.example").toString(),
      scopes: await getJson(app, "/source-observations/integration-scopes"),
      profileReviews: await getJson(app, "/source-observations/provider-profiles"),
      controlPlaneOverview: await getJson(app, "/source-observations/integration-control-plane/overview"),
      profileAuthoringModel: null,
      lifecycleImpacts: null,
      readModelFailures: [],
      reviewObservations: null,
      mergeCandidates: null,
      sourceOptionPages: null,
      catalogSyncPreview: null,
      canManageCatalog: true,
    });

    expect(body.readModelFailures).toEqual([]);
    expect(body.readModel).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("composes the daily surface the admin loader composed from the per-projection routes", async () => {
    const location = "/catalog/integrations";
    const services = surfaceServices();
    const app = buildApp(services, mutableProfileStore());

    const body = await getJson(app, surfacePath("daily", location));
    const routeContext = parseCatalogPrimaryWorkbenchRouteContext(new URL(location, "https://admin.example"));
    const expected = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
      requestUrl: new URL(location, "https://admin.example").toString(),
      scopes: await getJson(app, "/source-observations/integration-scopes"),
      profileReviews: await getJson(app, "/source-observations/provider-profiles"),
      controlPlaneOverview: await getJson(
        app,
        "/source-observations/integration-control-plane/overview?audience=daily",
      ),
      profileAuthoringModel: null,
      lifecycleImpacts: null,
      readModelFailures: [],
      reviewObservations: null,
      mergeCandidates: await getJson(
        app,
        `/source-observations/merge-candidates?${buildDailyMergeCandidateQuery(routeContext)}`,
      ),
      promotionOutcome: null,
      promotionValidation: null,
      reviewPagination: { limit: 25, offset: 0 },
      sourceOptionPages: null,
      catalogSyncPreview: null,
      canManageCatalog: true,
    });

    expect(body.readModelFailures).toEqual([]);
    expect(body.readModel).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(services.listSourceObservations).not.toHaveBeenCalled();
  });

  it("reads catalog.manage from the API actor and refuses actors without integration read access", async () => {
    const viewer = buildApp(surfaceServices(), mutableProfileStore(), viewOnlyActor);
    const anonymous = buildApp(surfaceServices(), mutableProfileStore(), null);

    const body = await getJson(viewer, surfacePath("health", "/catalog/integrations/health"));
    const manager = await getJson(
      buildApp(surfaceServices(), mutableProfileStore()),
      surfacePath("health", "/catalog/integrations/health"),
    );

    expect(body.readModel).not.toEqual(manager.readModel);
    expect((await anonymous.request(surfacePath("health", "/catalog/integrations/health"))).status).toBe(401);
  });

  it.each([
    ["an unknown surface", surfacePath("providers", "/catalog/integrations"), 404],
    ["a location outside the Catalog admin", surfacePath("daily", "/account/sales"), 400],
    ["an absolute location", surfacePath("daily", "https://evil.example/catalog/integrations"), 400],
    ["a missing location", "/source-observations/workbench-surfaces/daily", 400],
  ])("refuses %s", async (_label, path, status) => {
    const app = buildApp(surfaceServices(), mutableProfileStore());

    expect((await app.request(path)).status).toBe(status);
  });
});

describe("Catalog primary workbench surface fail-soft projections", () => {
  const dailyLocation = `/catalog/integrations?providerKey=tcgdex&unitKey=${encodeURIComponent(TCGDEX_UNIT)}&languageCode=en`;
  const failing = async () => {
    throw new Error("synthetic projection failure");
  };

  it.each([
    ["integration-scopes", { listIntegrationScopes: failing }],
    ["control-plane-overview", { getCatalogIntegrationControlPlaneReadiness: failing }],
    ["source-observation-review", { listSourceObservations: failing }],
    ["merge-candidate-review", { listCatalogMergeCandidates: failing }],
  ] as const)("names a failed %s projection instead of reading it as empty", async (failure, overrides) => {
    const app = buildApp(surfaceServices(overrides), mutableProfileStore());

    const body = await getJson(app, surfacePath("daily", dailyLocation));

    expect(body.readModelFailures).toContain(failure);
    expect(body.readModel.schemaVersion).toBeTruthy();
  });

  it("names failed provider profiles instead of reading them as empty", async () => {
    const store = mutableProfileStore();
    const app = buildApp(surfaceServices(), {
      ...store,
      listProfileVersions: failing,
      seedProfileVersions: failing,
    });

    const body = await getJson(app, surfacePath("health", "/catalog/integrations/health"));

    expect(body.readModelFailures).toContain("provider-profiles");
  });

  it("reports no failures when every projection reads", async () => {
    const app = buildApp(surfaceServices(), mutableProfileStore());

    const body = await getJson(app, surfacePath("daily", dailyLocation));

    expect(body.readModelFailures).toEqual([]);
  });
});

describe("Catalog primary workbench deferred source options pagination", () => {
  const location = `/catalog/integrations?providerKey=tcgplayer&unitKey=${encodeURIComponent(POKEMON_UNIT)}&profileVersion=2026.06.05&sourceOptionAction=force-refresh-all`;
  const path = `/source-observations/workbench-surfaces/daily/source-options?${new URLSearchParams({ location })}`;

  // The seeded TCGplayer Pokemon profile's first, parentless option group.
  const GROUP = "product-lines";

  type OptionQuery = Readonly<{ queryKind: string; cursor?: string }>;

  function optionPage(input: {
    query: OptionQuery;
    nextCursor: string | null;
    hasMore: boolean;
    value?: string;
    // The whole list's option count; each page carries one option.
    total?: number;
    count?: number;
    cacheKey?: string;
  }) {
    return {
      items: [{ value: input.value ?? `option-${input.query.cursor ?? "first"}`, label: "Option", metadata: {} }],
      total: input.total ?? 1,
      count: input.count ?? 1,
      page: { cursor: input.query.cursor ?? null, nextCursor: input.nextCursor, limit: 25, hasMore: input.hasMore },
      cache: {
        status: "fresh",
        source: input.query.cursor ? "cache" : "live",
        cacheKey: input.cacheKey ?? "sha256:stable",
        fetchedAt: NOW,
        expiresAt: NOW,
        staleUntil: NOW,
        cacheOnly: Boolean(input.query.cursor),
        forceRefresh: !input.query.cursor,
        degraded: false,
        diagnostics: [],
      },
    };
  }

  async function surfacePages(
    queryIntegrationOptions: (query: OptionQuery) => Promise<unknown>,
    surfacePath: string = path,
  ) {
    const services = surfaceServices({
      getCatalogIntegrationControlPlaneReadiness: async () =>
        readiness([readinessUnit(POKEMON_UNIT, "tcgplayer", "2026.06.05")]),
      listIntegrationScopes: async () => [],
      queryIntegrationOptions,
    });
    const body = await getJson(buildApp(services, mutableProfileStore()), surfacePath);
    return body.pages as { queryKind: string; state: string; items: { value: string }[] }[];
  }

  async function groupPage(queryIntegrationOptions: (query: OptionQuery) => Promise<unknown>) {
    return (await surfacePages(queryIntegrationOptions)).find((page) => page.queryKind === GROUP);
  }

  function expectPaginationFailure(page: unknown) {
    expect(page).toMatchObject({
      state: "unavailable",
      items: [],
      page: { count: 0, total: 0, hasMore: false, nextCursor: null },
      cache: { diagnostics: [expect.objectContaining({ code: "catalog_provider_option_pagination_invalid" })] },
    });
  }

  it("fails the group closed past the continuation page cap, even when the decisive option lies beyond it", async () => {
    const calls: OptionQuery[] = [];
    const page = await groupPage(async (query) => {
      if (query.queryKind !== GROUP) {
        return optionPage({ query, nextCursor: null, hasMore: false });
      }
      calls.push(query);
      const pageNumber = query.cursor ? Number(query.cursor.slice("page-".length)) : 0;
      return optionPage({
        query,
        nextCursor: `page-${pageNumber + 1}`,
        hasMore: true,
        value: pageNumber === MAX_SOURCE_OPTION_CONTINUATION_PAGES + 1 ? "decisive-option" : undefined,
        total: MAX_SOURCE_OPTION_CONTINUATION_PAGES + 2,
      });
    });

    expect(calls).toHaveLength(MAX_SOURCE_OPTION_CONTINUATION_PAGES + 1);
    expectPaginationFailure(page);
  });

  it("fails the group closed when the option cache changes between pages", async () => {
    const page = await groupPage(async (query) =>
      query.queryKind === GROUP && !query.cursor
        ? optionPage({ query, nextCursor: "page-1", hasMore: true, total: 2 })
        : optionPage({ query, nextCursor: null, hasMore: false, total: 2, cacheKey: "sha256:replaced" }),
    );

    expectPaginationFailure(page);
  });

  it("fails the group closed when the option count changes between pages", async () => {
    const page = await groupPage(async (query) =>
      query.queryKind === GROUP && !query.cursor
        ? optionPage({ query, nextCursor: "page-1", hasMore: true, total: 2 })
        : optionPage({ query, nextCursor: null, hasMore: false, total: 3 }),
    );

    expectPaginationFailure(page);
  });

  it("returns every option when the continuation pages agree with their total", async () => {
    const page = await groupPage(async (query) =>
      query.queryKind !== GROUP
        ? optionPage({ query, nextCursor: null, hasMore: false })
        : !query.cursor
          ? optionPage({ query, nextCursor: "page-1", hasMore: true, total: 2 })
          : optionPage({ query, nextCursor: null, hasMore: false, total: 2 }),
    );

    expect(page!.items.map((item) => item.value)).toEqual(["option-first", "option-page-1"]);
  });

  // Each case answers the group's query with pages that end before, or past, the total they
  // report; every other group gets one complete page.
  it.each([
    [
      "a single last page carries fewer options than its total",
      (query: OptionQuery) => optionPage({ query, nextCursor: null, hasMore: false, total: 3 }),
    ],
    [
      "the continuation pages end, at a stable total, before every option",
      (query: OptionQuery) =>
        query.cursor
          ? optionPage({ query, nextCursor: null, hasMore: false, total: 3 })
          : optionPage({ query, nextCursor: "page-1", hasMore: true, total: 3 }),
    ],
    [
      "the pages carry more options than their total",
      (query: OptionQuery) =>
        query.cursor
          ? optionPage({ query, nextCursor: null, hasMore: false, total: 1 })
          : optionPage({ query, nextCursor: "page-1", hasMore: true, total: 1 }),
    ],
    [
      "a page's count disagrees with the options it carries",
      (query: OptionQuery) => optionPage({ query, nextCursor: null, hasMore: false, total: 1, count: 2 }),
    ],
    [
      "the total is not a count",
      (query: OptionQuery) => optionPage({ query, nextCursor: null, hasMore: false, total: 1.5 }),
    ],
  ])("fails only the group closed when %s", async (_case, groupResponse) => {
    // With a product line selected, its set names load beside the failing group.
    const withProductLine = `/source-observations/workbench-surfaces/daily/source-options?${new URLSearchParams({
      location: `${location}&productLineId=3&productLineName=Pokemon`,
    })}`;
    const pages = await surfacePages(
      async (query) =>
        query.queryKind === GROUP ? groupResponse(query) : optionPage({ query, nextCursor: null, hasMore: false }),
      withProductLine,
    );

    expectPaginationFailure(pages.find((page) => page.queryKind === GROUP));
    const others = pages.filter((page) => page.queryKind !== GROUP && page.state !== "not-requested");
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) {
      expect(other.state).not.toBe("unavailable");
      expect(other.items.length).toBe(1);
    }
  });
});

describe("buildDailyMergeCandidateQuery", () => {
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
