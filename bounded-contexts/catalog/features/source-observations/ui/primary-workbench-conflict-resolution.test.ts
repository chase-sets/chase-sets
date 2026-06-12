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

describe("Catalog primary workbench read model - conflict resolution", () => {
  it("models promotion-blocking conflicts with candidate values, precedence, blockers, and audit evidence", () => {
    const baseObservation = sourceObservationListItem({
      observation_id: "obs_conflict",
      promoted_catalog_item_id: "cat_001",
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_conflict&promotionPreviewId=preview_001&section=conflicts",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        auditLifecycle: {
          ...controlPlaneOverview().auditLifecycle,
          entries: [
            {
              eventId: "aud_conflict_001",
              occurredAt: "2026-06-09T01:05:00.000Z",
              eventName: "profile-section-edited",
              category: "profile-section",
              providerKey: "tcgdex",
              unitKey: "tcgdex:pokemon:card:import",
              profileVersion: "2026.06.04",
              actorUserId: "user_admin",
              relatedJobId: null,
              summary: "Promotion mapping reviewed for conflicting Catalog item.",
              diagnosticCodes: [],
            },
          ],
        },
      }),
      reviewObservations: {
        items: [
          {
            ...baseObservation,
            normalized: {
              ...baseObservation.normalized,
              mergeIdentity: undefined,
              externalCatalogItemReferences: [],
            },
          },
        ],
        total: 1,
        count: 1,
      },
      canManageCatalog: true,
    });

    expect(readModel.promotionPreview.blockers).toContain("promotion-conflict");
    expect(readModel.conflictResolution).toMatchObject({
      status: "blocked",
      summary: {
        conflictCount: 1,
        blockingCount: 1,
        autoResolvedCount: 0,
        reviewRequiredCount: 0,
        overrideAvailableCount: 0,
        auditEventCount: 1,
      },
      overridePolicy: {
        supported: false,
        state: "unavailable",
        blockers: ["unsupported-command"],
      },
    });
    expect(readModel.conflictResolution.rows[0]).toMatchObject({
      observationId: "obs_conflict",
      resolutionState: "blocks-promotion",
      promotionReadinessState: "blocked",
      precedenceRuleId: "promotion-command.conflict-blocking.v1",
      blockers: expect.arrayContaining(["promotion-conflict"]),
      overrideAction: {
        state: "unavailable",
        blockers: ["unsupported-command"],
        auditRequired: true,
      },
    });
    expect(readModel.conflictResolution.rows[0]?.candidateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "candidate", evidencePath: "sourceObservationReview.rows.conflictEvidence" }),
        expect.objectContaining({
          role: "candidate",
          evidencePath: "sourceObservationReview.rows.normalizedFactSummaries",
        }),
      ]),
    );
    expect(readModel.conflictResolution.precedenceRules[0]).toMatchObject({
      ruleId: "promotion-command.conflict-blocking.v1",
      blockingBehavior: "promotion-blocking",
    });
  });

  it("models auto-resolved source fact precedence without creating an override path", () => {
    const baseObservation = sourceObservationListItem({ observation_id: "obs_auto" });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_auto&section=conflicts",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: {
        items: [
          {
            ...baseObservation,
            normalized: {
              ...baseObservation.normalized,
              mergeIdentity: undefined,
              externalCatalogItemReferences: [],
            },
          },
        ],
        total: 1,
        count: 1,
      },
      canManageCatalog: true,
    });

    expect(readModel.conflictResolution.status).toBe("ready");
    expect(readModel.conflictResolution.summary).toMatchObject({
      conflictCount: 1,
      blockingCount: 0,
      autoResolvedCount: 1,
      reviewRequiredCount: 0,
      overrideAvailableCount: 0,
    });
    expect(readModel.conflictResolution.rows[0]).toMatchObject({
      resolutionState: "auto-resolved",
      precedenceRuleId: "source-observation.field-precedence.v1",
      blockers: [],
    });
    expect(readModel.conflictResolution.rows[0]?.candidateValues).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "winner" }), expect.objectContaining({ role: "loser" })]),
    );
    expect(readModel.conflictResolution.overridePolicy).toMatchObject({
      supported: false,
      state: "unavailable",
      blockers: ["unsupported-command"],
    });
  });

  it("keeps conflict override review permission-aware for view-only operators", () => {
    const baseObservation = sourceObservationListItem({ observation_id: "obs_view_only" });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_view_only&section=conflicts",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: {
        items: [
          {
            ...baseObservation,
            normalized: {
              ...baseObservation.normalized,
              mergeIdentity: undefined,
              externalCatalogItemReferences: [],
            },
          },
        ],
        total: 1,
        count: 1,
      },
      canManageCatalog: false,
    });

    expect(readModel.conflictResolution.status).toBe("ready");
    expect(readModel.conflictResolution.summary.blockingCount).toBe(0);
    expect(readModel.conflictResolution.overridePolicy).toMatchObject({
      supported: false,
      state: "denied",
      blockers: ["permission-denied", "unsupported-command"],
      auditRequired: true,
    });
    expect(readModel.conflictResolution.rows[0]).toMatchObject({
      resolutionState: "auto-resolved",
      blockers: ["permission-denied"],
      overrideAction: {
        state: "denied",
        blockers: ["permission-denied", "unsupported-command"],
        auditRequired: true,
      },
    });
  });
});
