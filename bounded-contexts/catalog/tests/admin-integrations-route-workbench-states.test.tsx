// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { t } from "@chase-sets/localization";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError as CatalogApiError } from "../support/shell-support/api/client";
import IntegrationsRoute, { loader } from "../routes/admin/integrations";
import {
  controlPlaneOverview,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "../features/source-observations/ui/primary-workbench-test-fixtures";
import { sourceOptionResponse } from "./admin-integrations-route-test-support";

const { mockCreateCatalogRequestApiClient, mockIsTransientAuthResolutionError, mockResolveActorFromAuthApi } =
  vi.hoisted(() => ({
    mockCreateCatalogRequestApiClient: vi.fn(),
    mockIsTransientAuthResolutionError: vi.fn(),
    mockResolveActorFromAuthApi: vi.fn(),
  }));
const { mockUseRouteLoaderData } = vi.hoisted(() => ({ mockUseRouteLoaderData: vi.fn() }));

// The route renders inside a real data router; only the root actor lookup is
// supplied because this harness mounts the integrations route without its root.
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useRouteLoaderData: mockUseRouteLoaderData };
});

vi.mock("../support/request-support/api-client", () => ({
  createCatalogRequestApiClient: mockCreateCatalogRequestApiClient,
}));

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  isTransientAuthResolutionError: mockIsTransientAuthResolutionError,
  resolveActorFromAuthApi: mockResolveActorFromAuthApi,
}));

const WORKBENCH_HEADING = "Pull provider data, review Source Observations, promote Catalog facts";
const DAILY_URL =
  "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1";

function list<T>(items: readonly T[]) {
  return { items: [...items], total: items.length, count: items.length };
}

function unavailable(): never {
  throw new CatalogApiError(503, { error: { code: "unavailable", message: "Synthetic outage." } });
}

function dailyApi(
  overrides: Readonly<{
    scopes?: unknown;
    profiles?: unknown;
    overview?: () => unknown;
    observations?: () => unknown;
    options?: (query: string) => Promise<unknown>;
  }> = {},
) {
  return {
    listSourceObservationIntegrationScopes: vi
      .fn()
      .mockResolvedValue(overrides.scopes ?? list([sourceObservationScope()])),
    listSourceObservationProviderProfiles: vi
      .fn()
      .mockResolvedValue(overrides.profiles ?? list([profileReview({ active: true, lifecycle: "active" })])),
    getCatalogIntegrationControlPlaneOverview: vi.fn(async () =>
      overrides.overview ? overrides.overview() : controlPlaneOverview(),
    ),
    listSourceObservations: vi.fn(async () =>
      overrides.observations
        ? overrides.observations()
        : list([sourceObservationListItem({ observation_id: "obs_001", status: "changed", provider_key: "tcgdex" })]),
    ),
    listCatalogMergeCandidates: vi.fn().mockResolvedValue(list([])),
    listSourceObservationIntegrationOptions: vi.fn(
      overrides.options ??
        (async (query: string) =>
          sourceOptionResponse(new URLSearchParams(query).get("queryKind") ?? "languages", {
            status: "fresh",
            source: "live",
            parentValue: null,
            degraded: false,
          })),
    ),
    recordCatalogControlPlaneEvent: vi.fn().mockResolvedValue({ status: "recorded" }),
  };
}

async function loadDaily(api: ReturnType<typeof dailyApi>, requestUrl = DAILY_URL) {
  mockCreateCatalogRequestApiClient.mockReturnValue(api);
  return loader({ request: new Request(requestUrl), params: {}, context: {} } as Parameters<typeof loader>[0]);
}

let router: ReturnType<typeof createMemoryRouter> | null = null;

async function renderDaily(routeData: Awaited<ReturnType<typeof loader>>) {
  router = createMemoryRouter(
    [{ path: "/catalog/integrations", loader: () => routeData, Component: IntegrationsRoute }],
    {
      initialEntries: ["/catalog/integrations"],
    },
  );
  const mounted = router;
  // Awaited act commits the loader transition before polling a large workbench
  // (see admin-integrations-route-render.test.tsx renderDailyRouteWithAttention).
  await act(async () => {
    render(<RouterProvider router={mounted} />);
  });
  await screen.findByRole("heading", { name: WORKBENCH_HEADING }, { timeout: 30_000 });
  fireEvent.click(screen.getByRole("button", { name: /Step 0 · Choose import scope/ }));
}

function unmountDaily() {
  router?.dispose();
  router = null;
  cleanup();
}

function sourceOptionsStatus(): string | null {
  return (
    document
      .querySelector("[data-catalog-source-options-status]")
      ?.getAttribute("data-catalog-source-options-status") ?? null
  );
}

describe("Catalog integrations route workbench states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTransientAuthResolutionError.mockReturnValue(false);
    mockResolveActorFromAuthApi.mockResolvedValue({ permissions: ["catalog.view", "catalog.manage"] });
    mockUseRouteLoaderData.mockReturnValue({ actor: { permissions: ["catalog.view", "catalog.manage"] } });
  });

  afterEach(() => {
    unmountDaily();
  });

  it("workbench loading empty error and populated states remain unchanged", async () => {
    // Loading -> populated: the shell paints from the awaited baseline while the
    // option fan-out is still in flight, then the streamed slice fills the panel.
    // The gate holds the streamed slice, not the option API: the loader's own
    // per-page timeout must not race the harness.
    let releaseOptions!: () => void;
    const optionsReleased = new Promise<void>((resolve) => {
      releaseOptions = resolve;
    });
    const populated = await loadDaily(dailyApi());

    // The streamed boundary carries only built read models, never the raw
    // baseline inputs they were derived from.
    expect(Object.keys(populated).sort()).toEqual([
      "commandFeedback",
      "deferredAliasReview",
      "deferredAttentionQueue",
      "deferredCatalogSyncRun",
      "deferredImportPreview",
      "deferredScopeSyncState",
      "deferredSourceOptions",
      "readModel",
      "requestUrl",
    ]);
    expect(populated.readModel.sourceOptions.pages.every((page) => page.items.length === 0)).toBe(true);
    expect(populated.readModel.sourceObservationReview).toMatchObject({
      freshness: "fresh",
      counts: { observed: 100, changed: 24 },
    });

    const streamedSourceOptions = populated.deferredSourceOptions;
    await renderDaily({
      ...populated,
      deferredSourceOptions: optionsReleased.then(() => streamedSourceOptions),
    });
    // The disclosure mounts its panel asynchronously once opened.
    expect(
      await screen.findByText(
        t("catalog.features.sourceObservations.ui.primaryWorkbench.deferred.sourceOptions.loading"),
        {},
        { timeout: 30_000 },
      ),
    ).toBeTruthy();
    expect(sourceOptionsStatus()).toBeNull();

    await act(async () => {
      releaseOptions();
      await streamedSourceOptions;
    });
    await waitFor(() => expect(sourceOptionsStatus()).toBe("ready"));
    const streamed = await streamedSourceOptions;
    expect(streamed.pages.length).toBeGreaterThan(0);
    expect(streamed.pages.every((page) => page.state === "live")).toBe(true);
    expect(JSON.stringify(streamed)).not.toContain("total_observations");
    expect(
      screen.queryByText(t("catalog.features.sourceObservations.ui.primaryWorkbench.deferred.sourceOptions.loading")),
    ).toBeNull();
    unmountDaily();

    // Empty: no scopes, profiles, or overview keeps the empty defaults and the
    // provider-scope requirement instead of a fabricated selection.
    const empty = await loadDaily(
      dailyApi({ scopes: list([]), profiles: list([]), overview: () => null, observations: () => list([]) }),
      "https://admin.example/catalog/integrations",
    );
    expect(empty.readModel.routeContext).toMatchObject({ providerKey: null, unitKey: null, importScope: null });
    expect(empty.readModel.providerScope.providers).toEqual([]);
    expect(empty.readModel.sourceOptions.optionKinds).toEqual([]);
    expect(empty.readModel.actions.find((action) => action.key === "scope.import")).toMatchObject({
      state: "blocked",
      copyKey: "catalog.primary.providerScope.required",
    });
    await renderDaily(empty);
    // Without an overview each build stamps its own time; the rest is identical.
    const emptyStreamed = await empty.deferredSourceOptions;
    expect({ ...emptyStreamed, generatedAt: null }).toEqual({ ...empty.readModel.sourceOptions, generatedAt: null });
    expect(sourceOptionsStatus()).toBeNull();
    unmountDaily();

    // Error: failed overview, review and option reads degrade in place; the
    // workbench still renders and the streamed slice resolves degraded.
    const failed = await loadDaily(
      dailyApi({ overview: unavailable, observations: unavailable, options: async () => unavailable() }),
    );
    expect(failed.readModel.readiness.freshness).toBe("unavailable");
    expect(failed.readModel.sourceObservationReview.freshness).toBe("unavailable");
    expect(failed.readModel.actions.find((action) => action.key === "observation.reject")).toMatchObject({
      state: "unavailable",
      blockers: ["read-model-unavailable"],
    });
    await renderDaily(failed);
    await act(async () => {
      await failed.deferredSourceOptions;
    });
    const failedOptions = await failed.deferredSourceOptions;
    // Failed option reads surface as unavailable pages; the expansion level
    // falls back to the stale scope rows the baseline already carries.
    expect(failedOptions.status).toBe("degraded");
    expect(failedOptions.pages.map((page) => [page.queryKind, page.state, page.blockers])).toEqual([
      ["languages", "unavailable", ["read-model-unavailable"]],
      ["series", "unavailable", ["read-model-unavailable"]],
      ["expansions", "stale", ["provider-transport-stale-cache"]],
    ]);
    await waitFor(() => expect(sourceOptionsStatus()).toBe("degraded"));
  });
});
