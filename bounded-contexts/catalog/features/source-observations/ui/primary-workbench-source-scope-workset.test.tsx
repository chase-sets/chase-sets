// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "./primary-workbench-read-model";
import { CatalogSourceScopeWorksetModule } from "./admin-control-plane/import-to-promotion/source-scope-workset-module";
import type { CatalogProviderProfileVersionReview, SourceObservationIntegrationScope } from "./contracts";
import { controlPlaneOverview, profileReview, sourceObservationScope } from "./primary-workbench-test-fixtures";
import { parseCatalogPrimaryWorkbenchRouteContext } from "./primary-workbench-route-context";
import {
  ygojsonYugiohSealedProductReferenceProviderProfile,
  ygojsonYugiohSealedProductReferenceSourceObservationMappingContract,
} from "../api/providers/ygojson/executable-mapping-contract";
import { guidedSourceScopeFields } from "./primary-workbench-source-scope-fields";
import { scopeContextFromFormData, scopeContextToIntegrationJobScope } from "./primary-workbench-scope-context";

function sealedProductProfile(): CatalogProviderProfileVersionReview {
  const profile = ygojsonYugiohSealedProductReferenceProviderProfile;
  return profileReview({
    providerKey: "ygojson",
    ingestionUnitKey: "ygojson:yugioh:sealed-product:reference-data",
    profileKey: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.profileKey,
    profileVersion: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.profileVersion,
    displayName: profile.displayName,
    active: true,
    lifecycle: "active",
    profile,
    languageOptions: ["en"],
    supportedScopes: [...profile.supportedScopes],
    sourceOptionKinds: profile.optionQueries.map((query) => ({
      queryKind: query.queryKind,
      queryKeySynonyms: [...query.queryKeySynonyms],
      displayName: query.displayName,
      scope: query.scope,
      parentScope: query.parentScope,
      parentRequired: false,
      parentValueKind: null,
      parentDiagnosticText: null,
    })),
  });
}

describe("Catalog source-scope workset", () => {
  afterEach(() => cleanup());

  it("carries two product coordinates through the active profile, real workset, guided field, URL and command form", () => {
    const profile = sealedProductProfile();
    const identities: string[] = [];
    for (const productId of ["synthetic-product-a", "synthetic-product-b"]) {
      const requestUrl = `https://admin.example/catalog/integrations?providerKey=ygojson&unitKey=${profile.ingestionUnitKey}&productId=${productId}`;
      const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
        requestUrl,
        scopes: { items: [], total: 0, count: 0 },
        profileReviews: { items: [profile], total: 1, count: 1 },
        controlPlaneOverview: null,
        canManageCatalog: true,
      });
      expect(readModel.routeContext.scope).toMatchObject({ productId, languageCode: "en", expansionId: null });
      expect(readModel.sourceOptions.pages[0]).toMatchObject({ queryKind: "sealed-products", scope: "product" });
      expect(readModel.sourceOptions.selectedUnitKey).toBe(profile.ingestionUnitKey);
      expect(guidedSourceScopeFields(readModel)[0]).toMatchObject({ fieldName: "productId", selectedValue: productId });
      const row = readModel.sourceScopeWorkset.units.find((unit) => unit.unitKey === profile.ingestionUnitKey)!;
      expect(row.commandContext.productId).toBe(productId);
      expect(
        parseCatalogPrimaryWorkbenchRouteContext(`https://admin.example${row.currentWorkbenchHref}`).scope?.productId,
      ).toBe(productId);
      identities.push(row.importScope!);
      render(<CatalogSourceScopeWorksetModule readModel={readModel} />);
      const form = sourceScopeCommandForm("scope.import", profile.ingestionUnitKey)!;
      expect(hiddenValue(form, "productId")).toBe(productId);
      const formData = new FormData(form);
      const scope = scopeContextFromFormData(formData, readModel.routeContext.scope!);
      expect(scopeContextToIntegrationJobScope(scope).productId).toBe(productId);
      formData.set("productId", "");
      formData.set("importScope", "");
      expect(scopeContextFromFormData(formData, readModel.routeContext.scope!).productId).toBeNull();
      cleanup();
    }
    expect(new Set(identities).size).toBe(2);
  });

  it("refuses stale product selection for missing, inactive and mismatched units", () => {
    const active = sealedProductProfile();
    for (const [unitKey, profile] of [
      ["", active],
      [active.ingestionUnitKey, { ...active, active: false }],
      ["ygojson:yugioh:set:reference-data", active],
    ] as const) {
      const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
        requestUrl: `https://admin.example/catalog/integrations?providerKey=ygojson&unitKey=${unitKey}&productId=synthetic-stale-product&languageCode=en`,
        scopes: { items: [], total: 0, count: 0 },
        profileReviews: { items: [profile], total: 1, count: 1 },
        controlPlaneOverview: null,
        canManageCatalog: true,
      });
      expect(readModel.routeContext.scope?.productId).toBeNull();
      expect(readModel.sourceScopeWorkset.units.every((unit) => !unit.commandContext.productId)).toBe(true);
    }
  });

  it("ties one selected MTG source scope to configured provider-unit sync actions without a Magic-only area", () => {
    const profiles = magicProfiles();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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

    const mtgjsonForm = sourceScopeCommandForm("scope.import", "mtgjson:mtg:set:reference-data");
    expect(formPathname(mtgjsonForm)).toBe("/catalog/integrations");
    expect(mtgjsonForm?.getAttribute("action")).not.toContain("/api/");
    expect(hiddenValue(mtgjsonForm, "providerKey")).toBe("mtgjson");
    expect(hiddenValue(mtgjsonForm, "unitKey")).toBe("mtgjson:mtg:set:reference-data");
    expect(hiddenValue(mtgjsonForm, "importScope")).toBe("en:magic:5DN");
    expect(hiddenValue(mtgjsonForm, "productLineName")).toBe("Magic: The Gathering");
    expect(hiddenValue(mtgjsonForm, "expansionName")).toBe("Fifth Dawn");

    const tcgplayerForm = sourceScopeCommandForm("scope.import", "tcgplayer:mtg:single-card:source-observation-import");
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
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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

    const form = sourceScopeCommandForm("scope.import", "tcgdex:pokemon:single-card:source-observation-import");
    expect(hiddenValue(form, "providerKey")).toBe("tcgdex");
    expect(hiddenValue(form, "unitKey")).toBe("tcgdex:pokemon:single-card:source-observation-import");
    expect(hiddenValue(form, "importScope")).toBe("en:3:base:base1");
    expect(hiddenValue(form, "seriesId")).toBe("base");
    expect(hiddenValue(form, "expansionId")).toBe("base1");
    expect(within(form!).queryByDisplayValue(/api\//i)).toBeNull();
  });

  it("uses the same source-scope workset for a Lorcana set without a Lorcana-only area", () => {
    const profiles = lorcanaProfiles();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=lorcanajson&unitKey=lorcanajson:lorcana:single-card:reference-data&languageCode=en&productLineId=lorcana&productLineName=Disney%20Lorcana&expansionId=TFC&expansionName=The%20First%20Chapter&profileVersion=2026.06.23",
      scopes: { items: lorcanaSetScopes(), total: 3, count: 3 },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: overviewForProfiles(profiles, "lorcana"),
      canManageCatalog: true,
    });

    expect(readModel.sourceScopeWorkset.status).toBe("ready");
    expect(readModel.sourceScopeWorkset.selectedScope).toMatchObject({
      importScope: "en:lorcana:TFC",
      hasConcreteScope: true,
    });
    expect(readModel.sourceScopeWorkset.units.map((unit) => unit.providerKey)).toEqual([
      "lorcanajson",
      "lorcast",
      "tcgplayer",
    ]);
    expect(readModel.sourceScopeWorkset.units.every((unit) => unit.actions.import.state === "available")).toBe(true);

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    expect(screen.getAllByText("Selected source scope").length).toBeGreaterThan(0);
    expect(screen.queryByText("Lorcana set sync")).toBeNull();
    expect(screen.getAllByText("LorcanaJSON").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Lorcast Lorcana cards").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TCGplayer Lorcana Single Cards").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Sync LorcanaJSON" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Sync Lorcast Lorcana cards" }).length).toBeGreaterThan(0);

    const lorcanajsonForm = sourceScopeCommandForm("scope.import", "lorcanajson:lorcana:single-card:reference-data");
    expect(formPathname(lorcanajsonForm)).toBe("/catalog/integrations");
    expect(lorcanajsonForm?.getAttribute("action")).not.toContain("/api/");
    expect(hiddenValue(lorcanajsonForm, "providerKey")).toBe("lorcanajson");
    expect(hiddenValue(lorcanajsonForm, "unitKey")).toBe("lorcanajson:lorcana:single-card:reference-data");
    expect(hiddenValue(lorcanajsonForm, "importScope")).toBe("en:lorcana:TFC");
    expect(hiddenValue(lorcanajsonForm, "productLineName")).toBe("Disney Lorcana");
    expect(hiddenValue(lorcanajsonForm, "expansionName")).toBe("The First Chapter");

    const tcgplayerForm = sourceScopeCommandForm(
      "scope.import",
      "tcgplayer:lorcana:single-card:source-observation-import",
    );
    expect(hiddenValue(tcgplayerForm, "providerKey")).toBe("tcgplayer");
    expect(hiddenValue(tcgplayerForm, "productLineId")).toBe("71");
    expect(hiddenValue(tcgplayerForm, "expansionName")).toBe("The First Chapter");
    expect(hiddenValue(tcgplayerForm, "importScope")).toBe("en:71:TFC");
    expect(within(tcgplayerForm!).queryByDisplayValue(/api\//i)).toBeNull();
  });

  it("keeps compact Lorcast set selections named before a provider scope row exists", () => {
    const unitKey = "lorcast:lorcana:single-card:reference-data";
    const profiles = lorcanaProfiles();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=lorcast&unitKey=lorcast:lorcana:single-card:reference-data&importScope=en%3A1&languageCode=en&expansionId=1&profileVersion=2026.06.23",
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
            promoted_observations: 242,
            rejected_observations: 0,
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      sourceOptionPages: [
        {
          request: {
            providerKey: "lorcast",
            profileKey: "lorcast-lorcana-card",
            profileVersion: "2026.06.23",
            ingestionUnitKey: unitKey,
            queryKind: "sets",
            displayName: "Set",
            scope: "set-name",
            parentScope: null,
            parentRequired: false,
            parentDiagnosticText: null,
            selectedParentValue: null,
            selectedParentLabel: null,
            languageCode: "en",
            parentValue: null,
            cursor: null,
            limit: 25,
            cacheOnly: true,
            queryHref: "/api/catalog/source-observations/integration-options?providerKey=lorcast&queryKind=sets",
            refreshHref: null,
          },
          response: {
            items: [
              {
                providerKey: "lorcast",
                queryKind: "sets",
                value: "1",
                label: "The First Chapter",
                description: null,
                parentValue: null,
                imageUrl: null,
                aliases: [],
                metadata: {},
              },
            ],
            total: 1,
            count: 1,
            cache: {
              status: "fresh",
              source: "cache",
              cacheKey: "lorcast:sets:en",
              fetchedAt: "2026-07-01T00:00:00.000Z",
              expiresAt: "2026-07-02T00:00:00.000Z",
              staleUntil: "2026-07-03T00:00:00.000Z",
              cacheOnly: true,
              forceRefresh: false,
              degraded: false,
              diagnostics: [],
            },
          },
        },
      ],
      controlPlaneOverview: overviewForProfiles(profiles, "lorcana"),
      canManageCatalog: true,
    });
    const lorcastUnit = readModel.sourceScopeWorkset.units.find((unit) => unit.unitKey === unitKey);

    expect(readModel.sourceScopeWorkset.selectedScope).toMatchObject({
      importScope: "en:1",
      label: "lorcast / en / Disney Lorcana / The First Chapter",
    });
    expect(lorcastUnit?.commandContext).toMatchObject({
      providerKey: "lorcast",
      unitKey,
      importScope: "en:1",
      productLineName: "Disney Lorcana",
      expansionId: "1",
      expansionName: "The First Chapter",
    });
    expect(lorcastUnit?.actions.import.state).toBe("available");

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    expect(screen.getAllByText("lorcast / en / Disney Lorcana / The First Chapter").length).toBeGreaterThan(0);
    const form = sourceScopeCommandForm("scope.import", unitKey);
    expect(hiddenValue(form, "importScope")).toBe("en:1");
    expect(hiddenValue(form, "productLineName")).toBe("Disney Lorcana");
    expect(hiddenValue(form, "expansionId")).toBe("1");
    expect(hiddenValue(form, "expansionName")).toBe("The First Chapter");
    expect(
      new URL(lorcastUnit?.currentWorkbenchHref ?? "", "https://admin.example").searchParams.get("expansionName"),
    ).toBe("The First Chapter");
  });

  it("uses sibling Lorcana scope rows when Lorcast set option cache is absent", () => {
    const unitKey = "lorcast:lorcana:single-card:reference-data";
    const profiles = lorcanaProfiles();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=lorcast&unitKey=lorcast:lorcana:single-card:reference-data&importScope=en%3A1&languageCode=en&expansionId=1&profileVersion=2026.06.23",
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
            promoted_observations: 242,
            rejected_observations: 0,
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      sourceOptionPages: [],
      controlPlaneOverview: overviewForProfiles(profiles, "lorcana"),
      canManageCatalog: true,
    });
    const lorcastUnit = readModel.sourceScopeWorkset.units.find((unit) => unit.unitKey === unitKey);

    expect(readModel.sourceScopeWorkset.selectedScope).toMatchObject({
      importScope: "en:1",
      label: "lorcast / en / Disney Lorcana / The First Chapter",
    });
    expect(lorcastUnit?.commandContext).toMatchObject({
      providerKey: "lorcast",
      unitKey,
      importScope: "en:1",
      productLineName: "Disney Lorcana",
      expansionId: "1",
      expansionName: "The First Chapter",
    });

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    expect(screen.getAllByText("lorcast / en / Disney Lorcana / The First Chapter").length).toBeGreaterThan(0);
    const form = sourceScopeCommandForm("scope.import", unitKey);
    expect(hiddenValue(form, "importScope")).toBe("en:1");
    expect(hiddenValue(form, "productLineName")).toBe("Disney Lorcana");
    expect(hiddenValue(form, "expansionId")).toBe("1");
    expect(hiddenValue(form, "expansionName")).toBe("The First Chapter");
  });

  it("does not project a TCGplayer MTG scope into the Yu-Gi-Oh unit", () => {
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const profiles = [
      tcgplayerUnitProfile("mtg-single-card-product-sku", "TCGplayer Magic Single Cards", mtgUnit, "2026.06.19"),
      tcgplayerUnitProfile(
        "yugioh-single-card-product-sku",
        "TCGplayer Yu-Gi-Oh Single Cards",
        yugiohUnit,
        "2026.06.20",
      ),
    ];
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:mtg:single-card:source-observation-import&languageCode=en&productLineId=1&productLineName=Magic&expansionName=Classic%20Sixth%20Edition&profileVersion=2026.06.19",
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "tcgplayer",
            language_code: "en",
            product_line_id: "1",
            product_line_name: "Magic",
            series_id: "",
            series_name: "",
            expansion_id: "",
            expansion_name: "Classic Sixth Edition",
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.sourceScopeWorkset.units.map((unit) => unit.unitKey)).toEqual([mtgUnit]);
    expect(readModel.sourceScopeWorkset.units[0]?.commandContext).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: mtgUnit,
      importScope: "en:1:Classic Sixth Edition",
      productLineId: "1",
      expansionName: "Classic Sixth Edition",
    });

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    expect(sourceScopeCommandForm("scope.import", mtgUnit)).not.toBeNull();
    expect(sourceScopeCommandForm("scope.import", yugiohUnit)).toBeNull();
  });

  it("keeps a selected TCGplayer Yu-Gi-Oh unit visible but blocked for a stale MTG scope", () => {
    const mtgUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const yugiohUnit = "tcgplayer:yugioh:single-card:source-observation-import";
    const profiles = [
      tcgplayerUnitProfile("mtg-single-card-product-sku", "TCGplayer Magic Single Cards", mtgUnit, "2026.06.19"),
      tcgplayerUnitProfile(
        "yugioh-single-card-product-sku",
        "TCGplayer Yu-Gi-Oh Single Cards",
        yugiohUnit,
        "2026.06.20",
      ),
    ];
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:yugioh:single-card:source-observation-import&importScope=en:1:Classic%20Sixth%20Edition&languageCode=en&productLineId=1&productLineName=Magic&expansionName=Classic%20Sixth%20Edition&profileVersion=2026.06.20",
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "tcgplayer",
            language_code: "en",
            product_line_id: "1",
            product_line_name: "Magic",
            series_id: "",
            series_name: "",
            expansion_id: "",
            expansion_name: "Classic Sixth Edition",
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });
    const yugiohUnitRow = readModel.sourceScopeWorkset.units.find((unit) => unit.unitKey === yugiohUnit);

    expect(readModel.sourceScopeWorkset.units.map((unit) => unit.unitKey)).toEqual([mtgUnit, yugiohUnit]);
    expect(yugiohUnitRow?.commandContext).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: yugiohUnit,
      importScope: null,
      productLineId: null,
      expansionName: null,
    });
    expect(yugiohUnitRow?.actions.import).toMatchObject({
      state: "disabled",
      blockers: ["import-scope-required"],
    });
  });

  it("does not project a stale Pokemon scope into a selected Yu-Gi-Oh provider command", () => {
    const profile = yugiohSetNameProfile(
      "ygoprodeck",
      "YGOPRODeck Yu-Gi-Oh card prints",
      "ygoprodeck:yugioh:single-card:reference-data",
    );
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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

    const form = sourceScopeCommandForm("scope.import", "ygoprodeck:yugioh:single-card:reference-data");
    expect(hiddenValue(form, "importScope")).toBe("");
    expect(hiddenValue(form, "seriesId")).toBe("");
    expect(hiddenValue(form, "expansionId")).toBe("");
  });

  it("uses an explicit YGOJSON set-name selection instead of stale legacy Pokemon scope params", () => {
    const profile = yugiohSetNameProfile("ygojson", "YGOJSON Yu-Gi-Oh sets", "ygojson:yugioh:set:reference-data");
    const selectedSetId = "9baa1b43-8a60-44dd-a144-dbef99c8c7a4";
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: `https://admin.example/catalog/integrations?providerKey=ygojson&unitKey=ygojson:yugioh:set:reference-data&importScope=ja:SV:SV8&expansionName=${selectedSetId}&profileVersion=2026.06.21&filter.importScope=ja%3ASV%3ASV8`,
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: overviewForProfiles([profile], "yugioh"),
      canManageCatalog: true,
    });
    const unit = readModel.sourceScopeWorkset.units.find((candidate) => candidate.providerKey === "ygojson");

    expect(readModel.routeContext.importScope).toBe(`en:${selectedSetId}`);
    expect(readModel.routeContext.sourceObservationFilters).toEqual({
      providerKey: "ygojson",
      importScope: `en:${selectedSetId}`,
    });
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

    const form = sourceScopeCommandForm("scope.import", "ygojson:yugioh:set:reference-data");
    expect(hiddenValue(form, "importScope")).toBe(`en:${selectedSetId}`);
    expect(hiddenValue(form, "seriesId")).toBe("");
    expect(hiddenValue(form, "expansionId")).toBe("");
    expect(hiddenValue(form, "expansionName")).toBe(selectedSetId);
  });

  it("uses a Scrydex One Piece set-name selection as the primary import context", () => {
    const profile = scrydexOnePieceSetNameProfile();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=scrydex:one-piece:single-card:source-observation-import&expansionName=OP16&profileVersion=2026.06.22&sourceOptionAction=force-refresh-all",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: overviewForProfiles([profile], "one-piece"),
      canManageCatalog: true,
    });
    const unit = readModel.sourceScopeWorkset.units.find((candidate) => candidate.providerKey === "scrydex");

    expect(readModel.routeContext.importScope).toBe("en:OP16");
    expect(readModel.routeContext.sourceObservationFilters).toEqual({
      providerKey: "scrydex",
      importScope: "en:OP16",
    });
    expect(readModel.importJobs.selectedScope).toMatchObject({
      providerKey: "scrydex",
      unitKey: "scrydex:one-piece:single-card:source-observation-import",
      importScope: "en:OP16",
    });
    expect(readModel.actions.find((actionEntry) => actionEntry.key === "scope.import")?.blockers).not.toContain(
      "import-scope-required",
    );
    expect(unit?.commandContext).toMatchObject({
      providerKey: "scrydex",
      importScope: "en:OP16",
      languageCode: "en",
      seriesId: null,
      expansionId: null,
      expansionName: "OP16",
    });
    expect(unit?.actions.import.state).toBe("available");

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    const form = sourceScopeCommandForm("scope.import", "scrydex:one-piece:single-card:source-observation-import");
    expect(hiddenValue(form, "importScope")).toBe("en:OP16");
    expect(hiddenValue(form, "seriesId")).toBe("");
    expect(hiddenValue(form, "expansionId")).toBe("");
    expect(hiddenValue(form, "expansionName")).toBe("OP16");
  });

  it("does not project stale One Piece set fields into a Scrydex Lorcana command", () => {
    const unitKey = "scrydex:lorcana:single-card:source-observation-import";
    const profile = scrydexLorcanaSetNameProfile();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=scrydex:lorcana:single-card:source-observation-import&importScope=en%3ATFC&languageCode=en&productLineName=One%20Piece%20Card%20Game&expansionName=The%20Time%20Of%20Battle&profileVersion=2026.06.23",
      scopes: { items: [lorcanaScope("scrydex", { observed_observations: 1 })], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: overviewForProfiles([profile], "lorcana"),
      canManageCatalog: true,
    });
    const unit = readModel.sourceScopeWorkset.units.find((candidate) => candidate.unitKey === unitKey);

    expect(unit?.commandContext).toMatchObject({
      providerKey: "scrydex",
      unitKey,
      importScope: null,
      productLineName: null,
      expansionName: null,
    });
    expect(unit?.actions.import).toMatchObject({
      state: "disabled",
      blockers: ["import-scope-required"],
    });

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    const form = sourceScopeCommandForm("scope.import", unitKey);
    expect(hiddenValue(form, "importScope")).toBe("");
    expect(hiddenValue(form, "productLineName")).toBe("");
    expect(hiddenValue(form, "expansionName")).toBe("");
    expect(within(form!).queryByDisplayValue("The Time Of Battle")).toBeNull();
  });

  it("uses provider scope labels when Scrydex Lorcana route state carries compact set ids", () => {
    const unitKey = "scrydex:lorcana:single-card:source-observation-import";
    const profile = scrydexLorcanaSetNameProfile();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=scrydex:lorcana:single-card:source-observation-import&importScope=en%3ATFC&languageCode=en&productLineName=Disney%20Lorcana&expansionName=TFC&profileVersion=2026.06.23",
      scopes: { items: [lorcanaScope("scrydex", { observed_observations: 1 })], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: overviewForProfiles([profile], "lorcana"),
      canManageCatalog: true,
    });
    const unit = readModel.sourceScopeWorkset.units.find((candidate) => candidate.unitKey === unitKey);

    expect(unit?.commandContext).toMatchObject({
      providerKey: "scrydex",
      unitKey,
      importScope: "en:lorcana:TFC",
      productLineName: "Disney Lorcana",
      expansionId: "TFC",
      expansionName: "The First Chapter",
    });

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    const form = sourceScopeCommandForm("scope.import", unitKey);
    expect(hiddenValue(form, "importScope")).toBe("en:lorcana:TFC");
    expect(hiddenValue(form, "expansionId")).toBe("TFC");
    expect(hiddenValue(form, "expansionName")).toBe("The First Chapter");
    expect(form?.getAttribute("action")).toContain("expansionName=The+First+Chapter");
  });

  it("uses provider scope labels when Lorcast route state carries numeric set ids", () => {
    const unitKey = "lorcast:lorcana:single-card:reference-data";
    const profiles = lorcanaProfiles();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=lorcast&unitKey=lorcast:lorcana:single-card:reference-data&importScope=en%3A1&languageCode=en&productLineName=Disney%20Lorcana&expansionId=1&expansionName=1&profileVersion=2026.06.23",
      scopes: {
        items: [
          lorcanaScope("lorcast", {
            product_line_id: "",
            expansion_id: "1",
            observed_observations: 1,
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: overviewForProfiles(profiles, "lorcana"),
      canManageCatalog: true,
    });
    const unit = readModel.sourceScopeWorkset.units.find((candidate) => candidate.unitKey === unitKey);

    expect(unit?.commandContext).toMatchObject({
      providerKey: "lorcast",
      unitKey,
      importScope: "en:1",
      productLineName: "Disney Lorcana",
      expansionId: "1",
      expansionName: "The First Chapter",
    });

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    const form = sourceScopeCommandForm("scope.import", unitKey);
    expect(hiddenValue(form, "importScope")).toBe("en:1");
    expect(hiddenValue(form, "expansionId")).toBe("1");
    expect(hiddenValue(form, "expansionName")).toBe("The First Chapter");
    expect(form?.getAttribute("action")).toContain("expansionName=The+First+Chapter");
  });

  it("keeps a selected Lorcast set importable before provider scope rows exist", () => {
    const unitKey = "lorcast:lorcana:single-card:reference-data";
    const profiles = lorcanaProfiles();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=lorcast&unitKey=lorcast:lorcana:single-card:reference-data&languageCode=en&productLineName=Disney%20Lorcana&expansionId=1&profileVersion=2026.06.23",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: overviewForProfiles(profiles, "lorcana"),
      canManageCatalog: true,
    });
    const unit = readModel.sourceScopeWorkset.units.find((candidate) => candidate.unitKey === unitKey);

    expect(unit?.commandContext).toMatchObject({
      providerKey: "lorcast",
      unitKey,
      importScope: "en:1",
      productLineName: "Disney Lorcana",
      expansionId: "1",
    });
    expect(unit?.state).toBe("not-imported");
    expect(unit?.actions.import.state).toBe("available");
    expect(unit?.currentWorkbenchHref).toContain("importScope=en%3A1");

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    const form = sourceScopeCommandForm("scope.import", unitKey);
    expect(hiddenValue(form, "importScope")).toBe("en:1");
    expect(hiddenValue(form, "expansionId")).toBe("1");
    expect(hiddenValue(form, "expansionName")).toBe("");
    expect(screen.getAllByRole("button", { name: "Sync Lorcast Lorcana cards" }).length).toBeGreaterThan(0);
  });

  it("keeps LorcanaJSON compact set scopes promotable after preview redirects", () => {
    const unitKey = "lorcanajson:lorcana:single-card:reference-data";
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=lorcanajson&unitKey=lorcanajson:lorcana:single-card:reference-data&importScope=en%3A1&languageCode=en&productLineName=Disney%20Lorcana&expansionId=1&expansionName=The%20First%20Chapter&profileVersion=2026.06.23&promotionPreviewId=preview-lorcanajson_lorcanajson_lorcana_single-card_reference-data_en_1_2026.06.23_en_1_all_none_filtered-242-242",
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
      profileReviews: {
        items: [
          profileReview({
            providerKey: "lorcanajson",
            profileKey: "lorcana-card-reference-data",
            profileVersion: "2026.06.23",
            ingestionUnitKey: unitKey,
            displayName: "LorcanaJSON Lorcana single-card reference data",
            active: true,
            lifecycle: "active",
            status: "active",
            connectorKind: "lorcanajson-json",
            profile: {
              providerKey: "lorcanajson",
              supportedScopes: ["lorcana/single-card"],
            },
            supportedScopes: ["lorcana/single-card"],
            languageOptions: ["en"],
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: overviewForProfiles(
        [
          profileReview({
            providerKey: "lorcanajson",
            profileVersion: "2026.06.23",
            ingestionUnitKey: unitKey,
            displayName: "LorcanaJSON Lorcana single-card reference data",
            active: true,
            lifecycle: "active",
            status: "active",
          }),
        ],
        "lorcana",
      ),
      reviewObservations: { items: [], total: 0, count: 0 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    expect(readModel.sourceObservationReview.counts).toMatchObject({
      observed: 242,
      eligible: 242,
    });
    expect(readModel.sourceObservationReview.pagination.total).toBe(0);
    expect(readModel.promotionPreview.freshness).toBe("fresh");
    expect(readModel.promotionPreview.outcomeCounts.eligible).toBe(242);
    expect(readModel.promotionPreview.commandPlanHash).toContain("requested:242:eligible:242");
    expect(readModel.sourceScopeWorkset.units[0]?.counts.eligible).toBe(242);
  });

  it("keeps LorcanaJSON aggregate-backed previews promotable when row review falls back", () => {
    const unitKey = "lorcanajson:lorcana:single-card:reference-data";
    const profiles = lorcanaProfiles();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=lorcanajson&unitKey=lorcanajson:lorcana:single-card:reference-data&importScope=en%3A1&languageCode=en&productLineName=Disney%20Lorcana&expansionId=1&expansionName=The%20First%20Chapter&profileVersion=2026.06.23&promotionPreviewId=preview-lorcanajson_lorcanajson_lorcana_single-card_reference-data_en_1_2026.06.23_en_1_all_none_filtered-242-242&filter.importScope=en%3A1&filter.providerKey=lorcanajson&commandStatus=success&commandIntent=observation.promote&commandResult=preview-ready",
      scopes: {
        items: [
          sourceObservationScope({
            provider_key: "lorcanajson",
            language_code: "en",
            product_line_id: "",
            product_line_name: "Disney Lorcana",
            series_id: "",
            series_name: "",
            expansion_id: "",
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
      profileReviews: {
        items: profiles,
        total: profiles.length,
        count: profiles.length,
      },
      controlPlaneOverview: overviewForProfiles(profiles, "lorcana"),
      readModelFailures: ["source-observation-review"],
      reviewObservations: null,
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    expect(readModel.routeContext.sourceObservationFilters).toMatchObject({
      providerKey: "lorcanajson",
      importScope: "en:1",
    });
    expect(readModel.sourceObservationReview.pagination.total).toBe(0);
    expect(readModel.sourceObservationReview.freshness).toBe("unavailable");
    expect(readModel.sourceObservationReview.promotionReadyCount).toBe(242);
    expect(readModel.promotionPreview.freshness).toBe("fresh");
    expect(readModel.promotionPreview.executionSafeguards.staleReasons).toEqual([]);
    expect(readModel.promotionPreview.commandPlanHash).toContain("requested:242:eligible:242");
    expect(readModel.actions.find((action) => action.key === "observation.promote")).toMatchObject({
      state: "available",
      blockers: [],
    });
    expect(readModel.sourceScopeWorkset.units.find((unit) => unit.unitKey === unitKey)?.counts.eligible).toBe(242);
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
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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
      buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
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

    const form = sourceScopeCommandForm("scope.import", "tcgplayer:mtg:single-card:source-observation-import");
    const action = new URL(form?.getAttribute("action") ?? "", "https://admin.example");
    expect(action.searchParams.get("providerKey")).toBe("tcgplayer");
    expect(action.searchParams.get("unitKey")).toBe("tcgplayer:mtg:single-card:source-observation-import");
    expect(action.searchParams.get("importScope")).toBe("en:1:Classic Sixth Edition");
    expect(hiddenValue(form, "expansionId")).toBe("");
    expect(hiddenValue(form, "expansionName")).toBe("Classic Sixth Edition");
    expect(hiddenValue(form, "importScope")).toBe("en:1:Classic Sixth Edition");
  });

  it("replaces stale legacy importScope and drops stale review state when a structured set-name selection changes", () => {
    const profile = magicProfile(
      "tcgplayer",
      "TCGplayer Magic Single Cards",
      "tcgplayer:mtg:single-card:source-observation-import",
      "provider-product",
    );
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:mtg:single-card:source-observation-import&importScope=en%3AFifth%20Dawn&productLineId=1&expansionName=Classic%20Sixth%20Edition&profileVersion=2026.06.19&filter.importScope=en%3AFifth%20Dawn&filter.status=changed&selectedObservationIds=obs_old&jobId=job_old&reviewOffset=25&reviewLimit=50&promotionPreviewId=preview_old",
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
    expect(unit.currentWorkbenchHref).not.toContain("filter.status=changed");
    expect(unit.currentWorkbenchHref).not.toContain("selectedObservationIds=obs_old");
    expect(unit.currentWorkbenchHref).not.toContain("jobId=job_old");
    expect(unit.currentWorkbenchHref).not.toContain("reviewOffset=25");
    expect(unit.currentWorkbenchHref).not.toContain("reviewLimit=50");
    expect(unit.currentWorkbenchHref).not.toContain("promotionPreviewId=preview_old");

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    const form = sourceScopeCommandForm("scope.import", "tcgplayer:mtg:single-card:source-observation-import");
    const action = new URL(form?.getAttribute("action") ?? "", "https://admin.example");
    expect(action.searchParams.get("importScope")).toBe("en:1:Classic Sixth Edition");
    expect(action.searchParams.get("filter.importScope")).toBeNull();
    expect(action.searchParams.get("filter.status")).toBeNull();
    expect(action.searchParams.get("selectedObservationIds")).toBeNull();
    expect(action.searchParams.get("jobId")).toBeNull();
    expect(action.searchParams.get("reviewOffset")).toBeNull();
    expect(action.searchParams.get("reviewLimit")).toBeNull();
    expect(action.searchParams.get("promotionPreviewId")).toBeNull();
    expect(action.searchParams.toString()).not.toContain("Fifth+Dawn");
    expect(hiddenValue(form, "importScope")).toBe("en:1:Classic Sixth Edition");
  });

  it("fails closed until a concrete source scope is selected", () => {
    const profiles = magicProfiles();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl: "https://admin.example/catalog/integrations?providerKey=scryfall",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: profiles, total: profiles.length, count: profiles.length },
      controlPlaneOverview: overviewForProfiles(profiles, "mtg"),
      canManageCatalog: true,
    });

    expect(readModel.sourceScopeWorkset.status).toBe("scope-required");
    for (const unit of readModel.sourceScopeWorkset.units) {
      expect(unit.commandContext.importScope).toBeNull();
      expect(new URL(unit.currentWorkbenchHref, "https://admin.example").searchParams.get("importScope")).toBeNull();
      expect(unit.actions.import).toMatchObject({
        state: "disabled",
        blockers: ["import-scope-required"],
      });
    }

    render(<CatalogSourceScopeWorksetModule readModel={readModel} />);

    expect(screen.getByText("Select a source scope")).toBeTruthy();
    const scryfallForm = sourceScopeCommandForm("scope.import", "scryfall:mtg:single-card:reference-data");
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

function lorcanaProfiles(): CatalogProviderProfileVersionReview[] {
  return [
    lorcanaSetNameProfile("lorcanajson", "LorcanaJSON", "lorcanajson:lorcana:single-card:reference-data"),
    lorcanaSetNameProfile("lorcast", "Lorcast Lorcana cards", "lorcast:lorcana:single-card:reference-data"),
    tcgplayerUnitProfile(
      "lorcana-single-card-product-sku",
      "TCGplayer Lorcana Single Cards",
      "tcgplayer:lorcana:single-card:source-observation-import",
      "2026.06.23",
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

function lorcanaSetNameProfile(
  providerKey: "lorcanajson" | "lorcast",
  displayName: string,
  ingestionUnitKey: string,
): CatalogProviderProfileVersionReview {
  return profileReview({
    providerKey,
    profileKey: `${providerKey}-lorcana-card`,
    profileVersion: "2026.06.23",
    ingestionUnitKey,
    displayName,
    active: true,
    lifecycle: "active",
    status: "active",
    connectorKind: `${providerKey}-json`,
    profile: { providerKey, supportedScopes: ["set-name", "product/card"] },
    supportedScopes: ["set-name", "product/card"],
    mappingOutputKind: "lorcana-card-print",
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["set"],
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

function lorcanaSetScopes(): SourceObservationIntegrationScope[] {
  return [
    lorcanaScope("lorcanajson", { observed_observations: 204, changed_observations: 18, promoted_observations: 40 }),
    lorcanaScope("lorcast", { observed_observations: 204, changed_observations: 10, promoted_observations: 0 }),
    lorcanaScope("tcgplayer", { observed_observations: 80, changed_observations: 7, promoted_observations: 48 }),
  ];
}

function lorcanaScope(
  providerKey: "lorcanajson" | "lorcast" | "scrydex" | "tcgplayer",
  counts: Partial<SourceObservationIntegrationScope>,
): SourceObservationIntegrationScope {
  const providerScope =
    providerKey === "tcgplayer"
      ? { product_line_id: "71", expansion_id: "" }
      : { product_line_id: "lorcana", expansion_id: "TFC" };

  return sourceObservationScope({
    provider_key: providerKey,
    language_code: "en",
    product_line_id: providerScope.product_line_id,
    product_line_name: "Disney Lorcana",
    series_id: "",
    series_name: "",
    expansion_id: providerScope.expansion_id,
    expansion_name: "The First Chapter",
    total_observations: 204,
    rejected_observations: 0,
    ...counts,
    latest_source_updated_at: "2026-06-23T12:00:00.000Z",
    latest_observed_at: "2026-06-23T12:05:00.000Z",
    first_observed_at: "2026-06-23T12:00:00.000Z",
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

function scrydexOnePieceSetNameProfile(): CatalogProviderProfileVersionReview {
  return profileReview({
    providerKey: "scrydex",
    profileKey: "scrydex-one-piece-card",
    profileVersion: "2026.06.22",
    ingestionUnitKey: "scrydex:one-piece:single-card:source-observation-import",
    displayName: "Scrydex One Piece Cards",
    active: true,
    lifecycle: "active",
    status: "active",
    connectorKind: "scrydex-json",
    profile: { providerKey: "scrydex", supportedScopes: ["set-name", "product/card"] },
    supportedScopes: ["set-name", "product/card"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["set"],
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

function scrydexLorcanaSetNameProfile(): CatalogProviderProfileVersionReview {
  return profileReview({
    providerKey: "scrydex",
    profileKey: "scrydex-lorcana-card",
    profileVersion: "2026.06.23",
    ingestionUnitKey: "scrydex:lorcana:single-card:source-observation-import",
    displayName: "Scrydex Lorcana cards",
    active: true,
    lifecycle: "active",
    status: "active",
    connectorKind: "scrydex-json",
    profile: { providerKey: "scrydex", supportedScopes: ["set-name", "product/card"] },
    supportedScopes: ["set-name", "product/card"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "sets",
        queryKeySynonyms: ["set"],
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

function tcgplayerUnitProfile(
  profileKey: string,
  displayName: string,
  ingestionUnitKey: string,
  profileVersion: string,
): CatalogProviderProfileVersionReview {
  return profileReview({
    providerKey: "tcgplayer",
    profileKey,
    profileVersion,
    ingestionUnitKey,
    displayName,
    active: true,
    lifecycle: "active",
    status: "active",
    connectorKind: "tcgplayer-automation-client",
    profile: {
      providerKey: "tcgplayer",
      supportedScopes: ["product-line/category", "set-name"],
    },
    supportedScopes: ["product-line/category", "set-name"],
    languageOptions: ["en"],
    sourceOptionKinds: [
      {
        queryKind: "product-lines",
        queryKeySynonyms: ["productLineId"],
        displayName: "Product Line",
        scope: "product-line/category",
        parentScope: null,
        parentRequired: false,
        parentValueKind: null,
        parentDiagnosticText: null,
      },
      {
        queryKind: "set-names",
        queryKeySynonyms: ["setName"],
        displayName: "Set Name",
        scope: "set-name",
        parentScope: "product-line/category",
        parentRequired: true,
        parentValueKind: "product-line-id",
        parentDiagnosticText: "Select Product Line before Set Name.",
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
        usageBudget: null,
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
