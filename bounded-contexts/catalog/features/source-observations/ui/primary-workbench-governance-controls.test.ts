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

describe("Catalog primary workbench read model - governance controls", () => {
  it("models governance controls for view-only RBAC while preserving deletion evidence", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=controls",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: false,
    });

    expect(readModel.governanceControls.status).toBe("blocked");
    expect(readModel.governanceControls.rbacMatrix).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionKey: "scope.import",
          requiredPermission: "catalog.manage",
          state: "denied",
          blockers: ["permission-denied"],
          deniedCopy: expect.stringContaining("catalog.manage is required"),
        }),
      ]),
    );
    expect(readModel.governanceControls.legacyRemovalEvidence).toMatchObject({
      status: "removed",
      requiredDisposition: "complete-removal",
    });
    expect(readModel.governanceControls.legacyRemovalEvidence.removedSurfaces).toEqual(
      expect.arrayContaining(["runtime code", "product patterns", "tests", "fixtures", "documentation", "runbooks"]),
    );
  });

  it("models kill-switch blocked workflows with worker pause and alert/runbook evidence", () => {
    const baseOverview = controlPlaneOverview();
    const controls = [
      {
        controlId: "catalog-import-launch-stop",
        defaultState: "quarantined" as const,
        status: "blocked" as const,
        severity: "error" as const,
        capabilities: ["source-observation-import"],
        providerKeys: ["tcgdex"],
        profileKeys: ["tcgdex-pokemon-card"],
        unitKeys: ["tcgdex:pokemon:card:import"],
        message: "Catalog integration imports stopped by launch kill switch.",
        auditEventName: "rollout-control-denied" as const,
        metricKey: "catalog.integration.rollout.stop",
      },
      {
        controlId: "catalog-promotion-launch-stop",
        defaultState: "quarantined" as const,
        status: "blocked" as const,
        severity: "error" as const,
        capabilities: ["promotion"],
        providerKeys: ["tcgdex"],
        profileKeys: ["tcgdex-pokemon-card"],
        unitKeys: ["tcgdex:pokemon:card:import"],
        message: "Catalog promotion stopped by launch kill switch.",
        auditEventName: "rollout-control-denied" as const,
        metricKey: "catalog.integration.promotion.stop",
      },
      {
        controlId: "catalog-reapply-launch-stop",
        defaultState: "quarantined" as const,
        status: "blocked" as const,
        severity: "error" as const,
        capabilities: ["reapply", "replay"],
        providerKeys: ["tcgdex"],
        profileKeys: ["tcgdex-pokemon-card"],
        unitKeys: ["tcgdex:pokemon:card:import"],
        message: "Catalog reapply and replay stopped by launch kill switch.",
        auditEventName: "rollout-control-denied" as const,
        metricKey: "catalog.integration.reapply.stop",
      },
    ];
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&section=controls",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        readiness: {
          ...baseOverview.readiness,
          rolloutControls: {
            generatedAt: baseOverview.generatedAt,
            controls,
          },
        },
      }),
      canManageCatalog: true,
    });

    expect(readModel.governanceControls.rolloutMode).toMatchObject({
      state: "stopped",
      workerState: "paused",
      importKillSwitchActive: true,
      promotionKillSwitchActive: true,
      reapplyKillSwitchActive: true,
    });
    expect(readModel.governanceControls.controls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "provider-emergency-stop", blockers: ["kill-switch-active"] }),
        expect.objectContaining({ kind: "worker-pause", status: "blocked" }),
      ]),
    );
    expect(readModel.actions.find((action) => action.key === "scope.import")?.blockers).toContain("kill-switch-active");
    expect(readModel.governanceControls.observability.signals[0]?.alertLinks[0]?.href).toBe(
      "https://grafana.chasesets.com/d/chase-sets-catalog-control-plane/catalog-integration-control-plane",
    );
    expect(readModel.governanceControls.observability.signals[0]?.runbookLinks[0]?.href).toBe(
      "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/catalog-integration-operations.md",
    );
  });

  it("marks stale governance observability data as degraded or unavailable", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=controls",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.governanceControls.freshness).toBe("partial");
    expect(readModel.governanceControls.observability.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "option-query-latency", stale: true, status: "unavailable" }),
        expect.objectContaining({ key: "projection-freshness", stale: true, status: "unavailable" }),
        expect.objectContaining({ key: "source-observation-quarantine", stale: true, status: "degraded" }),
      ]),
    );
    expect(
      readModel.governanceControls.observability.signals.filter((signal) => signal.stale && signal.status === "ready"),
    ).toHaveLength(0);
  });
});
