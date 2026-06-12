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

describe("Catalog primary workbench read model - import jobs", () => {
  it("summarizes scoped durable import operations and blocks duplicate starts while active", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    expect(readModel.importJobs.selectedScope).toMatchObject({
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:card:import",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      expectedObservationVolume: 142,
      changedCount: 24,
      readiness: {
        adapterReadiness: "ready",
        credentialReadiness: "not-required",
        rolloutEnabled: true,
      },
    });
    expect(readModel.importJobs.activeJobCount).toBe(1);
    expect(readModel.importJobs.jobs[0]).toMatchObject({
      jobId: "job_001",
      state: "running",
      completed: 7,
      total: 24,
      progressPercent: 29,
      retryAvailable: false,
      resumeAvailable: false,
      cancelAvailable: true,
    });
    expect(readModel.importJobs.jobs[0]?.sourceObservationReviewHref).toContain("section=source-observation-review");
    expect(readModel.importJobs.jobs[0]?.sourceObservationReviewHref).toContain("providerKey=tcgdex");
    expect(readModel.importJobs.jobs[0]?.auditEvidenceUrl).toContain("section=evidence");
    expect(readModel.importJobs.jobs[0]?.auditEvidenceUrl).toContain("returnPath=");
    expect(readModel.actions.find((action) => action.key === "start-provider-import")).toMatchObject({
      state: "blocked",
      blockers: ["active-job-conflict"],
    });
  });

  it("groups retryable provider failures and transport blockers for operator recovery", () => {
    const overview = controlPlaneOverview({
      readiness: {
        ...controlPlaneOverview().readiness,
        units: [
          {
            ...controlPlaneOverview().readiness.units[0]!,
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
      unitActivity: {
        ...controlPlaneOverview().unitActivity,
        units: [
          {
            unitKey: "tcgdex:pokemon:card:import",
            recentJobs: [
              {
                ...controlPlaneOverview().unitActivity.units[0]!.recentJobs[0]!,
                operatorStatus: "failed",
                phase: "failed",
                completed: 12,
                total: 24,
              },
            ],
          },
        ],
      },
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: overview,
      canManageCatalog: true,
    });

    expect(readModel.readiness.providerTransport).toContain("timeout");
    expect(readModel.readiness.blockers).toContain("provider-transport-timeout");
    expect(readModel.promotionPreview.blockers).not.toContain("provider-transport-timeout");
    expect(readModel.actions.find((action) => action.key === "execute-promotion")?.blockers).not.toContain(
      "provider-transport-timeout",
    );
    expect(readModel.importJobs.failedJobCount).toBe(1);
    expect(readModel.healthTriage.status).toBe("blocked");
    expect(readModel.healthTriage.recentJobs[0]).toMatchObject({
      phase: "failed",
      ownerMetricKey: "catalog.integration.job.failed",
    });
    expect(readModel.importJobs.jobs[0]).toMatchObject({
      state: "failed",
      retryAvailable: true,
      cancelAvailable: false,
      failureGroups: expect.arrayContaining([
        expect.objectContaining({ key: "durable-job-failed", severity: "error" }),
        expect.objectContaining({ key: "provider-transport-timeout", severity: "error" }),
      ]),
    });
  });

  it("maps stale and cancelled provider import jobs to lifecycle recovery actions", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        unitActivity: {
          ...baseOverview.unitActivity,
          units: [
            {
              unitKey: "tcgdex:pokemon:card:import",
              recentJobs: [
                {
                  ...baseOverview.unitActivity.units[0]!.recentJobs[0]!,
                  jobId: "job_stale",
                  operatorStatus: "stale",
                  phase: "processing",
                },
                {
                  ...baseOverview.unitActivity.units[0]!.recentJobs[0]!,
                  jobId: "job_cancelled",
                  operatorStatus: "cancelled",
                  phase: "failed",
                },
              ],
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    expect(readModel.importJobs.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId: "job_stale",
          state: "running",
          retryAvailable: true,
          resumeAvailable: true,
          cancelAvailable: true,
          blockers: ["stale-replay"],
        }),
        expect.objectContaining({
          jobId: "job_cancelled",
          state: "cancelled",
          retryAvailable: true,
          resumeAvailable: false,
          cancelAvailable: false,
          failureGroups: expect.arrayContaining([
            expect.objectContaining({ key: "durable-job-cancelled", severity: "warning" }),
          ]),
        }),
      ]),
    );
  });

  it("distinguishes concurrent durable jobs from a single active job conflict", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        unitActivity: {
          ...baseOverview.unitActivity,
          units: [
            {
              unitKey: "tcgdex:pokemon:card:import",
              recentJobs: [
                baseOverview.unitActivity.units[0]!.recentJobs[0]!,
                {
                  ...baseOverview.unitActivity.units[0]!.recentJobs[0]!,
                  jobId: "job_002",
                  phase: "fetching",
                },
              ],
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    expect(readModel.importJobs.activeJobCount).toBe(2);
    expect(readModel.actions.find((action) => action.key === "start-provider-import")?.blockers).toEqual([
      "active-job-conflict",
      "concurrent-job",
    ]);
  });
});
