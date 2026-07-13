// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tcgdexPokemonCardSourceObservationMappingContract } from "../api/tcgdex-executable-mapping-contract";
import { tcgdexPokemonTcgProviderProfile } from "../api/provider-integration-profiles";
import { catalogProviderProfileEditableSectionKeys } from "../api/provider-profile-section-registry";
import type { SourceObservationLorcanaCardPrintNormalized } from "../domain/domain";
import {
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  buildCatalogPrimaryWorkbenchSourceOptionRequests,
  type CatalogPrimaryWorkbenchSourceOptionRequest,
} from "./primary-workbench-read-model";
import { CatalogIntegrationsSurfacePage } from "./integrations-surface-page";
import type { SourceObservationIntegrationOptionResponse } from "./contracts";
import {
  controlPlaneOverview,
  catalogMergeCandidateListItem,
  integrationJobSummary,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "./primary-workbench-test-fixtures";
import { CatalogIntegrationProfileAuthoringWorkspace } from "./admin-control-plane/profiles/profile-authoring-workspace";

// The import-jobs module polls live progress via useRevalidator, the daily
// import-context form submits context changes via useSubmit, and the review
// evidence SideSheet lazy-loads deep evidence via useFetcher (#1971); these pages
// render bare (no data router), so stub all three for the workbench tree. The
// useFetcher stub stays in the idle/no-data state, so opening the evidence sheet
// renders its DS loading state — the deep-evidence composition is covered directly
// by the read-model unit tests and end-to-end by the integrations e2e spec.
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useRevalidator: () => ({ revalidate: () => undefined, state: "idle" }),
    useSubmit: () => () => undefined,
    useFetcher: () => ({ state: "idle", data: undefined, load: () => undefined }),
  };
});

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// The import-context controls (provider/unit/guided-scope/profile) now live in the
// collapsible "Step 0" bar (#1973). With a scope already chosen the bar renders
// COLLAPSED to a summary, so its form internals are mounted but `hidden`. Expand it
// via its trigger before asserting on those controls — the same edit round trip an
// operator performs.
function expandImportContextBar(): void {
  const trigger = screen.queryByRole("button", { name: /Step 0 · Choose import scope/ });
  if (trigger && trigger.getAttribute("aria-expanded") === "false") {
    fireEvent.click(trigger);
  }
}

// Supporting workspaces link back to the daily import-to-promotion surface route,
// which is the base /catalog/integrations path and carries no ?section= (it is the
// default workspace of its surface).
function expectBackToWorkbenchHref(href: string | null | undefined) {
  const url = new URL(href ?? "", "https://admin.example");
  expect(url.pathname).toBe("/catalog/integrations");
  expect(url.searchParams.has("section")).toBe(false);
}

const japaneseSv8RequestUrl =
  "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&languageCode=ja&seriesId=SV&expansionId=SV8&profileVersion=2026.06.04";

function japaneseSv8SourceOptionResponse(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
): SourceObservationIntegrationOptionResponse {
  if (request.queryKind === "languages") {
    return sourceOptionResponse(request, "fresh", "cache", [{ value: "ja", label: "Japanese", parentValue: null }]);
  }
  if (request.queryKind === "series") {
    return sourceOptionResponse(request, "fresh", "live", [
      { value: "SV", label: "Scarlet & Violet", parentValue: "ja" },
    ]);
  }

  return sourceOptionResponse(request, "fresh", "live", [
    { value: "SV8", label: "Super Electric Breaker", parentValue: "SV" },
  ]);
}

function sourceOptionResponse(
  request: CatalogPrimaryWorkbenchSourceOptionRequest,
  status: NonNullable<SourceObservationIntegrationOptionResponse["cache"]>["status"],
  source: NonNullable<SourceObservationIntegrationOptionResponse["cache"]>["source"],
  items: readonly { value: string; label: string; parentValue: string | null }[],
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
      degraded: false,
      diagnostics: [],
    },
  };
}

// The single rebuilt page renders one audience surface at a time. The describe
// keeps its historical name so the launch test-architecture anchor that asserts
// this file still documents the rebuilt rendered-workflow coverage continues to
// pass; the coverage now exercises CatalogIntegrationsSurfacePage per surface.
describe("CatalogPrimaryWorkbenchPage", () => {
  afterEach(() => {
    cleanup();
    window.history.pushState({}, "", "/catalog/integrations");
  });

  it("guides a Japanese SV8 operator from provider options to sync, review, and promote-all", () => {
    const profile = profileReview({ active: true, lifecycle: "active", languageOptions: ["ja"] });
    const japaneseSv8Scope = sourceObservationScope({
      language_code: "ja",
      product_line_id: "",
      series_id: "SV",
      series_name: "Scarlet & Violet",
      expansion_id: "SV8",
      expansion_name: "Super Electric Breaker",
      total_observations: 130,
      observed_observations: 130,
      changed_observations: 130,
      promoted_observations: 0,
      rejected_observations: 0,
    });
    const sourceOptionRequests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
      requestUrl: japaneseSv8RequestUrl,
      scopes: [japaneseSv8Scope],
      profiles: [profile],
      cacheOnly: true,
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: japaneseSv8RequestUrl,
      scopes: { items: [japaneseSv8Scope], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      sourceOptionPages: sourceOptionRequests.map((request) => ({
        request,
        response: japaneseSv8SourceOptionResponse(request),
      })),
      controlPlaneOverview: null,
      reviewObservations: {
        items: [
          sourceObservationListItem({
            external_key: "SV8-001",
            language_code: "ja",
            normalized: {
              ...sourceObservationListItem().normalized,
              languageCode: "ja",
              name: "Pikachu ex",
              setId: "SV8",
              setName: "Super Electric Breaker",
              expansionId: "SV8",
              expansionName: "Super Electric Breaker",
              seriesId: "SV",
              seriesName: "Scarlet & Violet",
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(
      screen.getByRole("heading", {
        name: "Pull provider data, review Source Observations, promote Catalog facts",
      }),
    ).toBeTruthy();
    // The Japanese SV8 scope is already chosen, so the Step 0 bar lands collapsed;
    // expand it to drive the provider-options -> guided-scope walkthrough.
    expandImportContextBar();
    expect(screen.getByLabelText("Provider")).toBeTruthy();
    expect(screen.getByLabelText("Unit")).toBeTruthy();
    // The raw colon-delimited import-scope text box is replaced by guided,
    // profile-driven scope selects whose values come from synced provider options.
    expect(screen.queryByLabelText("Import scope")).toBeNull();
    const scopeGroup = screen.getByRole("group", { name: "Source scope" });
    const language = within(scopeGroup).getByLabelText("Language") as HTMLSelectElement;
    const series = within(scopeGroup).getByLabelText("Series") as HTMLSelectElement;
    const expansion = within(scopeGroup).getByLabelText("Expansion") as HTMLSelectElement;
    expect(language.name).toBe("languageCode");
    expect(language.value).toBe("ja");
    expect(within(language).getByRole("option", { name: "Japanese" })).toBeTruthy();
    expect(series.name).toBe("seriesId");
    expect(series.value).toBe("SV");
    expect(within(series).getByRole("option", { name: "Scarlet & Violet" })).toBeTruthy();
    expect(expansion.name).toBe("expansionId");
    expect(expansion.value).toBe("SV8");
    expect(within(expansion).getByRole("option", { name: "Super Electric Breaker" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply context" })).toBeNull();
    expect(screen.getByRole("button", { name: "Select source scope" })).toBeTruthy();
    // The daily flow is now an explicit, linear three-stage path. The stepper names
    // each stage; the review and create stages expose their work below it.
    expect(screen.getAllByText("Run sync").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Review changes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Create / update items").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Source Observation review" })).toBeTruthy();
    expect(screen.getAllByText("Pikachu ex").length).toBeGreaterThan(0);
    expect(screen.getByText("Promote all eligible in this scope")).toBeTruthy();
    // The promotion command plan is demoted into supporting detail inside the create
    // stage; its detail content (including the decision summaries) stays rendered.
    expect(screen.getByText("Promotion command plan")).toBeTruthy();
    expect(screen.getAllByText("Matching filtered observations").length).toBeGreaterThan(0);
    expect(screen.getByText("Reject requires a reason")).toBeTruthy();
    expect(screen.getByText("Defer keeps observations in review")).toBeTruthy();
    expect(screen.getByText("Reapply uses current active profile")).toBeTruthy();
    expect(screen.getByText("Replay uses original source profile version")).toBeTruthy();
    expect(
      screen.getByText("Rejects stale observation, profile, rollout, permission, and command input changes"),
    ).toBeTruthy();

    // Cross-surface navigation now lives in the admin shell side nav (the nested
    // "Integrations" manifest group), not on the page: the integrations surface no
    // longer renders its own "Catalog control plane workflows" nav or the mobile
    // workflow combobox.
    expect(screen.queryByRole("navigation", { name: "Catalog control plane workflows" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Choose Catalog workflow" })).toBeNull();
    expect(screen.queryByText("Old integrations surface")).toBeNull();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();

    // Scope-first sync lives in the Run sync stage. Open that stage last because
    // it collapses the review/create stages asserted above.
    fireEvent.click(screen.getByRole("button", { name: /Run sync/i }));
    expect(screen.getByRole("heading", { name: "Catalog scope sync" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Catalog sync" })).toBeTruthy();

    const syncForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="start-catalog-sync"]',
    );
    expect(syncForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("start-catalog-sync");
    expect(syncForm?.querySelector<HTMLInputElement>('input[name="productDomain"]')?.value).toBe("pokemon");
    expect(syncForm?.querySelector<HTMLInputElement>('input[name="productForm"]')?.value).toBe("card");
    expect(syncForm?.querySelector<HTMLInputElement>('input[name="languageCode"]')?.value).toBe("ja");
    expect(syncForm?.querySelector<HTMLInputElement>('input[name="referenceKind"]')?.value).toBe("expansion");
    expect(syncForm?.querySelector<HTMLInputElement>('input[name="referenceId"]')?.value).toBe("SV8");
    expect(syncForm?.querySelector<HTMLInputElement>('input[name="expansionId"]')?.value).toBe("SV8");
    expect(syncForm?.querySelector<HTMLInputElement>('input[name="selectedUnitKeys"]')?.value).toBe(
      "tcgdex:pokemon:card:import",
    );
  });

  it("enables Catalog sync after selecting an optional eligible provider unit", () => {
    const pokemonUnit = "tcgplayer:pokemon:single-card:source-observation-import";
    const catalogSyncPreview = {
      previewVersion: "catalog-sync-provider-participation-preview-v1" as const,
      scope: {
        scopeVersion: "catalog-sync-scope-v1" as const,
        productDomain: "pokemon",
        productForm: "single-card",
        languageCode: "en",
        reference: { kind: "set" as const, id: "Base Set", name: "Base Set", seriesId: null, seriesName: null },
        providerHints: [
          {
            providerKey: "tcgplayer",
            unitKey: pokemonUnit,
            productLineId: "3",
            productLineName: "Pokemon",
            setName: "Base Set",
          },
        ],
        providerParticipation: {
          requiredUnitKeys: [],
          selectedUnitKeys: [],
          excludedUnitKeys: [],
        },
      },
      status: "ready" as const,
      startAllowed: true,
      units: [
        {
          providerKey: "tcgplayer",
          unitKey: pokemonUnit,
          profileKey: "pokemon-single-card-product-sku",
          profileVersion: "2026.06.03",
          displayName: "TCGplayer Pokemon Single Cards",
          role: "supplemental-marketplace-reference" as const,
          requirement: "optional" as const,
          eligibility: "eligible" as const,
          defaultSelected: false,
          selected: false,
          childExecutionScope: {
            provider: "tcgplayer",
            profileKey: "pokemon-single-card-product-sku",
            ingestionUnitKey: pokemonUnit,
            language: "en",
            productLineId: "3",
            setName: "Base Set",
          },
          estimate: {
            targetCount: null,
            requestStrategy: null,
            estimatedRequestCount: null,
            estimateState: "not-requested" as const,
            estimateReason: null,
            transportSteps: [],
          },
          blockers: [],
          explanation: "TCGplayer Pokemon Single Cards can participate as an optional reference unit.",
        },
      ],
      blockers: [],
      explanation: "Eligible provider units are ready to pull Source Observations for this Catalog scope.",
    };
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Apokemon%3Asingle-card%3Asource-observation-import&languageCode=en&productLineId=3&productLineName=Pokemon&expansionName=Base+Set",
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "tcgplayer",
            language_code: "en",
            product_line_id: "3",
            product_line_name: "Pokemon",
            series_id: undefined,
            series_name: undefined,
            expansion_id: undefined,
            expansion_name: "Base Set",
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: {
        items: [
          profileReview({
            providerKey: "tcgplayer",
            profileKey: "pokemon-single-card-product-sku",
            profileVersion: "2026.06.03",
            ingestionUnitKey: pokemonUnit,
            displayName: "TCGplayer Pokemon Single Cards",
            lifecycle: "active",
            active: true,
            status: "active",
            profile: {
              providerKey: "tcgplayer",
              supportedScopes: ["product-line/category", "set-name", "product", "sku"],
            },
            supportedScopes: ["product-line/category", "set-name", "product", "sku"],
          }),
        ],
        total: 1,
        count: 1,
      },
      catalogSyncPreview,
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);
    fireEvent.click(screen.getByRole("button", { name: /Run sync/i }));

    const startButton = screen.getByRole("button", { name: "Start Catalog sync" });
    expect(startButton.hasAttribute("disabled")).toBe(true);

    const participationRow = document.querySelector<HTMLElement>(
      `[data-catalog-sync-participation-unit="${pokemonUnit}"]`,
    );
    expect(participationRow).toBeTruthy();
    const checkbox = within(participationRow!).getByRole("checkbox", { name: "Not selected" });
    expect(checkbox.hasAttribute("disabled")).toBe(false);

    fireEvent.click(checkbox);

    expect(within(participationRow!).getByRole("checkbox", { name: "Selected" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Catalog sync" }).hasAttribute("disabled")).toBe(false);
    const syncForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="start-catalog-sync"]',
    );
    expect(
      [...(syncForm?.querySelectorAll<HTMLInputElement>('input[name="selectedUnitKeys"]') ?? [])].map(
        (input) => input.value,
      ),
    ).toContain(pokemonUnit);
  });

  it("reviews merged candidates before Source Observation evidence with detail mapping and action affordances", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&languageCode=en&seriesId=base&expansionId=base1&profileVersion=2026.06.04",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      mergeCandidates: { items: [catalogMergeCandidateListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Merged candidate review" })).toBeTruthy();
    expect(screen.getAllByText("Charizard / Base Set / #4 / en / standard").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/tcgdex: obs_001/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/tcgplayer: obs_tcgplayer_001/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("0 blocking").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Promote: Charizard/ }).length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByRole("button", { name: /Split: Charizard/ })
        .at(0)
        ?.hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen
        .getAllByRole("button", { name: /Update: Charizard/ })
        .at(0)
        ?.hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.getAllByRole("button", { name: /Ignore: Charizard/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Defer: Charizard/ }).length).toBeGreaterThan(0);

    const promoteForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="promote-merge-candidate"]',
    );
    expect(promoteForm?.querySelector<HTMLInputElement>('input[name="candidateId"]')?.value).toBe(
      "cand_pokemon_base1_004_standard",
    );
    expect(promoteForm?.querySelector<HTMLInputElement>('input[name="reason"]')?.value).toBe(
      "Promote from the scope-first Catalog sync workbench.",
    );
    const splitForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="split-merge-candidate"]',
    );
    const updateForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="update-merge-candidate"]',
    );
    const splitBody = JSON.parse(
      splitForm?.querySelector<HTMLInputElement>('input[name="mergeCandidateCommandBody"]')?.value ?? "{}",
    ) as Record<string, unknown>;
    const updateBody = JSON.parse(
      updateForm?.querySelector<HTMLInputElement>('input[name="mergeCandidateCommandBody"]')?.value ?? "{}",
    ) as Record<string, unknown>;
    expect(splitBody).toMatchObject({
      reason: "Split candidate from the scope-first Catalog sync workbench.",
      splitCandidateId: "cand_pokemon_base1_004_standard__split__obs_tcgplayer_001",
    });
    expect(updateBody).toMatchObject({
      reason: "Update Product mapping from the scope-first Catalog sync workbench.",
      snapshot: {
        identityFingerprint: "sha256:candidate-identity",
        proposedExternalProductReferences: [
          {
            providerKey: "tcgplayer",
            externalKey: "sku:123",
          },
        ],
      },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Evidence" }).at(0)!);

    expect(screen.getByRole("dialog", { name: /Candidate detail:/ })).toBeTruthy();
    expect(screen.getByText("Source comparison")).toBeTruthy();
    expect(screen.getByText(/tcgdex obs_001 name: Charizard/)).toBeTruthy();
    expect(screen.getByText("Field provenance")).toBeTruthy();
    expect(screen.getByText(/cardNumber: tcgplayer 2026.06.04 High/)).toBeTruthy();
    expect(screen.getByText("Proposed references and Product mapping")).toBeTruthy();
    expect(screen.getAllByText("tcgdex:base1-4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tcgplayer:sku:123 -> condition:near-mint").length).toBeGreaterThan(0);
    expect(screen.getByText("Proposed facts")).toBeTruthy();
    expect(screen.getByText("Generated command payloads")).toBeTruthy();
    expect(screen.getByText(/Update: update-catalog-merge-candidate-product-mapping/)).toBeTruthy();
    expect(screen.getByText(/Split: split-catalog-merge-candidate-by-source-membership/)).toBeTruthy();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("keeps scoped TCGplayer Pokemon merge candidates visible when candidate identity uses TCG wording", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Apokemon%3Asingle-card%3Asource-observation-import&languageCode=en&productLineId=3&productLineName=Pokemon&expansionName=Base+Set&profileVersion=2026.06.05",
      scopes: { items: [sourceObservationScope({ provider_key: "tcgplayer" })], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ providerKey: "tcgplayer", active: true, lifecycle: "active" })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem({ provider_key: "tcgplayer" })], total: 1, count: 1 },
      mergeCandidates: {
        items: [
          catalogMergeCandidateListItem({
            identity_json: {
              ...catalogMergeCandidateListItem().identity_json,
              productLineName: "Pokemon TCG",
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Merged candidate review" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Promote: Charizard/ }).length).toBeGreaterThan(0);
  });

  it("keeps ready TCGplayer Pokemon merge-candidate Promote enabled when Source Observation review has no changed rows", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer%3Apokemon%3Asingle-card%3Asource-observation-import&languageCode=en&productLineId=3&productLineName=Pokemon&expansionName=Base+Set&profileVersion=2026.06.05",
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "tcgplayer",
            observed_observations: 102,
            changed_observations: 0,
            promoted_observations: 0,
            expansion_id: "Base Set",
            expansion_name: "Base Set",
            series_id: undefined,
            series_name: undefined,
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: {
        items: [
          profileReview({
            providerKey: "tcgplayer",
            profileKey: "pokemon-single-card-product-sku",
            profileVersion: "2026.06.05",
            displayName: "TCGplayer Pokemon Single Cards",
            active: true,
            lifecycle: "active",
            status: "active",
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [], total: 0, count: 0 },
      mergeCandidates: {
        items: [
          catalogMergeCandidateListItem({
            proposed_external_catalog_item_references_json: [
              { providerKey: "tcgplayer", externalKey: "product:86271" },
            ],
            membership_json: [
              {
                ...catalogMergeCandidateListItem().membership_json[1],
                observationId: "tcgplayer_en_product_86271",
                externalKey: "product:86271",
              },
            ],
            field_provenance_json: [
              {
                ...catalogMergeCandidateListItem().field_provenance_json[1],
                observationId: "tcgplayer_en_product_86271",
              },
            ],
            observation_count: 1,
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    fireEvent.click(screen.getByRole("button", { name: /Review changes/ }));

    const reviewModule = screen.getByRole("heading", { name: "Merged candidate review" }).closest("section");
    expect(reviewModule).toBeTruthy();
    const promoteButtons = within(reviewModule!).getAllByRole("button", { name: /Promote: Charizard/ });
    expect(promoteButtons.some((button) => !button.hasAttribute("disabled"))).toBe(true);
    expect(within(reviewModule!).queryByText("Command unavailable")).toBeNull();

    fireEvent.click(within(reviewModule!).getAllByRole("button", { name: "Evidence" }).at(0)!);

    expect(screen.getByText(/Promote: direct-catalog-merge-candidate-promotion from \d+ source/)).toBeTruthy();
  });

  it("keeps split and update merge-candidate actions blocked without typed command payload provenance", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&languageCode=en&seriesId=base&expansionId=base1&profileVersion=2026.06.04",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      mergeCandidates: { items: [catalogMergeCandidateListItem({ membership_json: [] })], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(
      screen.getAllByRole("button", { name: /Split: Charizard/ }).every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(
      screen.getAllByRole("button", { name: /Update: Charizard/ }).every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(
        'form[data-catalog-primary-workbench-command="update-merge-candidate"] input[name="mergeCandidateCommandBody"]',
      )?.value,
    ).toBe("");
  });

  it("shows selected-scope import preflight usage evidence before sync", async () => {
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=scrydex:one-piece:single-card:source-observation-import&languageCode=en&expansionId=op-01&profileVersion=2026.06.18";
    const profile = profileReview({
      providerKey: "scrydex",
      profileKey: "one-piece-card-print-source-observation",
      ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
      displayName: "Scrydex One Piece cards",
      profileVersion: "2026.06.18",
      active: true,
      lifecycle: "active",
      profile: {
        providerKey: "scrydex",
        supportedScopes: ["one-piece/card"],
      },
      supportedScopes: ["one-piece/card"],
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl,
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "scrydex",
            language_code: "en",
            product_line_id: "",
            series_id: "",
            expansion_id: "op-01",
            expansion_name: "Romance Dawn",
            total_observations: 0,
            observed_observations: 0,
            changed_observations: 0,
            promoted_observations: 0,
            rejected_observations: 0,
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const { container } = render(
      <CatalogIntegrationsSurfacePage
        surface="daily"
        readModel={readModel}
        deferredImportPreview={Promise.resolve({
          action: "import",
          providerKey: "scrydex",
          scope: {
            provider: "scrydex",
            ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
            language: "en",
            setId: "op-01",
          },
          profileSnapshot: null,
          targetCount: 1,
          targets: [
            {
              targetId: "set:op-01",
              name: "op-01",
              languageCode: "en",
              scopeKey: "expansion-cards",
              planKey: "scrydex:one-piece:expansion:op-01:cards",
              estimatedPayloads: null,
              transportSteps: ["Fetch Scrydex One Piece expansion cards with max page size"],
              usageEstimate: {
                requestStrategy: "bulk-first",
                estimateState: "estimate-unavailable",
                estimatedRequestCount: null,
                estimateReason: "Card page count is available only after the first Scrydex paged response.",
                pageSize: 250,
                selectedFields: ["id", "name", "number", "expansion"],
                perRecordFallbackReason: null,
                usageCheckState: "not-configured",
                creditDiagnostic: "Scrydex usage endpoint is not configured for this environment.",
                degradedDiagnostic: null,
              },
            },
          ],
        })}
      />,
    );

    expect(await screen.findByText("Import preflight")).toBeTruthy();
    await waitFor(() => expect(container.querySelector('[data-catalog-import-preview="ready"]')).toBeTruthy());
    const panel = container.querySelector('[data-catalog-import-preview="ready"]');
    expect(panel?.getAttribute("data-catalog-import-preview-provider")).toBe("scrydex");
    expect(panel?.getAttribute("data-catalog-import-preview-unit")).toBe(
      "scrydex:one-piece:single-card:source-observation-import",
    );
    expect(panel?.getAttribute("data-catalog-import-preview-scope")).toBe("en:op-01");
    expect(panel?.getAttribute("data-catalog-import-preview-strategy")).toBe("bulk-first");
    expect(panel?.getAttribute("data-catalog-import-preview-usage-state")).toBe("not-configured");
    expect(screen.getByText("Estimate unavailable")).toBeTruthy();
    expect(screen.getByText("250")).toBeTruthy();
    expect(screen.getByText("id, name, number, expansion")).toBeTruthy();
  });

  it("suppresses stale import preflight evidence from a previous selected scope", async () => {
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=scrydex:one-piece:sealed-product:source-observation-import&languageCode=en&expansionName=OP09&profileVersion=2026.06.22";
    const profile = profileReview({
      providerKey: "scrydex",
      profileKey: "one-piece-sealed-product-source-observation",
      ingestionUnitKey: "scrydex:one-piece:sealed-product:source-observation-import",
      displayName: "Scrydex One Piece sealed products",
      profileVersion: "2026.06.22",
      active: true,
      lifecycle: "active",
      profile: {
        providerKey: "scrydex",
        supportedScopes: ["set-name", "product/sealed"],
      },
      supportedScopes: ["set-name", "product/sealed"],
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl,
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "scrydex",
            language_code: "en",
            product_line_id: "",
            series_id: "",
            expansion_id: "",
            expansion_name: "OP09",
            total_observations: 0,
            observed_observations: 0,
            changed_observations: 0,
            promoted_observations: 0,
            rejected_observations: 0,
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const { container } = render(
      <CatalogIntegrationsSurfacePage
        surface="daily"
        readModel={readModel}
        deferredImportPreview={Promise.resolve({
          action: "import",
          providerKey: "scrydex",
          scope: {
            provider: "scrydex",
            ingestionUnitKey: "scrydex:one-piece:sealed-product:source-observation-import",
            language: "en",
            setName: "OP16",
          },
          profileSnapshot: null,
          targetCount: 1,
          targets: [
            {
              targetId: "set:OP16",
              name: "OP16",
              languageCode: "en",
              scopeKey: "sealed-products",
              planKey: "scrydex:one-piece:expansion:op16:sealed",
              estimatedPayloads: null,
              transportSteps: ["Fetch Scrydex One Piece sealed products"],
              usageEstimate: {
                requestStrategy: "bulk-first",
                estimateState: "estimate-unavailable",
                estimatedRequestCount: null,
                estimateReason: "Provider estimate is unavailable.",
                pageSize: 250,
                selectedFields: ["id", "name", "expansion"],
                perRecordFallbackReason: null,
                usageCheckState: "not-configured",
                creditDiagnostic: null,
                degradedDiagnostic: null,
              },
            },
          ],
        })}
      />,
    );

    await waitFor(() => expect(screen.queryByText("Import preflight")).toBeNull());
    expect(container.querySelector('[data-catalog-import-preview="ready"]')).toBeNull();
  });

  it("suppresses stale One Piece import preflight evidence from a Lorcana downstream scope", async () => {
    const unitKey = "lorcanajson:lorcana:single-card:reference-data";
    const requestUrl =
      "https://admin.example/catalog/integrations?providerKey=lorcanajson" +
      `&unitKey=${encodeURIComponent(unitKey)}` +
      "&importScope=en%3A1&languageCode=en&productLineName=Disney%20Lorcana" +
      "&expansionId=1&expansionName=The%20First%20Chapter&profileVersion=2026.06.23";
    const profile = profileReview({
      providerKey: "lorcanajson",
      profileKey: "lorcana-card-reference-data",
      profileVersion: "2026.06.23",
      ingestionUnitKey: unitKey,
      displayName: "LorcanaJSON Lorcana single-card reference data",
      lifecycle: "active",
      active: true,
      status: "active",
      connectorKind: "lorcanajson-json",
      profile: {
        providerKey: "lorcanajson",
        supportedScopes: ["lorcana/single-card"],
      },
      supportedScopes: ["lorcana/single-card"],
      languageOptions: ["en"],
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl,
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "lorcanajson",
            language_code: "en",
            product_line_id: "",
            product_line_name: "Disney Lorcana",
            series_id: "",
            series_name: "",
            expansion_id: "1",
            expansion_name: "The First Chapter",
            total_observations: 242,
            observed_observations: 242,
            changed_observations: 0,
            promoted_observations: 0,
            rejected_observations: 0,
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const { container } = render(
      <CatalogIntegrationsSurfacePage
        surface="daily"
        readModel={readModel}
        deferredImportPreview={Promise.resolve({
          action: "import",
          providerKey: "scrydex",
          scope: {
            provider: "scrydex",
            ingestionUnitKey: "scrydex:one-piece:sealed-product:source-observation-import",
            language: "en",
            setName: "OP16",
          },
          profileSnapshot: null,
          targetCount: 1,
          targets: [
            {
              targetId: "set:OP16",
              name: "OP16",
              languageCode: "en",
              scopeKey: "sealed-products",
              planKey: "scrydex:one-piece:expansion:op16:sealed",
              estimatedPayloads: null,
              transportSteps: ["Fetch Scrydex One Piece sealed products"],
              usageEstimate: {
                requestStrategy: "bulk-first",
                estimateState: "estimate-unavailable",
                estimatedRequestCount: null,
                estimateReason: "Provider estimate is unavailable.",
                pageSize: 250,
                selectedFields: ["id", "name", "expansion"],
                perRecordFallbackReason: null,
                usageCheckState: "not-configured",
                creditDiagnostic: null,
                degradedDiagnostic: null,
              },
            },
          ],
        })}
      />,
    );

    await waitFor(() => expect(screen.queryByText("Loading import preflight")).toBeNull());
    expect(screen.queryByText("Import preflight")).toBeNull();
    expect(container.querySelector('[data-catalog-import-preview="ready"]')).toBeNull();
  });

  it("renders dense health triage with distinct semantic, transport, rollout, job, and audit evidence", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=triage",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: healthTriageStressOverview(),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="health" readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Integration health triage" })).toBeTruthy();
    expectBackToWorkbenchHref(screen.getByRole("link", { name: "Back to import workbench" }).getAttribute("href"));
    expect(screen.getAllByText("Catalog semantic readiness").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Provider transport readiness").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TCGdex semantic mapping").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TCGdex sealed import").length).toBeGreaterThan(0);
    expect(screen.getAllByText("catalog.integration.semantic_readiness.blocked").length).toBeGreaterThan(0);
    expect(screen.getAllByText("catalog.integration.provider_transport.blocked").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Resolve Catalog semantic mapping readiness before previewing promotion/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Fix provider adapter transport or wait for retry recovery/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Provider pagination cursor failed after page 18/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Catalog integration imports stopped by launch kill switch/i).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        /catalog\.integration\.rollout\.stop is failing closed\. Clear the rollout stop before restarting provider pulls\./i,
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/issue #801/i)).toBeNull();
    expect(screen.queryByText(/ops-release owns/i)).toBeNull();
    expect(screen.getAllByText("import job job_failed failed after provider pagination drift.").length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText(/Open the durable job evidence, resolve the failure group/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText("import-job-started").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Provider import started for health triage.").length).toBeGreaterThan(0);
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("renders generic provider usage budget fields for a One Piece import unit", () => {
    const baseOverview = controlPlaneOverview();
    const unitKey = "scrydex:one-piece:single-card:source-observation-import";
    const baseProvider = baseOverview.providerReadiness.providers[0]!;
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: `https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=${unitKey}&section=triage`,
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "scrydex",
            product_line_id: "one-piece",
            product_line_name: "One Piece",
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: [], total: 0, count: 0 },
      controlPlaneOverview: controlPlaneOverview({
        readiness: {
          ...baseOverview.readiness,
          units: [
            {
              ...baseOverview.readiness.units[0]!,
              unitKey,
              providerKey: "scrydex",
              displayName: "Scrydex One Piece cards",
              productDomain: "one-piece",
              productForm: "single-card",
            },
          ],
        },
        providerReadiness: {
          ...baseOverview.providerReadiness,
          providers: [
            {
              ...baseProvider,
              providerKey: "scrydex",
              adapterKey: "scrydex",
              readiness: "degraded",
              unitKeys: [unitKey],
              usageBudget: {
                creditBalance: 980,
                creditUnit: "credits",
                readiness: "degraded",
                estimatedCalls: 4,
                estimatedScope: "bulk import",
                refreshedAt: "2026-06-22T20:00:00.000Z",
              },
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="health" readModel={readModel} />);

    expect(screen.getAllByText("Scrydex One Piece cards").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Credits").length).toBeGreaterThan(0);
    expect(screen.getAllByText("980 credits").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Budget readiness").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Estimated calls").length).toBeGreaterThan(0);
    expect(screen.getAllByText("4 / bulk import").length).toBeGreaterThan(0);
    expect(screen.queryByText("One Piece sync")).toBeNull();
  });

  it("renders governance controls with RBAC, kill switches, observability, and complete-removal evidence", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=controls",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: healthTriageStressOverview(),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="governance" readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Governance controls" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Rollout and worker controls" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "RBAC action matrix" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Operational observability" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Retired compatibility removal" })).toBeTruthy();
    expect(screen.getAllByText("Provider emergency stop").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Worker pause/resume state").length).toBeGreaterThan(0);
    expect(screen.getAllByText("catalog.integration.rollout.stop").length).toBeGreaterThan(0);
    expect(screen.queryByText(/issue #801/i)).toBeNull();
    expect(screen.queryByText(/ops-release/i)).toBeNull();
    expect(screen.queryByText(/no issue/i)).toBeNull();
    expect(screen.getAllByText("start-provider-import").length).toBeGreaterThan(0);
    expect(screen.getAllByText("execute-promotion").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Alert catalog.integration.jobs.failure_rate").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Runbook Projection freshness").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Payload escape hatch").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Broad patch compatibility").length).toBeGreaterThan(0);
    expect(screen.queryByText(/runbooks, release notes, and operator instructions/i)).toBeNull();
    expect(screen.queryByText(/before launch/i)).toBeNull();
    expect(screen.queryByText(/holding area/i)).toBeNull();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("renders the audit timeline with filters, timeline, and redacted links", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_001&promotionPreviewId=preview_001&section=evidence",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      profileAuthoringModel: profileAuthoringModel({ review: profile }),
      controlPlaneOverview: {
        ...controlPlaneOverview(),
        auditLifecycle: {
          ...controlPlaneOverview().auditLifecycle,
          entries: [
            {
              eventId: "aud_release_001",
              occurredAt: "2026-06-09T01:00:00.000Z",
              eventName: "import-job-started",
              category: "import-job",
              providerKey: "tcgdex",
              unitKey: "tcgdex:pokemon:card:import",
              profileVersion: "2026.06.04",
              actorUserId: "user_operator",
              relatedJobId: "job_001",
              summary: "Provider import started for release evidence.",
              diagnosticCodes: [],
            },
          ],
        },
      },
      reviewObservations: {
        items: [sourceObservationListItem({ observation_id: "obs_001", status: "changed", provider_key: "tcgdex" })],
        total: 1,
        count: 1,
      },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="health" readModel={readModel} />);

    expect(screen.getAllByRole("heading", { name: "Audit timeline" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Timeline filters" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Redacted evidence links" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Release evidence checklist" })).toBeNull();
    expect(screen.getAllByText("Source payload access").length).toBeGreaterThan(0);
    expect(screen.getAllByText("not-required").length).toBeGreaterThan(0);
    expect(screen.getAllByText("source-observation-changed").length).toBeGreaterThan(0);
    expect(screen.queryByText(/blocks release/i)).toBeNull();
    expect(screen.queryByText(/Release tests and smoke evidence/i)).toBeNull();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
    expect(screen.queryByText(/holding area/i)).toBeNull();
  });

  it("renders profile authoring overview and draft creation as a focused support workspace", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=profile-work",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(
      <CatalogIntegrationProfileAuthoringWorkspace
        readModel={{
          ...readModel,
          profileAuthoring: {
            ...readModel.profileAuthoring,
            sectionGroups: [],
            sectionWorkspaces: [],
          },
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Provider profile authoring" })).toBeTruthy();
    expect(screen.getByText("Selected profile is ready")).toBeTruthy();
    expect(screen.getAllByText("TCGdex Pokemon cards").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tcgdex-pokemon-card@2026.06.04").length).toBeGreaterThan(0);
    expect(screen.getByText("Draft required for active profiles")).toBeTruthy();
    expect(screen.getByText("Immutable identity facts")).toBeTruthy();
    expect(screen.getByLabelText("Draft profile version")).toHaveProperty("value", "2026.06.04-draft");
    expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(false);

    const draftForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="clone-provider-profile"]',
    );
    expect(draftForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("clone-provider-profile");
    expect(draftForm?.querySelector<HTMLInputElement>('input[name="sourceProviderKey"]')?.value).toBe("tcgdex");
    expect(draftForm?.querySelector<HTMLInputElement>('input[name="sourceProfileVersion"]')?.value).toBe("2026.06.04");
    expect(new URL(draftForm?.getAttribute("action") ?? "", "https://admin.example").pathname).toBe(
      "/catalog/integrations/providers",
    );
    expect(screen.queryByRole("heading", { name: "Provider import operations" })).toBeNull();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
    expect(screen.queryByText(/Profile JSON|Candidate JSON|Active JSON/i)).toBeNull();
  });

  it("renders validation readiness as a focused fixture, dry-run, compare, and activation workspace", () => {
    const profile = profileReview({
      active: true,
      lifecycle: "active",
      executableMappingContract: jsonClone(tcgdexPokemonCardSourceObservationMappingContract),
      profile: {
        providerKey: "tcgdex",
        supportedScopes: ["pokemon/card"],
        selectedOptionMapping: {
          dimensions: [
            {
              dimensionKey: "foil-treatment",
              sourcePath: "card.variant.displayName",
            },
          ],
        },
      },
      fixtures: {
        fixtureRoot: "bounded-contexts/catalog/features/source-observations/api/__fixtures__/tcgdex",
        coveredFlows: [
          "normal",
          "partial",
          "stale",
          "changed",
          "ambiguous",
          "replay",
          "sealed-product",
          "unknown-option",
        ],
        liveProviderCallsAllowed: false,
      },
    });
    const overview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04&section=readiness",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      profileAuthoringModel: profileAuthoringModel({ review: profile }),
      controlPlaneOverview: {
        ...overview,
        readiness: {
          ...overview.readiness,
          units: [
            {
              ...overview.readiness.units[0],
              dryRunEvidence: [
                {
                  externalKey: "en:sv01-001",
                  sourceUrl: "fixture://tcgdex/normal.json",
                  sourceHash: "sha256:tcgdex-normal",
                  normalizedFacts: {
                    name: "Sprigatito",
                    cardNumber: "001",
                    cardVariantKey: "standard",
                  },
                },
              ],
            },
          ],
        },
      },
      canManageCatalog: true,
    });

    render(
      <CatalogIntegrationsSurfacePage
        surface="providers"
        readModel={{
          ...readModel,
          profileAuthoring: {
            ...readModel.profileAuthoring,
            sectionGroups: [],
            sectionWorkspaces: [],
          },
        }}
      />,
    );

    const validationWorkspace = document.querySelector<HTMLElement>(
      '[data-catalog-validation-readiness-workspace="true"]',
    );
    expect(validationWorkspace).toBeTruthy();
    const validation = within(validationWorkspace as HTMLElement);

    expect(validation.getByRole("heading", { name: "Validation readiness" })).toBeTruthy();
    expect(validation.getByRole("heading", { name: "Fixture flow proof" })).toBeTruthy();
    expect(validation.getByRole("heading", { name: "Dry-run evidence" })).toBeTruthy();
    expect(validation.getByRole("heading", { name: "Semantic compare" })).toBeTruthy();
    expect(validation.getByRole("heading", { name: "Activation readiness" })).toBeTruthy();
    expect(validation.getByRole("heading", { name: "Activation decision" })).toBeTruthy();
    expect(validation.getByRole("textbox", { name: "Migration evidence" })).toBeTruthy();
    expect(validation.getByRole("textbox", { name: "Fixture run" })).toBeTruthy();
    expect(validation.getByRole("button", { name: "Save migration evidence" }).hasAttribute("disabled")).toBe(false);
    expect(validation.getByRole("button", { name: "Activate profile" }).hasAttribute("disabled")).toBe(true);
    expect(validation.getAllByText("Migration evidence missing").length).toBeGreaterThan(0);
    expect(validation.getAllByText("Reference impact review required").length).toBeGreaterThan(0);
    expect(validation.getByRole("link", { name: "Open audit evidence" }).getAttribute("href")).toContain(
      "/catalog/integrations/health",
    );
    expect(validation.getAllByText(/Sprigatito/).length).toBeGreaterThan(0);
    expect(validation.getAllByText(/sha256:candidate-mapping/).length).toBeGreaterThan(0);
    expect(validation.getAllByText("Changes the card variant merge identity.").length).toBeGreaterThan(0);
    expect(validation.getAllByText("Promotion Plan").length).toBeGreaterThan(0);
    expectBackToWorkbenchHref(screen.getByRole("link", { name: "Back to import workbench" }).getAttribute("href"));

    const migrationEvidenceForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-validation-evidence-form="true"]',
    );
    expect(migrationEvidenceForm?.getAttribute("action")).toContain("section=readiness");
    expect(migrationEvidenceForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "update-provider-profile-section",
    );
    expect(migrationEvidenceForm?.querySelector<HTMLInputElement>('input[name="sectionKey"]')?.value).toBe(
      "migration-evidence",
    );
    expect(migrationEvidenceForm?.querySelector<HTMLInputElement>('input[name="providerKey"]')?.value).toBe("tcgdex");
    expect(migrationEvidenceForm?.querySelector<HTMLInputElement>('input[name="profileVersion"]')?.value).toBe(
      "2026.06.04",
    );

    const activationForm = document.querySelector<HTMLFormElement>('form[data-catalog-activate-profile-form="true"]');
    expect(activationForm?.getAttribute("action")).toContain("section=readiness");
    expect(activationForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "activate-provider-profile",
    );
    expect(activationForm?.querySelector<HTMLInputElement>('input[name="providerKey"]')?.value).toBe("tcgdex");
    expect(activationForm?.querySelector<HTMLInputElement>('input[name="profileVersion"]')?.value).toBe("2026.06.04");

    // The "Inspect proof" affordance is unique to the validation workspace's dry-run
    // section; its SideSheet renders in a portal, so scope the revealed proof content
    // to the open dialog rather than the stacked workspace subtree.
    fireEvent.click(validation.getAllByRole("button", { name: "Inspect proof" })[0]!);

    const proofSheet = within(screen.getByRole("dialog"));
    expect(proofSheet.getByRole("heading", { name: "Duplicate candidates" })).toBeTruthy();
    expect(proofSheet.getByRole("heading", { name: "Selected options" })).toBeTruthy();
    expect(proofSheet.getByRole("heading", { name: "Promotion command preview" })).toBeTruthy();
    expect(proofSheet.getAllByText("Option dimension: foil-treatment").length).toBeGreaterThan(0);
    expect(proofSheet.getAllByText("CreateCatalogItem").length).toBeGreaterThan(0);
    expect(proofSheet.getByText("Payload body")).toBeTruthy();
    expect(proofSheet.getByText("not retained")).toBeTruthy();
    expect(screen.queryByText(/raw JSON|Profile JSON|Candidate JSON|Active JSON/i)).toBeNull();
  }, 15_000);

  it("renders lifecycle recovery with rollback, deprecation, retirement, and complete-removal evidence", () => {
    const overview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04&section=lifecycle",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ active: true, lifecycle: "active", referenceCount: 2 })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: {
        ...overview,
        unitActivity: {
          ...overview.unitActivity,
          units: overview.unitActivity.units.map((unit) => ({ ...unit, recentJobs: [] })),
        },
      },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="governance" readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Lifecycle recovery" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open activation readiness" }).getAttribute("href")).toContain(
      "section=readiness",
    );
    expect(screen.getByRole("heading", { name: "Rollback profile" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Deprecate profile" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Retire profile" })).toBeTruthy();
    expect(screen.getByText("Retirement removes the profile behavior")).toBeTruthy();
    expect(
      screen.getAllByText(/Retiring a provider profile removes its mapping and promotion behavior/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Profile retirement references").length).toBeGreaterThan(0);

    const rollbackForm = document.querySelector<HTMLFormElement>('form[data-catalog-lifecycle-command="rollback"]');
    const deprecateForm = document.querySelector<HTMLFormElement>('form[data-catalog-lifecycle-command="deprecate"]');
    const retireForm = document.querySelector<HTMLFormElement>('form[data-catalog-lifecycle-command="retire"]');

    // Lifecycle recovery is now the governance surface's default workspace
    // (conflict resolution, formerly first, is retired), so its canonical action
    // URL omits ?section= entirely instead of naming it explicitly.
    expect(rollbackForm?.getAttribute("action")).toContain("/catalog/integrations/governance");
    expect(rollbackForm?.getAttribute("action")).not.toContain("section=");
    expect(deprecateForm?.getAttribute("action")).toContain("/catalog/integrations/governance");
    expect(deprecateForm?.getAttribute("action")).not.toContain("section=");
    expect(retireForm?.getAttribute("action")).toContain("/catalog/integrations/governance");
    expect(retireForm?.getAttribute("action")).not.toContain("section=");
    expect(rollbackForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "rollback-provider-profile",
    );
    expect(deprecateForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "deprecate-provider-profile",
    );
    expect(retireForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("retire-provider-profile");
    expect(screen.getByLabelText(/I confirm rollback profile impact and audit evidence/i)).toBeTruthy();
    expect(screen.getByLabelText(/I confirm deprecate profile impact and audit evidence/i)).toBeTruthy();
    expect(
      screen.getByLabelText(
        /I confirm retirement removes this provider profile behavior entirely and all impact evidence is clear/i,
      ),
    ).toBeTruthy();
    expect(retireForm?.querySelector<HTMLInputElement>('input[name="providerKey"]')?.value).toBe("tcgdex");
    expect(retireForm?.querySelector<HTMLInputElement>('input[name="profileVersion"]')?.value).toBe("2026.06.04");
    expect(screen.queryByText(/raw JSON|Profile JSON|Candidate JSON|Active JSON/i)).toBeNull();
  });

  it("no longer renders the standalone conflict resolution workspace on the governance surface", () => {
    // Conflict resolution is retired as a standalone workspace: blocking
    // conflicts, candidate values, and precedence now render inline in the merge
    // candidate review drawer, where resolution already happens at promote time.
    // The conflictResolutionFor composer itself keeps its own coverage in
    // primary-workbench-conflict-resolution.test.ts (it still feeds the
    // governance-controls observability signal and the audit-evidence timeline).
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="governance" readModel={readModel} />);

    expect(screen.queryByRole("heading", { name: "Conflict resolution" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Fact conflicts" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Precedence rules" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Lifecycle recovery" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Governance controls" })).toBeTruthy();
  });

  it("renders option-query, import-scope, and mapping authoring detail panels without reviving raw profile editors", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=profile-work&profileVersion=2026.06.04-draft",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [
          profileReview({
            active: false,
            lifecycle: "draft",
            profileVersion: "2026.06.04-draft",
            profile: jsonClone(tcgdexPokemonTcgProviderProfile),
            executableMappingContract: jsonClone(tcgdexPokemonCardSourceObservationMappingContract),
            capabilities: [...tcgdexPokemonTcgProviderProfile.capabilities],
            supportedScopes: [...tcgdexPokemonTcgProviderProfile.supportedScopes],
            languageOptions: [...tcgdexPokemonTcgProviderProfile.languageOptions],
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: controlPlaneOverview({
        providerReadiness: {
          ...baseOverview.providerReadiness,
          providers: [
            {
              ...baseOverview.providerReadiness.providers[0]!,
              optionQueryHealth: {
                status: "degraded",
                diagnosticCodes: ["provider-option-query-stale-cache-used"],
                message: "Stale provider option query cache used during adapter recovery.",
              },
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationProfileAuthoringWorkspace readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Provider option queries" })).toBeTruthy();
    expect(screen.getAllByText("tcgdex-list-expansions").length).toBeGreaterThan(0);
    expect(screen.getAllByText("tcgdex-expansion-card-count").length).toBeGreaterThan(0);
    expect(screen.getAllByText("symbolUrl").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Option queries degraded").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Stale provider option query cache used/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Import-scope controls" })).toBeTruthy();
    expect(screen.getAllByText("Product / Card").length).toBeGreaterThan(0);
    expect(screen.getAllByText("en:3:base:base1").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "Mapping expression rows" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Observation id").length).toBeGreaterThan(0);
    expect(screen.getAllByText("catalog-merge-evidence").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Preview").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Duplicate").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reorder").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Remove").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Inline diagnostics").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Long paths").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Profile JSON|Candidate JSON|Active JSON|raw JSON/i)).toBeNull();
  });

  it("renders section forms as editable typed controls for draft profiles", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=profile-work&profileVersion=2026.06.04-draft",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ active: false, lifecycle: "draft", profileVersion: "2026.06.04-draft" })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogIntegrationProfileAuthoringWorkspace readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Guided section workspaces" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Profile section groups" })).toBeTruthy();
    expect(screen.getByLabelText("Profile section")).toBeTruthy();

    const forms = document.querySelectorAll<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="update-provider-profile-section"]',
    );
    expect(forms).toHaveLength(catalogProviderProfileEditableSectionKeys.length);

    const basics = document.querySelector<HTMLElement>('[data-catalog-profile-section-workspace="basics"]');
    expect(within(basics!).getByLabelText("Display name")).toHaveProperty("value", "TCGdex Pokemon cards");
    expect(within(basics!).getByRole("button", { name: "Save section" }).hasAttribute("disabled")).toBe(false);
    expect(basics?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe(
      "update-provider-profile-section",
    );
    expect(basics?.querySelector<HTMLInputElement>('input[name="sectionKey"]')?.value).toBe("basics");
    expect(basics?.querySelector<HTMLInputElement>('input[name="profileVersion"]')?.value).toBe("2026.06.04-draft");
    expect(screen.queryByRole("textbox", { name: /raw json/i })).toBeNull();
  });

  it("keeps profile overview inspectable but disables draft creation for view-only operators", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: false,
    });

    render(
      <CatalogIntegrationProfileAuthoringWorkspace
        readModel={{
          ...readModel,
          profileAuthoring: {
            ...readModel.profileAuthoring,
            sectionGroups: [],
            sectionWorkspaces: [],
          },
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Provider profile authoring" })).toBeTruthy();
    expect(screen.getAllByText("TCGdex Pokemon cards").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("Permission denied").length).toBeGreaterThan(0);
    expect(
      screen.getByText("View-only operators can inspect profile evidence but cannot create draft profiles."),
    ).toBeTruthy();
  });

  it("renders stale selected-profile state without falling back to another version", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work&profileVersion=missing-version",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(
      <CatalogIntegrationProfileAuthoringWorkspace
        readModel={{
          ...readModel,
          profileAuthoring: {
            ...readModel.profileAuthoring,
            sectionGroups: [],
            sectionWorkspaces: [],
          },
        }}
      />,
    );

    expect(screen.getByText("Profile selection is stale")).toBeTruthy();
    expect(screen.getByText("Select an available version")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create draft" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Selected profile is ready")).toBeNull();
  });

  it("renders scoped durable import monitoring without hiding the primary provider pull", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    const { container } = render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    // Open the Run sync stage to monitor the durable import and keep the parent
    // scope enqueue visible beside provider child job controls.
    fireEvent.click(screen.getByRole("button", { name: /Run sync/i }));

    expect(screen.getByRole("heading", { name: "Catalog scope sync" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Catalog sync" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Provider import operations" })).toBeTruthy();
    expect(screen.getByText("Expected observations")).toBeTruthy();
    expect(screen.getAllByText("142").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    expect(screen.getAllByText("import job job_001 is running (7/24).").length).toBeGreaterThan(0);
    expect(screen.getAllByText("7/24 work units, 29% complete").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Cancel" }).length).toBeGreaterThan(0);
    expect(
      container.querySelectorAll(
        '[data-catalog-import-job-row="true"][data-catalog-import-job-unit="tcgdex:pokemon:card:import"][data-catalog-import-job-scope="en:3:base:base1"][data-catalog-import-job-state="running"][data-catalog-import-job-operator-status="running"]',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll(
        '[data-catalog-sync-participation-row="true"][data-catalog-sync-participation-unit="tcgdex:pokemon:card:import"]',
      ).length,
    ).toBeGreaterThan(0);

    const cancelForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="cancel-import-job"]',
    );
    expect(cancelForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("cancel-import-job");
    expect(cancelForm?.querySelector<HTMLInputElement>('input[name="jobId"]')?.value).toBe("job_001");

    const reviewLinks = screen.getAllByRole("link", { name: "Review observations" });
    expect(reviewLinks.some((link) => link.getAttribute("href")?.includes("section=source-observation-review"))).toBe(
      true,
    );
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  it("keeps completed LorcanaJSON import jobs inspectable after imported scope state opens review", () => {
    const unitKey = "lorcanajson:lorcana:set:reference-data";
    const baseOverview = controlPlaneOverview();
    const profile = profileReview({
      providerKey: "lorcanajson",
      profileKey: "lorcanajson-lorcana-set",
      profileVersion: "2026.06.23",
      ingestionUnitKey: unitKey,
      displayName: "LorcanaJSON Set Reference",
      lifecycle: "active",
      active: true,
      status: "active",
      connectorKind: "lorcanajson-json",
      profile: {
        providerKey: "lorcanajson",
        supportedScopes: ["lorcana/set"],
      },
      supportedScopes: ["lorcana/set"],
      languageOptions: ["en"],
    });
    const scope = sourceObservationScope({
      provider_key: "lorcanajson",
      language_code: "en",
      product_line_id: "",
      product_line_name: "Disney Lorcana",
      series_id: "",
      series_name: "",
      expansion_id: "1",
      expansion_name: "1",
      total_observations: 242,
      observed_observations: 242,
      changed_observations: 0,
      promoted_observations: 0,
      rejected_observations: 0,
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=lorcanajson&unitKey=lorcanajson:lorcana:set:reference-data&importScope=en%3A1&languageCode=en&productLineName=Disney%20Lorcana&expansionId=1&expansionName=1&profileVersion=2026.06.23",
      scopes: { items: [scope], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        readiness: {
          ...baseOverview.readiness,
          units: [
            {
              ...baseOverview.readiness.units[0]!,
              unitKey,
              providerKey: "lorcanajson",
              displayName: "LorcanaJSON Set Reference",
              productDomain: "lorcana",
              productForm: "set",
              profileVersion: "2026.06.23",
            },
          ],
        },
        unitActivity: {
          ...baseOverview.unitActivity,
          units: [
            {
              unitKey,
              recentJobs: [
                integrationJobSummary({
                  jobId: "job_lorcana_set",
                  operatorStatus: "completed",
                  phase: "completed",
                  completed: 242,
                  total: 242,
                  unitKey,
                  providerKey: "lorcanajson",
                  importScope: "en:1",
                  profileVersion: "2026.06.23",
                  summary: "import job job_lorcana_set is completed (242/242).",
                }),
              ],
            },
          ],
        },
        providerReadiness: {
          ...baseOverview.providerReadiness,
          providers: [
            {
              ...baseOverview.providerReadiness.providers[0]!,
              providerKey: "lorcanajson",
              adapterKey: "lorcanajson",
              unitKeys: [unitKey],
            },
          ],
        },
      }),
      reviewObservations: {
        items: [
          sourceObservationListItem({
            observation_id: "lorcanajson_card_en_21",
            provider_key: "lorcanajson",
            external_key: "lorcanajson:card:21",
            source_profile_key: "lorcanajson-lorcana-set",
            source_profile_version: "2026.06.23",
            status: "observed",
            normalized: {
              kind: "lorcana-card-print",
              tcg: "lorcana",
              languageCode: "en",
              name: "Stitch - Carefree Surfer",
              cardNumber: "21",
              setId: "1",
              setCode: null,
              setName: "The First Chapter",
              expansionName: "The First Chapter",
              rarity: null,
              cardType: null,
              inkColor: null,
              releaseDate: null,
              releaseYear: null,
              productLineName: "Disney Lorcana",
              imageUrls: [],
              mergeIdentity: {
                tcg: "lorcana",
                productLineName: "Disney Lorcana",
                setName: "The First Chapter",
                printedProductName: "Stitch - Carefree Surfer",
                collectorNumber: "21",
                languageCode: "en",
              },
            } satisfies SourceObservationLorcanaCardPrintNormalized,
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    const runSync = screen.getByRole("button", { name: /Run sync/i });
    expect(runSync.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("heading", { name: "Source Observation review" })).toBeTruthy();

    fireEvent.click(runSync);

    expect(screen.getAllByText("import job job_lorcana_set is completed (242/242).").length).toBeGreaterThan(0);
    expect(screen.getAllByText(`Unit: ${unitKey}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Scope: lorcanajson / en / 1").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Review observations" }).length).toBeGreaterThan(0);
  });

  it("opens completed-job Source Observation review handoffs even when the selected scope has no changed rows", () => {
    const unitKey = "lorcanajson:lorcana:single-card:reference-data";
    const baseOverview = controlPlaneOverview();
    const profile = profileReview({
      providerKey: "lorcanajson",
      profileKey: "lorcana-card-reference-data",
      profileVersion: "2026.06.23",
      ingestionUnitKey: unitKey,
      displayName: "LorcanaJSON Lorcana single-card reference data",
      lifecycle: "active",
      active: true,
      status: "active",
      connectorKind: "lorcanajson-json",
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        `https://admin.example/catalog/integrations?section=source-observation-review&providerKey=lorcanajson` +
        `&unitKey=${encodeURIComponent(unitKey)}&importScope=en%3A1&languageCode=en&productLineName=Disney+Lorcana` +
        "&expansionId=1&expansionName=The+First+Chapter&profileVersion=2026.06.23&jobId=job_lorcana_set",
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "lorcanajson",
            language_code: "en",
            product_line_id: "",
            product_line_name: "Disney Lorcana",
            series_id: "",
            series_name: "",
            expansion_id: "1",
            expansion_name: "The First Chapter",
            total_observations: 242,
            observed_observations: 242,
            changed_observations: 0,
            promoted_observations: 0,
            rejected_observations: 0,
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        ...baseOverview,
        unitActivity: {
          ...baseOverview.unitActivity,
          units: [
            {
              unitKey,
              recentJobs: [
                integrationJobSummary({
                  jobId: "job_lorcana_set",
                  operatorStatus: "completed",
                  phase: "completed",
                  completed: 242,
                  total: 242,
                  unitKey,
                  providerKey: "lorcanajson",
                  importScope: "en:1",
                  profileVersion: "2026.06.23",
                  summary: "import job job_lorcana_set is completed (242/242).",
                }),
              ],
            },
          ],
        },
        providerReadiness: {
          ...baseOverview.providerReadiness,
          providers: [
            {
              ...baseOverview.providerReadiness.providers[0]!,
              providerKey: "lorcanajson",
              adapterKey: "lorcanajson",
              unitKeys: [unitKey],
            },
          ],
        },
      }),
      reviewObservations: { items: [], total: 0, count: 0 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Source Observation review" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Review changes/i }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /Run sync/i }).getAttribute("aria-expanded")).toBe("false");
  });

  it("renders provider transport blockers with operator reason and next step copy", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        readiness: {
          ...baseOverview.readiness,
          units: [
            {
              ...baseOverview.readiness.units[0]!,
              transportReadiness: "blocked",
              diagnostics: [
                {
                  code: "provider-timeout",
                  severity: "error",
                  message: "Provider timeout while fetching payloads.",
                  unitKey: "tcgdex:pokemon:card:import",
                  retryAfterSeconds: null,
                  source: "provider-adapter",
                },
              ],
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(screen.getAllByText("Provider timeout").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/The adapter timed out before receiving a complete provider response/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Next: Retry the provider pull after checking health triage/i).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("provider-transport-timeout")).toBeNull();
  });

  it("deep-links daily-flow blockers into the provider-setup surface with return context to the import scope", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04-draft&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      // No active profile -> the daily flow surfaces the missing-active-profile
      // blocker, whose support target is the profile-authoring provider-setup workspace.
      profileReviews: {
        items: [profileReview({ active: false, lifecycle: "draft", profileVersion: "2026.06.04-draft" })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(readModel.routeContext.section).toBe("import-to-promotion");
    expect(readModel.readiness.blockers).toContain("missing-active-profile");

    // The consolidated daily blocker panel links the blocker into the providers
    // surface workspace that clears it, not the daily route itself.
    const resolveLink = screen
      .getAllByRole("link", { name: /Resolve in Profile authoring/i })
      .map((link) => new URL(link.getAttribute("href") ?? "", "https://admin.example"))
      .find((url) => url.pathname === "/catalog/integrations/providers");
    expect(resolveLink).toBeTruthy();

    // Profile authoring is the providers-surface default, so the deep link carries no
    // ?section= but preserves the full provider working set.
    expect(resolveLink!.searchParams.has("section")).toBe(false);
    expect(resolveLink!.searchParams.get("providerKey")).toBe("tcgdex");
    expect(resolveLink!.searchParams.get("unitKey")).toBe("tcgdex:pokemon:card:import");
    expect(resolveLink!.searchParams.get("importScope")).toBe("en:3:base:base1");
    expect(resolveLink!.searchParams.get("profileVersion")).toBe("2026.06.04-draft");

    // The carried return path round-trips back to the daily surface route preserving
    // provider, unit, scope, profile version, and review filters.
    const returnPath = new URL(resolveLink!.searchParams.get("returnPath") ?? "", "https://admin.example");
    expect(returnPath.pathname).toBe("/catalog/integrations");
    expect(returnPath.searchParams.has("section")).toBe(false);
    expect(returnPath.searchParams.get("providerKey")).toBe("tcgdex");
    expect(returnPath.searchParams.get("unitKey")).toBe("tcgdex:pokemon:card:import");
    expect(returnPath.searchParams.get("importScope")).toBe("en:3:base:base1");
    expect(returnPath.searchParams.get("profileVersion")).toBe("2026.06.04-draft");
    expect(returnPath.searchParams.get("filter.status")).toBe("changed");
  });

  it("surfaces a slim governance denied indicator on the daily route that deep-links to governance controls with return context", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      // A view-only operator: the primary commands are denied by access control.
      canManageCatalog: false,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    // The daily route stays on the import-to-promotion surface; it shows a SLIM
    // denied indicator, not the full governance RBAC/kill-switch/observability panel.
    expect(readModel.routeContext.section).toBe("import-to-promotion");
    expect(screen.getByText("A primary command is denied by access control")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "RBAC action matrix" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Rollout and worker controls" })).toBeNull();

    // The indicator deep-links into the governance-controls workspace on the
    // governance surface, carrying return context back to the daily job.
    const governanceLink = screen
      .getAllByRole("link", { name: "Open governance controls" })
      .map((link) => new URL(link.getAttribute("href") ?? "", "https://admin.example"))
      .find((url) => url.pathname === "/catalog/integrations/governance");
    expect(governanceLink).toBeTruthy();
    expect(governanceLink!.searchParams.get("section")).toBe("controls");
    expect(governanceLink!.searchParams.get("providerKey")).toBe("tcgdex");
    expect(governanceLink!.searchParams.get("unitKey")).toBe("tcgdex:pokemon:card:import");
    expect(governanceLink!.searchParams.get("importScope")).toBe("en:3:base:base1");

    const returnPath = new URL(governanceLink!.searchParams.get("returnPath") ?? "", "https://admin.example");
    expect(returnPath.pathname).toBe("/catalog/integrations");
    expect(returnPath.searchParams.has("section")).toBe(false);
    expect(returnPath.searchParams.get("providerKey")).toBe("tcgdex");
    expect(returnPath.searchParams.get("importScope")).toBe("en:3:base:base1");
    expect(returnPath.searchParams.get("filter.status")).toBe("changed");
  });

  it("surfaces a slim governance stopped indicator on the daily route when a rollout kill switch blocks a primary command", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        readiness: {
          ...baseOverview.readiness,
          rolloutControls: {
            generatedAt: baseOverview.generatedAt,
            controls: [
              {
                controlId: "catalog-import-launch-stop",
                defaultState: "quarantined",
                status: "blocked",
                severity: "error",
                capabilities: ["source-observation-import"],
                providerKeys: ["tcgdex"],
                profileKeys: ["tcgdex-pokemon-card"],
                unitKeys: ["tcgdex:pokemon:card:import"],
                message: "Catalog integration imports stopped by launch kill switch.",
                auditEventName: "rollout-control-denied",
                metricKey: "catalog.integration.rollout.stop",
              },
            ],
          },
        },
      }),
      // A privileged operator: the command is stopped by a rollout control, not denied.
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(screen.getByText("A primary command is stopped by a rollout control")).toBeTruthy();
    // The denied copy is not shown for a rollout stop without an access denial.
    expect(screen.queryByText("A primary command is denied by access control")).toBeNull();
    // Still no full governance panel on the daily route.
    expect(screen.queryByRole("heading", { name: "RBAC action matrix" })).toBeNull();

    const governanceLink = screen
      .getAllByRole("link", { name: "Open governance controls" })
      .map((link) => new URL(link.getAttribute("href") ?? "", "https://admin.example"))
      .find((url) => url.pathname === "/catalog/integrations/governance");
    expect(governanceLink).toBeTruthy();
    expect(governanceLink!.searchParams.get("section")).toBe("controls");
    expect(new URL(governanceLink!.searchParams.get("returnPath") ?? "", "https://admin.example").pathname).toBe(
      "/catalog/integrations",
    );
  });

  it("renders no governance indicator on the daily route when no primary command is denied or stopped", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(screen.queryByText("A primary command is denied by access control")).toBeNull();
    expect(screen.queryByText("A primary command is stopped by a rollout control")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open governance controls" })).toBeNull();
  });

  it("surfaces a slim degraded health indicator on the daily surface that deep-links into health triage on the health surface", () => {
    const baseOverview = controlPlaneOverview();
    // The daily surface deliberately omits the full health-triage slice (#1744), so
    // build the actual daily surface read model and prove the compact signal still
    // fires from the core readiness/transport data it always loads.
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        readiness: {
          ...baseOverview.readiness,
          units: [
            {
              ...baseOverview.readiness.units[0]!,
              diagnostics: [
                {
                  code: "provider-partial-data",
                  severity: "warning",
                  message: "Provider returned partial data for this unit.",
                  unitKey: "tcgdex:pokemon:card:import",
                  retryAfterSeconds: null,
                  source: "provider-adapter",
                },
              ],
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    // A compact degraded banner, not the full health dashboard, on the daily route.
    expect(screen.getByText("Integration health is degraded")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Integration health triage" })).toBeNull();

    // It deep-links into health triage on the health surface with return context.
    const healthLink = screen
      .getAllByRole("link", { name: "Open health triage" })
      .map((link) => new URL(link.getAttribute("href") ?? "", "https://admin.example"))
      .find((url) => url.pathname === "/catalog/integrations/health");
    expect(healthLink).toBeTruthy();
    expect(healthLink!.searchParams.get("section")).toBe("triage");
    expect(healthLink!.searchParams.get("providerKey")).toBe("tcgdex");
    expect(healthLink!.searchParams.get("unitKey")).toBe("tcgdex:pokemon:card:import");

    const returnPath = new URL(healthLink!.searchParams.get("returnPath") ?? "", "https://admin.example");
    expect(returnPath.pathname).toBe("/catalog/integrations");
    expect(returnPath.searchParams.has("section")).toBe(false);
    expect(returnPath.searchParams.get("providerKey")).toBe("tcgdex");
    expect(returnPath.searchParams.get("filter.status")).toBe("changed");
  });

  it("escalates the daily health indicator to blocked when a provider transport failure blocks a primary command", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        readiness: {
          ...baseOverview.readiness,
          units: [
            {
              ...baseOverview.readiness.units[0]!,
              transportReadiness: "blocked",
              diagnostics: [
                {
                  code: "provider-timeout",
                  severity: "error",
                  message: "Provider timeout while fetching payloads.",
                  unitKey: "tcgdex:pokemon:card:import",
                  retryAfterSeconds: null,
                  source: "provider-adapter",
                },
              ],
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(screen.getByText("Integration health is blocking a primary command")).toBeTruthy();
    expect(screen.queryByText("Integration health is degraded")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Integration health triage" })).toBeNull();
    expect(screen.getAllByRole("link", { name: "Open health triage" }).length).toBeGreaterThan(0);
  });

  it("renders no daily health indicator when provider transport, freshness, and jobs are nominal", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(screen.queryByText("Integration health is degraded")).toBeNull();
    expect(screen.queryByText("Integration health is blocking a primary command")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open health triage" })).toBeNull();
  });

  it("renders Source Observation evidence rows, drawer details, and bulk selection without raw payloads", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: {
        items: [
          sourceObservationListItem({
            normalized: {
              ...sourceObservationListItem().normalized,
              name: "A very long provider supplied Charizard display name with release diagnostics attached",
            },
            status_reason: "Provider changed rarity evidence during the latest pull.",
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Source Observation review" })).toBeTruthy();
    expect(screen.getAllByText(/A very long provider supplied Charizard/).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Provider payload withheld; normalized facts and provenance are redaction-safe.").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", {
        name: /Preview promotion: A very long provider supplied Charizard/i,
      }).length,
    ).toBeGreaterThan(0);

    const reviewModule = screen.getByRole("heading", { name: "Source Observation review" }).closest("section");
    expect(reviewModule).toBeTruthy();
    const checkbox = within(reviewModule as HTMLElement).getAllByRole("checkbox")[0];
    fireEvent.click(checkbox);

    expect(screen.getByText("1 observation(s) selected")).toBeTruthy();

    const evidenceButtons = screen.getAllByRole("button", { name: "Evidence" });
    fireEvent.click(evidenceButtons[evidenceButtons.length - 1]!);

    // The sheet chrome (title/description) renders inline; the deep evidence is
    // lazy-loaded via useFetcher (#1971), which the stubbed router keeps in the
    // loading state, so the DS loading affordance shows instead of the deep arrays.
    // The composed evidence (including the status-reason conflict line) is asserted
    // directly in the read-model unit tests and end-to-end in the e2e spec.
    expect(screen.getByText(/Source provenance, normalized facts/)).toBeTruthy();
    expect(screen.getByText("Loading evidence…")).toBeTruthy();
    expect(screen.queryByText(/raw JSON/i)).toBeNull();
  });

  // #1748 acceptance gate (criterion 3, accessibility matrix): the daily Source
  // Observation review renders real table semantics — a <table> with column headers,
  // per-row "Select row" controls, and a polite live region announcing dynamic load
  // state — rather than a bespoke grid of <div>s. These are assertable on the live
  // CatalogIntegrationsSurfacePage daily surface, the route operators land on first.
  it("renders the daily Source Observation review with accessible table semantics and a live region", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    const reviewModule = screen.getByRole("heading", { name: "Source Observation review" }).closest("section");
    expect(reviewModule).toBeTruthy();
    const review = within(reviewModule as HTMLElement);

    // Real table semantics: a table element with column headers (not a div grid).
    const reviewTable = review.getByRole("table");
    expect(reviewTable).toBeTruthy();
    expect(within(reviewTable).getAllByRole("columnheader").length).toBeGreaterThan(0);
    expect(within(reviewTable).getAllByRole("row").length).toBeGreaterThan(1);
    // Per-row selection control names its row for screen readers.
    expect(within(reviewTable).getAllByRole("checkbox", { name: /Select row/i }).length).toBeGreaterThan(0);

    // A polite live region announces dynamic review load/progress state to screen
    // readers (the dynamic-job/blocker-updates accessibility dimension).
    const liveRegions = (reviewModule as HTMLElement).querySelectorAll('[role="status"][aria-live="polite"]');
    expect(liveRegions.length).toBeGreaterThan(0);
  });

  it("submits primary workbench commands with clean intent and selected-observation context", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    const syncForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="start-catalog-sync"]',
    );
    expect(syncForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("start-catalog-sync");
    expect(syncForm?.querySelector<HTMLInputElement>('input[name="productDomain"]')?.value).toBe("pokemon");
    expect(syncForm?.querySelector<HTMLInputElement>('input[name="referenceId"]')?.value).toBe("base1");
    expect(syncForm?.getAttribute("action")).toContain("/catalog/integrations?");
    expect(syncForm?.getAttribute("action")).not.toMatch(/raw-json|legacy|compat/i);
    expect(
      JSON.parse(syncForm?.querySelector<HTMLInputElement>('input[name="providerHints"]')?.value ?? "{}"),
    ).toMatchObject({
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      productLineId: "3",
      seriesId: "base",
      setId: "base1",
    });

    const reviewModule = screen.getByRole("heading", { name: "Source Observation review" }).closest("section");
    const checkbox = within(reviewModule as HTMLElement).getAllByRole("checkbox")[0];
    fireEvent.click(checkbox);

    // Selecting a reviewable row surfaces the canonical BulkActionBar: the preview and
    // defer commands render eagerly as the bar's primary/secondary CommandFormButtons,
    // so their forms are queryable immediately.
    const selectedPreviewForm = Array.from(
      document.querySelectorAll<HTMLFormElement>('form[data-catalog-primary-workbench-command="preview-promotion"]'),
    ).find((form) => form.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value === "obs_001");
    const deferForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="defer-source-observations"]',
    );

    expect(selectedPreviewForm).toBeTruthy();
    expect(deferForm?.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value).toBe("obs_001");
    expect(deferForm?.querySelector<HTMLInputElement>('input[name="reason"]')?.value).toBe(
      "Deferred from the primary workbench; observation remains in review.",
    );

    // Reject is destructive and reason-required, so it lives behind the BulkActionPanel
    // trigger. Opening the panel mounts the reject form (and its required reason input);
    // before it is opened the form is intentionally absent from the DOM.
    expect(
      document.querySelector('form[data-catalog-primary-workbench-command="reject-source-observations"]'),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    const rejectForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="reject-source-observations"]',
    );
    expect(rejectForm?.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value).toBe("obs_001");
    expect(rejectForm?.querySelector<HTMLInputElement>('input[name="reason"]')?.required).toBe(true);
  });

  it("submits reapply and replay commands for promoted Source Observations as durable jobs", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=promoted",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: {
        items: [
          sourceObservationListItem({
            observation_id: "obs_promoted",
            status: "promoted",
            promoted_catalog_item_id: "cat_001",
            promoted_at: "2026-06-09T01:05:00.000Z",
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    const reapplyForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="start-reapply"]:not([data-catalog-source-scope-unit])',
    );
    const replayForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="start-replay"]',
    );

    expect(reapplyForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("start-reapply");
    expect(reapplyForm?.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value).toBe(
      "obs_promoted",
    );
    expect(replayForm?.querySelector<HTMLInputElement>('input[name="_intent"]')?.value).toBe("start-replay");
    expect(replayForm?.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value).toBe(
      "obs_promoted",
    );
  });

  it("keeps replay available for promoted Source Observations when the current active profile is missing", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=promoted",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: false, lifecycle: "retired" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: {
        items: [
          sourceObservationListItem({
            observation_id: "obs_promoted",
            status: "promoted",
            promoted_catalog_item_id: "cat_001",
            promoted_at: "2026-06-09T01:05:00.000Z",
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(
      screen.getAllByRole("button", { name: /Reapply: Charizard/i }).every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(
      screen.getAllByRole("button", { name: /Replay: Charizard/i }).every((button) => button.hasAttribute("disabled")),
    ).toBe(false);

    const replayForm = document.querySelector<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="start-replay"]',
    );
    expect(replayForm?.querySelector<HTMLInputElement>('input[name="selectedObservationIds"]')?.value).toBe(
      "obs_promoted",
    );
  });

  it("blocks replay for promoted Source Observations with missing original profile evidence", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=promoted",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: {
        items: [
          sourceObservationListItem({
            observation_id: "obs_promoted",
            status: "promoted",
            source_profile_version: "",
            promoted_catalog_item_id: "cat_001",
            promoted_at: "2026-06-09T01:05:00.000Z",
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(
      screen.getAllByRole("button", { name: /Replay: Charizard/i }).every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(screen.getAllByText("Profile version missing").length).toBeGreaterThan(0);
  });

  it("renders explicit-row command scope and stale-preview blockers before promotion execution", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.03&filter.status=changed&selectedObservationIds=obs_missing&promotionPreviewId=preview_old",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    // The create stage is active for a stored preview; its inline confirmation shows
    // the previewed scope, and the demoted command-plan detail repeats it.
    expect(screen.getByText("Promotion command plan")).toBeTruthy();
    expect(screen.getAllByText("Explicit selected observations").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stale").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stale promotion preview").length).toBeGreaterThan(0);
    // The promotion preview is folded into the inline create/update confirmation, so
    // the commit button stays disabled until a fresh preview is confirmed.
    expect(
      screen
        .getAllByRole("button", { name: "Create or update Catalog Items" })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("renders promote-all as an explicit selected-scope action with preview counts and confirmation", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04&filter.status=changed&promotionPreviewId=preview_scope",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(screen.getByText("Promote all eligible in this scope")).toBeTruthy();
    expect(
      screen.getByText(
        "Scoped to Matching filtered observations: only the 1 eligible observation(s) here are promoted.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Scoped")).toBeTruthy();
    expect(screen.getAllByText("Matched").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Eligible").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Blocked").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Skipped").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Conflicts").length).toBeGreaterThan(0);
    // "Draft Catalog Item updates" now labels both the create-stage count and the
    // operational metric strip (the consolidated blast-radius metric that replaced
    // the duplicated "Blockers" count), so match all occurrences.
    expect(screen.getAllByText("Draft Catalog Item updates").length).toBeGreaterThan(0);
    expect(screen.getByText(/No other provider scope is promoted by this action/i)).toBeTruthy();

    const confirmation = screen.getByLabelText(
      "I confirm this will promote 1 eligible observation(s) from Matching filtered observations.",
    );
    expect(confirmation).toBeTruthy();
    const commitButton = screen.getAllByRole("button", { name: "Create or update Catalog Items" }).at(0);
    expect(commitButton?.hasAttribute("disabled")).toBe(true);

    fireEvent.click(confirmation);

    expect(commitButton?.hasAttribute("disabled")).toBe(false);
    const executeForms = document.querySelectorAll<HTMLFormElement>(
      'form[data-catalog-primary-workbench-command="execute-promotion"]',
    );
    expect(executeForms.length).toBeGreaterThan(0);
  });

  it("clears route-provided Source Observation selections when the review context changes", async () => {
    const selectedReadModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_001",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });
    const clearedReadModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    const { rerender } = render(<CatalogIntegrationsSurfacePage surface="daily" readModel={selectedReadModel} />);

    expect(screen.getByText("1 observation(s) selected")).toBeTruthy();

    rerender(<CatalogIntegrationsSurfacePage surface="daily" readModel={clearedReadModel} />);

    await waitFor(() => {
      expect(screen.queryByText("1 observation(s) selected")).toBeNull();
    });
  });

  it("renders denied row actions without exposing provider bypass controls", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      canManageCatalog: false,
    });

    render(<CatalogIntegrationsSurfacePage surface="daily" readModel={readModel} />);

    expect(screen.getByRole("heading", { name: "Source Observation review" })).toBeTruthy();
    expect(
      screen
        .getAllByRole("button", { name: /Preview promotion: Charizard/i })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(screen.getAllByText("Permission denied").length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/This operator account cannot run the requested Catalog command/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/Next: Ask an admin to grant catalog.manage/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/all providers/i)).toBeNull();
  });
});

function healthTriageStressOverview() {
  const baseOverview = controlPlaneOverview();
  const semanticUnitKey = "tcgdex:pokemon:card:import";
  const transportUnitKey = "tcgdex:pokemon:sealed:import";
  const longProviderDiagnostic =
    "Provider pagination cursor failed after page 18 while acquiring payloads; retry only after the adapter can resume without duplicating Source Observations.";
  const baseUnit = baseOverview.readiness.units[0]!;
  const baseJob = baseOverview.unitActivity.units[0]!.recentJobs[0]!;

  return controlPlaneOverview({
    readiness: {
      ...baseOverview.readiness,
      rolloutControls: {
        generatedAt: baseOverview.generatedAt,
        controls: [
          {
            controlId: "catalog-import-launch-stop",
            defaultState: "quarantined",
            status: "blocked",
            severity: "error",
            capabilities: ["source-observation-import"],
            providerKeys: ["tcgdex"],
            profileKeys: ["tcgdex-pokemon-card"],
            unitKeys: [transportUnitKey],
            message: "Catalog integration imports stopped by launch kill switch.",
            auditEventName: "rollout-control-denied",
            metricKey: "catalog.integration.rollout.stop",
          },
        ],
      },
      units: [
        {
          ...baseUnit,
          unitKey: semanticUnitKey,
          displayName: "TCGdex semantic mapping",
          semanticReadiness: "blocked",
          fixtureValidationStatus: "blocked",
          dryRunStatus: "blocked",
          diagnosticCounts: { info: 0, warning: 1, error: 1 },
          diagnostics: [
            {
              code: "semantic-mapping-blocked",
              severity: "error",
              message: "Catalog semantic mapping is missing collector number evidence.",
              unitKey: semanticUnitKey,
              retryAfterSeconds: null,
              source: "catalog",
            },
            {
              code: "dry-run-evidence-missing",
              severity: "warning",
              message: "Dry-run evidence must be completed before promotion preview.",
              unitKey: semanticUnitKey,
              retryAfterSeconds: null,
              source: "catalog",
            },
          ],
          latestDiagnosticText: "Catalog semantic mapping is missing collector number evidence.",
        },
        {
          ...baseUnit,
          unitKey: transportUnitKey,
          displayName: "TCGdex sealed import",
          productForm: "sealed",
          transportReadiness: "blocked",
          diagnosticCounts: { info: 0, warning: 0, error: 1 },
          diagnostics: [
            {
              code: "provider-pagination-failed",
              severity: "error",
              message: longProviderDiagnostic,
              unitKey: transportUnitKey,
              retryAfterSeconds: 300,
              source: "provider-adapter",
            },
          ],
          latestDiagnosticText: longProviderDiagnostic,
        },
      ],
    },
    unitActivity: {
      generatedAt: baseOverview.generatedAt,
      units: [
        {
          unitKey: semanticUnitKey,
          recentJobs: [
            {
              ...baseJob,
              jobId: "job_failed",
              phase: "failed",
              operatorStatus: "failed",
              completed: 18,
              total: 24,
              summary: "import job job_failed failed after provider pagination drift.",
              unitKey: semanticUnitKey,
              providerKey: "tcgdex",
              importScope: "en:3:base:base1",
            },
            {
              ...baseJob,
              jobId: "job_running",
              completed: 4,
              total: 24,
              summary: "import job job_running is running with launch diagnostics.",
              unitKey: semanticUnitKey,
              providerKey: "tcgdex",
              importScope: "en:3:base:base1",
            },
          ],
        },
      ],
    },
    providerReadiness: {
      generatedAt: baseOverview.generatedAt,
      providers: [
        {
          ...baseOverview.providerReadiness.providers[0]!,
          readiness: "degraded",
          unitKeys: [semanticUnitKey, transportUnitKey],
          rateLimitStatus: {
            status: "degraded",
            diagnosticCodes: ["provider-rate-limit"],
            message: "Provider rate limit is cooling down.",
          },
          payloadAcquisition: {
            status: "blocked",
            diagnosticCodes: ["provider-pagination-failed"],
            message: longProviderDiagnostic,
          },
          diagnostics: [
            {
              code: "provider-pagination-failed",
              severity: "error",
              message: longProviderDiagnostic,
              unitKey: transportUnitKey,
              retryAfterSeconds: 300,
              source: "provider-adapter",
            },
          ],
        },
      ],
    },
    auditLifecycle: {
      generatedAt: baseOverview.generatedAt,
      projectionStatus: "partial",
      statusMessage: "Audit lifecycle projection is partial while health triage is live.",
      entries: [
        {
          eventId: "aud_health_001",
          occurredAt: "2026-06-09T01:02:00.000Z",
          eventName: "import-job-started",
          category: "import-job",
          providerKey: "tcgdex",
          unitKey: semanticUnitKey,
          profileVersion: "2026.06.04",
          actorUserId: "user_admin",
          relatedJobId: "job_running",
          summary: "Provider import started for health triage.",
          diagnosticCodes: ["provider-pagination-failed"],
        },
      ],
    },
  });
}
