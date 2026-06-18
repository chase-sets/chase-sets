// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

// The import-jobs module polls live progress via useRevalidator and the import
// context form submits context changes via useSubmit; these pages render bare (no
// data router), so stub both for the workbench tree. A single shared submit spy
// captures the client-navigation submits the context form/source-option controls
// now issue (replacing the former full-document form.requestSubmit()).
const submitSpy = vi.fn();

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
    useSubmit: () => submitSpy,
  };
});

afterEach(() => {
  submitSpy.mockClear();
});

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

function dailyReadModelWithJapaneseExpansionOnly() {
  const profile = profileReview({ active: true, lifecycle: "active" });
  const scope = sourceObservationScope({
    language_code: "ja",
    product_line_id: "",
    product_line_name: "",
    series_id: "SV",
    series_name: "Scarlet & Violet",
    expansion_id: "SV8",
    expansion_name: "Super Electric Breaker",
  });
  const requestUrl =
    "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&expansionId=SV8&profileVersion=2026.06.04";
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl,
    scopes: [scope],
    profiles: [profile],
    cacheOnly: true,
  });

  return buildCatalogPrimaryWorkbenchReadModel({
    requestUrl,
    scopes: { items: [scope], total: 1, count: 1 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    sourceOptionPages: requests.map((request) => ({ request, response: japaneseSv8ResponseFor(request) })),
    controlPlaneOverview: null,
    canManageCatalog: true,
  });
}

function providerProfile(providerKey: "scrydex" | "tcgdex", displayName: string, supportedScope: string) {
  return profileReview({
    providerKey,
    profileKey: `${providerKey}-profile`,
    displayName,
    active: true,
    lifecycle: "active",
    profile: {
      providerKey,
      supportedScopes: [supportedScope],
    },
    supportedScopes: [supportedScope],
  });
}

function dailyReadModelWithProviders(requestUrl: string) {
  const profiles = [
    providerProfile("scrydex", "Scrydex", "product/card"),
    providerProfile("tcgdex", "TCGdex", "pokemon/card"),
  ];

  return buildCatalogPrimaryWorkbenchReadModel({
    requestUrl,
    scopes: { items: [], total: 0, count: 0 },
    profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
    controlPlaneOverview: null,
    canManageCatalog: true,
  });
}

function responseFor(request: CatalogPrimaryWorkbenchSourceOptionRequest): SourceObservationIntegrationOptionResponse {
  if (request.queryKind === "languages") {
    return optionResponse(request, "fresh", "cache", [
      { value: "en", label: "en", parentValue: null },
      { value: "ja", label: "ja", parentValue: null },
    ]);
  }
  if (request.queryKind === "series") {
    return optionResponse(request, "fresh", "live", [{ value: "base", label: "Base", parentValue: "en" }]);
  }
  return optionResponse(request, "stale", "cache", [{ value: "base1", label: "Base Set", parentValue: "base" }], true);
}

function japaneseSv8ResponseFor(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
): SourceObservationIntegrationOptionResponse {
  if (request.queryKind === "languages") {
    return optionResponse(request, "fresh", "cache", [
      { value: "en", label: "en", parentValue: null },
      { value: "ja", label: "ja", parentValue: null },
    ]);
  }
  if (request.queryKind === "series") {
    return optionResponse(request, "fresh", "cache", [
      { value: "base", label: "Base", parentValue: "en" },
      { value: "SV", label: "Scarlet & Violet", parentValue: "ja" },
    ]);
  }
  return optionResponse(request, "fresh", "cache", [
    { value: "base1", label: "Base Set", parentValue: "base" },
    { value: "SV8", label: "Super Electric Breaker", parentValue: "SV" },
  ]);
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
      aliases: [],
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

// The import-context concern (provider/unit/guided-scope/profile + the source-
// options status) now lives in the collapsible "Step 0" import-context bar (#1973).
// When a scope is already chosen the bar renders COLLAPSED to a one-line summary, so
// its form internals are mounted but `hidden` (base-ui collapses the disclosure
// panel). Expand it via its trigger before asserting on those internals — this is
// the same edit round trip an operator performs. Render models without a chosen
// scope render the bar already open, so expanding is a safe no-op.
function expandImportContextBar(): void {
  const trigger = screen.queryByRole("button", { name: /Step 0 · Choose import scope/ });
  if (trigger && trigger.getAttribute("aria-expanded") === "false") {
    fireEvent.click(trigger);
  }
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

describe("CatalogWorkbenchShell provider/unit selection", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the unit selector scoped to the selected provider", () => {
    render(
      <CatalogIntegrationsSurfacePage
        surface="daily"
        readModel={dailyReadModelWithProviders(
          "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import",
        )}
      />,
    );

    const unit = screen.getByLabelText<HTMLSelectElement>("Unit");
    expect(within(unit).getByRole("option", { name: "tcgdex:pokemon:card:import" })).toBeTruthy();
    expect(within(unit).queryByRole("option", { name: "scrydex:product:card:import" })).toBeNull();
  });

  it("clears provider-dependent fields before submitting a provider change", () => {
    render(
      <CatalogIntegrationsSurfacePage
        surface="daily"
        readModel={dailyReadModelWithProviders(
          "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&languageCode=en&seriesId=base&expansionId=base1&profileVersion=2026.06.04",
        )}
      />,
    );

    const provider = screen.getByLabelText<HTMLSelectElement>("Provider");
    const unit = screen.getByLabelText<HTMLSelectElement>("Unit");
    const profileVersion = screen.getByLabelText<HTMLInputElement>("Profile version");
    const form = provider.form;
    expect(form).not.toBeNull();

    const staleAction = document.createElement("input");
    staleAction.type = "hidden";
    staleAction.name = "sourceOptionAction";
    staleAction.value = "force-refresh-all";
    form!.appendChild(staleAction);

    const staleQueryKind = document.createElement("input");
    staleQueryKind.type = "hidden";
    staleQueryKind.name = "sourceOptionQueryKind";
    staleQueryKind.value = "expansions";
    form!.appendChild(staleQueryKind);

    fireEvent.change(provider, { target: { value: "scrydex" } });

    expect(provider.value).toBe("scrydex");
    expect(unit.value).toBe("");
    expect(unit.disabled).toBe(true);
    expect(profileVersion.value).toBe("");
    expect(profileVersion.disabled).toBe(true);

    const submitted = new FormData(provider.form!);
    expect(submitted.get("providerKey")).toBe("scrydex");
    expect(submitted.has("unitKey")).toBe(false);
    expect(submitted.has("languageCode")).toBe(false);
    expect(submitted.has("seriesId")).toBe(false);
    expect(submitted.has("expansionId")).toBe(false);
    expect(submitted.has("profileVersion")).toBe(false);
    expect(submitted.has("sourceOptionAction")).toBe(false);
    expect(submitted.has("sourceOptionQueryKind")).toBe(false);
    expect(form!.elements.namedItem("sourceOptionAction")).toBeNull();
    expect(form!.elements.namedItem("sourceOptionQueryKind")).toBeNull();
    // The context change submits as a client GET navigation (no full reload), not
    // a full-document form.requestSubmit().
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]![0]).toBe(form);
    expect(submitSpy.mock.calls[0]![1]).toMatchObject({ method: "get", replace: true, preventScrollReset: true });
  });

  it("clears scope and source-option intent fields before submitting a unit change", () => {
    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModelWithSourceOptions()} />);

    const unit = screen.getByLabelText<HTMLSelectElement>("Unit");
    const profileVersion = screen.getByLabelText<HTMLInputElement>("Profile version");
    const form = unit.form;
    expect(form).not.toBeNull();

    const staleAction = document.createElement("input");
    staleAction.type = "hidden";
    staleAction.name = "sourceOptionAction";
    staleAction.value = "force-refresh-all";
    form!.appendChild(staleAction);

    const staleQueryKind = document.createElement("input");
    staleQueryKind.type = "hidden";
    staleQueryKind.name = "sourceOptionQueryKind";
    staleQueryKind.value = "expansions";
    form!.appendChild(staleQueryKind);

    fireEvent.change(unit, { target: { value: unit.value } });

    expect(profileVersion.value).toBe("");
    expect(profileVersion.disabled).toBe(true);

    const submitted = new FormData(form!);
    expect(submitted.get("providerKey")).toBe("tcgdex");
    expect(submitted.get("unitKey")).toBe("tcgdex:pokemon:card:import");
    expect(submitted.has("languageCode")).toBe(false);
    expect(submitted.has("seriesId")).toBe(false);
    expect(submitted.has("expansionId")).toBe(false);
    expect(submitted.has("profileVersion")).toBe(false);
    expect(submitted.has("sourceOptionAction")).toBe(false);
    expect(submitted.has("sourceOptionQueryKind")).toBe(false);
    expect(form!.elements.namedItem("sourceOptionAction")).toBeNull();
    expect(form!.elements.namedItem("sourceOptionQueryKind")).toBeNull();
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]![0]).toBe(form);
  });

  it("normalizes a stale mismatched provider/unit URL to the selected provider", () => {
    const readModel = dailyReadModelWithProviders(
      "https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=tcgdex:pokemon:card:import&languageCode=ja&seriesId=XYb&profileVersion=tcgdex-only",
    );

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    const provider = screen.getByLabelText<HTMLSelectElement>("Provider");
    const unit = screen.getByLabelText<HTMLSelectElement>("Unit");

    expect(provider.value).toBe("scrydex");
    expect(unit.value).toBe("scrydex:product:card:import");
    expect(within(unit).getByRole("option", { name: "scrydex:product:card:import" })).toBeTruthy();
    expect(within(unit).queryByRole("option", { name: "tcgdex:pokemon:card:import" })).toBeNull();
    const scope = readModel.routeContext.scope;
    expect(scope).toBeDefined();
    expect(readModel.routeContext.importScope).toBeNull();
    expect(scope?.languageCode).toBeNull();
    expect(scope?.seriesId).toBeNull();
    expect(readModel.routeContext.profileVersion).toBe("2026.06.04");
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
    expandImportContextBar();

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

  // A stale/mixed option page can carry child items whose parentValue no longer
  // matches the selected parent (e.g. a Series belonging to ja while Language=en, or
  // an Expansion belonging to a different series while Series=base). The guided
  // selects must narrow to the selected parent and never offer those foreign options.
  it("narrows dependent scope options to the selected parent", () => {
    const readModel = dailyReadModelWithSourceOptions((request) => {
      if (request.queryKind === "languages") {
        return optionResponse(request, "fresh", "cache", [
          { value: "en", label: "en", parentValue: null },
          { value: "ja", label: "ja", parentValue: null },
        ]);
      }
      if (request.queryKind === "series") {
        return optionResponse(request, "fresh", "live", [
          { value: "base", label: "Base", parentValue: "EN" },
          { value: "legends", label: "Legends", parentValue: "ja" },
        ]);
      }
      return optionResponse(
        request,
        "stale",
        "cache",
        [
          { value: "base1", label: "Base Set", parentValue: "BASE" },
          { value: "adv1", label: "Advanced", parentValue: "ADV" },
        ],
        true,
      );
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);
    expandImportContextBar();

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    const series = within(scopeGroup).getByLabelText<HTMLSelectElement>("Series");
    const expansion = within(scopeGroup).getByLabelText<HTMLSelectElement>("Expansion");

    // Series narrows to Language=en: the ja-parented "Legends" series is gone.
    expect(within(series).getByRole("option", { name: "Base" })).toBeTruthy();
    expect(within(series).queryByRole("option", { name: "Legends" })).toBeNull();

    // Expansion narrows to Series=base: the ADV-parented "Advanced" expansion is gone.
    expect(within(expansion).getByRole("option", { name: "Base Set" })).toBeTruthy();
    expect(within(expansion).queryByRole("option", { name: "Advanced" })).toBeNull();
  });

  it("shows hydrated parents when a child-only source option is selected", () => {
    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModelWithJapaneseExpansionOnly()} />);
    expandImportContextBar();

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    const language = within(scopeGroup).getByLabelText<HTMLSelectElement>("Language");
    const series = within(scopeGroup).getByLabelText<HTMLSelectElement>("Series");
    const expansion = within(scopeGroup).getByLabelText<HTMLSelectElement>("Expansion");

    expect(language.value).toBe("ja");
    expect(within(language).getByRole("option", { name: "Japanese" })).toBeTruthy();

    expect(series.value).toBe("SV");
    expect(within(series).getByRole("option", { name: "Scarlet & Violet" })).toBeTruthy();
    expect(within(series).queryByRole("option", { name: "Base" })).toBeNull();

    expect(expansion.value).toBe("SV8");
    expect(within(expansion).getByRole("option", { name: "Super Electric Breaker" })).toBeTruthy();
    expect(within(expansion).queryByRole("option", { name: "Base Set" })).toBeNull();
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
    expandImportContextBar();

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    // TCGplayer's profile declares Product Line / Set Name, not language/series.
    expect(within(scopeGroup).getByLabelText<HTMLSelectElement>("Product Line").name).toBe("productLineId");
    expect(within(scopeGroup).getByLabelText<HTMLSelectElement>("Set Name").name).toBe("expansionId");
    expect(within(scopeGroup).queryByLabelText("Series")).toBeNull();
  });

  it("does not render another provider source-scope shape when the selected provider has no active option profile", () => {
    const tcgdexProfile = profileReview({ active: true, lifecycle: "active" });
    const scrydexProfile = profileReview({
      providerKey: "scrydex",
      profileKey: "scrydex-profile",
      displayName: "Scrydex",
      active: false,
      lifecycle: "test",
      profile: {
        providerKey: "scrydex",
        supportedScopes: ["product/card"],
      },
      supportedScopes: ["product/card"],
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=scrydex",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [tcgdexProfile, scrydexProfile], total: 2, count: 2 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);
    expandImportContextBar();

    expect(screen.getByLabelText<HTMLSelectElement>("Provider").value).toBe("scrydex");
    expect(screen.queryByRole("group", { name: "Source scope" })).toBeNull();
    expect(screen.queryByLabelText("Language")).toBeNull();
    expect(screen.queryByLabelText("Series")).toBeNull();
    expect(screen.queryByLabelText("Expansion")).toBeNull();
    expect(screen.queryByText("Source options")).toBeNull();
  });

  it("labels a selected language code when the option page has not loaded that value yet", () => {
    const profile = profileReview({ active: true, lifecycle: "active", languageOptions: ["en", "ja"] });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&languageCode=ja",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);
    expandImportContextBar();

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    const language = within(scopeGroup).getByLabelText<HTMLSelectElement>("Language");
    expect(within(language).getByRole("option", { name: "Japanese" })).toBeTruthy();
    expect(language.value).toBe("ja");
  });

  it("submits dependent source-scope filters and clears stale child selections", () => {
    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModelWithSourceOptions()} />);
    expandImportContextBar();

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    const language = within(scopeGroup).getByLabelText<HTMLSelectElement>("Language");
    const series = within(scopeGroup).getByLabelText<HTMLSelectElement>("Series");
    const expansion = within(scopeGroup).getByLabelText<HTMLSelectElement>("Expansion");

    expect(series.value).toBe("base");
    expect(expansion.value).toBe("base1");

    fireEvent.change(language, { target: { value: "ja" } });

    expect(language.value).toBe("ja");
    expect(series.value).toBe("");
    expect(expansion.value).toBe("");
    expect(submitSpy).toHaveBeenCalledTimes(1);

    fireEvent.change(series, { target: { value: "base" } });

    expect(expansion.value).toBe("");
    expect(submitSpy).toHaveBeenCalledTimes(2);
  });

  // A parent filter change must force a live refresh of every dependent option page,
  // not just reload cache-only options, so the form submits with
  // sourceOptionAction=force-refresh-all stamped on it.
  it("forces a refresh-all of source options when a parent filter changes", () => {
    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModelWithSourceOptions()} />);
    expandImportContextBar();

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    const language = within(scopeGroup).getByLabelText<HTMLSelectElement>("Language");
    const form = language.form;
    expect(form).not.toBeNull();

    // A prior per-group reload/force-refresh left a stale query-kind hint on the
    // form; the refresh-all submit must drop it since it carries no single group.
    const staleQueryKind = document.createElement("input");
    staleQueryKind.type = "hidden";
    staleQueryKind.name = "sourceOptionQueryKind";
    staleQueryKind.value = "languages";
    form!.appendChild(staleQueryKind);

    fireEvent.change(language, { target: { value: "ja" } });

    const action = form!.elements.namedItem("sourceOptionAction");
    expect(action).toBeInstanceOf(HTMLInputElement);
    expect((action as HTMLInputElement).type).toBe("hidden");
    expect((action as HTMLInputElement).value).toBe("force-refresh-all");
    expect(form!.elements.namedItem("sourceOptionQueryKind")).toBeNull();
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]![0]).toBe(form);
  });

  it("hydrates parent fields and refreshes source options when a leaf filter changes", () => {
    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModelWithJapaneseExpansionOnly()} />);
    expandImportContextBar();

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    const language = within(scopeGroup).getByLabelText<HTMLSelectElement>("Language");
    const series = within(scopeGroup).getByLabelText<HTMLSelectElement>("Series");
    const expansion = within(scopeGroup).getByLabelText<HTMLSelectElement>("Expansion");
    const form = expansion.form;
    expect(form).not.toBeNull();

    language.value = "";
    series.value = "";

    fireEvent.change(expansion, { target: { value: "SV8" } });

    expect(language.value).toBe("ja");
    expect(series.value).toBe("SV");
    const action = form!.elements.namedItem("sourceOptionAction");
    expect(action).toBeInstanceOf(HTMLInputElement);
    expect((action as HTMLInputElement).value).toBe("force-refresh-all");
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]![0]).toBe(form);
  });
});

describe("CatalogWorkbenchShell source-options status panel", () => {
  afterEach(() => {
    cleanup();
  });

  it("summarizes per-group freshness with reload and force-refresh controls", () => {
    const { container } = render(
      <CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModelWithSourceOptions()} />,
    );
    expandImportContextBar();

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
    // controls are no longer GET-link navigations — each refreshes the streamed
    // source-options slice in place via a client GET navigation (`useSubmit`) so
    // the page never full-reloads. The submit target stays /catalog/integrations
    // with the source-option intent — never the raw provider-options API href the
    // read model still carries for the loader.
    const reload = panelScope.getAllByRole("button", { name: "Reload" });
    expect(reload).toHaveLength(3);
    for (const control of reload) {
      submitSpy.mockClear();
      fireEvent.click(control);
      expect(submitSpy).toHaveBeenCalledTimes(1);
      expect(submitSpy.mock.calls[0]![0]).toBeNull();
      const submitOptions = submitSpy.mock.calls[0]![1] as { action: string; method: string };
      expect(submitOptions.method).toBe("get");
      const target = new URL(submitOptions.action, "https://admin.example");
      expect(target.pathname).toBe("/catalog/integrations");
      expect(target.pathname).not.toContain("/api/catalog");
      expect(target.searchParams.get("sourceOptionAction")).toBe("reload");
      expect(target.searchParams.get("sourceOptionQueryKind")).toBeTruthy();
      // Route context is preserved so the reload reopens the same scope.
      expect(target.searchParams.get("providerKey")).toBe("tcgdex");
      expect(target.searchParams.has("forceRefresh")).toBe(false);
    }

    const forceRefresh = panelScope.getAllByRole("button", { name: "Force refresh" });
    expect(forceRefresh.length).toBeGreaterThan(0);
    submitSpy.mockClear();
    fireEvent.click(forceRefresh[0]!);
    const forceRefreshTarget = new URL(
      (submitSpy.mock.calls[0]![1] as { action: string }).action,
      "https://admin.example",
    );
    expect(forceRefreshTarget.pathname).toBe("/catalog/integrations");
    expect(forceRefreshTarget.searchParams.get("sourceOptionAction")).toBe("force-refresh");
    expect(forceRefreshTarget.searchParams.get("sourceOptionQueryKind")).toBeTruthy();
    expect(forceRefreshTarget.searchParams.has("forceRefresh")).toBe(false);

    const refreshAll = panelScope.getByRole("button", { name: "Refresh all" });
    submitSpy.mockClear();
    fireEvent.click(refreshAll);
    const refreshAllTarget = new URL(
      (submitSpy.mock.calls[0]![1] as { action: string }).action,
      "https://admin.example",
    );
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
    expandImportContextBar();

    expect(
      container.querySelector('[data-source-option-page="set-names"][data-source-option-state="not-requested"]'),
    ).not.toBeNull();
    // The guided Set Name select is disabled until its required product-line parent
    // is chosen.
    const setName = screen.getByLabelText<HTMLSelectElement>("Set Name");
    expect(setName.disabled).toBe(true);
  });
});

// #1973: the import-context concern is a collapsible "Step 0" bar. Expanded while no
// scope is chosen (the operator must pick one); collapsed to a one-line summary once
// a scope is set, with the disclosure trigger as the edit affordance. Collapse/expand
// is pure client state — it never navigates, so it never full-reloads (no submit).
describe("CatalogWorkbenchShell collapsible import-context bar (Step 0)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the bar expanded with no collapsed summary when no scope is chosen", () => {
    render(
      <CatalogIntegrationsSurfacePage
        surface="daily"
        readModel={dailyReadModelWithProviders(
          "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import",
        )}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Step 0 · Choose import scope/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // No scope chosen yet → no collapsed summary, and the form is reachable.
    expect(screen.queryByText(/— edit$/)).toBeNull();
    expect(screen.getByLabelText<HTMLSelectElement>("Provider")).toBeTruthy();
  });

  it("collapses to a provider · unit · scope · profile summary once a scope is chosen", () => {
    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModelWithSourceOptions()} />);

    const trigger = screen.getByRole("button", { name: /Step 0 · Choose import scope/ });
    // A scope is chosen (en/base/base1) → the bar lands collapsed, summarizing the
    // current import context, and its form internals are hidden until expanded.
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByText("tcgdex · tcgdex:pokemon:card:import · en/base/base1 · profile 2026.06.04 — edit"),
    ).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Source scope" })).toBeNull();
  });

  it("expands in place to edit and collapses again without any navigation submit", () => {
    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModelWithSourceOptions()} />);

    const trigger = screen.getByRole("button", { name: /Step 0 · Choose import scope/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // Edit: clicking the summary trigger reveals the guided scope form…
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("group", { name: "Source scope" })).toBeTruthy();

    // …and collapsing again hides it. Neither toggle submits a navigation: the
    // collapse/expand is client state, so the page is never re-loaded by editing.
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(submitSpy).not.toHaveBeenCalled();
  });
});
