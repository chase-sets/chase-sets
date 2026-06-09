import { describe, expect, it } from "vitest";
import { validateCatalogPrimaryWorkbenchReadModelContract } from "../api/primary-workbench-admin-contracts";
import { buildCatalogPrimaryWorkbenchReadModel } from "./primary-workbench-read-model";
import { sourceObservationScope, profileReview } from "./primary-workbench-test-fixtures";

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
});
