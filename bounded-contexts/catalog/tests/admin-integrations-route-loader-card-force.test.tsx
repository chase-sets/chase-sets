// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogApiError } from "../client";
import { loader } from "../routes/admin/integrations";
import { sourceObservationScope } from "../features/source-observations/ui/primary-workbench-test-fixtures";
import {
  scrydexLorcanaImportPreview,
  scrydexLorcanaProfileReview,
  sourceOptionResponse,
} from "./admin-integrations-route-test-support";

const { mockCreateCatalogRequestApiClient, mockIsTransientAuthResolutionError, mockResolveActorFromAuthApi } =
  vi.hoisted(() => ({
    mockCreateCatalogRequestApiClient: vi.fn(),
    mockIsTransientAuthResolutionError: vi.fn(),
    mockResolveActorFromAuthApi: vi.fn(),
  }));

vi.mock("../support/request-support/api-client", () => ({
  createCatalogRequestApiClient: mockCreateCatalogRequestApiClient,
}));

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  isTransientAuthResolutionError: mockIsTransientAuthResolutionError,
  resolveActorFromAuthApi: mockResolveActorFromAuthApi,
}));

const unitKey = "scrydex:lorcana:single-card:source-observation-import";
const base = `https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(unitKey)}`;
const walk = `${base}&expansionId=TFC&expansionName=The+First+Chapter`;

const calls: string[] = [];
function api() {
  const listSourceObservationIntegrationOptions = vi.fn(async (query: string) => {
    calls.push(query);
    const params = new URLSearchParams(query);
    if (params.get("queryKind") === "cards" && params.get("cacheOnly") === "true") {
      throw new CatalogApiError(503, {
        error: { code: "catalog_provider_option_query_unavailable", message: "cache empty (synthetic)" },
      });
    }
    return sourceOptionResponse(params.get("queryKind") ?? "sets", {
      status: "fresh",
      source: params.get("forceRefresh") === "true" ? "live" : "cache",
      parentValue: params.get("parentValue"),
      degraded: false,
      value: "TFC",
      label: "The First Chapter",
      metadata: { expansionId: "TFC", languageCode: "en" },
    });
  });
  return {
    listSourceObservationIntegrationScopes: vi.fn().mockResolvedValue({
      items: [
        sourceObservationScope({
          provider_key: "scrydex",
          language_code: "en",
          product_line_id: "",
          product_line_name: "Disney Lorcana",
          series_id: "",
          series_name: "",
          expansion_id: "TFC",
          expansion_name: "The First Chapter",
        }),
      ],
      total: 1,
      count: 1,
    }),
    listSourceObservationProviderProfiles: vi
      .fn()
      .mockResolvedValue({ items: [scrydexLorcanaProfileReview(unitKey)], total: 1, count: 1 }),
    getCatalogIntegrationControlPlaneOverview: vi.fn().mockResolvedValue(null),
    listSourceObservations: vi.fn().mockResolvedValue({ items: [], total: 0, count: 0 }),
    listSourceObservationIntegrationOptions,
    previewSourceObservationIntegrationImport: vi.fn().mockResolvedValue(scrydexLorcanaImportPreview(unitKey)),
    recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
  };
}

async function load(url: string) {
  calls.length = 0;
  const routeData = await loader({ request: new Request(url), params: {}, context: {} } as Parameters<
    typeof loader
  >[0]);
  const sourceOptions = await routeData.deferredSourceOptions;
  const forced = calls.filter((query) => new URLSearchParams(query).get("forceRefresh") === "true");
  const cardCalls = calls.filter((query) => new URLSearchParams(query).get("queryKind") === "cards");
  const cardForced = cardCalls.filter((query) => new URLSearchParams(query).get("forceRefresh") === "true");
  const cardPage = sourceOptions?.pages.find((page) => page.queryKind === "cards");
  return {
    url,
    calls: [...calls],
    forced: forced.length,
    cardCalls: cardCalls.length,
    cardForced: cardForced.length,
    cardPage: cardPage
      ? { state: cardPage.state, actionState: cardPage.actionState, refreshHref: cardPage.refreshHref }
      : null,
    status: sourceOptions?.status,
    refreshAllHref: sourceOptions?.refresh.refreshAllHref ?? null,
    summary: sourceOptions?.summary,
  };
}

// Exactly what useSingleUseCardForceRefreshIntent submits after resolution.
function stripped(url: string) {
  const current = new URL(url);
  current.searchParams.delete("sourceOptionAction");
  current.searchParams.delete("sourceOptionQueryKind");
  return current.toString();
}

describe("Catalog integrations loader Card force refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTransientAuthResolutionError.mockReturnValue(false);
    mockResolveActorFromAuthApi.mockResolvedValue({ permissions: ["catalog.view", "catalog.manage"] });
    mockCreateCatalogRequestApiClient.mockReturnValue(api());
  });
  afterEach(() => {
    calls.length = 0;
  });

  it("counts forceRefresh across the Card operator lifecycle", async () => {
    const steps: Record<string, Awaited<ReturnType<typeof load>>> = {};
    steps.render = await load(walk);
    steps.parentSelection = await load(`${base}&expansionId=ROF&expansionName=Rise+of+the+Floodborn`);
    steps.reloadCards = await load(`${walk}&sourceOptionAction=reload&sourceOptionQueryKind=cards`);
    steps.refreshAll = await load(`${walk}&sourceOptionAction=force-refresh-all`);
    const intentUrl = `${walk}&sourceOptionAction=force-refresh&sourceOptionQueryKind=cards`;
    steps.forceCards = await load(intentUrl);
    steps.afterStrip = await load(stripped(intentUrl));
    steps.revalidateAfterStrip = await load(stripped(intentUrl));
    steps.nameOnlyForce = await load(
      `${base}&expansionName=The+First+Chapter&sourceOptionAction=force-refresh&sourceOptionQueryKind=cards`,
    );
    steps.nameOnlyRender = await load(`${base}&expansionName=The+First+Chapter`);
    // Pre-strip revalidation (intent still in URL, e.g. an action while the forced slice is in flight).
    steps.revalidateBeforeStrip = await load(intentUrl);
    expect(steps.render.cardForced).toBe(0);
    expect(steps.parentSelection.cardForced).toBe(0);
    expect(steps.reloadCards.forced).toBe(0);
    expect(steps.refreshAll.cardForced).toBe(0);
    expect(steps.forceCards.forced).toBe(1);
    expect(steps.forceCards.cardForced).toBe(1);
    expect(steps.forceCards.calls).toHaveLength(1);
    const forcedParams = new URLSearchParams(steps.forceCards.calls[0]);
    const refreshParams = new URL(steps.render.cardPage!.refreshHref!, walk).searchParams;
    expect(forcedParams.toString()).toBe(refreshParams.toString());
    expect(forcedParams.get("parentValue")).toBe("TFC");
    expect(forcedParams.has("cacheOnly")).toBe(false);
    expect(steps.afterStrip.forced).toBe(0);
    expect(steps.revalidateAfterStrip.forced).toBe(0);
    expect(steps.nameOnlyForce.cardCalls).toBe(0);
    expect(steps.nameOnlyRender.cardPage).toMatchObject({ state: "not-requested", actionState: "disabled" });
    expect(steps.render.cardPage).toMatchObject({ state: "unavailable" });
    expect(steps.render.cardPage?.actionState).not.toBe("disabled");
    expect(steps.render.status).not.toBe("degraded");
  });
});
