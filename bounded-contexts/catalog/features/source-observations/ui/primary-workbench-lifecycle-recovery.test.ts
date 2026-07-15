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

describe("Catalog primary workbench read model - lifecycle recovery", () => {
  it("models blocked profile retirement with active references and jobs", () => {
    const profile = profileReview({ active: true, lifecycle: "active", referenceCount: 2 });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&profileVersion=2026.06.04&section=lifecycle",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      lifecycleImpacts: {
        retire: lifecycleImpact("retire", {
          referencedObservationCount: 2,
          sourceProfileReferenceCount: 1,
          impactedJobCount: 1,
          allowed: false,
          blockers: [
            {
              code: "profile-lifecycle-active-jobs",
              severity: "error",
              diagnosticText: "Active lifecycle jobs block retirement.",
              path: "jobs.active",
              providerKey: "tcgdex",
              adapterKey: null,
              unitKey: "tcgdex:pokemon:card:import",
              source: "catalog",
            },
            {
              code: "profile-retirement-referenced-observations",
              severity: "error",
              diagnosticText: "Source Observation references block retirement.",
              path: "profileVersion.references",
              providerKey: "tcgdex",
              adapterKey: null,
              unitKey: "tcgdex:pokemon:card:import",
              source: "catalog",
            },
          ],
        }),
      },
      canManageCatalog: true,
    });

    const retirement = readModel.lifecycleRecovery.operations.find((operation) => operation.operation === "retire");

    expect(readModel.lifecycleRecovery.status).toBe("blocked");
    expect(retirement).toMatchObject({
      state: "blocked",
      allowed: false,
      blockers: expect.arrayContaining([
        "profile-lifecycle-conflict",
        "profile-retirement-references",
        "active-job-conflict",
      ]),
      impact: {
        referencedObservationCount: 2,
        sourceProfileReferenceCount: 1,
        impactedJobCount: 1,
      },
    });
    expect(readModel.lifecycleRecovery.strictRetirement.summary).toMatch(
      /removes its mapping and promotion behavior entirely/i,
    );
    expect(readModel.lifecycleRecovery.strictRetirement.summary).not.toMatch(
      /runbooks|release notes|operator instructions/i,
    );
    expect(readModel.actions.find((action) => action.key === "provider-profile.retire")).toMatchObject({
      state: "blocked",
      blockers: expect.arrayContaining(["profile-retirement-references"]),
    });
  });

  it("models successful profile retirement for inactive unreferenced candidates", () => {
    const activeProfile = profileReview({ active: true, lifecycle: "active", profileVersion: "2026.06.04" });
    const deprecatedProfile = profileReview({
      active: false,
      lifecycle: "deprecated",
      profileVersion: "2026.06.03",
      referenceCount: 0,
    });
    const overview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&profileVersion=2026.06.03&section=lifecycle",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [activeProfile, deprecatedProfile], total: 2, count: 2 },
      controlPlaneOverview: {
        ...overview,
        unitActivity: {
          ...overview.unitActivity,
          units: overview.unitActivity.units.map((unit) => ({ ...unit, recentJobs: [] })),
        },
      },
      lifecycleImpacts: {
        retire: lifecycleImpact("retire", {
          profile: {
            ...lifecycleImpact("retire").profile,
            profileVersion: "2026.06.03",
            lifecycle: "deprecated",
            active: false,
          },
        }),
      },
      canManageCatalog: true,
    });

    const retirement = readModel.lifecycleRecovery.operations.find((operation) => operation.operation === "retire");

    expect(retirement).toMatchObject({
      state: "available",
      allowed: true,
      blockers: [],
      providerKey: "tcgdex",
      profileVersion: "2026.06.03",
      confirmationRequired: true,
      commandKey: "provider-profile.retire",
    });
    expect(readModel.actions.find((action) => action.key === "provider-profile.retire")).toMatchObject({
      state: "available",
      blockers: [],
    });
  });

  it("denies lifecycle recovery actions for view-only operators", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&profileVersion=2026.06.04&section=lifecycle",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: false,
    });

    expect(readModel.lifecycleRecovery.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "retire",
          state: "denied",
          blockers: expect.arrayContaining(["permission-denied"]),
        }),
        expect.objectContaining({
          operation: "rollback",
          state: "denied",
          blockers: expect.arrayContaining(["permission-denied"]),
        }),
      ]),
    );
  });
});
