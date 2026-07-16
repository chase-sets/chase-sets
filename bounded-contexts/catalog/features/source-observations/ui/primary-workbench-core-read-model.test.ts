import {
  buildCatalogPrimaryWorkbenchReadModel,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
  catalogProviderProfileEditableSectionKeys,
  cleanVerificationReport,
  controlPlaneOverview,
  describe,
  expect,
  integrationJobSummary,
  it,
  jsonClone,
  lifecycleImpact,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
  tcgdexPokemonCardSourceObservationMappingContract,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  validateCatalogPrimaryWorkbenchReadModelContract,
  type CatalogProviderIntegrationProfile,
} from "./primary-workbench-read-model-test-support";

describe("Catalog primary workbench read model - core composition", () => {
  it("builds a validated #1060 read model from typed Catalog admin data", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(() => validateCatalogPrimaryWorkbenchReadModelContract(readModel)).not.toThrow();
    expect(readModel.routeContext).toMatchObject({
      section: "import-to-promotion",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      sourceObservationFilters: {
        providerKey: "tcgdex",
        status: "changed",
      },
    });
    expect(readModel.sourceObservationReview.counts).toMatchObject({
      observed: 100,
      changed: 24,
      promoted: 16,
      eligible: 124,
    });
    expect(readModel.actions.find((action) => action.key === "observation.promote")).toMatchObject({
      state: "available",
      blockers: [],
    });
  });

  it("fails closed when manage permission or active profile is missing", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [], total: 0, count: 0 },
      controlPlaneOverview: null,
      canManageCatalog: false,
    });

    expect(readModel.readiness.blockers).toEqual(["permission-denied", "missing-active-profile"]);
    expect(readModel.actions.find((action) => action.key === "scope.import")).toMatchObject({
      state: "blocked",
      blockers: ["permission-denied"],
    });
    expect(readModel.deploySkew.forbiddenFallbacks).not.toContain("compatibility redirect");
  });

  it("does not treat draft or test profiles as active import readiness", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: false, lifecycle: "test" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.routeContext.profileVersion).toBeNull();
    expect(readModel.readiness.blockers).toContain("missing-active-profile");
    expect(readModel.actions.find((action) => action.key === "scope.import")).toMatchObject({
      state: "blocked",
      blockers: ["missing-active-profile"],
    });
  });

  it("blocks provider import until a concrete source scope is selected", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.importJobs.selectedScope).toBeNull();
    expect(readModel.actions.find((action) => action.key === "scope.import")).toMatchObject({
      state: "blocked",
      blockers: ["import-scope-required"],
      copyKey: "catalog.primary.providerScope.required",
    });
  });

  it("exposes each active Magic TCGplayer profile unit in the provider scope", () => {
    const singleCardUnit = "tcgplayer:mtg:single-card:source-observation-import";
    const sealedProductUnit = "tcgplayer:mtg:sealed-product:source-observation-import";
    const singleCardProfile = profileReview({
      providerKey: "tcgplayer",
      profileKey: "mtg-single-card-product-sku",
      profileVersion: "2026.06.19",
      ingestionUnitKey: singleCardUnit,
      displayName: "TCGplayer Magic single-card SKUs",
      active: true,
      lifecycle: "active",
      supportedScopes: ["mtg/single-card"],
    });
    const sealedProductProfile = profileReview({
      providerKey: "tcgplayer",
      profileKey: "mtg-sealed-product-sku",
      profileVersion: "2026.06.19",
      ingestionUnitKey: sealedProductUnit,
      displayName: "TCGplayer Magic sealed-product SKUs",
      active: true,
      lifecycle: "active",
      supportedScopes: ["mtg/sealed-product"],
    });

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=tcgplayer:mtg:sealed-product:source-observation-import&profileVersion=2026.06.19",
      scopes: { items: [], total: 0, count: 0 },
      profileReviews: { items: [singleCardProfile, sealedProductProfile], total: 2, count: 2 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });
    const tcgplayerProvider = readModel.providerScope.providers.find(
      (provider) => provider.providerKey === "tcgplayer",
    );

    expect(() => validateCatalogPrimaryWorkbenchReadModelContract(readModel)).not.toThrow();
    expect(readModel.routeContext).toMatchObject({
      providerKey: "tcgplayer",
      unitKey: sealedProductUnit,
      profileVersion: "2026.06.19",
    });
    expect(readModel.sourceOptions.selectedProfile).toMatchObject({
      profileKey: "mtg-sealed-product-sku",
    });
    expect(readModel.sourceOptions.selectedUnitKey).toBe(sealedProductUnit);
    expect(tcgplayerProvider).toMatchObject({
      displayName: "TCGplayer",
    });
    expect(tcgplayerProvider?.units.map((unit) => unit.unitKey).sort()).toEqual(
      [sealedProductUnit, singleCardUnit].sort(),
    );
    expect(
      Object.fromEntries(tcgplayerProvider?.units.map((unit) => [unit.unitKey, unit.activeProfile?.profileKey]) ?? []),
    ).toEqual({
      [sealedProductUnit]: "mtg-sealed-product-sku",
      [singleCardUnit]: "mtg-single-card-product-sku",
    });
  });
});
