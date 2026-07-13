import {
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
    for (const surface of ["daily", "governance", "health"] as const) {
      const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface(surface, fullSurfaceInput("workbench"));
      expect(() => validateCatalogPrimaryWorkbenchReadModelContract(readModel)).not.toThrow();
    }
  });

  it("keeps every control-plane provider selectable when daily profile reviews are selected-provider scoped", () => {
    const base = fullSurfaceInput("workbench");
    const overview = controlPlaneOverview();
    const tcgdexUnit = overview.readiness.units[0]!;
    const tcgdexProvider = overview.providerReadiness.providers[0]!;
    const referenceProofUnitKey = "reference-cards:pokemon:single-card:source-observation-proof";
    const tcgplayerUnitKey = "tcgplayer:pokemon:single-card:source-observation-import";
    const scrydexUnitKey = "scrydex:one-piece:single-card:source-observation-import";
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("daily", {
      ...base,
      // Staging can trim the daily profile review payload to the selected
      // provider, but the provider dropdown still needs the provider readiness
      // inventory so operators can switch to the other integration profiles.
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      controlPlaneOverview: {
        ...overview,
        readiness: {
          ...overview.readiness,
          units: [
            tcgdexUnit,
            {
              ...tcgdexUnit,
              unitKey: referenceProofUnitKey,
              providerKey: "reference-cards",
              displayName: "Reference Pokemon single-card Source Observation proof",
              ingestionPurpose: "proof",
            },
            {
              ...tcgdexUnit,
              unitKey: tcgplayerUnitKey,
              providerKey: "tcgplayer",
              displayName: "TCGplayer Pokemon products",
              productDomain: "pokemon",
              productForm: "single-card",
              profileVersion: "2026.06.03",
            },
            {
              ...tcgdexUnit,
              unitKey: scrydexUnitKey,
              providerKey: "scrydex",
              displayName: "Scrydex One Piece cards",
              productDomain: "one-piece",
              productForm: "single-card",
              profileVersion: "2026.06.22",
            },
          ],
        },
        providerReadiness: {
          ...overview.providerReadiness,
          providers: [
            tcgdexProvider,
            {
              ...tcgdexProvider,
              providerKey: "reference-cards",
              adapterKey: "reference-cards",
              unitKeys: [referenceProofUnitKey],
            },
            { ...tcgdexProvider, providerKey: "tcgplayer", adapterKey: "tcgplayer", unitKeys: [tcgplayerUnitKey] },
            { ...tcgdexProvider, providerKey: "scrydex", adapterKey: "scrydex", unitKeys: [scrydexUnitKey] },
          ],
        },
      },
    });

    expect(readModel.providerScope.providers.map((provider) => provider.providerKey)).toEqual([
      "scrydex",
      "tcgdex",
      "tcgplayer",
    ]);
    const tcgplayerProvider = readModel.providerScope.providers.find(
      (provider) => provider.providerKey === "tcgplayer",
    );
    expect(tcgplayerProvider).toMatchObject({
      displayName: "TCGplayer Pokemon products",
      units: [{ unitKey: tcgplayerUnitKey, productDomain: "pokemon", productForm: "single-card" }],
    });
    expect(tcgplayerProvider?.units[0]?.activeProfile).toBeNull();
    expect(readModel.providerScope.providers.find((provider) => provider.providerKey === "scrydex")).toMatchObject({
      displayName: "Scrydex One Piece cards",
      units: [{ unitKey: scrydexUnitKey, productDomain: "one-piece", productForm: "single-card" }],
    });
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
    expect(daily.profileAuthoring.status).toBe("missing-profile");
    expect(daily.profileAuthoring.availableProfiles).toEqual([]);
    expect(daily.profileAuthoring.sectionWorkspaces).toEqual([]);
    expect(daily.validationReadiness.fixtureFlows).toEqual([]);
    expect(daily.validationReadiness.dryRunEvidence).toEqual([]);
    expect(daily.validationReadiness.semanticCompare.sections).toEqual([]);
  });

  it("keeps the daily core slices and rendered action states identical to the full read model", () => {
    const input = fullSurfaceInput("workbench");
    // The health surface renders every supporting slice, so it computes the
    // complete read model — the reference the other surfaces are compared against.
    const full = buildCatalogPrimaryWorkbenchReadModelForSurface("health", input);
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

  it("computes the governance surface's profile/validation slices identically to the full read model (#3832: the retired providers surface's slices, now the v2 Provider detail page's loader input)", () => {
    const input = fullSurfaceInput("profile-work");
    // The health surface renders every supporting slice, so it computes the
    // complete read model — the reference the other surfaces are compared against.
    // "providers" was retired by #3832; the profile-authoring/validation-readiness
    // slices it used to own now feed only the v2 Provider detail page, which
    // composes from "governance"/"health" (see provider-detail-loader.ts) — so
    // this test compares "governance" (the cheaper of the two surfaces that still
    // computes both slices with real data) instead.
    const full = buildCatalogPrimaryWorkbenchReadModelForSurface("health", input);
    const governance = buildCatalogPrimaryWorkbenchReadModelForSurface("governance", input);

    expect(governance.profileAuthoring).toEqual(full.profileAuthoring);
    expect(governance.validationReadiness).toEqual(full.validationReadiness);
    expect(governance.profileAuthoring.status).toBe("ready");
  });

  it("computes the governance surface slices identically to the full read model", () => {
    const input = fullSurfaceInput("conflicts");
    const full = buildCatalogPrimaryWorkbenchReadModelForSurface("health", input);
    const governance = buildCatalogPrimaryWorkbenchReadModelForSurface("governance", input);

    expect(governance.conflictResolution).toEqual(full.conflictResolution);
    expect(governance.lifecycleRecovery).toEqual(full.lifecycleRecovery);
    expect(governance.governanceControls).toEqual(full.governanceControls);
  });
});
