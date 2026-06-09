import { describe, expect, it } from "vitest";
import { validateCatalogPrimaryWorkbenchReadModelContract } from "../api/primary-workbench-admin-contracts";
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
      eligible: 22,
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
      expectedObservationVolume: 100,
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
    expect(readModel.importJobs.failedJobCount).toBe(1);
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

    expect(readModel.sourceObservationReview.counts.eligible).toBe(22);
    expect(readModel.sourceObservationReview.rows[0]?.promotionReadiness.state).toBe("already-promoted");
    expect(readModel.sourceObservationReview.promotionReadyCount).toBe(0);
  });

  it("fails closed for denied writes and does not fetch all-provider review rows without provider context", () => {
    const noProviderQuery = buildCatalogPrimaryWorkbenchSourceObservationReviewQuery({
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
