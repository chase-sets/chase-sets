import {
  buildCatalogPrimaryWorkbenchReadModel,
  describe,
  expect,
  it,
  profileReview,
  sourceObservationListItem,
  sourceObservationScope,
} from "./primary-workbench-read-model-test-support";
import type { CatalogPrimaryWorkbenchReadModel } from "../api/primary-workbench-admin-contracts";
import {
  catalogPrimaryWorkbenchDailyFlowFor,
  catalogPrimaryWorkbenchDailyStatusFor,
  catalogPrimaryWorkbenchFlowStageState,
} from "./primary-workbench-daily-flow";
import { catalogPrimaryWorkbenchHref } from "./primary-workbench-route-context";

function dailyReadModel(query: string, review?: { total: number; offset: number }): CatalogPrimaryWorkbenchReadModel {
  return buildCatalogPrimaryWorkbenchReadModel({
    requestUrl: `https://admin.example/catalog/integrations?${query}`,
    scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
    profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
    controlPlaneOverview: null,
    reviewObservations: review
      ? { items: [sourceObservationListItem()], total: review.total, count: 1 }
      : { items: [], total: 0, count: 0 },
    reviewPagination: { limit: 25, offset: review?.offset ?? 0 },
    canManageCatalog: true,
  });
}

type Readiness = CatalogPrimaryWorkbenchReadModel["readiness"];
type ReviewSlice = CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];

function withReadiness(model: CatalogPrimaryWorkbenchReadModel, readiness: Partial<Readiness>) {
  return { ...model, readiness: { ...model.readiness, ...readiness } };
}

function withReview(model: CatalogPrimaryWorkbenchReadModel, review: Partial<ReviewSlice>) {
  return { ...model, sourceObservationReview: { ...model.sourceObservationReview, ...review } };
}

const nothingToReview = (model: CatalogPrimaryWorkbenchReadModel) =>
  withReview(model, {
    rows: [],
    promotionReadyCount: 0,
    counts: { ...model.sourceObservationReview.counts, changed: 0 },
  });

describe("Catalog primary workbench daily flow", () => {
  it("opens the route section's stage before the stage with work", () => {
    const sections = {
      "import-jobs": "run-sync",
      "provider-scope-selection": "run-sync",
      readiness: "run-sync",
      "source-observation-review": "review-changes",
      "conflict-resolution": "review-changes",
      "promotion-preview": "create-items",
      "promotion-result": "create-items",
    } as const;
    for (const [section, stage] of Object.entries(sections)) {
      const model = nothingToReview(dailyReadModel(`providerKey=tcgdex&section=${section}`));
      expect({ section, stage: catalogPrimaryWorkbenchDailyFlowFor(model).openStage }).toEqual({ section, stage });
    }
  });

  it("opens Create for a preview or result, Review for work to review, and Run sync otherwise", () => {
    const base = nothingToReview(dailyReadModel("providerKey=tcgdex"));
    expect(catalogPrimaryWorkbenchDailyFlowFor(base).openStage).toBe("run-sync");
    expect(catalogPrimaryWorkbenchDailyFlowFor(withReview(base, { promotionReadyCount: 2 })).openStage).toBe(
      "review-changes",
    );
    expect(
      catalogPrimaryWorkbenchDailyFlowFor(
        withReview(base, { counts: { ...base.sourceObservationReview.counts, changed: 1 } }),
      ).openStage,
    ).toBe("review-changes");
    expect(
      catalogPrimaryWorkbenchDailyFlowFor(
        withReview(base, {
          rows: dailyReadModel("providerKey=tcgdex", { total: 1, offset: 0 }).sourceObservationReview.rows,
        }),
      ).openStage,
    ).toBe("review-changes");
    expect(
      catalogPrimaryWorkbenchDailyFlowFor({
        ...base,
        promotionPreview: { ...base.promotionPreview, previewId: "preview_1" },
      }).openStage,
    ).toBe("create-items");
    expect(
      catalogPrimaryWorkbenchDailyFlowFor({
        ...base,
        promotionResult: {} as NonNullable<CatalogPrimaryWorkbenchReadModel["promotionResult"]>,
      }).openStage,
    ).toBe("create-items");
  });

  it("blocks Run sync on a readiness blocker and Create on a promotion blocker, and marks the rest", () => {
    const base = nothingToReview(dailyReadModel("providerKey=tcgdex"));
    const blocked: CatalogPrimaryWorkbenchReadModel = {
      ...withReadiness(base, { blockers: ["provider-credential-missing"] }),
      promotionPreview: { ...base.promotionPreview, blockers: ["active-job-conflict"] },
    };
    expect(catalogPrimaryWorkbenchDailyFlowFor(blocked).stages.map((stage) => [stage.key, stage.state])).toEqual([
      ["run-sync", "blocked"],
      ["review-changes", "upcoming"],
      ["create-items", "blocked"],
    ]);

    const synced = withReview(withReadiness(base, { blockers: [] }), {
      counts: { ...base.sourceObservationReview.counts, changed: 1 },
      promotionReadyCount: 0,
    });
    const flow = catalogPrimaryWorkbenchDailyFlowFor({
      ...synced,
      promotionPreview: { ...synced.promotionPreview, blockers: [] },
    });
    expect(flow.openStage).toBe("review-changes");
    expect(flow.stages.map((stage) => [stage.key, stage.state])).toEqual([
      ["run-sync", "complete"],
      ["review-changes", "current"],
      ["create-items", "upcoming"],
    ]);
  });

  it("derives the states for a stage the operator opened", () => {
    const stage = { key: "review-changes", blocked: false, done: false } as const;
    expect(catalogPrimaryWorkbenchFlowStageState(stage, "run-sync")).toBe("upcoming");
    expect(catalogPrimaryWorkbenchFlowStageState(stage, "review-changes")).toBe("current");
    expect(catalogPrimaryWorkbenchFlowStageState(stage, "create-items")).toBe("complete");
    expect(catalogPrimaryWorkbenchFlowStageState({ ...stage, done: true }, "run-sync")).toBe("complete");
    expect(catalogPrimaryWorkbenchFlowStageState({ ...stage, blocked: true }, "review-changes")).toBe("blocked");
  });

  it.each(["readiness", "promotion"] as const)("blocks only the %s stage for isolated blockers", (kind) => {
    const base = nothingToReview(dailyReadModel("providerKey=tcgdex"));
    const model = {
      ...base,
      readiness: { ...base.readiness, blockers: kind === "readiness" ? ["rbac-missing" as const] : [] },
      promotionPreview: { ...base.promotionPreview, blockers: kind === "promotion" ? ["rbac-missing" as const] : [] },
    };
    const flow = catalogPrimaryWorkbenchDailyFlowFor(model);
    for (const selected of ["run-sync", "review-changes", "create-items"] as const) {
      expect(
        flow.stagesByOpenStage[selected].filter((stage) => stage.state === "blocked").map((stage) => stage.key),
      ).toEqual([kind === "readiness" ? "run-sync" : "create-items"]);
    }
    expect(flow.stages).toEqual(flow.stagesByOpenStage[flow.openStage]);
    expect(flow.stages.every((stage) => !("blocked" in stage) && !("done" in stage))).toBe(true);
  });

  it("publishes the flow on the read model", () => {
    const model = dailyReadModel("providerKey=tcgdex&filter.status=changed", { total: 1, offset: 0 });
    expect(model.flow).toEqual(catalogPrimaryWorkbenchDailyFlowFor(model));
    expect(model.dailyStatus).toEqual(catalogPrimaryWorkbenchDailyStatusFor(model));
  });
});

describe("Catalog primary workbench daily status", () => {
  const nominal = withReadiness(dailyReadModel("providerKey=tcgdex"), {
    blockers: [],
    providerTransport: [],
    freshness: "fresh",
    rbacAllowed: true,
    rolloutEnabled: true,
  });
  const status = (model: CatalogPrimaryWorkbenchReadModel) => catalogPrimaryWorkbenchDailyStatusFor(model);

  it("shows no banner when governance and health are nominal", () => {
    expect(
      status({ ...nominal, actions: nominal.actions.map((action) => ({ ...action, state: "available" as const })) }),
    ).toEqual({
      governance: null,
      health: null,
    });
  });

  it("says denied for RBAC, a denied action or a denial blocker, before stopped", () => {
    const nominalActions = nominal.actions.map((action) => ({ ...action, state: "available" as const }));
    const quiet = { ...nominal, actions: nominalActions };
    for (const blocker of ["permission-denied", "authorization-denied", "rbac-missing"] as const) {
      expect(status(withReadiness(quiet, { blockers: [blocker], rolloutEnabled: false })).governance).toBe("denied");
      expect(
        status({ ...quiet, promotionPreview: { ...quiet.promotionPreview, blockers: [blocker, "rollout-disabled"] } })
          .governance,
      ).toBe("denied");
    }
    for (const blocker of ["rollout-disabled", "kill-switch-active"] as const) {
      expect(status(withReadiness(quiet, { blockers: [blocker] })).governance).toBe("stopped");
      expect(
        status({ ...quiet, promotionPreview: { ...quiet.promotionPreview, blockers: [blocker] } }).governance,
      ).toBe("stopped");
    }
    expect(status(withReadiness(quiet, { rbacAllowed: false, rolloutEnabled: false })).governance).toBe("denied");
    expect(
      status({ ...quiet, actions: [{ ...nominalActions[0]!, state: "denied" as const }, ...nominalActions.slice(1)] })
        .governance,
    ).toBe("denied");
    expect(status(withReadiness(quiet, { blockers: ["rbac-missing", "kill-switch-active"] })).governance).toBe(
      "denied",
    );
    expect(status(withReadiness(quiet, { rolloutEnabled: false })).governance).toBe("stopped");
    expect(
      status({ ...quiet, promotionPreview: { ...quiet.promotionPreview, blockers: ["kill-switch-active"] } })
        .governance,
    ).toBe("stopped");
  });

  it("says blocked for a blocking transport and degraded for other transport, stale readiness or a failed job", () => {
    expect(status(withReadiness(nominal, { providerTransport: ["partial-data", "timeout"] })).health).toBe("blocked");
    expect(status(withReadiness(nominal, { providerTransport: ["pagination-failure"] })).health).toBe("blocked");
    expect(status(withReadiness(nominal, { providerTransport: ["degraded-provider"] })).health).toBe("blocked");
    expect(status(withReadiness(nominal, { providerTransport: ["rate-limit"] })).health).toBe("degraded");
    expect(status(withReadiness(nominal, { freshness: "stale" })).health).toBe("degraded");
    expect(status({ ...nominal, importJobs: { ...nominal.importJobs, failedJobCount: 1 } }).health).toBe("degraded");
  });
});

describe("Catalog primary workbench review links", () => {
  const query = "providerKey=tcgdex&filter.status=changed&filter.language=en&reviewLimit=25";

  it("links the neighbouring pages of a three-page queue and closes both ends", () => {
    const pages = [0, 25, 50].map((offset) => dailyReadModel(`${query}&reviewOffset=${offset}`, { total: 75, offset }));
    const links = pages.map((model) => model.sourceObservationReview.pagination);

    expect(links[0]?.previousHref).toBeNull();
    expect(links[2]?.nextHref).toBeNull();
    // The links admin-web's pager built from the route context before the API carried them.
    pages.forEach((model, index) => {
      const { offset, limit } = model.sourceObservationReview.pagination;
      if (index > 0) {
        expect(links[index]?.previousHref).toBe(
          catalogPrimaryWorkbenchHref(
            { ...model.routeContext, reviewOffset: Math.max(offset - limit, 0) || null },
            "source-observation-review",
          ),
        );
      }
      if (index < 2) {
        expect(links[index]?.nextHref).toBe(
          catalogPrimaryWorkbenchHref(
            { ...model.routeContext, reviewOffset: offset + limit },
            "source-observation-review",
          ),
        );
      }
    });
    expect(new URL(links[1]!.previousHref!, "https://admin.example").searchParams.get("reviewOffset")).toBeNull();
    expect(new URL(links[1]!.nextHref!, "https://admin.example").searchParams.get("reviewOffset")).toBe("50");
  });

  it("gives each status option its count and the link the segmented control navigated to", () => {
    const model = dailyReadModel(`${query}&reviewOffset=25`, { total: 75, offset: 25 });
    const { counts, statusFilters } = model.sourceObservationReview;

    expect(statusFilters.map((option) => [option.value, option.count])).toEqual([
      ["all", counts.observed + counts.changed + counts.promoted + counts.rejected],
      ["observed", counts.observed],
      ["eligible", counts.eligible],
      ["promoted", counts.promoted],
      ["rejected", counts.rejected],
    ]);
    for (const option of statusFilters) {
      // admin-web's former selectStatus: the daily link without the page, with filter.status set or cleared.
      const before = new URL(
        catalogPrimaryWorkbenchHref(model.routeContext, "import-to-promotion"),
        "https://admin.example",
      );
      before.searchParams.delete("status");
      before.searchParams.delete("reviewOffset");
      if (option.value === "all") before.searchParams.delete("filter.status");
      else before.searchParams.set("filter.status", option.value);
      const after = new URL(option.href, "https://admin.example");

      expect(after.pathname).toBe(before.pathname);
      expect([...after.searchParams].sort()).toEqual([...before.searchParams].sort());
    }
  });
});
