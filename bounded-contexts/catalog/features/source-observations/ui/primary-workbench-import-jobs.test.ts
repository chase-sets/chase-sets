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
import { parseCatalogPrimaryWorkbenchRouteContext } from "./primary-workbench-route-context";

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
      scope: {
        providerKey: "tcgdex",
        languageCode: "en",
        productLineId: "3",
        seriesId: "base",
        expansionId: "base1",
      },
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
    // Audit evidence is the default workspace of the health surface, so its href is
    // the canonical /health route and carries no redundant ?section= param.
    expect(readModel.importJobs.jobs[0]?.auditEvidenceUrl).toContain("/catalog/integrations/health");
    expect(readModel.importJobs.jobs[0]?.auditEvidenceUrl).not.toContain("section=");
    expect(readModel.importJobs.jobs[0]?.auditEvidenceUrl).toContain("returnPath=");
    expect(readModel.actions.find((action) => action.key === "scope.import")).toMatchObject({
      state: "blocked",
      blockers: ["active-job-conflict"],
    });
  });

  it("reports completed job result counts for the selected scope", () => {
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
                integrationJobSummary({
                  phase: "completed",
                  operatorStatus: "completed",
                  completed: 3,
                  total: 3,
                  result: {
                    requested: 3,
                    imported: 1,
                    observed: 142,
                    reapplied: 0,
                    skipped: 1,
                    failed: 1,
                    outcomeCount: 3,
                    redactedFailureReasons: [
                      "Catalog provider 'scrydex' source observation normalization failed at normalized.imageUrls.",
                    ],
                  },
                }),
              ],
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    expect(readModel.importJobs.jobs[0]?.result).toMatchObject({
      requestedScope: {
        providerKey: "tcgdex",
        languageCode: "en",
        productLineId: "3",
        seriesId: "base",
        expansionId: "base1",
      },
      requestedCount: 3,
      importedSetCount: 1,
      observedCount: 142,
      reappliedCount: 0,
      skippedCount: 1,
      failedCount: 1,
      redactedFailureReasons: [
        "Catalog provider 'scrydex' source observation normalization failed at normalized.imageUrls.",
      ],
      replayOrReapplyState: "not-applicable",
    });
  });

  it("links completed LorcanaJSON jobs to a clean structured set review scope", () => {
    const unitKey = "lorcanajson:lorcana:single-card:reference-data";
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=lorcanajson&unitKey=lorcanajson:lorcana:single-card:reference-data&importScope=en%3A1&filter.status=changed&selectedObservationIds=obs_old&promotionPreviewId=preview_old&reviewOffset=25&jobId=job_old",
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
            profileKey: "lorcanajson-lorcana-single-card",
            profileVersion: "2026.06.23",
            ingestionUnitKey: unitKey,
            displayName: "LorcanaJSON Disney Lorcana cards",
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
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: controlPlaneOverview({
        readiness: {
          ...baseOverview.readiness,
          units: [
            {
              ...baseOverview.readiness.units[0]!,
              unitKey,
              providerKey: "lorcanajson",
              displayName: "LorcanaJSON Disney Lorcana cards",
              productDomain: "lorcana",
              productForm: "single-card",
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
                  jobId: "job_lorcana_first_chapter",
                  operatorStatus: "completed",
                  phase: "completed",
                  completed: 242,
                  total: 242,
                  unitKey,
                  providerKey: "lorcanajson",
                  importScope: "en:1",
                  profileVersion: "2026.06.23",
                  profileSnapshot: {
                    schemaVersion: "catalog-provider-profile-version-v1",
                    compatibilityPolicy: "provider-profile-version",
                    providerKey: "lorcanajson",
                    profileKey: "lorcanajson-lorcana-single-card",
                    profileVersion: "2026.06.23",
                    lifecycle: "active",
                    active: true,
                    connectorKind: "lorcanajson-json",
                    connectorSourceVersion: null,
                    sourceMappingFingerprint: "sha256:lorcanajson-lorcana",
                  },
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
      canManageCatalog: true,
    });

    const reviewHref = readModel.importJobs.jobs[0]?.sourceObservationReviewHref;
    expect(reviewHref).toBeDefined();

    const href = new URL(reviewHref ?? "", "https://admin.example");
    expect(href.searchParams.get("section")).toBe("source-observation-review");
    expect(href.searchParams.get("providerKey")).toBe("lorcanajson");
    expect(href.searchParams.get("unitKey")).toBe(unitKey);
    expect(href.searchParams.get("importScope")).toBe("en:1");
    expect(href.searchParams.get("languageCode")).toBe("en");
    expect(href.searchParams.get("expansionId")).toBe("1");
    expect(href.searchParams.get("expansionName")).toBe("The First Chapter");
    expect(href.searchParams.get("productLineId")).toBeNull();
    expect(href.searchParams.get("filter.status")).toBeNull();
    expect(href.searchParams.get("selectedObservationIds")).toBeNull();
    expect(href.searchParams.get("reviewOffset")).toBeNull();
    expect(href.searchParams.get("reviewLimit")).toBeNull();
    expect(href.searchParams.get("promotionPreviewId")).toBeNull();

    const reviewQuery = new URLSearchParams(
      buildCatalogPrimaryWorkbenchSourceObservationReviewQuery(parseCatalogPrimaryWorkbenchRouteContext(href)) ?? "",
    );
    expect(reviewQuery.get("provider")).toBe("lorcanajson");
    expect(reviewQuery.get("language")).toBe("en");
    expect(reviewQuery.get("expansionId")).toBe("1");
    expect(reviewQuery.get("setId")).toBe("1");
    expect(reviewQuery.get("productLineId")).toBeNull();
  });

  it("matches native TCGdex scope rows case-insensitively without falling back to provider-wide totals", () => {
    const baseOverview = controlPlaneOverview();
    const matched = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&importScope=ja:SV:SV8",
      scopes: {
        items: [
          sourceObservationScope({
            language_code: "ja",
            product_line_id: "",
            series_id: "sv",
            expansion_id: "sv8",
            total_observations: 130,
            observed_observations: 130,
            changed_observations: 130,
            promoted_observations: 0,
            rejected_observations: 0,
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        unitActivity: {
          ...baseOverview.unitActivity,
          units: [
            {
              unitKey: "tcgdex:pokemon:single-card:source-observation-import",
              recentJobs: [
                integrationJobSummary({
                  jobId: "job_ja_sv8_active",
                  unitKey: "tcgdex:pokemon:single-card:source-observation-import",
                  importScope: "ja:sv:sv8",
                  profileVersion: "2026.06.04",
                }),
              ],
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    expect(matched.importJobs.selectedScope).toMatchObject({
      importScope: "ja:SV:SV8",
      expectedObservationVolume: 130,
      observedCount: 130,
      changedCount: 130,
      promotedCount: 0,
    });
    expect(matched.sourceObservationReview.counts).toMatchObject({ observed: 130, changed: 130, promoted: 0 });
    expect(matched.importJobs.activeJobCount).toBe(1);
    expect(matched.importJobs.jobs[0]).toMatchObject({
      jobId: "job_ja_sv8_active",
      scopeMatchesRoute: true,
    });
    expect(matched.actions.find((action) => action.key === "scope.import")?.blockers).toContain("active-job-conflict");

    const empty = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&importScope=ja:SV:SV8",
      scopes: {
        items: [
          sourceObservationScope({
            language_code: "ja",
            product_line_id: "",
            series_id: "sv",
            expansion_id: "sv1",
            total_observations: 31639,
            observed_observations: 0,
            changed_observations: 0,
            promoted_observations: 31639,
            rejected_observations: 0,
          }),
        ],
        total: 1,
        count: 1,
      },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    expect(empty.importJobs.selectedScope).toMatchObject({
      expectedObservationVolume: 0,
      observedCount: 0,
      changedCount: 0,
      promotedCount: 0,
    });
    expect(empty.sourceObservationReview.counts).toMatchObject({ observed: 0, changed: 0, promoted: 0 });
  });

  it("matches all-series scopes without narrowing them to an expansion id", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:single-card:source-observation-import&importScope=ja:SV",
      scopes: {
        items: [
          sourceObservationScope({
            language_code: "ja",
            product_line_id: "",
            series_id: "sv",
            expansion_id: "sv1",
            total_observations: 10,
            observed_observations: 4,
            changed_observations: 1,
            promoted_observations: 5,
            rejected_observations: 0,
          }),
          sourceObservationScope({
            language_code: "ja",
            product_line_id: "",
            series_id: "sv",
            expansion_id: "sv8",
            total_observations: 130,
            observed_observations: 100,
            changed_observations: 30,
            promoted_observations: 0,
            rejected_observations: 0,
          }),
        ],
        total: 2,
        count: 2,
      },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    expect(readModel.importJobs.selectedScope).toMatchObject({
      importScope: "ja:SV",
      expectedObservationVolume: 140,
      observedCount: 104,
      changedCount: 31,
      promotedCount: 5,
    });
    expect(readModel.sourceObservationReview.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "language", value: "ja" }),
        expect.objectContaining({ key: "setId", value: null }),
      ]),
    );
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
    expect(readModel.actions.find((action) => action.key === "observation.promote")?.blockers).not.toContain(
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
    expect(readModel.actions.find((action) => action.key === "scope.import")?.blockers).toEqual([
      "active-job-conflict",
      "concurrent-job",
    ]);
  });
});
