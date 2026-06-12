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

describe("Catalog primary workbench read model - clean reset release", () => {
  it("models clean reset release evidence as blocked until reset/drop evidence is present", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=reset-release",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.cleanResetRelease.status).toBe("blocked");
    expect(readModel.cleanResetRelease.environment).toBe("production-prelaunch");
    expect(readModel.cleanResetRelease.summary.findingCount).toBeGreaterThan(0);
    expect(readModel.cleanResetRelease.resetEvidence.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "missing-operator",
        "missing-approval-reference",
        "missing-backup-decision",
        "missing-staging-rehearsal-reference",
        "missing-smoke-verification-reference",
        "missing-dry-run",
        "missing-before-verification",
        "missing-after-verification",
      ]),
    );
    expect(
      readModel.cleanResetRelease.decisions.find((decision) => decision.key === "destructive-reset-policy"),
    ).toMatchObject({
      status: "blocked",
      ownerIssue: "#1054",
      blocksRelease: true,
    });
    expect(readModel.cleanResetRelease.backfill.every((row) => row.blocksRelease)).toBe(true);
    expect(JSON.stringify(readModel.cleanResetRelease)).toMatch(/complete removal of code, patterns, documentation/i);
  });

  it("marks clean reset release complete when prelaunch reset evidence and removal proof are clean", () => {
    const reportBefore = cleanVerificationReport({
      sourceObservations: 12,
      legacySourceObservationReferences: 4,
      integrationDurableJobs: 2,
      providerOptionQueryCacheEntries: 5,
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=reset-release",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        unitActivity: {
          generatedAt: "2026-06-09T01:05:00.000Z",
          units: [
            {
              unitKey: "tcgdex:pokemon:card:import",
              recentJobs: [
                integrationJobSummary({
                  operatorStatus: "completed",
                  phase: "completed",
                  completed: 24,
                  total: 24,
                }),
              ],
            },
          ],
        },
      }),
      cleanResetEvidence: {
        environment: "production-prelaunch",
        generatedAt: "2026-06-09T00:00:00.000Z",
        operator: "catalog-release-lead",
        approvalReference: "private-evidence://catalog/prelaunch-reset/approval-20260609",
        stagingRehearsalReference: "private-evidence://catalog/prelaunch-reset/staging-rehearsal-20260609",
        smokeVerificationReference: "private-evidence://catalog/prelaunch-reset/prod-smoke-20260609",
        backupDecision: {
          kind: "skip-backup-accepted-data-loss",
          approver: "catalog-release-lead",
          rationale: "Only unlaunched Catalog integration data is targeted; fresh import rebuilds source data.",
          targetDataSet: "Catalog integration prelaunch state",
        },
        targetTables: [
          "catalog_source_observation_integration_work_units",
          "catalog_source_observation_integration_job_events",
          "catalog_source_observation_integration_durable_jobs",
          "catalog_source_observation_bulk_review_work_units",
          "catalog_source_observation_bulk_review_job_events",
          "catalog_source_observation_bulk_review_jobs",
          "catalog_source_observations",
          "catalog_provider_option_query_cache",
          "catalog_tcgplayer_automation_domain_rate_limits",
          "catalog_provider_integration_profile_versions",
        ],
        dryRun: reportBefore,
        before: reportBefore,
        after: cleanVerificationReport(),
      },
      canManageCatalog: true,
    });

    expect(readModel.cleanResetRelease.status).toBe("complete");
    expect(readModel.cleanResetRelease.summary).toMatchObject({
      findingCount: 0,
      blockingDecisionCount: 0,
      backfillRequiredCount: 0,
      temporaryScaffoldingRemovalRequiredCount: 0,
      completeRemovalEvidenceReady: true,
    });
    expect(readModel.cleanResetRelease.backfill.map((row) => row.status)).toEqual([
      "skipped-clean-reset",
      "skipped-clean-reset",
      "skipped-clean-reset",
    ]);
    expect(
      readModel.cleanResetRelease.decisions.find((decision) => decision.key === "complete-old-surface-removal"),
    ).toMatchObject({
      status: "ready",
      ownerIssue: "#1090",
      blocksRelease: false,
    });
  });

  it("blocks clean reset release when temporary scaffolding still requires complete deletion", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=reset-release",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      cleanResetEvidence: {
        environment: "staging",
        generatedAt: "2026-06-09T00:00:00.000Z",
        operator: "catalog-release-lead",
        approvalReference: "private-evidence://catalog/prelaunch-reset/staging-approval-20260609",
        smokeVerificationReference: "private-evidence://catalog/prelaunch-reset/staging-smoke-20260609",
        backupDecision: {
          kind: "create-backup-snapshot-export",
          reference: "private-evidence://catalog/prelaunch-reset/export-20260609",
          owner: "catalog-release-lead",
          retentionUntil: "2026-06-30",
          restoreVerificationReference: "private-evidence://catalog/prelaunch-reset/restore-check-20260609",
        },
        targetTables: [
          "catalog_source_observation_integration_work_units",
          "catalog_source_observation_integration_job_events",
          "catalog_source_observation_integration_durable_jobs",
          "catalog_source_observation_bulk_review_work_units",
          "catalog_source_observation_bulk_review_job_events",
          "catalog_source_observation_bulk_review_jobs",
          "catalog_source_observations",
          "catalog_provider_option_query_cache",
          "catalog_tcgplayer_automation_domain_rate_limits",
          "catalog_provider_integration_profile_versions",
        ],
        dryRun: cleanVerificationReport({ sourceObservations: 4 }),
        before: cleanVerificationReport({ sourceObservations: 4 }),
        after: cleanVerificationReport(),
      },
      temporaryReleaseScaffolding: [
        {
          key: "deploy-skew-release-scaffold",
          label: "Deploy-skew release scaffold",
          ownerIssue: "#1061",
          status: "removal-required",
          evidenceUrl: "/catalog/integrations?providerKey=tcgdex&section=reset-release",
          removalEvidence: "Temporary deploy-skew support route must be completely deleted before launch.",
        },
      ],
      canManageCatalog: true,
    });

    expect(readModel.cleanResetRelease.status).toBe("blocked");
    expect(readModel.cleanResetRelease.summary.temporaryScaffoldingRemovalRequiredCount).toBe(1);
    expect(readModel.cleanResetRelease.temporaryScaffolding[0]).toMatchObject({
      status: "removal-required",
      blocksRelease: true,
      deletionRequiredBeforeLaunch: true,
    });
    expect(
      readModel.cleanResetRelease.decisions.find((decision) => decision.key === "deploy-skew-removal"),
    ).toMatchObject({
      status: "blocked",
      blocksRelease: true,
    });
  });
});
