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

describe("Catalog primary workbench read model - health triage", () => {
  it("keeps degraded health triage owner metrics for warning diagnostics and unavailable audit projection", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
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
              diagnosticCounts: { info: 0, warning: 1, error: 0 },
              diagnostics: [
                {
                  code: "semantic-warning",
                  severity: "warning",
                  message: "Catalog semantic readiness needs operator review before promotion.",
                  unitKey: "tcgdex:pokemon:card:import",
                  retryAfterSeconds: null,
                  source: "catalog",
                },
              ],
              latestDiagnosticText: "Catalog semantic readiness needs operator review before promotion.",
            },
          ],
        },
        auditLifecycle: {
          ...baseOverview.auditLifecycle,
          projectionStatus: "unavailable",
          statusMessage: "Audit lifecycle projection is unavailable.",
        },
      }),
      canManageCatalog: true,
    });

    expect(readModel.healthTriage.status).toBe("degraded");
    expect(readModel.healthTriage.units[0]).toMatchObject({
      status: "degraded",
      ownerMetricKey: "catalog.integration.semantic_readiness.diagnostic.warning",
      affectedPrimaryAction: "review-source-observations",
    });
    expect(
      readModel.healthTriage.readModels.find((state) => state.queryKey === "audit-evidence-timeline"),
    ).toMatchObject({
      freshness: "unavailable",
      statusMessage: "Audit lifecycle projection is unavailable.",
    });
  });

  it("projects provider usage budget metadata through the shared provider readiness interface", () => {
    const baseOverview = controlPlaneOverview();
    const baseUnit = baseOverview.readiness.units[0]!;
    const baseProvider = baseOverview.providerReadiness.providers[0]!;
    const onePieceUnitKey = "scrydex:one-piece:single-card:source-observation-import";
    const pokemonUnitKey = "tcgdex:pokemon:single-card:source-observation-import";
    const magicUnitKey = "scryfall:magic:single-card:source-observation-import";
    const overview = controlPlaneOverview({
      readiness: {
        ...baseOverview.readiness,
        units: [
          {
            ...baseUnit,
            unitKey: pokemonUnitKey,
            providerKey: "tcgdex",
            displayName: "TCGdex Pokemon cards",
            productDomain: "pokemon",
            productForm: "single-card",
          },
          {
            ...baseUnit,
            unitKey: magicUnitKey,
            providerKey: "scryfall",
            displayName: "Scryfall Magic cards",
            productDomain: "magic",
            productForm: "single-card",
          },
          {
            ...baseUnit,
            unitKey: onePieceUnitKey,
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
            providerKey: "tcgdex",
            adapterKey: "tcgdex",
            unitKeys: [pokemonUnitKey],
            usageBudget: null,
          },
          {
            ...baseProvider,
            providerKey: "scryfall",
            adapterKey: "scryfall",
            unitKeys: [magicUnitKey],
            usageBudget: null,
          },
          {
            ...baseProvider,
            providerKey: "scrydex",
            adapterKey: "scrydex",
            readiness: "degraded",
            unitKeys: [onePieceUnitKey],
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
    });

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: `https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=${onePieceUnitKey}&section=triage`,
      scopes: {
        items: [
          sourceObservationScope({ provider_key: "tcgdex", product_line_name: "Pokemon" }),
          sourceObservationScope({ provider_key: "scryfall", product_line_id: "magic", product_line_name: "Magic" }),
          sourceObservationScope({
            provider_key: "scrydex",
            product_line_id: "one-piece",
            product_line_name: "One Piece",
          }),
        ],
        total: 3,
        count: 3,
      },
      profileReviews: { items: [], total: 0, count: 0 },
      controlPlaneOverview: overview,
      canManageCatalog: true,
    });

    expect(readModel.healthTriage.providers.map((provider) => provider.providerKey)).toEqual([
      "tcgdex",
      "scryfall",
      "scrydex",
    ]);
    expect(readModel.healthTriage.providers.find((provider) => provider.providerKey === "scrydex")).toMatchObject({
      usageBudget: {
        creditBalance: 980,
        creditUnit: "credits",
        readiness: "degraded",
        estimatedCalls: 4,
        estimatedScope: "bulk import",
      },
    });
    expect(readModel.healthTriage.providers.find((provider) => provider.providerKey === "tcgdex")?.usageBudget).toBe(
      null,
    );
    expect(readModel.healthTriage.providers.find((provider) => provider.providerKey === "scryfall")?.usageBudget).toBe(
      null,
    );
    expect(readModel.providerScope.providers.find((provider) => provider.providerKey === "scrydex")).toMatchObject({
      units: [{ unitKey: onePieceUnitKey, productDomain: "one-piece", productForm: "single-card" }],
    });
    expect(() => validateCatalogPrimaryWorkbenchReadModelContract(readModel)).not.toThrow();
  });

  it("does not report a present-but-old overview as fresh, and preserves its real generated-at provenance", () => {
    const overview = controlPlaneOverview({ generatedAt: "2000-01-01T00:00:00.000Z" });

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: overview,
      canManageCatalog: true,
      now: "2026-06-09T01:05:00.000Z",
    });

    expect(readModel.healthTriage.freshness).toBe("unavailable");
    expect(readModel.healthTriage.generatedAt).toBe("2000-01-01T00:00:00.000Z");
  });

  it("reports an absent overview as unavailable rather than fabricating a fresh reading", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
      now: "2026-06-09T01:05:00.000Z",
    });

    expect(readModel.healthTriage.freshness).toBe("unavailable");
    expect(readModel.healthTriage.generatedAt).toBe("2026-06-09T01:05:00.000Z");
  });

  it("reports a genuinely fresh overview as fresh (negative control)", () => {
    const overview = controlPlaneOverview({ generatedAt: "2026-06-09T01:04:58.000Z" });

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: overview,
      canManageCatalog: true,
      now: "2026-06-09T01:05:00.000Z",
    });

    expect(readModel.healthTriage.freshness).toBe("fresh");
    expect(readModel.healthTriage.generatedAt).toBe("2026-06-09T01:04:58.000Z");
  });
});
