// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
  type CatalogPrimaryWorkbenchSourceOptionRequest,
} from "./primary-workbench-read-model";
import { CatalogIntegrationsSurfacePage } from "./integrations-surface-page";
import type { CatalogControlPlaneRouteSurfaceKey } from "./admin-control-plane/information-architecture";
import type { CatalogProviderSourceOptionKind, SourceObservationIntegrationOptionResponse } from "./contracts";
import { profileReview, sourceObservationScope } from "./primary-workbench-test-fixtures";

// The import-jobs module polls live progress via useRevalidator and the import
// context form submits context changes via useSubmit; these pages render bare (no
// data router), so stub both for the workbench tree. A single shared submit spy
// captures the client-navigation submits the context form/source-option controls
// now issue (replacing the former full-document form.requestSubmit()).
const submitSpy = vi.fn();
const submittedFormDataSnapshots: FormData[] = [];

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
    useSubmit: () => (target: unknown, options: unknown) => {
      if (target instanceof HTMLFormElement) {
        submittedFormDataSnapshots.push(new FormData(target));
      }
      submitSpy(target, options);
    },
  };
});

afterEach(() => {
  submitSpy.mockClear();
  submittedFormDataSnapshots.length = 0;
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

  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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

  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl,
    scopes: { items: [scope], total: 1, count: 1 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    sourceOptionPages: requests.map((request) => ({ request, response: japaneseSv8ResponseFor(request) })),
    controlPlaneOverview: null,
    canManageCatalog: true,
  });
}

function dailyReadModelWithExplicitJapaneseImportScope() {
  const profile = profileReview({
    active: true,
    lifecycle: "active",
    ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
  });
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
    "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&importScope=ja:SV:SV8&profileVersion=2026.06.04";
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl,
    scopes: [scope],
    profiles: [profile],
    cacheOnly: true,
  });

  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl,
    scopes: { items: [scope], total: 1, count: 1 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    sourceOptionPages: requests.map((request) => ({ request, response: japaneseSv8ResponseFor(request) })),
    controlPlaneOverview: null,
    canManageCatalog: true,
  });
}

function dailyTcgplayerYugiohModelsAfterStalePokemonScope() {
  const mtgProfile = profileReview({
    providerKey: "tcgplayer",
    profileKey: "mtg-single-card-product-sku",
    profileVersion: "2026.06.19",
    ingestionUnitKey: "tcgplayer:mtg:single-card:source-observation-import",
    displayName: "TCGplayer Magic single cards",
    active: true,
    lifecycle: "active",
    status: "active",
    profile: {
      providerKey: "tcgplayer",
      supportedScopes: ["product-line/category", "set-name"],
    },
    supportedScopes: ["product-line/category", "set-name"],
  });
  const yugiohProfile = profileReview({
    providerKey: "tcgplayer",
    profileKey: "yugioh-single-card-product-sku",
    profileVersion: "2026.06.20",
    ingestionUnitKey: "tcgplayer:yugioh:single-card:source-observation-import",
    displayName: "TCGplayer Yu-Gi-Oh single cards",
    active: false,
    lifecycle: "test",
    status: "planned",
    profile: {
      providerKey: "tcgplayer",
      supportedScopes: ["product-line/category", "set-name"],
    },
    supportedScopes: ["product-line/category", "set-name"],
  });
  const stalePokemonScope = sourceObservationScope({
    provider_key: "tcgplayer",
    language_code: "ja",
    product_line_id: "3",
    product_line_name: "Pokemon",
    series_id: "SV",
    series_name: "Scarlet & Violet",
    expansion_id: "SV8",
    expansion_name: "Super Electric Breaker",
  });
  const profiles = [mtgProfile, yugiohProfile];
  const requestUrl =
    "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:yugioh:single-card:source-observation-import&importScope=ja:SV:SV8&profileVersion=2026.06.20&filter.importScope=ja:SV:SV8&filter.providerKey=tcgplayer&sourceOptionAction=force-refresh&sourceOptionQueryKind=product-lines";
  const shellReadModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl,
    scopes: { items: [stalePokemonScope], total: 1, count: 1 },
    profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
    controlPlaneOverview: null,
    canManageCatalog: true,
  });
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl,
    routeContext: shellReadModel.routeContext,
    scopes: [stalePokemonScope],
    profiles,
    cacheOnly: true,
  });
  const streamedReadModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl,
    scopes: { items: [stalePokemonScope], total: 1, count: 1 },
    profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
    sourceOptionPages: requests.map((request) =>
      request.queryKind === "product-lines"
        ? {
            request,
            response: optionResponse(request, "fresh", "live", [{ value: "2", label: "Yu-Gi-Oh!", parentValue: null }]),
          }
        : { request },
    ),
    controlPlaneOverview: null,
    canManageCatalog: true,
  });

  return { shellReadModel, streamedSourceOptions: streamedReadModel.sourceOptions };
}

// Reproduces the live UAT retry-1 shape from #5850: a TCGplayer Magic single-card
// import context before the operator's scope has picked a product line, and the
// same context after a retry lands with productLineId=1 selected and the Product
// Line option page streamed in fully loaded and ready (453 options).
function tcgplayerProductLineRetryReadModels() {
  const profile = profileReview({
    providerKey: "tcgplayer",
    profileKey: "mtg-single-card-product-sku",
    profileVersion: "2026.06.19",
    ingestionUnitKey: "tcgplayer:mtg:single-card:source-observation-import",
    displayName: "TCGplayer Magic single cards",
    active: true,
    lifecycle: "active",
    status: "active",
    profile: {
      providerKey: "tcgplayer",
      supportedScopes: ["product-line/category", "set-name"],
    },
    supportedScopes: ["product-line/category", "set-name"],
  });

  const requestUrlBeforeRetry =
    "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:mtg:single-card:source-observation-import&profileVersion=2026.06.19";
  const beforeRetryReadModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl: requestUrlBeforeRetry,
    scopes: { items: [], total: 0, count: 0 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    controlPlaneOverview: null,
    canManageCatalog: true,
  });

  const scopeAfterRetry = sourceObservationScope({
    provider_key: "tcgplayer",
    product_line_id: "1",
    product_line_name: "Magic: The Gathering",
  });
  const requestUrlAfterRetry =
    "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:mtg:single-card:source-observation-import&productLineId=1&profileVersion=2026.06.19";
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl: requestUrlAfterRetry,
    scopes: [scopeAfterRetry],
    profiles: [profile],
    cacheOnly: false,
  });
  const productLineItems = Array.from({ length: 453 }, (_, index) => ({
    value: String(index + 1),
    label: index === 0 ? "Magic: The Gathering" : `Product Line ${index + 1}`,
    parentValue: null,
  }));
  const afterRetryReadModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl: requestUrlAfterRetry,
    scopes: { items: [scopeAfterRetry], total: 1, count: 1 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    sourceOptionPages: requests.map((request) =>
      request.queryKind === "product-lines"
        ? { request, response: optionResponse(request, "fresh", "live", productLineItems) }
        : { request },
    ),
    controlPlaneOverview: null,
    canManageCatalog: true,
  });

  return { beforeRetryReadModel, afterRetryReadModel };
}

function rejectedSourceOptionsPromise() {
  const promise = Promise.reject(new Error("streamed source options unavailable"));
  promise.catch(() => undefined);
  return promise;
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

type WorkbenchProviderUnitProfile = Readonly<{
  providerKey: string;
  profileKey: string;
  displayName: string;
  ingestionUnitKey: string;
  supportedScopes: readonly string[];
  sourceOptionKinds?: readonly CatalogProviderSourceOptionKind[];
}>;

const yugiohProviderUnitProfiles = [
  {
    providerKey: "ygoprodeck",
    profileKey: "yugioh-card-print-reference-data",
    displayName: "YGOPRODeck Yu-Gi-Oh Card Print Reference Data",
    ingestionUnitKey: "ygoprodeck:yugioh:single-card:reference-data",
    supportedScopes: ["set-name", "product/card"],
    sourceOptionKinds: [
      providerSourceOptionKind("set-names", "Set", "setName"),
      providerSourceOptionKind("products", "Card", "productName", {
        parentValueKind: "setName",
        parentDiagnosticText: "Select a Set before loading YGOPRODeck cards.",
      }),
    ],
  },
  {
    providerKey: "ygoprodeck",
    profileKey: "yugioh-set-reference-data",
    displayName: "YGOPRODeck Yu-Gi-Oh Set Reference Data",
    ingestionUnitKey: "ygoprodeck:yugioh:set:reference-data",
    supportedScopes: ["set-name"],
  },
  {
    providerKey: "ygojson",
    profileKey: "yugioh-set-reference-data",
    displayName: "YGOJSON Yu-Gi-Oh Set Reference Data",
    ingestionUnitKey: "ygojson:yugioh:set:reference-data",
    supportedScopes: ["set-name", "product"],
    sourceOptionKinds: [
      providerSourceOptionKind("set-names", "Set", "setName"),
      providerSourceOptionKind("products", "Sealed Product", "productName", {
        parentValueKind: "setName",
        parentDiagnosticText: "Select a Set before loading YGOJSON sealed products.",
      }),
    ],
  },
  {
    providerKey: "ygojson",
    profileKey: "yugioh-sealed-product-reference-data",
    displayName: "YGOJSON Yu-Gi-Oh Sealed Product Reference Data",
    ingestionUnitKey: "ygojson:yugioh:sealed-product:reference-data",
    supportedScopes: ["product"],
    sourceOptionKinds: [providerSourceOptionKind("products", "Sealed Product", "productName")],
  },
] as const satisfies readonly WorkbenchProviderUnitProfile[];

const tcgplayerProviderUnitProfiles = [
  {
    providerKey: "tcgplayer",
    profileKey: "pokemon-single-card-product-sku",
    displayName: "TCGplayer Pokemon single cards",
    ingestionUnitKey: "tcgplayer:pokemon:single-card:source-observation-import",
    supportedScopes: ["product-line/category", "set-name", "product", "sku"],
  },
  {
    providerKey: "tcgplayer",
    profileKey: "mtg-single-card-product-sku",
    displayName: "TCGplayer Magic single cards",
    ingestionUnitKey: "tcgplayer:mtg:single-card:source-observation-import",
    supportedScopes: ["product-line/category", "set-name", "product", "sku"],
  },
  {
    providerKey: "tcgplayer",
    profileKey: "yugioh-single-card-product-sku",
    displayName: "TCGplayer Yu-Gi-Oh single cards",
    ingestionUnitKey: "tcgplayer:yugioh:single-card:source-observation-import",
    supportedScopes: ["product-line/category", "set-name", "product", "sku"],
  },
] as const satisfies readonly WorkbenchProviderUnitProfile[];

function providerSourceOptionKind(
  queryKind: string,
  displayName: string,
  scope: string,
  parent: Partial<Pick<CatalogProviderSourceOptionKind, "parentValueKind" | "parentDiagnosticText">> = {},
): CatalogProviderSourceOptionKind {
  return {
    queryKind,
    queryKeySynonyms: [],
    displayName,
    scope,
    parentScope: null,
    parentRequired: Boolean(parent.parentValueKind),
    parentValueKind: parent.parentValueKind ?? null,
    parentDiagnosticText: parent.parentDiagnosticText ?? null,
  };
}

function providerUnitProfileReview(profile: WorkbenchProviderUnitProfile) {
  return profileReview({
    providerKey: profile.providerKey,
    profileKey: profile.profileKey,
    displayName: profile.displayName,
    ingestionUnitKey: profile.ingestionUnitKey,
    active: true,
    lifecycle: "active",
    status: "active",
    profile: {
      providerKey: profile.providerKey,
      supportedScopes: [...profile.supportedScopes],
    },
    supportedScopes: [...profile.supportedScopes],
    sourceOptionKinds: [...(profile.sourceOptionKinds ?? [])],
  });
}

function dailyReadModelWithProviders(requestUrl: string) {
  const profiles = [
    providerProfile("scrydex", "Scrydex", "product/card"),
    providerProfile("tcgdex", "TCGdex", "pokemon/card"),
  ];

  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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

function latestSubmittedFormData(): FormData {
  const submitted = submittedFormDataSnapshots.at(-1);
  expect(submitted).toBeDefined();
  return submitted!;
}

function appendHiddenField(form: HTMLFormElement, name: string, value: string): void {
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = name;
  field.value = value;
  form.appendChild(field);
}

function appendStaleImportContextHiddenState(form: HTMLFormElement): void {
  appendHiddenField(form, "importScope", "en:OP09");
  appendHiddenField(form, "filter.importScope", "en:OP09");
  appendHiddenField(form, "filter.providerKey", "scrydex");
  appendHiddenField(form, "filter.status", "changed");
  appendHiddenField(form, "selectedObservationIds", "obs_old");
  appendHiddenField(form, "jobId", "job_old");
  appendHiddenField(form, "reviewOffset", "25");
  appendHiddenField(form, "reviewLimit", "50");
  appendHiddenField(form, "promotionPreviewId", "preview_old");
}

function expectSubmittedWithoutStaleImportContextState(submitted: FormData): void {
  expect(submitted.has("importScope")).toBe(false);
  expect([...submitted.keys()].some((key) => key.startsWith("filter."))).toBe(false);
  expect(submitted.has("selectedObservationIds")).toBe(false);
  expect(submitted.has("jobId")).toBe(false);
  expect(submitted.has("reviewOffset")).toBe(false);
  expect(submitted.has("reviewLimit")).toBe(false);
  expect(submitted.has("promotionPreviewId")).toBe(false);
}

describe("CatalogWorkbenchShell single per-surface return affordance", () => {
  afterEach(() => {
    cleanup();
  });

  // The supporting surfaces stack multiple workspaces; the back-link is rendered
  // once by the surface header rather than repeated per stacked workspace (#1739
  // left three on the health surface, forcing e2e .first()).
  it.each(["governance", "health"] as const)(
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
    expect(
      within(unit).queryByRole("option", { name: "scrydex:one-piece:single-card:source-observation-import" }),
    ).toBeNull();
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
    appendStaleImportContextHiddenState(form!);

    fireEvent.change(provider, { target: { value: "scrydex" } });

    expect(provider.value).toBe("scrydex");
    expect(unit.value).toBe("");
    expect(unit.disabled).toBe(false);
    expect(profileVersion.value).toBe("");
    expect(profileVersion.disabled).toBe(false);

    const submitted = latestSubmittedFormData();
    expect(submitted.get("providerKey")).toBe("scrydex");
    expect(submitted.has("unitKey")).toBe(false);
    expect(submitted.has("languageCode")).toBe(false);
    expect(submitted.has("seriesId")).toBe(false);
    expect(submitted.has("expansionId")).toBe(false);
    expect(submitted.has("profileVersion")).toBe(false);
    expect(submitted.has("sourceOptionAction")).toBe(false);
    expect(submitted.has("sourceOptionQueryKind")).toBe(false);
    expectSubmittedWithoutStaleImportContextState(submitted);
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
    expect(profileVersion.disabled).toBe(false);

    const submitted = latestSubmittedFormData();
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
    expect(unit.value).toBe("scrydex:one-piece:single-card:source-observation-import");
    expect(
      within(unit).getByRole("option", { name: "scrydex:one-piece:single-card:source-observation-import" }),
    ).toBeTruthy();
    expect(within(unit).queryByRole("option", { name: "tcgdex:pokemon:card:import" })).toBeNull();
    const scope = readModel.routeContext.scope;
    expect(scope).toBeDefined();
    expect(readModel.routeContext.importScope).toBeNull();
    expect(scope?.languageCode).toBeNull();
    expect(scope?.seriesId).toBeNull();
    expect(readModel.routeContext.profileVersion).toBe("2026.06.04");
  });

  it("represents Yu-Gi-Oh provider units beside existing Pokemon and Magic choices", () => {
    const profiles = [
      providerUnitProfileReview({
        providerKey: "tcgdex",
        profileKey: "pokemon-tcg",
        displayName: "TCGdex Pokemon cards",
        ingestionUnitKey: "tcgdex:pokemon:card:import",
        supportedScopes: ["pokemon/card"],
      }),
      providerUnitProfileReview({
        providerKey: "mtgjson",
        profileKey: "mtg-card-reference-data",
        displayName: "MTGJSON Magic card reference data",
        ingestionUnitKey: "mtgjson:mtg:single-card:reference-data",
        supportedScopes: ["set-name", "product/card"],
      }),
      providerUnitProfileReview({
        providerKey: "scryfall",
        profileKey: "mtg-card-print-reference-data",
        displayName: "Scryfall Magic card print reference data",
        ingestionUnitKey: "scryfall:mtg:single-card:reference-data",
        supportedScopes: ["set-name", "product/card"],
      }),
      ...yugiohProviderUnitProfiles.map(providerUnitProfileReview),
      ...tcgplayerProviderUnitProfiles.map(providerUnitProfileReview),
    ];
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgplayer",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    const provider = screen.getByLabelText<HTMLSelectElement>("Provider");
    const providerKeys = [...provider.options].map((option) => option.value);
    for (const providerKey of ["tcgdex", "mtgjson", "scryfall", "tcgplayer", "ygoprodeck", "ygojson"]) {
      expect(providerKeys).toContain(providerKey);
    }

    const tcgplayerUnits = screen.getByLabelText<HTMLSelectElement>("Unit");
    expect(
      within(tcgplayerUnits).getByRole("option", {
        name: "tcgplayer:pokemon:single-card:source-observation-import",
      }),
    ).toBeTruthy();
    expect(
      within(tcgplayerUnits).getByRole("option", {
        name: "tcgplayer:mtg:single-card:source-observation-import",
      }),
    ).toBeTruthy();
    expect(
      within(tcgplayerUnits).getByRole("option", {
        name: "tcgplayer:yugioh:single-card:source-observation-import",
      }),
    ).toBeTruthy();

    const providerScope = readModel.providerScope.providers;
    const ygoprodeckUnits = providerScope
      .find((option) => option.providerKey === "ygoprodeck")
      ?.units.map((unit) => unit.unitKey);
    expect(ygoprodeckUnits).toHaveLength(2);
    expect(ygoprodeckUnits).toEqual(
      expect.arrayContaining(["ygoprodeck:yugioh:single-card:reference-data", "ygoprodeck:yugioh:set:reference-data"]),
    );

    const ygojsonUnits = providerScope
      .find((option) => option.providerKey === "ygojson")
      ?.units.map((unit) => unit.unitKey);
    expect(ygojsonUnits).toHaveLength(2);
    expect(ygojsonUnits).toEqual(
      expect.arrayContaining(["ygojson:yugioh:set:reference-data", "ygojson:yugioh:sealed-product:reference-data"]),
    );
  });
});

describe("CatalogWorkbenchShell no page-local cross-surface navigation", () => {
  afterEach(() => {
    cleanup();
  });

  // Cross-surface navigation now lives in the admin shell side nav (the nested
  // "Integrations" manifest group), so the integrations surface must not render its
  // own "Catalog control plane workflows" navigation or the mobile workflow combobox.
  it.each(["daily", "governance", "health"] as const)(
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

  it("hydrates guided scope fields from the effective import scope when structured query fields are absent", () => {
    render(
      <CatalogIntegrationsSurfacePage surface="daily" readModel={dailyReadModelWithExplicitJapaneseImportScope()} />,
    );
    expandImportContextBar();

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    const language = within(scopeGroup).getByLabelText<HTMLSelectElement>("Language");
    const series = within(scopeGroup).getByLabelText<HTMLSelectElement>("Series");
    const expansion = within(scopeGroup).getByLabelText<HTMLSelectElement>("Expansion");

    expect(language.value).toBe("ja");
    expect(within(language).getByRole("option", { name: "Japanese" })).toBeTruthy();
    expect(series.value).toBe("SV");
    expect(within(series).getByRole("option", { name: "Scarlet & Violet" })).toBeTruthy();
    expect(expansion.value).toBe("SV8");
    expect(within(expansion).getByRole("option", { name: "Super Electric Breaker" })).toBeTruthy();
  });

  it("does not hard-code TCGdex scope levels for a generic provider", () => {
    const profile = profileReview({ providerKey: "tcgplayer", active: true, lifecycle: "active" });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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
    expect(document.querySelector<HTMLInputElement>('input[name="expansionName"]')).not.toBeNull();
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
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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
    appendStaleImportContextHiddenState(form!);

    fireEvent.change(language, { target: { value: "ja" } });

    const action = form!.elements.namedItem("sourceOptionAction");
    expect(action).toBeInstanceOf(HTMLInputElement);
    expect((action as HTMLInputElement).type).toBe("hidden");
    expect((action as HTMLInputElement).value).toBe("force-refresh-all");
    expect(form!.elements.namedItem("sourceOptionQueryKind")).toBeNull();
    expectSubmittedWithoutStaleImportContextState(latestSubmittedFormData());
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
    expect((form!.elements.namedItem("seriesName") as HTMLInputElement).value).toBe("Scarlet & Violet");
    expect((form!.elements.namedItem("expansionName") as HTMLInputElement).value).toBe("Super Electric Breaker");
    const action = form!.elements.namedItem("sourceOptionAction");
    expect(action).toBeInstanceOf(HTMLInputElement);
    expect((action as HTMLInputElement).value).toBe("force-refresh-all");
    expect(latestSubmittedFormData().get("seriesName")).toBe("Scarlet & Violet");
    expect(latestSubmittedFormData().get("expansionName")).toBe("Super Electric Breaker");
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]![0]).toBe(form);
  });

  it("keeps the importer usable when the streamed source-options slice rejects", async () => {
    const { container } = render(
      <CatalogIntegrationsSurfacePage
        surface="daily"
        readModel={surfaceReadModel("daily")}
        deferredSourceOptions={rejectedSourceOptionsPromise()}
      />,
    );
    expandImportContextBar();

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    expect(within(scopeGroup).getByLabelText<HTMLSelectElement>("Language")).toBeTruthy();
    expect(within(scopeGroup).getByLabelText<HTMLSelectElement>("Series")).toBeTruthy();
    expect(within(scopeGroup).getByLabelText<HTMLSelectElement>("Expansion")).toBeTruthy();

    await waitFor(() => {
      expect(container.querySelector("[data-catalog-source-options-status]")).not.toBeNull();
    });
  });

  // Regression coverage for #5850. The guided scope selects used `defaultValue`
  // inside a `Fragment key={field.queryKind}` subtree that is intentionally
  // stable across a streamed-options revalidation (so focus/scroll survive the
  // fallback -> resolved swap) — but a stable key means `defaultValue` only ever
  // applies once, at first mount. A live UAT retry proved the resulting defect:
  // the route carried productLineId=1 with 453 Product Line options loaded and
  // Ready, yet the already-mounted control still showed the placeholder from
  // whatever was selected (or absent) at first mount. `rerender` on the SAME
  // `render()` instance (no unmount, matching the client GET navigation that
  // revalidates the loader in place without remounting the route) reproduces
  // that exact shape.
  it("reflects a route/deferred-option revalidation on the already-mounted guided select instead of freezing at its first-mount value", () => {
    const { beforeRetryReadModel, afterRetryReadModel } = tcgplayerProductLineRetryReadModels();

    const { rerender } = render(<CatalogIntegrationsSurfacePage surface="daily" readModel={beforeRetryReadModel} />);
    expandImportContextBar();

    const scopeGroupBefore = screen.getByRole("group", { name: "Source scope" });
    const productLineBefore = within(scopeGroupBefore).getByLabelText<HTMLSelectElement>("Product Line");
    expect(productLineBefore.value).toBe("");

    // Revalidation: the route now carries productLineId=1 and the option page has
    // streamed in fully loaded (453 items, ready) — the retry-1 shape from the
    // live UAT run.
    rerender(<CatalogIntegrationsSurfacePage surface="daily" readModel={afterRetryReadModel} />);

    const scopeGroupAfter = screen.getByRole("group", { name: "Source scope" });
    const productLineAfter = within(scopeGroupAfter).getByLabelText<HTMLSelectElement>("Product Line");
    expect(productLineAfter.value).toBe("1");
    expect(within(productLineAfter).getByRole("option", { name: "Magic: The Gathering" }).getAttribute("value")).toBe(
      "1",
    );
    // Purely a passive prop update carried by the route/loader — no user action
    // (submit) fired to produce this value.
    expect(submitSpy).not.toHaveBeenCalled();
  });

  // AC2 (#5850), stated literally: route has productLineId, options loaded ->
  // control shows the product line. A fresh mount already passed even on the
  // buggy `defaultValue` code (defaultValue does apply on first mount); this
  // guards the observable contract regardless of which mechanism satisfies it.
  it("shows the route's selected product line on a fresh mount whose options are already loaded and ready", () => {
    const { afterRetryReadModel } = tcgplayerProductLineRetryReadModels();

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={afterRetryReadModel} />);
    expandImportContextBar();

    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    const productLine = within(scopeGroup).getByLabelText<HTMLSelectElement>("Product Line");
    expect(productLine.value).toBe("1");
    expect(within(productLine).getByRole<HTMLOptionElement>("option", { name: "Magic: The Gathering" }).selected).toBe(
      true,
    );
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
      const submitOptions = submitSpy.mock.calls[0]![1] as { action: string; method: string };
      expect(submitOptions.method).toBe("get");
      const target = new URL(submitOptions.action, "https://admin.example");
      expect(target.pathname).toBe("/catalog/integrations");
      expect(target.search).toBe("");
      expect(target.pathname).not.toContain("/api/catalog");
      const submittedParams = new URLSearchParams(submitSpy.mock.calls[0]![0] as URLSearchParams);
      expect(submittedParams.get("sourceOptionAction")).toBe("reload");
      expect(submittedParams.get("sourceOptionQueryKind")).toBeTruthy();
      // Route context is preserved so the reload reopens the same scope.
      expect(submittedParams.get("providerKey")).toBe("tcgdex");
      expect(submittedParams.has("forceRefresh")).toBe(false);
    }

    const forceRefresh = panelScope.getAllByRole("button", { name: "Force refresh" });
    expect(forceRefresh.length).toBeGreaterThan(0);
    submitSpy.mockClear();
    fireEvent.click(forceRefresh[0]!);
    const forceRefreshTarget = new URL(
      (submitSpy.mock.calls[0]![1] as { action: string }).action,
      "https://admin.example",
    );
    const forceRefreshParams = new URLSearchParams(submitSpy.mock.calls[0]![0] as URLSearchParams);
    expect(forceRefreshTarget.pathname).toBe("/catalog/integrations");
    expect(forceRefreshTarget.search).toBe("");
    expect(forceRefreshParams.get("sourceOptionAction")).toBe("force-refresh");
    expect(forceRefreshParams.get("sourceOptionQueryKind")).toBeTruthy();
    expect(forceRefreshParams.has("forceRefresh")).toBe(false);

    const refreshAll = panelScope.getByRole("button", { name: "Refresh all" });
    submitSpy.mockClear();
    fireEvent.click(refreshAll);
    const refreshAllTarget = new URL(
      (submitSpy.mock.calls[0]![1] as { action: string }).action,
      "https://admin.example",
    );
    const refreshAllParams = new URLSearchParams(submitSpy.mock.calls[0]![0] as URLSearchParams);
    expect(refreshAllTarget.pathname).toBe("/catalog/integrations");
    expect(refreshAllTarget.search).toBe("");
    expect(refreshAllParams.get("sourceOptionAction")).toBe("force-refresh-all");
    // Refresh-all fans across every group, so it carries no single queryKind.
    expect(refreshAllParams.has("sourceOptionQueryKind")).toBe(false);
    expect(refreshAllParams.has("forceRefresh")).toBe(false);
  });

  it("submits streamed TCGplayer Yu-Gi-Oh parent refreshes without stale Pokemon scope", async () => {
    const { shellReadModel, streamedSourceOptions } = dailyTcgplayerYugiohModelsAfterStalePokemonScope();
    const { container } = render(
      <CatalogIntegrationsSurfacePage
        surface="daily"
        readModel={shellReadModel}
        deferredSourceOptions={Promise.resolve(streamedSourceOptions)}
      />,
    );
    expandImportContextBar();

    await waitFor(() => {
      expect(
        container.querySelector('[data-source-option-page="product-lines"][data-source-option-state="live"]'),
      ).not.toBeNull();
    });
    const productLines = container.querySelector('[data-source-option-page="product-lines"]');
    expect(productLines).not.toBeNull();

    submitSpy.mockClear();
    fireEvent.click(within(productLines as HTMLElement).getByRole("button", { name: "Force refresh" }));

    expect(submitSpy).toHaveBeenCalledTimes(1);
    const submitOptions = submitSpy.mock.calls[0]![1] as { action: string; method: string };
    const submittedParams = new URLSearchParams(submitSpy.mock.calls[0]![0] as URLSearchParams);
    expect(new URL(submitOptions.action, "https://admin.example").pathname).toBe("/catalog/integrations");
    expect(submittedParams.get("providerKey")).toBe("tcgplayer");
    expect(submittedParams.get("unitKey")).toBe("tcgplayer:yugioh:single-card:source-observation-import");
    expect(submittedParams.get("profileVersion")).toBe("2026.06.20");
    expect(submittedParams.get("sourceOptionAction")).toBe("force-refresh");
    expect(submittedParams.get("sourceOptionQueryKind")).toBe("product-lines");
    expect(submittedParams.has("importScope")).toBe(false);
    expect(submittedParams.has("filter.importScope")).toBe(false);
    expect(submittedParams.has("forceRefresh")).toBe(false);

    expect(screen.queryByRole("button", { name: "Refresh all" })).toBeNull();
  });

  it("flags a group whose required parent scope is not selected yet", () => {
    const profile = profileReview({ providerKey: "tcgplayer", active: true, lifecycle: "active" });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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
    const setNamesPage = container.querySelector('[data-source-option-page="set-names"]');
    expect(setNamesPage).not.toBeNull();
    expect(
      within(setNamesPage as HTMLElement).getByRole<HTMLButtonElement>("button", { name: "Reload" }).disabled,
    ).toBe(true);
    expect(
      within(setNamesPage as HTMLElement).getByRole<HTMLButtonElement>("button", { name: "Force refresh" }).disabled,
    ).toBe(true);
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
