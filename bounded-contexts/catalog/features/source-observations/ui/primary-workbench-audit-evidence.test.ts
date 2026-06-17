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

describe("Catalog primary workbench read model - audit evidence", () => {
  it("models the audit timeline with filters and redacted evidence links", () => {
    const profile = profileReview({ active: true, lifecycle: "active" });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_001&jobId=job_001&promotionPreviewId=preview_001&section=evidence",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profile], total: 1, count: 1 },
      profileAuthoringModel: profileAuthoringModel({ review: profile }),
      controlPlaneOverview: {
        ...controlPlaneOverview(),
        unitActivity: {
          generatedAt: "2026-06-09T01:00:00.000Z",
          units: [
            {
              unitKey: "tcgdex:pokemon:card:import",
              recentJobs: [
                integrationJobSummary({
                  jobId: "job_001",
                  phase: "completed",
                  operatorStatus: "completed",
                  completed: 24,
                  total: 24,
                }),
              ],
            },
          ],
        },
        auditLifecycle: {
          generatedAt: "2026-06-09T01:05:00.000Z",
          projectionStatus: "partial",
          statusMessage: "Audit lifecycle projection is partial.",
          entries: [
            {
              eventId: "aud_profile_001",
              occurredAt: "2026-06-09T00:30:00.000Z",
              eventName: "profile-section-edited",
              category: "profile-section",
              providerKey: "tcgdex",
              unitKey: "tcgdex:pokemon:card:import",
              profileVersion: "2026.06.04",
              actorUserId: "user_editor",
              relatedJobId: null,
              summary: "Mapping section changed with redacted evidence.",
              diagnosticCodes: [],
            },
            {
              eventId: "aud_import_001",
              occurredAt: "2026-06-09T01:00:00.000Z",
              eventName: "import-job-started",
              category: "import-job",
              providerKey: "tcgdex",
              unitKey: "tcgdex:pokemon:card:import",
              profileVersion: "2026.06.04",
              actorUserId: "user_operator",
              relatedJobId: "job_001",
              summary: "Provider import started for release evidence.",
              diagnosticCodes: [],
            },
          ],
        },
      },
      reviewObservations: {
        items: [
          sourceObservationListItem({
            observation_id: "obs_001",
            status: "changed",
            provider_key: "tcgdex",
          }),
        ],
        total: 1,
        count: 1,
      },
      canManageCatalog: true,
    });

    expect(readModel.auditEvidence.status).toBe("partial");
    expect(readModel.auditEvidence.filters.map((filter) => filter.key)).toEqual([
      "provider",
      "unit",
      "profile-version",
      "job",
      "observation",
      "action-category",
      "actor",
      "time",
    ]);
    expect(readModel.auditEvidence.timeline.map((event) => event.eventName)).toEqual(
      expect.arrayContaining([
        "import-job-started",
        "source-observation-changed",
        "dry-run-executed",
        "promotion-plan-generated",
        "diagnostics-present",
      ]),
    );
    expect(readModel.auditEvidence.redactionPolicy).toMatchObject({
      sourcePayloadAccess: "not-required",
      profileSnapshotAccess: "not-required",
    });
    expect(JSON.stringify(readModel.auditEvidence)).not.toMatch(/raw\s+json|payload\s+json|profile\s+json/i);
    expect(readModel.auditEvidence).not.toHaveProperty("releaseChecklist");
    expect(JSON.stringify(readModel.auditEvidence)).not.toMatch(
      /blocks release|smokeProof|ops-release|catalog-source-observations/i,
    );
  });

  it("keeps audit evidence unavailable when the timeline projection is missing while preserving redaction policy", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=evidence",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem({ observation_id: "obs_001" })], total: 1, count: 1 },
      canManageCatalog: true,
    });

    expect(readModel.auditEvidence.status).toBe("unavailable");
    expect(readModel.auditEvidence.projectionState).toMatchObject({
      queryKey: "audit-evidence-timeline",
      missingProjection: true,
      partialProjection: false,
    });
    expect(readModel.auditEvidence.redactionPolicy.forbiddenEvidenceRequests).toEqual(
      expect.arrayContaining(["source payload body download", "provider profile snapshot document"]),
    );
  });
});
