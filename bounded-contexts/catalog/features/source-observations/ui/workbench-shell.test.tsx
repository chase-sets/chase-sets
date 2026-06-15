// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCatalogPrimaryWorkbenchReadModel,
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
  type CatalogPrimaryWorkbenchSourceOptionRequest,
} from "./primary-workbench-read-model";
import { CatalogIntegrationsSurfacePage } from "./integrations-surface-page";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import type { SourceObservationIntegrationOptionResponse } from "./contracts";
import { profileReview, sourceObservationScope } from "./primary-workbench-test-fixtures";

function surfaceReadModel(surface: CatalogControlPlaneRouteSurfaceKey) {
  return buildCatalogPrimaryWorkbenchReadModelForSurface(surface, {
    requestUrl:
      "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
    controlPlaneOverview: null,
    canManageCatalog: true,
  });
}

// A daily read model whose TCGdex option pages are loaded with structured items, so
// the guided selector renders real choices and the status panel reflects per-group
// freshness. Mirrors the response fixtures used by the source-options read model.
const guidedRequestUrl =
  "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&languageCode=en&seriesId=base&expansionId=base1&profileVersion=2026.06.04";

function dailyReadModelWithSourceOptions(
  pageStates: (
    request: CatalogPrimaryWorkbenchSourceOptionRequest,
  ) => SourceObservationIntegrationOptionResponse = responseFor,
) {
  const profile = profileReview({ active: true, lifecycle: "active" });
  const scope = sourceObservationScope();
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl: guidedRequestUrl,
    scopes: [scope],
    profiles: [profile],
    cacheOnly: true,
  });

  return buildCatalogPrimaryWorkbenchReadModel({
    requestUrl: guidedRequestUrl,
    scopes: { items: [scope], total: 1, count: 1 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    sourceOptionPages: requests.map((request) => ({ request, response: pageStates(request) })),
    controlPlaneOverview: null,
    canManageCatalog: true,
  });
}

function responseFor(request: CatalogPrimaryWorkbenchSourceOptionRequest): SourceObservationIntegrationOptionResponse {
  if (request.queryKind === "languages") {
    return optionResponse(request, "fresh", "cache", [{ value: "en", label: "English", parentValue: null }]);
  }
  if (request.queryKind === "series") {
    return optionResponse(request, "fresh", "live", [{ value: "base", label: "Base", parentValue: "en" }]);
  }
  return optionResponse(request, "stale", "cache", [{ value: "base1", label: "Base Set", parentValue: "base" }], true);
}

function optionResponse(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  status: NonNullable<SourceObservationIntegrationOptionResponse["cache"]>["status"],
  source: NonNullable<SourceObservationIntegrationOptionResponse["cache"]>["source"],
  items: readonly { value: string; label: string; parentValue: string | null }[],
  degraded = false,
): SourceObservationIntegrationOptionResponse {
  return {
    items: items.map((item) => ({
      providerKey: request.providerKey,
      queryKind: request.queryKind,
      value: item.value,
      label: item.label,
      description: null,
      parentValue: item.parentValue,
      imageUrl: null,
      metadata: {},
    })),
    total: items.length,
    count: items.length,
    page: { cursor: request.cursor, nextCursor: null, limit: request.limit, hasMore: false },
    cache: {
      status,
      source,
      cacheKey: `sha256:${request.queryKind}`,
      fetchedAt: "2026-06-09T00:00:00.000Z",
      expiresAt: "2026-06-09T00:15:00.000Z",
      staleUntil: "2026-06-10T00:00:00.000Z",
      cacheOnly: request.cacheOnly,
      forceRefresh: false,
      degraded,
      diagnostics: [],
    },
  };
}

describe("CatalogWorkbenchShell single per-surface return affordance", () => {
  afterEach(() => {
    cleanup();
  });

  // The supporting surfaces stack multiple workspaces; the back-link is rendered
  // once by the surface header rather than repeated per stacked workspace (#1739
  // left three on the release surface, forcing e2e .first()).
  it.each(["providers", "governance", "release"] as const)(
    "renders exactly one back-link on the %s surface even though it stacks multiple workspaces",
    (surface) => {
      render(<CatalogIntegrationsSurfacePage surface={surface} readModel={surfaceReadModel(surface)} />);

      const backLinks = screen.getAllByRole("link", { name: "Back to import workbench" });
      expect(backLinks).toHaveLength(1);
      const target = new URL(backLinks[0]!.getAttribute("href") ?? "", "https://admin.example");
      expect(target.pathname).toBe("/catalog/integrations");
      expect(target.searchParams.has("section")).toBe(false);
      expect(target.searchParams.get("providerKey")).toBe("tcgdex");
    },
  );

  it("renders no back-link on the daily surface, which is the primary job", () => {
    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={surfaceReadModel("daily")} />);

    expect(screen.queryByRole("link", { name: "Back to import workbench" })).toBeNull();
  });
});

describe("CatalogWorkbenchShell no page-local cross-surface navigation", () => {
  afterEach(() => {
    cleanup();
  });

  // Cross-surface navigation now lives in the admin shell side nav (the nested
  // "Integrations" manifest group), so the integrations surface must not render its
  // own "Catalog control plane workflows" navigation or the mobile workflow combobox.
  it.each(["daily", "providers", "governance", "release"] as const)(
    "does not render the page-local workflow nav on the %s surface",
    (surface) => {
      render(<CatalogIntegrationsSurfacePage surface={surface} readModel={surfaceReadModel(surface)} />);

      expect(screen.queryByRole("navigation", { name: "Catalog control plane workflows" })).toBeNull();
      expect(screen.queryByRole("combobox", { name: "Choose Catalog workflow" })).toBeNull();
    },
  );
});

describe("CatalogWorkbenchShell guided source-scope selector", () => {
  afterEach(() => {
    cleanup();
  });

  it("replaces the raw importScope text box with profile-driven scope selects", () => {
    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModelWithSourceOptions()} />);

    // The transitional free-text import scope field is gone on a provider that
    // declares option queries; the operator picks structured scope levels instead.
    expect(screen.queryByLabelText("Import scope")).toBeNull();

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    const language = within(scopeGroup).getByLabelText<HTMLSelectElement>("Language");
    const series = within(scopeGroup).getByLabelText<HTMLSelectElement>("Series");
    const expansion = within(scopeGroup).getByLabelText<HTMLSelectElement>("Expansion");

    // Each guided control submits the structured route-context query field, not a
    // colon-delimited importScope string.
    expect(language.name).toBe("languageCode");
    expect(series.name).toBe("seriesId");
    expect(expansion.name).toBe("expansionId");

    // Options come from the synced provider option pages, with the route's current
    // scope preselected.
    expect(within(language).getByRole("option", { name: "English" })).toBeTruthy();
    expect(language.value).toBe("en");
    expect(series.value).toBe("base");
    expect(within(expansion).getByRole("option", { name: "Base Set" })).toBeTruthy();
    expect(expansion.value).toBe("base1");
  });

  it("does not hard-code TCGdex scope levels for a generic provider", () => {
    const profile = profileReview({ providerKey: "tcgplayer", active: true, lifecycle: "active" });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgplayer&productLineId=3",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    // TCGplayer's profile declares Product Line / Set Name, not language/series.
    expect(within(scopeGroup).getByLabelText<HTMLSelectElement>("Product Line").name).toBe("productLineId");
    expect(within(scopeGroup).getByLabelText<HTMLSelectElement>("Set Name").name).toBe("expansionId");
    expect(within(scopeGroup).queryByLabelText("Series")).toBeNull();
  });
});

describe("CatalogWorkbenchShell source-options status panel", () => {
  afterEach(() => {
    cleanup();
  });

  it("summarizes per-group freshness with reload and force-refresh links", () => {
    const { container } = render(
      <CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModelWithSourceOptions()} />,
    );

    // One stale expansions page degrades the overall status.
    const panel = container.querySelector('[data-catalog-source-options-status="degraded"]');
    expect(panel).not.toBeNull();

    // Each declared option group renders with its own freshness state.
    expect(
      container.querySelector('[data-source-option-page="languages"][data-source-option-state="cached"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-source-option-page="series"][data-source-option-state="live"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-source-option-page="expansions"][data-source-option-state="stale"]'),
    ).not.toBeNull();

    const panelScope = within(panel as HTMLElement);
    // Reload (cache) is offered per group; force-refresh (live) per group. The
    // operator must stay in the Catalog Integrations workbench, so every control
    // links to /catalog/integrations with a source-option intent — never to the raw
    // provider-options API href the read model still carries for the loader.
    const reload = panelScope.getAllByRole("link", { name: "Reload" });
    expect(reload).toHaveLength(3);
    for (const link of reload) {
      const target = new URL(link.getAttribute("href") ?? "", "https://admin.example");
      expect(target.pathname).toBe("/catalog/integrations");
      expect(target.pathname).not.toContain("/api/catalog");
      expect(target.searchParams.get("sourceOptionAction")).toBe("reload");
      expect(target.searchParams.get("sourceOptionQueryKind")).toBeTruthy();
      // Route context is preserved so the reload reopens the same scope.
      expect(target.searchParams.get("providerKey")).toBe("tcgdex");
      expect(target.searchParams.has("forceRefresh")).toBe(false);
    }

    const forceRefresh = panelScope.getAllByRole("link", { name: "Force refresh" });
    expect(forceRefresh.length).toBeGreaterThan(0);
    const forceRefreshTarget = new URL(forceRefresh[0]!.getAttribute("href") ?? "", "https://admin.example");
    expect(forceRefreshTarget.pathname).toBe("/catalog/integrations");
    expect(forceRefreshTarget.searchParams.get("sourceOptionAction")).toBe("force-refresh");
    expect(forceRefreshTarget.searchParams.get("sourceOptionQueryKind")).toBeTruthy();
    expect(forceRefreshTarget.searchParams.has("forceRefresh")).toBe(false);

    const refreshAll = panelScope.getByRole("link", { name: "Refresh all" });
    const refreshAllTarget = new URL(refreshAll.getAttribute("href") ?? "", "https://admin.example");
    expect(refreshAllTarget.pathname).toBe("/catalog/integrations");
    expect(refreshAllTarget.searchParams.get("sourceOptionAction")).toBe("force-refresh-all");
    // Refresh-all fans across every group, so it carries no single queryKind.
    expect(refreshAllTarget.searchParams.has("sourceOptionQueryKind")).toBe(false);
    expect(refreshAllTarget.searchParams.has("forceRefresh")).toBe(false);
  });

  it("flags a group whose required parent scope is not selected yet", () => {
    const profile = profileReview({ providerKey: "tcgplayer", active: true, lifecycle: "active" });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      // No product line is chosen, so TCGplayer's set-name group cannot request its
      // required productLineId parent and must surface a missing-parent state.
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgplayer",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const { container } = render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(
      container.querySelector('[data-source-option-page="set-names"][data-source-option-state="not-requested"]'),
    ).not.toBeNull();
    // The guided Set Name select is disabled until its required product-line parent
    // is chosen.
    const setName = screen.getByLabelText<HTMLSelectElement>("Set Name");
    expect(setName.disabled).toBe(true);
  });
});
