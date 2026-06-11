import { describe, expect, it } from "vitest";
import { validateCatalogPrimaryWorkbenchReadModelContract } from "../api/primary-workbench-admin-contracts";
import { catalogProviderProfileEditableSectionKeys } from "../api/provider-profile-section-registry";
import {
  buildCatalogPrimaryWorkbenchReadModel,
  buildCatalogPrimaryWorkbenchSourceObservationReviewQuery,
} from "./primary-workbench-read-model";
import {
  controlPlaneOverview,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "./primary-workbench-test-fixtures";

describe("Catalog primary workbench read model", () => {
  it("builds a validated #1060 read model from typed Catalog admin data", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&filter.status=changed",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(() => validateCatalogPrimaryWorkbenchReadModelContract(readModel)).not.toThrow();
    expect(readModel.routeContext).toMatchObject({
      section: "import-to-promotion",
      providerKey: "tcgdex",
      importScope: "en:3:base:base1",
      profileVersion: "2026.06.04",
      sourceObservationFilters: {
        providerKey: "tcgdex",
        status: "changed",
      },
    });
    expect(readModel.sourceObservationReview.counts).toMatchObject({
      observed: 100,
      changed: 24,
      promoted: 16,
      eligible: 124,
    });
    expect(readModel.actions.find((action) => action.key === "preview-promotion")).toMatchObject({
      state: "available",
      blockers: [],
    });
  });

  it("fails closed when manage permission or active profile is missing", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [], total: 0, count: 0 },
      controlPlaneOverview: null,
      canManageCatalog: false,
    });

    expect(readModel.readiness.blockers).toEqual(["permission-denied", "missing-active-profile"]);
    expect(readModel.actions.find((action) => action.key === "start-provider-import")).toMatchObject({
      state: "blocked",
      blockers: ["permission-denied"],
    });
    expect(readModel.deploySkew.forbiddenFallbacks).not.toContain("compatibility redirect");
  });

  it("does not treat draft or test profiles as active import readiness", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: false, lifecycle: "test" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.routeContext.profileVersion).toBeNull();
    expect(readModel.readiness.blockers).toContain("missing-active-profile");
    expect(readModel.actions.find((action) => action.key === "start-provider-import")).toMatchObject({
      state: "blocked",
      blockers: ["missing-active-profile"],
    });
  });

  it("builds provider profile overview and draft creation evidence from typed review records", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [
          profileReview({
            active: true,
            lifecycle: "active",
            referenceCount: 3,
            authoringAudit: {
              createdAt: "2026-06-08T00:00:00.000Z",
              createdByUserId: "user_admin",
              updatedAt: "2026-06-09T00:00:00.000Z",
              updatedByUserId: "user_editor",
            },
            migrationEvidence: {
              evidenceText: "Validated mapping change.",
              mappingFingerprintBefore: "sha256:old",
              mappingFingerprintAfter: "sha256:new",
              fixtureRunId: "fixture_run_001",
              recordedAt: "2026-06-09T00:10:00.000Z",
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.profileAuthoring.status).toBe("ready");
    expect(readModel.profileAuthoring.selectedProfile).toMatchObject({
      providerKey: "tcgdex",
      profileKey: "tcgdex-pokemon-card",
      profileVersion: "2026.06.04",
      lifecycle: "active",
      referenceCount: 3,
      mappingFingerprint: "sha256:new",
      validation: {
        status: "valid",
        diagnosticCount: 0,
      },
      fixtures: {
        coveredFlows: ["normal", "changed", "replay"],
      },
      migrationEvidence: {
        state: "recorded",
        fixtureRunId: "fixture_run_001",
      },
    });
    expect(readModel.profileAuthoring.cloneDraft).toMatchObject({
      commandKey: "clone-provider-profile",
      sourceProviderKey: "tcgdex",
      sourceProfileVersion: "2026.06.04",
      targetProfileVersion: "2026.06.04-draft",
      targetLifecycle: "draft",
      state: "available",
      blockers: [],
    });
    expect(readModel.profileAuthoring.cloneDraft.immutableIdentityFacts.map((fact) => fact.key)).toEqual([
      "provider-key",
      "profile-key",
      "source-contract-owner",
      "source-contract-repository",
      "connector-kind",
      "supported-scopes",
    ]);
    expect(readModel.actions.find((action) => action.key === "clone-provider-profile")).toMatchObject({
      state: "available",
      blockers: [],
    });
  });

  it("projects every registered profile section into guided workspaces without raw editors", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work&profileVersion=2026.06.04-draft",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ active: false, lifecycle: "draft", profileVersion: "2026.06.04-draft" })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.profileAuthoring.sectionGroups.map((group) => group.key)).toEqual([
      "profile-foundation",
      "provider-acquisition",
      "observation-mapping",
      "catalog-promotion",
      "evidence-lifecycle",
    ]);
    expect(readModel.profileAuthoring.sectionWorkspaces.map((workspace) => workspace.sectionKey)).toEqual([
      ...catalogProviderProfileEditableSectionKeys,
    ]);
    for (const workspace of readModel.profileAuthoring.sectionWorkspaces) {
      expect(workspace.commandKey).toBe("update-provider-profile-section");
      expect(workspace.actionState).toBe("available");
      expect(workspace.fields.length).toBeGreaterThan(0);
      expect(`${workspace.displayName} ${workspace.fields.map((field) => field.label).join(" ")}`).not.toMatch(
        /raw JSON|Profile JSON|Candidate JSON|Active JSON/i,
      );
    }
  });

  it("marks section save outcomes, diagnostics, and stale conflicts at section scope", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work&profileVersion=2026.06.04-draft&commandIntent=update-provider-profile-section&commandStatus=error&commandResult=section-conflict&commandSection=source-contract",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: {
        items: [
          profileReview({
            active: false,
            lifecycle: "draft",
            profileVersion: "2026.06.04-draft",
            validation: {
              status: "invalid",
              diagnostics: [
                {
                  code: "source-contract-owner",
                  path: "sourceContract.owner",
                  diagnosticText: "Source contract owner is required.",
                  severity: "error",
                },
              ],
            },
          }),
        ],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    const sourceContract = readModel.profileAuthoring.sectionWorkspaces.find(
      (workspace) => workspace.sectionKey === "source-contract",
    );

    expect(sourceContract).toMatchObject({
      status: "error",
      staleState: "conflict",
      saveOutcome: "conflict",
      blockers: ["profile-section-stale"],
    });
    expect(sourceContract?.diagnostics[0]).toMatchObject({
      path: "sourceContract.owner",
      diagnosticText: "Source contract owner is required.",
    });
  });

  it("keeps profile evidence visible while denying draft creation for view-only operators", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: false,
    });

    expect(readModel.profileAuthoring.selectedProfile?.profileVersion).toBe("2026.06.04");
    expect(readModel.profileAuthoring.cloneDraft).toMatchObject({
      state: "denied",
      blockers: ["permission-denied"],
    });
    expect(readModel.actions.find((action) => action.key === "clone-provider-profile")).toMatchObject({
      state: "denied",
      blockers: ["permission-denied"],
    });
  });

  it("fails closed when route-selected profile version is stale", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&section=profile-work&profileVersion=missing-version",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: null,
      canManageCatalog: true,
    });

    expect(readModel.profileAuthoring.status).toBe("stale-selection");
    expect(readModel.profileAuthoring.selectedProfile).toBeNull();
    expect(readModel.profileAuthoring.cloneDraft).toMatchObject({
      state: "blocked",
      blockers: ["profile-version-missing"],
      targetProfileVersion: null,
    });
  });

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

  it("keeps degraded health triage owner metrics for warning diagnostics and unavailable audit projection", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModel({
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview({
        readiness: {
          ...baseOverview.readiness,
          units: [
            {
              ...baseOverview.readiness.units[0]!,
              diagnosticCounts: { info: 0, warning: 1, error: 0 },
              diagnostics: [
                {
                  code: "semantic-warning",
                  severity: "warning",
                  message: "Catalog semantic readiness needs operator review before promotion.",
                  unitKey: "tcgdex:pokemon:card:import",
                  retryAfterSeconds: null,
                  source: "catalog",
                },
              ],
              latestDiagnosticText: "Catalog semantic readiness needs operator review before promotion.",
            },
          ],
        },
        auditLifecycle: {
          ...baseOverview.auditLifecycle,
          projectionStatus: "unavailable",
          statusMessage: "Audit lifecycle projection is unavailable.",
        },
      }),
      canManageCatalog: true,
    });

    expect(readModel.healthTriage.status).toBe("degraded");
    expect(readModel.healthTriage.units[0]).toMatchObject({
      status: "degraded",
      ownerMetricKey: "catalog.integration.semantic_readiness.diagnostic.warning",
      affectedPrimaryAction: "review-source-observations",
    });
    expect(
      readModel.healthTriage.readModels.find((state) => state.queryKey === "audit-evidence-timeline"),
    ).toMatchObject({
      freshness: "unavailable",
      statusMessage: "Audit lifecycle projection is unavailable.",
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
        expect.objectContaining({ key: "preview-promotion", state: "available" }),
        expect.objectContaining({ key: "reject-source-observations", state: "available" }),
      ]),
    });
    expect(readModel.sourceObservationReview.rows[0]?.payloadSummary).not.toMatch(/raw JSON/i);
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
    expect(readModel.actions.find((action) => action.key === "preview-promotion")).toMatchObject({
      state: "disabled",
      blockers: ["no-promotion-eligible-observations"],
    });
    expect(readModel.actions.find((action) => action.key === "execute-promotion")).toMatchObject({
      state: "blocked",
      blockers: expect.arrayContaining(["stale-promotion-preview"]),
    });
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

  it("fails closed for denied writes and does not fetch all-provider review rows without provider context", () => {
    const noProviderQuery = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery({
      section: "import-to-promotion",
      providerKey: null,
      unitKey: null,
      importScope: null,
      profileVersion: null,
      sourceObservationFilters: {},
      selectedObservationIds: [],
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
        expect.objectContaining({ key: "preview-promotion", state: "blocked", blockers: ["permission-denied"] }),
        expect.objectContaining({
          key: "reject-source-observations",
          state: "denied",
          blockers: ["permission-denied"],
        }),
      ]),
    );
  });
});
