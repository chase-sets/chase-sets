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
import {
  sourceObservationEvidenceDetailFor,
  sourceObservationReviewCompositionFor,
} from "./primary-workbench-source-observation-review";
import type { CatalogPrimaryWorkbenchRouteContext } from "../api/primary-workbench-admin-contracts";

const slimRowRouteContext: CatalogPrimaryWorkbenchRouteContext = {
  section: "import-to-promotion",
  providerKey: "tcgdex",
  unitKey: null,
  importScope: null,
  profileVersion: null,
  sourceObservationFilters: {},
  selectedObservationIds: [],
  reviewOffset: null,
  reviewLimit: null,
  jobId: null,
  promotionPreviewId: null,
  returnPath: null,
};

describe("Catalog primary workbench read model - source observation review", () => {
  it("uses loaded review rows when the scope summary projection is empty for the selected provider scope", () => {
    const { review } = sourceObservationReviewCompositionFor({
      canManage: true,
      changed: 0,
      eligible: 0,
      observed: 0,
      promoted: 0,
      readinessBlockers: [],
      rejected: 0,
      reviewObservations: {
        items: [
          sourceObservationListItem({
            provider_key: "tcgplayer",
            language_code: "en",
            status: "observed",
            normalized: {
              kind: "provider-product",
              languageCode: "en",
              name: "Alakazam",
              setName: "Base Set",
              expansionName: "Base Set",
              cardNumber: null,
              imageUrls: [],
              providerProductId: "42365",
              providerProductName: "Alakazam",
              productLineName: "Pokemon",
              productCategoryName: "Cards",
              externalCatalogItemReferences: [],
              externalProductReferences: [],
              skuReferences: [],
            },
          }),
        ],
        total: 102,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      reviewUnavailable: false,
      routeContext: {
        ...slimRowRouteContext,
        providerKey: "tcgplayer",
        unitKey: "tcgplayer:pokemon:single-card:source-observation-import",
        importScope: "en:3:Base Set",
        scope: {
          providerKey: "tcgplayer",
          languageCode: "en",
          productLineId: "3",
          productLineName: "Pokemon",
          seriesId: null,
          seriesName: null,
          expansionId: "Base Set",
          expansionName: "Base Set",
          status: null,
        },
      },
      scopeRows: [],
    });

    expect(review.counts).toMatchObject({ observed: 102, eligible: 102 });
    expect(review.promotionReadyCount).toBe(102);
    expect(review.rows[0]?.actions.find((action) => action.key === "observation.promote")).toMatchObject({
      state: "available",
      blockers: [],
    });
  });

  it("maps Source Observation rows into redaction-safe review evidence with command readiness", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_001",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      reviewObservations: {
        items: [
          sourceObservationListItem({
            normalized: {
              ...sourceObservationListItem().normalized,
              name: "A very long provider supplied Charizard display name with enough detail to test dense review rows",
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    expect(readModel.sourceObservationReview.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "providerKey", value: "tcgdex", serverApplied: true }),
        expect.objectContaining({ key: "status", value: "changed", serverApplied: true }),
        expect.objectContaining({ key: "setId", value: "base1", serverApplied: true }),
      ]),
    );
    expect(readModel.sourceObservationReview.pagination).toMatchObject({ mode: "offset", total: 1, limit: 25 });
    expect(readModel.sourceObservationReview.bulkSelection).toMatchObject({
      selectedCount: 1,
      eligibleSelectedCount: 1,
    });
    expect(readModel.sourceObservationReview.rows[0]).toMatchObject({
      observationId: "obs_001",
      providerKey: "tcgdex",
      promotionReadiness: { state: "eligible", blockers: [] },
      redactionSummary: expect.stringContaining("Provider payload withheld"),
      commandPreview: { disposition: "eligible", confirmationRequired: true },
      actions: expect.arrayContaining([
        expect.objectContaining({ key: "observation.promote", state: "available" }),
        expect.objectContaining({ key: "observation.reject", state: "available" }),
      ]),
    });
    expect(readModel.sourceObservationReview.rows[0]?.payloadSummary).not.toMatch(/raw JSON/i);
  });

  it("exposes a navigable offset page window when the queue exceeds one page", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&filter.status=changed&reviewOffset=25&reviewLimit=25",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 80, count: 1 },
      reviewPagination: { limit: 25, offset: 25 },
      canManageCatalog: true,
    });

    expect(readModel.sourceObservationReview.pagination).toMatchObject({
      mode: "offset",
      limit: 25,
      offset: 25,
      total: 80,
      previousCursor: "offset:0",
      nextCursor: "offset:50",
    });
    expect(readModel.sourceObservationReview.cursor).toBe("offset:25");
  });

  it("closes the next cursor on the final page", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&reviewOffset=75&reviewLimit=25",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 80, count: 1 },
      reviewPagination: { limit: 25, offset: 75 },
      canManageCatalog: true,
    });

    expect(readModel.sourceObservationReview.pagination).toMatchObject({
      offset: 75,
      total: 80,
      previousCursor: "offset:50",
      nextCursor: null,
    });
  });

  it("distinguishes new, changed, and eligible promotion saved filters", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: {
        items: [
          sourceObservationListItem({ observation_id: "obs_new", status: "observed" }),
          sourceObservationListItem({ observation_id: "obs_changed", status: "changed" }),
        ],
        total: 2,
        count: 2,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    expect(readModel.sourceObservationReview.savedFilters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "ready-for-promotion",
          label: "Eligible for promotion",
          filters: { providerKey: "tcgdex" },
          count: 124,
        }),
        expect.objectContaining({
          key: "new-observations",
          label: "New observations",
          filters: { providerKey: "tcgdex", status: "observed" },
          count: 100,
        }),
        expect.objectContaining({
          key: "changed-since-last-pull",
          label: "Changed observations",
          filters: { providerKey: "tcgdex", status: "changed" },
          count: 24,
        }),
      ]),
    );
    expect(readModel.sourceObservationReview.rows.map((row) => row.promotionReadiness.state)).toEqual([
      "eligible",
      "eligible",
    ]);
  });

  it("models explicit-row promotion command scope with decision and profile semantics", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed&selectedObservationIds=obs_001&promotionPreviewId=preview_001",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    expect(readModel.promotionPreview.scope).toMatchObject({
      kind: "explicit-rows",
      requestedCount: 1,
      eligibleCount: 1,
      selectedObservationIds: ["obs_001"],
      partialFailureMode: "per-observation",
    });
    expect(readModel.promotionPreview.outcomeCounts).toMatchObject({
      eligible: 1,
      blocked: 0,
      skipped: 0,
      conflicting: 1,
      failed: 0,
    });
    expect(readModel.promotionPreview.commandPlanHash).toContain("preview:preview_001:explicit-rows");
    expect(readModel.promotionPreview.executionSafeguards).toMatchObject({
      previewRequired: true,
      previewFresh: true,
      stalePreviewRejected: false,
      idempotencyRequired: true,
      doubleSubmitProtection: true,
    });
    expect(readModel.promotionPreview.executionSafeguards.rejectsWhenChanged).toEqual([
      "observations",
      "profile-version",
      "rollout-state",
      "permissions",
      "command-inputs",
    ]);
    expect(readModel.promotionPreview.reviewDecisions.reject).toMatchObject({
      reasonRequired: true,
      partialFailureMode: "failed-observations-remain-in-scope",
    });
    expect(readModel.promotionPreview.reviewDecisions.defer).toMatchObject({
      stateChange: "keeps-observation-in-review",
      returnsToReviewWhen: "next-provider-import-or-filter-reset",
    });
    expect(readModel.promotionPreview.profileWorkflows).toMatchObject({
      reapply: {
        profileSemantics: "current-active-profile",
        target: "promoted-observations",
        profileVersion: "2026.06.04",
      },
      replay: {
        profileSemantics: "original-source-profile-version",
        target: "source-observation-evidence",
        profileVersion: "2026.06.04",
      },
    });
  });

  it("models matching-filter promotion scope with skipped and failed outcome counts", () => {
    const overview = controlPlaneOverview({
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
              },
            ],
          },
        ],
      },
    });
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: overview,
      reviewObservations: {
        items: [
          sourceObservationListItem(),
          sourceObservationListItem({
            observation_id: "obs_002",
            external_key: "base1-5",
            status: "rejected",
            status_reason: "Out of scope.",
          }),
        ],
        total: 2,
        count: 2,
      },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    expect(readModel.promotionPreview.scope.kind).toBe("matching-filter");
    expect(readModel.promotionPreview.scope.filterSummary).toEqual(
      expect.arrayContaining(["Provider: tcgdex", "Status: changed"]),
    );
    expect(readModel.promotionPreview.outcomeCounts).toMatchObject({
      eligible: 1,
      skipped: 1,
      failed: 1,
    });
    expect(readModel.promotionPreview.executionSafeguards.overlappingActionBlockers).toEqual([]);
  });

  it("rejects stale promotion previews when profile or command inputs changed", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1&profileVersion=2026.06.03&selectedObservationIds=obs_missing&promotionPreviewId=preview_old",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      canManageCatalog: true,
    });

    expect(readModel.promotionPreview.freshness).toBe("stale");
    expect(readModel.promotionPreview.executionSafeguards.previewFresh).toBe(false);
    expect(readModel.promotionPreview.executionSafeguards.stalePreviewRejected).toBe(true);
    expect(readModel.promotionPreview.executionSafeguards.staleReasons).toEqual(["profile-version", "command-inputs"]);
    expect(readModel.promotionPreview.blockers).toEqual(
      expect.arrayContaining(["no-promotion-eligible-observations", "stale-promotion-preview"]),
    );
    expect(readModel.actions.find((action) => action.key === "observation.promote")).toMatchObject({
      state: "blocked",
      blockers: expect.arrayContaining(["no-promotion-eligible-observations", "stale-promotion-preview"]),
    });
    expect(readModel.actions.filter((action) => action.key === "observation.promote")).toHaveLength(1);
  });

  it("keeps visible promotion readiness counts tied to fetched review rows", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&filter.status=promoted",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: {
        items: [
          sourceObservationListItem({
            status: "promoted",
            promoted_catalog_item_id: "cat_item_001",
            promoted_at: "2026-06-09T01:10:00.000Z",
          }),
        ],
        total: 1,
        count: 1,
      },
      canManageCatalog: true,
    });

    expect(readModel.sourceObservationReview.counts.eligible).toBe(124);
    expect(readModel.sourceObservationReview.rows[0]?.promotionReadiness.state).toBe("already-promoted");
    expect(readModel.sourceObservationReview.promotionReadyCount).toBe(0);
  });

  it("derives the review set filter from native TCGdex language-series-set scopes", () => {
    const query = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery({
      section: "import-to-promotion",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      importScope: "ja:SV:SV8",
      profileVersion: "2026.06.03",
      sourceObservationFilters: {},
      selectedObservationIds: [],
      reviewOffset: null,
      reviewLimit: null,
      jobId: null,
      promotionPreviewId: null,
      returnPath: null,
    });

    const params = new URLSearchParams(query ?? "");
    expect(params.get("provider")).toBe("tcgdex");
    expect(params.get("language")).toBe("ja");
    expect(params.get("seriesId")).toBe("sv");
    expect(params.get("setId")).toBe("sv8");
  });

  it("derives all-series review filters without inventing an expansion filter", () => {
    const query = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery({
      section: "import-to-promotion",
      providerKey: "tcgdex",
      unitKey: "tcgdex:pokemon:single-card:source-observation-import",
      importScope: "ja:SV",
      profileVersion: "2026.06.03",
      sourceObservationFilters: {},
      selectedObservationIds: [],
      reviewOffset: null,
      reviewLimit: null,
      jobId: null,
      promotionPreviewId: null,
      returnPath: null,
    });

    const params = new URLSearchParams(query ?? "");
    expect(params.get("provider")).toBe("tcgdex");
    expect(params.get("language")).toBe("ja");
    expect(params.get("seriesId")).toBe("sv");
    expect(params.has("setId")).toBe(false);
    expect(params.has("expansionId")).toBe(false);
  });

  it("fails closed for denied writes and does not fetch all-provider review rows without provider context", () => {
    const noProviderQuery = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery({
      section: "import-to-promotion",
      providerKey: null,
      unitKey: null,
      importScope: null,
      profileVersion: null,
      sourceObservationFilters: {},
      selectedObservationIds: [],
      reviewOffset: null,
      reviewLimit: null,
      jobId: null,
      promotionPreviewId: null,
      returnPath: null,
    });

    expect(noProviderQuery).toBeNull();

    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      canManageCatalog: false,
    });

    expect(readModel.sourceObservationReview.rows[0]?.promotionReadiness).toMatchObject({
      state: "blocked",
      blockers: ["permission-denied"],
    });
    expect(readModel.sourceObservationReview.rows[0]?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "observation.promote", state: "blocked", blockers: ["permission-denied"] }),
        expect.objectContaining({
          key: "observation.reject",
          state: "denied",
          blockers: ["permission-denied"],
        }),
      ]),
    );
  });
});

describe("Catalog primary workbench review payload split (#1971)", () => {
  it("ships slim review rows without the deep evidence/audit arrays", () => {
    const { review } = sourceObservationReviewCompositionFor({
      canManage: true,
      changed: 1,
      eligible: 1,
      observed: 1,
      promoted: 0,
      readinessBlockers: [],
      rejected: 0,
      reviewObservations: { items: [sourceObservationListItem()], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      routeContext: slimRowRouteContext,
      scopeRows: [sourceObservationScope()],
    });

    const row = review.rows[0]!;
    // Cell-only data: the badge preview is capped at the first 3 facts and the cell
    // renders a duplicate COUNT, not the full duplicate list.
    expect(row.factSummaryPreview.length).toBeLessThanOrEqual(3);
    expect(row.duplicateCount).toBeGreaterThanOrEqual(0);
    expect(row).toMatchObject({ observationId: "obs_001", promotionReadiness: { state: "eligible" } });

    // The deep evidence/audit arrays and the sheet-only provenance fields never
    // ship on the row — they move to the lazily-fetched evidence detail.
    for (const movedField of [
      "normalizedFactSummaries",
      "duplicateEvidence",
      "conflictEvidence",
      "auditTrail",
      "sourceUrl",
      "sourceRecordHash",
      "observedAt",
      "sourceProfileVersion",
      "languageCode",
      "promotionProfileVersion",
    ]) {
      expect(row).not.toHaveProperty(movedField);
    }

    // The serialized review slice carries no evidence index — that stays in-process.
    expect(review).not.toHaveProperty("evidenceByObservationId");
  });

  it("composes a deep evidence detail keyed by observationId for every row", () => {
    const { review, evidenceByObservationId } = sourceObservationReviewCompositionFor({
      canManage: true,
      changed: 1,
      eligible: 1,
      observed: 1,
      promoted: 0,
      readinessBlockers: [],
      rejected: 0,
      reviewObservations: { items: [sourceObservationListItem({ status: "changed" })], total: 1, count: 1 },
      reviewPagination: { limit: 25, offset: 0 },
      routeContext: slimRowRouteContext,
      scopeRows: [sourceObservationScope()],
    });

    expect(evidenceByObservationId.size).toBe(review.rows.length);
    const detail = evidenceByObservationId.get("obs_001")!;
    // The detail carries the FULL fact list, the duplicate/conflict/audit evidence,
    // and the provenance fields the SideSheet's KeyValueList renders.
    expect(detail.normalizedFactSummaries.length).toBeGreaterThan(review.rows[0]!.factSummaryPreview.length);
    expect(detail.duplicateEvidence.length).toBe(review.rows[0]!.duplicateCount);
    expect(detail.conflictEvidence.length).toBeGreaterThan(0);
    expect(detail.auditTrail.length).toBeGreaterThan(0);
    expect(detail).toMatchObject({
      observationId: "obs_001",
      sourceUrl: "https://api.tcgdex.example/cards/base1-4",
      sourceProfileVersion: "2026.06.04",
      languageCode: "en",
    });
  });

  it("composes the evidence detail standalone for the lazy endpoint", () => {
    const detail = sourceObservationEvidenceDetailFor(sourceObservationListItem(), { canManage: true });

    expect(detail).toMatchObject({
      observationId: "obs_001",
      providerKey: "tcgdex",
      promotionReadiness: { state: "eligible" },
      commandPreview: { disposition: "eligible" },
    });
    expect(detail.redactionSummary).toContain("Provider payload withheld");
  });

  it("surfaces resolved Product Contents provider evidence as reviewable promotion evidence with configured labels", () => {
    const detail = sourceObservationEvidenceDetailFor(
      sourceObservationListItem({
        normalized: {
          ...sourceObservationListItem().normalized,
          productContentsPromotion: {
            lines: [
              {
                contentTypeId: "pct_booster_content",
                inclusionPolicyId: "pcp_guaranteed",
                quantity: 15,
                containedCatalogItemId: null,
                candidateCatalogItemIds: ["cat_fury_sliver"],
                containedSelectedOptions: [{ dimensionId: "dim_language", optionId: "opt_en" }],
                provenance: {
                  sourceObservationEvidence: "reviewed-provider-contents",
                  providerPrivateUrl: "https://provider.example/private/raw",
                },
              },
            ],
          },
        },
      }),
      {
        canManage: true,
        productContentsConfig: {
          contentTypeLabelsById: new Map([["pct_booster_content", "Booster contents"]]),
          inclusionPolicyLabelsById: new Map([["pcp_guaranteed", "Guaranteed inclusion"]]),
        },
      },
    );

    expect(detail.productContentsEvidence).toMatchObject({
      state: "reviewable",
      lineCount: 1,
      summary: "1 Product Contents line(s) are resolved and reviewable for promotion.",
      rows: [
        expect.objectContaining({
          state: "reviewable",
          contentTypeLabel: "Booster contents",
          inclusionPolicyLabel: "Guaranteed inclusion",
          quantity: 15,
          containedCatalogItemId: "cat_fury_sliver",
          containedSelectedOptionLabels: ["dim_language:opt_en"],
          targetSummary: "Catalog Item cat_fury_sliver",
        }),
      ],
    });
    expect(detail.productContentsEvidence.rows[0]?.provenanceSummary).toEqual([
      "Provenance key: sourceObservationEvidence",
    ]);
    expect(JSON.stringify(detail.productContentsEvidence)).not.toContain("providerPrivateUrl");
    expect(JSON.stringify(detail.productContentsEvidence)).not.toContain("https://provider.example/private/raw");
  });

  it("shows rejected Product Contents evidence with existing Source Observation review semantics", () => {
    const detail = sourceObservationEvidenceDetailFor(
      sourceObservationListItem({
        status: "rejected",
        status_reason: "Provider contents are out of scope.",
        normalized: {
          ...sourceObservationListItem().normalized,
          productContentsPromotion: {
            lines: [
              {
                contentTypeId: "pct_booster_content",
                quantity: 1,
                containedCatalogItemId: "cat_fury_sliver",
                provenance: { sourceObservationEvidence: "reviewed-provider-contents" },
              },
            ],
          },
        },
      }),
      { canManage: true },
    );

    expect(detail.productContentsEvidence).toMatchObject({
      state: "rejected",
      summary: "1 Product Contents line(s) were rejected with this Source Observation.",
      rows: [expect.objectContaining({ state: "rejected" })],
    });
    expect(detail.promotionReadiness).toMatchObject({ state: "rejected" });
    expect(detail.conflictEvidence).toContain("Provider contents are out of scope.");
  });

  it("keeps retained-only Product Contents evidence unresolved without dumping provider payloads", () => {
    const detail = sourceObservationEvidenceDetailFor(
      sourceObservationListItem({
        normalized: {
          ...sourceObservationListItem().normalized,
          productContentsEvidence: {
            rawProviderContents: [{ name: "Fury Sliver", privateUrl: "https://provider.example/private/raw" }],
          },
          productContentsPromotion: null,
        },
      }),
      { canManage: true },
    );

    expect(detail.productContentsEvidence).toEqual({
      state: "unresolved",
      summary:
        "Provider Product Contents evidence is retained, but no reviewed Product Contents promotion is resolved yet.",
      lineCount: 0,
      rows: [],
    });
    expect(JSON.stringify(detail.productContentsEvidence)).not.toContain("rawProviderContents");
    expect(JSON.stringify(detail.productContentsEvidence)).not.toContain("https://provider.example/private/raw");
  });

  it("marks promoted Product Contents evidence after Catalog-owned promotion completes", () => {
    const detail = sourceObservationEvidenceDetailFor(
      sourceObservationListItem({
        status: "promoted",
        promoted_catalog_item_id: "cat_magic_sealed_001",
        promoted_at: "2026-06-09T02:00:00.000Z",
        normalized: {
          ...sourceObservationListItem().normalized,
          productContentsPromotion: {
            lines: [
              {
                contentTypeId: "pct_booster_content",
                quantity: null,
                containedCatalogItemId: "cat_fury_sliver",
                provenance: { sourceObservationEvidence: "reviewed-provider-contents" },
              },
            ],
          },
        },
      }),
      { canManage: true },
    );

    expect(detail.productContentsEvidence).toMatchObject({
      state: "promoted",
      summary: "1 Product Contents line(s) were promoted through Catalog commands.",
      rows: [expect.objectContaining({ state: "promoted" })],
    });
    expect(detail.promotionReadiness).toMatchObject({ state: "already-promoted" });
  });
});
