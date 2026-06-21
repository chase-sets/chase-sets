// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalogPrimaryWorkbenchReadModel } from "./primary-workbench-read-model";
import { CatalogSourceScopeWorksetModule } from "./admin-control-plane/import-to-promotion/source-scope-workset-module";
import type { CatalogProviderProfileVersionReview, SourceObservationIntegrationScope } from "./contracts";
import { controlPlaneOverview, profileReview, sourceObservationScope } from "./primary-workbench-test-fixtures";
import { parseCatalogPrimaryWorkbenchRouteContext } from "./primary-workbench-route-context";

describe("Catalog source-scope workset", () => {
  afterEach(() => cleanup());

  it("ties one selected MTG source scope to configured provider-unit sync actions without a Magic-only area", () => {
    const profiles = magicProfiles();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=mtgjson&unitKey=mtgjson:mtg:set:reference-data&languageCode=en&productLineId=magic&productLineName=Magic%3A%20The%20Gathering&expansionId=5DN&expansionName=Fifth%20Dawn&profileVersion=2026.06.19",
      scopes: { items: magicSetScopes(), total: 3, count: 3 },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: overviewForProfiles(profiles, "mtg"),
      canManageCatalog: true,
    });

    expect(readModel.sourceScopeWorkset.status).toBe("ready");
    expect(readModel.sourceScopeWorkset.selectedScope).toMatchObject({
      importScope: "en:magic:5DN",
      hasConcreteScope: true,
    });
    expect(readModel.sourceScopeWorkset.units.map((unit) => unit.providerKey)).toEqual([
      "mtgjson",
      "scryfall",
      "tcgplayer",
    ]);
    expect(readModel.sourceScopeWorkset.units.every((unit) => unit.actions.import.state === "available")).toBe(true);

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    expect(screen.getAllByText("Selected source scope").length).toBeGreaterThan(0);
    expect(screen.queryByText("Magic set sync")).toBeNull();
    expect(screen.getAllByText("MTGJSON Set Reference").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Scryfall Magic card prints").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TCGplayer Magic Single Cards").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Sync MTGJSON Set Reference" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Preview Scryfall Magic card prints" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Reapply TCGplayer Magic Single Cards" }).length).toBeGreaterThan(0);

    const mtgjsonForm = sourceScopeCommandForm("start-provider-import", "mtgjson:mtg:set:reference-data");
    expect(formPathname(mtgjsonForm)).toBe("/catalog/integrations");
    expect(mtgjsonForm?.getAttribute("action")).not.toContain("/api/");
    expect(hiddenValue(mtgjsonForm, "providerKey")).toBe("mtgjson");
    expect(hiddenValue(mtgjsonForm, "unitKey")).toBe("mtgjson:mtg:set:reference-data");
    expect(hiddenValue(mtgjsonForm, "importScope")).toBe("en:magic:5DN");
    expect(hiddenValue(mtgjsonForm, "productLineName")).toBe("Magic: The Gathering");
    expect(hiddenValue(mtgjsonForm, "expansionName")).toBe("Fifth Dawn");

    const tcgplayerForm = sourceScopeCommandForm(
      "start-provider-import",
      "tcgplayer:mtg:single-card:source-observation-import",
    );
    expect(hiddenValue(tcgplayerForm, "providerKey")).toBe("tcgplayer");
    expect(hiddenValue(tcgplayerForm, "productLineId")).toBe("1");
    expect(hiddenValue(tcgplayerForm, "expansionId")).toBe("2157");
    expect(hiddenValue(tcgplayerForm, "expansionName")).toBe("Fifth Dawn");
    expect(hiddenValue(tcgplayerForm, "importScope")).toBe("en:1:2157");
    const tcgplayerAction = new URL(tcgplayerForm?.getAttribute("action") ?? "", "https://admin.example");
    expect(tcgplayerAction.searchParams.get("providerKey")).toBe("tcgplayer");
    expect(tcgplayerAction.searchParams.get("unitKey")).toBe("tcgplayer:mtg:single-card:source-observation-import");
    expect(tcgplayerAction.searchParams.get("importScope")).toBe("en:1:2157");

    const links = screen.getAllByRole("link", { name: "Open source scope" });
    expect(links.every((link) => !link.getAttribute("href")?.includes("/api/"))).toBe(true);
    expect(new Set(links.map((link) => link.getAttribute("href"))).size).toBe(3);
  });

  it("uses the same source-scope workset for a Pokemon set", () => {
    const profiles = [
      profileReview({
        active: true,
        status: "active",
        lifecycle: "active",
        profileVersion: "2026.06.04",
        ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
      }),
    ];
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&languageCode=en&productLineId=3&productLineName=Pokemon&seriesId=base&seriesName=Base&expansionId=base1&expansionName=Base%20Set&profileVersion=2026.06.04",
      scopes: { items: [pokemonScope()], total: 1, count: 1 },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: overviewForProfiles(profiles, "pokemon"),
      canManageCatalog: true,
    });

    expect(readModel.sourceScopeWorkset.status).toBe("ready");
    expect(readModel.sourceScopeWorkset.units.map((unit) => unit.providerKey)).toEqual(["tcgdex"]);
    expect(readModel.sourceScopeWorkset.units[0]?.commandContext).toMatchObject({
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      expansionId: "base1",
      expansionName: "Base Set",
    });

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    expect(screen.getAllByText("Selected source scope").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TCGdex Pokemon cards").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Sync TCGdex Pokemon cards" }).length).toBeGreaterThan(0);

    const form = sourceScopeCommandForm(
      "start-provider-import",
      "tcgdex:pokemon:single-card:source-observation-import",
    );
    expect(hiddenValue(form, "providerKey")).toBe("tcgdex");
    expect(hiddenValue(form, "unitKey")).toBe("tcgdex:pokemon:single-card:source-observation-import");
    expect(hiddenValue(form, "importScope")).toBe("en:3:base:base1");
    expect(hiddenValue(form, "seriesId")).toBe("base");
    expect(hiddenValue(form, "expansionId")).toBe("base1");
    expect(within(form!).queryByDisplayValue(/api\//i)).toBeNull();
  });

  it("does not project a stale Pokemon scope into a selected Yu-Gi-Oh provider command", () => {
    const profile = yugiohSetNameProfile(
      "ygoprodeck",
      "YGOPRODeck Yu-Gi-Oh card prints",
      "ygoprodeck:yugioh:single-card:reference-data",
    );
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=ygoprodeck&unitKey=ygoprodeck:yugioh:single-card:reference-data&importScope=ja:SV:SV8&profileVersion=2026.06.21",
      scopes: {
        items: [
          pokemonScope({
            language_code: "ja",
            product_line_id: "",
            product_line_name: "",
            series_id: "SV",
            series_name: "Scarlet & Violet",
            expansion_id: "SV8",
            expansion_name: "Super Electric Breaker",
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: overviewForProfiles([profile], "yugioh"),
      canManageCatalog: true,
    });
    const unit = readModel.sourceScopeWorkset.units.find((candidate) => candidate.providerKey === "ygoprodeck");

    expect(unit?.commandContext).toMatchObject({
      providerKey: "ygoprodeck",
      importScope: null,
      languageCode: null,
      seriesId: null,
      expansionId: null,
      expansionName: null,
    });
    expect(unit?.actions.import).toMatchObject({
      state: "disabled",
      blockers: ["import-scope-required"],
    });

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    const form = sourceScopeCommandForm("start-provider-import", "ygoprodeck:yugioh:single-card:reference-data");
    expect(hiddenValue(form, "importScope")).toBe("");
    expect(hiddenValue(form, "seriesId")).toBe("");
    expect(hiddenValue(form, "expansionId")).toBe("");
  });

  it("uses an explicit YGOJSON set-name selection instead of stale legacy Pokemon scope params", () => {
    const profile = yugiohSetNameProfile("ygojson", "YGOJSON Yu-Gi-Oh sets", "ygojson:yugioh:set:reference-data");
    const selectedSetId = "9baa1b43-8a60-44dd-a144-dbef99c8c7a4";
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: `https://admin.example/catalog/integrations?providerKey=ygojson&unitKey=ygojson:yugioh:set:reference-data&importScope=ja:SV:SV8&expansionName=${selectedSetId}&profileVersion=2026.06.21&filter.importScope=ja%3ASV%3ASV8`,
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: overviewForProfiles([profile], "yugioh"),
      canManageCatalog: true,
    });
    const unit = readModel.sourceScopeWorkset.units.find((candidate) => candidate.providerKey === "ygojson");

    expect(readModel.routeContext.importScope).toBeNull();
    expect(readModel.routeContext.sourceObservationFilters).toEqual({ providerKey: "ygojson" });
    expect(unit?.commandContext).toMatchObject({
      providerKey: "ygojson",
      importScope: `en:${selectedSetId}`,
      languageCode: "en",
      seriesId: null,
      expansionId: null,
      expansionName: selectedSetId,
    });
    expect(unit?.actions.import.state).toBe("available");

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    const form = sourceScopeCommandForm("start-provider-import", "ygojson:yugioh:set:reference-data");
    expect(hiddenValue(form, "importScope")).toBe(`en:${selectedSetId}`);
    expect(hiddenValue(form, "seriesId")).toBe("");
    expect(hiddenValue(form, "expansionId")).toBe("");
    expect(hiddenValue(form, "expansionName")).toBe(selectedSetId);
  });

  it("round-trips Pokemon workset links whose provider labels contain ampersands", () => {
    const profiles = [
      profileReview({
        active: true,
        status: "active",
        lifecycle: "active",
        profileVersion: "2026.06.03",
        ingestionUnitKey: "tcgdex:pokemon:single-card:source-observation-import",
      }),
    ];
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
      scopes: {
        items: [
          pokemonScope({
            language_code: "ja",
            product_line_id: "",
            series_id: "SV",
            series_name: "Pokemon Card Game Scarlet & Violet",
            expansion_id: "SV8",
            expansion_name: "Super Electric Breaker",
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: overviewForProfiles(profiles, "pokemon"),
      canManageCatalog: true,
    });
    const unit = readModel.sourceScopeWorkset.units[0]!;
    const href = new URL(unit.currentWorkbenchHref, "https://admin.example");

    expect(href.searchParams.get("seriesName")).toBe("Pokemon Card Game Scarlet & Violet");
    expect(unit.commandContext.importScope).toBe("ja:SV:SV8");
    expect(() =>
      buildCatalogPrimaryWorkbenchReadModel({
        requestUrl: href.toString(),
        scopes: {
          items: [
            pokemonScope({
              language_code: "ja",
              product_line_id: "",
              series_id: "SV",
              series_name: "Pokemon Card Game Scarlet & Violet",
              expansion_id: "SV8",
              expansion_name: "Super Electric Breaker",
            }),
          ],
          total: 1,
          count: 1,
        },
        profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
        controlPlaneOverview: overviewForProfiles(profiles, "pokemon"),
        canManageCatalog: true,
      }),
    ).not.toThrow();
  });

  it("keeps provider set-name selections name-based across workset links and commands", () => {
    const profile = magicProfile(
      "tcgplayer",
      "TCGplayer Magic Single Cards",
      "tcgplayer:mtg:single-card:source-observation-import",
      "provider-product",
    );
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&productLineId=1&productLineName=Magic%3A%20The%20Gathering&expansionName=Classic%20Sixth%20Edition&profileVersion=2026.06.19",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });
    const unit = readModel.sourceScopeWorkset.units[0]!;
    const roundTripContext = parseCatalogPrimaryWorkbenchRouteContext(
      new URL(unit.currentWorkbenchHref, "https://admin.example"),
    );

    expect(unit.commandContext).toMatchObject({
      providerKey: "tcgplayer",
      importScope: "en:1:Classic Sixth Edition",
      productLineId: "1",
      expansionId: null,
      expansionName: "Classic Sixth Edition",
    });
    expect(readModel.routeContext.importScope).toBe("en:1:Classic Sixth Edition");
    expect(readModel.routeContext.sourceObservationFilters.importScope).toBe("en:1:Classic Sixth Edition");
    expect(unit.actions.import.state).toBe("available");
    expect(unit.currentWorkbenchHref).toContain("productLineId=1");
    expect(unit.currentWorkbenchHref).toContain("expansionName=Classic+Sixth+Edition");
    expect(unit.currentWorkbenchHref).not.toContain("expansionId=Classic");
    expect(roundTripContext.scope).toMatchObject({
      productLineId: "1",
      expansionId: null,
      expansionName: "Classic Sixth Edition",
    });

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    const form = sourceScopeCommandForm("start-provider-import", "tcgplayer:mtg:single-card:source-observation-import");
    const action = new URL(form?.getAttribute("action") ?? "", "https://admin.example");
    expect(action.searchParams.get("providerKey")).toBe("tcgplayer");
    expect(action.searchParams.get("unitKey")).toBe("tcgplayer:mtg:single-card:source-observation-import");
    expect(action.searchParams.get("importScope")).toBe("en:1:Classic Sixth Edition");
    expect(hiddenValue(form, "expansionId")).toBe("");
    expect(hiddenValue(form, "expansionName")).toBe("Classic Sixth Edition");
    expect(hiddenValue(form, "importScope")).toBe("en:1:Classic Sixth Edition");
  });

  it("replaces stale legacy importScope when a structured set-name selection changes", () => {
    const profile = magicProfile(
      "tcgplayer",
      "TCGplayer Magic Single Cards",
      "tcgplayer:mtg:single-card:source-observation-import",
      "provider-product",
    );
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:mtg:single-card:source-observation-import&importScope=en%3AFifth%20Dawn&productLineId=1&expansionName=Classic%20Sixth%20Edition&profileVersion=2026.06.19&filter.importScope=en%3AFifth%20Dawn",
      scopes: { items: [magicScope("tcgplayer", { expansion_name: "Fifth Dawn" })], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });
    const unit = readModel.sourceScopeWorkset.units[0]!;

    expect(readModel.routeContext.importScope).toBe("en:1:Classic Sixth Edition");
    expect(readModel.routeContext.sourceObservationFilters.importScope).toBe("en:1:Classic Sixth Edition");
    expect(unit.commandContext.importScope).toBe("en:1:Classic Sixth Edition");
    expect(unit.commandContext.expansionName).toBe("Classic Sixth Edition");
    expect(unit.currentWorkbenchHref).not.toContain("Fifth+Dawn");
    expect(unit.currentWorkbenchHref).not.toContain("Fifth%20Dawn");

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    const form = sourceScopeCommandForm("start-provider-import", "tcgplayer:mtg:single-card:source-observation-import");
    const action = new URL(form?.getAttribute("action") ?? "", "https://admin.example");
    expect(action.searchParams.get("importScope")).toBe("en:1:Classic Sixth Edition");
    expect(action.searchParams.get("filter.importScope")).toBe("en:1:Classic Sixth Edition");
    expect(action.searchParams.toString()).not.toContain("Fifth+Dawn");
    expect(hiddenValue(form, "importScope")).toBe("en:1:Classic Sixth Edition");
  });

  it("fails closed until a concrete source scope is selected", () => {
    const profiles = magicProfiles();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=scryfall",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: overviewForProfiles(profiles, "mtg"),
      canManageCatalog: true,
    });

    expect(readModel.sourceScopeWorkset.status).toBe("scope-required");
    for (const unit of readModel.sourceScopeWorkset.units) {
      expect(unit.commandContext.importScope).toBeNull();
      expect(unit.actions.import).toMatchObject({
        state: "disabled",
        blockers: ["import-scope-required"],
      });
    }

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    expect(screen.getByText("Select a source scope")).toBeTruthy();
    const scryfallForm = sourceScopeCommandForm("start-provider-import", "scryfall:mtg:single-card:reference-data");
    expect(formPathname(scryfallForm)).toBe("/catalog/integrations");
    expect(hiddenValue(scryfallForm, "importScope")).toBe("");
    expect(hiddenValue(scryfallForm, "expansionId")).toBe("");
  });
});

function magicProfiles(): CatalogProviderProfileVersionReview[] {
  return [
    magicProfile("mtgjson", "MTGJSON Set Reference", "mtgjson:mtg:set:reference-data", "magic-set-reference"),
    magicProfile(
      "scryfall",
      "Scryfall Magic card prints",
      "scryfall:mtg:single-card:reference-data",
      "magic-card-print",
    ),
    magicProfile(
      "tcgplayer",
      "TCGplayer Magic Single Cards",
      "tcgplayer:mtg:single-card:source-observation-import",
      "provider-product",
    ),
  ];
}

function magicProfile(
  providerKey: "mtgjson" | "scryfall" | "tcgplayer",
  displayName: string,
  ingestionUnitKey: string,
  mappingOutputKind: string,
): CatalogProviderProfileVersionReview {
  return profileReview({
    providerKey,
    profileKey: `${providerKey}-mtg`,
    profileVersion: "2026.06.19",
    ingestionUnitKey,
    displayName,
    active: true,
    lifecycle: "active",
    status: "active",
    profile: { providerKey, supportedScopes: ["set-name", "product/card"] },
    supportedScopes: ["set-name", "product/card"],
    mappingOutputKind,
    sourceOptionKinds: [
      {
        queryKind: providerKey === "tcgplayer" ? "set-names" : "sets",
        queryKeySynonyms: providerKey === "tcgplayer" ? ["set-name"] : ["set"],
        displayName: providerKey === "tcgplayer" ? "Set Name" : "Set",
        scope: "set-name",
        parentScope: providerKey === "tcgplayer" ? "product-line/category" : null,
        parentRequired: providerKey === "tcgplayer",
        parentValueKind: providerKey === "tcgplayer" ? "product-line-id" : null,
        parentDiagnosticText: providerKey === "tcgplayer" ? "Select Product Line before Set Name." : null,
      },
    ],
  });
}

function magicSetScopes(): SourceObservationIntegrationScope[] {
  return [
    magicScope("mtgjson", { observed_observations: 1, changed_observations: 1, promoted_observations: 0 }),
    magicScope("scryfall", { observed_observations: 400, changed_observations: 12, promoted_observations: 320 }),
    magicScope("tcgplayer", { observed_observations: 80, changed_observations: 6, promoted_observations: 70 }),
  ];
}

function magicScope(
  providerKey: "mtgjson" | "scryfall" | "tcgplayer",
  counts: Partial<SourceObservationIntegrationScope>,
): SourceObservationIntegrationScope {
  const providerScope =
    providerKey === "tcgplayer"
      ? { product_line_id: "1", expansion_id: "2157" }
      : { product_line_id: "magic", expansion_id: "5DN" };

  return sourceObservationScope({
    provider_key: providerKey,
    language_code: "en",
    product_line_id: providerScope.product_line_id,
    product_line_name: "Magic: The Gathering",
    series_id: "",
    series_name: "",
    expansion_id: providerScope.expansion_id,
    expansion_name: "Fifth Dawn",
    total_observations: 400,
    rejected_observations: 0,
    ...counts,
    latest_source_updated_at: "2026-06-19T12:00:00.000Z",
    latest_observed_at: "2026-06-19T12:05:00.000Z",
    first_observed_at: "2026-06-19T12:00:00.000Z",
  });
}

function yugiohSetNameProfile(providerKey: string, displayName: string, ingestionUnitKey: string) {
  return profileReview({
    providerKey,
    profileKey: `${providerKey}-yugioh-set`,
    profileVersion: "2026.06.21",
    ingestionUnitKey,
    displayName,
    active: true,
    lifecycle: "active",
    status: "active",
    connectorKind: providerKey,
    profile: {
      providerKey,
      supportedScopes: ["set-name"],
    },
    supportedScopes: ["set-name"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["setName"],
        displayName: "Set",
        scope: "set-name",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
    ],
  });
}

function pokemonScope(overrides: Partial<SourceObservationIntegrationScope> = {}): SourceObservationIntegrationScope {
  return sourceObservationScope({
    provider_key: "tcgdex",
    language_code: "en",
    product_line_id: "3",
    product_line_name: "Pokemon",
    series_id: "base",
    series_name: "Base",
    expansion_id: "base1",
    expansion_name: "Base Set",
    total_observations: 102,
    observed_observations: 100,
    changed_observations: 24,
    promoted_observations: 16,
    rejected_observations: 2,
    ...overrides,
  });
}

function overviewForProfiles(profiles: readonly CatalogProviderProfileVersionReview[], productDomain: string) {
  const base = controlPlaneOverview();
  const units = profiles.map((profile) => ({
    ...base.readiness.units[0]!,
    unitKey: profile.ingestionUnitKey,
    providerKey: profile.providerKey,
    displayName: profile.displayName,
    productDomain,
    productForm: profile.ingestionUnitKey.split(":")[2] ?? "card",
    profileVersion: profile.profileVersion,
    observationFacts: 1,
  }));

  return controlPlaneOverview({
    readiness: {
      ...base.readiness,
      units,
    },
    unitActivity: {
      generatedAt: base.generatedAt,
      units: units.map((unit) => ({ unitKey: unit.unitKey, recentJobs: [] })),
    },
    providerReadiness: {
      generatedAt: base.generatedAt,
      providers: units.map((unit) => ({
        providerKey: unit.providerKey,
        adapterKey: unit.providerKey,
        readiness: "ready",
        credentialReadiness: "not-required",
        credentialReadinessState: "not-required",
        credentialRequirement: "not-required",
        unitKeys: [unit.unitKey],
        apiReachability: { status: "ready", diagnosticCodes: [], message: null },
        optionQueryHealth: { status: "ready", diagnosticCodes: [], message: null },
        rateLimitStatus: { status: "ready", diagnosticCodes: [], message: null },
        payloadAcquisition: { status: "ready", diagnosticCodes: [], message: null },
        diagnostics: [],
      })),
    },
  });
}

function sourceScopeCommandForm(intent: string, unitKey: string): HTMLFormElement | null {
  return document.querySelector<HTMLFormElement>(
    `form[data-catalog-primary-workbench-command="${intent}"][data-catalog-source-scope-unit="${unitKey}"]`,
  );
}

function hiddenValue(form: HTMLFormElement | null, name: string): string | undefined {
  return form?.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;
}

function formPathname(form: HTMLFormElement | null): string | undefined {
  const action = form?.getAttribute("action");
  return action ? new URL(action, "https://admin.example").pathname : undefined;
}
