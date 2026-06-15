import {
  buildCatalogPrimaryWorkbenchReadModel,
  buildCatalogPrimaryWorkbenchReadModelForSurface,
  controlPlaneOverview,
  describe,
  expect,
  it,
  profileAuthoringModel,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
  validateCatalogPrimaryWorkbenchReadModelContract,
} from "./primary-workbench-read-model-test-support";

// Inputs rich enough that every supporting slice has real provider data to render,
// so a per-surface slice that matches the full builder proves it computed that
// slice from the same inputs (rather than collapsing to an empty default).
function fullSurfaceInput(section: string) {
  const profile = profileReview({ active: true, lifecycle: "active" });

  return {
    requestUrl: `https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.04&filter.status=changed&section=${section}`,
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: { items: [profile], total: 1, count: 1 },
    profileAuthoringModel: profileAuthoringModel({ review: profile }),
    controlPlaneOverview: controlPlaneOverview(),
    reviewObservations: {
      items: [sourceObservationListItem({ observation_id: "obs_001", status: "changed", provider_key: "tcgdex" })],
      total: 1,
      count: 1,
    },
    reviewPagination: { limit: 25, offset: 0 },
    canManageCatalog: true,
  };
}

// The action command buttons the daily import-to-promotion surface actually
// renders. The daily read model only needs these action states (plus the core
// review/promotion slices); the lifecycle, clone, and activate action entries are
// present in the array but never surfaced on the daily route.
const dailyRenderedActionKeys = [
  "select-provider-scope",
  "start-provider-import",
  "select-source-observations",
  "preview-promotion",
  "execute-promotion",
  "reject-source-observations",
  "defer-source-observations",
  "start-reapply",
  "start-replay",
] as const;

describe("Catalog primary workbench read model - per-surface slicing", () => {
  it("validates a read model for every audience surface route", () => {
    for (const surface of ["daily", "providers", "governance", "release"] as const) {
      const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface(surface, fullSurfaceInput("workbench"));
      expect(() => validateCatalogPrimaryWorkbenchReadModelContract(readModel)).not.toThrow();
    }
  });

  it("builds the daily surface without computing governance, lifecycle, release, or audit data", () => {
    // The daily surface drops the authoring-model, lifecycle-impact, and overview
    // inputs that the supporting slices feed on; supplying them but asking for the
    // daily surface must still collapse the supporting slices to their cheap
    // unavailable defaults instead of rendering provider data.
    const daily = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", fullSurfaceInput("workbench"));

    // Every overview-gated supporting slice fell back to its overview-absent
    // default: lifecycle recovery surfaces no provider audit events, governance
    // is only partially fresh, audit evidence reports a missing projection, and
    // validation/profile authoring never saw the authoring model.
    expect(daily.lifecycleRecovery.freshness).not.toBe("fresh");
    expect(daily.lifecycleRecovery.recentAuditEvents).toEqual([]);
    expect(daily.governanceControls.freshness).toBe("partial");
    expect(daily.auditEvidence.projectionState.missingProjection).toBe(true);
    expect(daily.validationReadiness.freshness).not.toBe("fresh");
  });

  it("keeps the daily core slices and rendered action states identical to the full read model", () => {
    const input = fullSurfaceInput("workbench");
    const full = buildCatalogPrimaryWorkbenchReadModel(input);
    const daily = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", input);

    for (const slice of [
      "routeContext",
      "providerScope",
      "sourceOptions",
      "readiness",
      "importJobs",
      "sourceObservationReview",
      "promotionPreview",
      "securityPrivacy",
      "deploySkew",
      "promotionResult",
    ] as const) {
      expect(daily[slice], `core slice ${slice}`).toEqual(full[slice]);
    }
    for (const key of dailyRenderedActionKeys) {
      expect(
        daily.actions.find((action) => action.key === key),
        `daily action ${key}`,
      ).toEqual(full.actions.find((action) => action.key === key));
    }
  });

  it("computes the providers surface slices identically to the full read model", () => {
    const input = fullSurfaceInput("profile-work");
    const full = buildCatalogPrimaryWorkbenchReadModel(input);
    const providers = buildCatalogPrimaryWorkbenchReadModelForSurface("providers", input);

    expect(providers.profileAuthoring).toEqual(full.profileAuthoring);
    expect(providers.validationReadiness).toEqual(full.validationReadiness);
    expect(providers.profileAuthoring.status).toBe("ready");
  });

  it("computes the governance surface slices identically to the full read model", () => {
    const input = fullSurfaceInput("conflicts");
    const full = buildCatalogPrimaryWorkbenchReadModel(input);
    const governance = buildCatalogPrimaryWorkbenchReadModelForSurface("governance", input);

    expect(governance.conflictResolution).toEqual(full.conflictResolution);
    expect(governance.lifecycleRecovery).toEqual(full.lifecycleRecovery);
    expect(governance.governanceControls).toEqual(full.governanceControls);
  });

  it("computes the release surface slices identically to the full read model", () => {
    const input = fullSurfaceInput("evidence");
    const full = buildCatalogPrimaryWorkbenchReadModel(input);
    const release = buildCatalogPrimaryWorkbenchReadModelForSurface("release", input);

    expect(release.cleanResetRelease).toEqual(full.cleanResetRelease);
    expect(release.auditEvidence).toEqual(full.auditEvidence);
    expect(release.healthTriage).toEqual(full.healthTriage);
  });
});
