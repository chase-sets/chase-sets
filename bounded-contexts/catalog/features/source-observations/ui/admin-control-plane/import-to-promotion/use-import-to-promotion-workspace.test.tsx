// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../primary-workbench-route-context";
import {
  useImportToPromotionWorkspace,
  type ImportToPromotionWorkspaceState,
} from "./use-import-to-promotion-workspace";

type ReviewRows = CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"];
type ReviewCounts = CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["counts"];
// Only the review fields the hook actually reads, each optional so a test states
// just the slice it exercises. Counts is partial (the hook reads only `changed`),
// completed to the full set inside the builder.
type ReviewSlice = Readonly<{
  rows?: ReviewRows;
  promotionReadyCount?: number;
  counts?: Partial<ReviewCounts>;
}>;

// Build the smallest typed read model the hook reads: the route context (real, so
// the persisted href serializes), the review slice (drives the server-derived
// stage + selection-impact counts), the promotion preview/result (drive the stage),
// and the two blocker lists. Everything else is irrelevant to this hook.
function readModel(
  options: Readonly<{
    requestUrl?: string;
    review?: ReviewSlice;
    previewId?: string | null;
    promotionResult?: CatalogPrimaryWorkbenchReadModel["promotionResult"];
  }> = {},
): CatalogPrimaryWorkbenchReadModel {
  const routeContext = parseCatalogPrimaryWorkbenchRouteContext(
    options.requestUrl ?? "https://admin.example/catalog/integrations?providerKey=tcgdex",
  );

  return {
    routeContext,
    readiness: { blockers: [] },
    promotionPreview: { previewId: options.previewId ?? null, blockers: [] },
    promotionResult: options.promotionResult ?? null,
    sourceObservationReview: {
      rows: options.review?.rows ?? [],
      promotionReadyCount: options.review?.promotionReadyCount ?? 0,
      counts: { observed: 0, changed: 0, promoted: 0, rejected: 0, eligible: 0, blocked: 0, ...options.review?.counts },
    },
  } as unknown as CatalogPrimaryWorkbenchReadModel;
}

// A reviewable row the hook can count for selection impact. The hook only reads
// `observationId` and `promotionReadiness.state` plus the `isReviewableObservationRow`
// inputs (`status`).
function reviewRow(
  observationId: string,
  overrides: Partial<CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]> = {},
): CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number] {
  return {
    observationId,
    status: "changed",
    promotionReadiness: { state: "eligible", blockers: [] },
    ...overrides,
  } as unknown as CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number];
}

let latest: ImportToPromotionWorkspaceState;

function Probe({ model }: Readonly<{ model: CatalogPrimaryWorkbenchReadModel }>) {
  latest = useImportToPromotionWorkspace(model);
  return null;
}

describe("useImportToPromotionWorkspace — stage reconciliation with server truth", () => {
  afterEach(() => {
    // No globals in this workspace's vitest config, so testing-library's auto
    // cleanup is not registered; unmount probes between tests explicitly.
    cleanup();
  });

  it("lands on the server-derived stage with nothing to review", () => {
    render(<Probe model={readModel()} />);
    expect(latest.activeStage).toBe("run-sync");
  });

  it("derives the review stage when there are changes to review", () => {
    render(
      <Probe model={readModel({ review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } } })} />,
    );
    expect(latest.activeStage).toBe("review-changes");
  });

  it("opens the review stage for a Source Observation review route handoff even when no rows changed", () => {
    render(
      <Probe
        model={readModel({
          requestUrl: "https://admin.example/catalog/integrations?section=source-observation-review&providerKey=tcgdex",
        })}
      />,
    );
    expect(latest.activeStage).toBe("review-changes");
  });

  it("opens the create stage for promotion route handoffs", () => {
    render(
      <Probe
        model={readModel({
          requestUrl: "https://admin.example/catalog/integrations?section=promotion-preview&providerKey=tcgdex",
        })}
      />,
    );
    expect(latest.activeStage).toBe("create-items");
  });

  it("derives the create stage once a promotion preview exists", () => {
    render(<Probe model={readModel({ previewId: "preview_1" })} />);
    expect(latest.activeStage).toBe("create-items");
  });

  it("follows server truth after an in-place command moves the work (the core fix)", () => {
    // Before: nothing to review yet, so the stepper sits on Run sync.
    const { rerender } = render(<Probe model={readModel()} />);
    expect(latest.activeStage).toBe("run-sync");

    // An in-place command returns data (no redirect) and the revalidated read model
    // now carries changes to review. The recomputed default must be honored — the
    // old `useState(useMemo(...))` froze it on the mount value and stayed on Run sync.
    rerender(
      <Probe model={readModel({ review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } } })} />,
    );
    expect(latest.activeStage).toBe("review-changes");

    // A promotion preview lands: the stepper advances to Create / update items
    // without any manual stage change.
    rerender(
      <Probe
        model={readModel({
          previewId: "preview_1",
          review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } },
        })}
      />,
    );
    expect(latest.activeStage).toBe("create-items");
  });

  it("keeps an explicit stage click through an in-place revalidation that does not move the work", () => {
    // Server truth is the review stage (there are changes), but the operator opens
    // Run sync to pull more provider data.
    const model = readModel({ review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } } });
    const { rerender } = render(<Probe model={model} />);
    expect(latest.activeStage).toBe("review-changes");

    act(() => {
      latest.setActiveStage("run-sync");
    });
    expect(latest.activeStage).toBe("run-sync");

    // A #1968 poll / #1969 fetcher submit refreshes the read model in place but the
    // work has not moved (same review state) — the explicit choice must survive.
    rerender(
      <Probe model={readModel({ review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } } })} />,
    );
    expect(latest.activeStage).toBe("run-sync");
  });

  it("lets the next command override an explicit stage click", () => {
    const model = readModel({ review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } } });
    const { rerender } = render(<Probe model={model} />);

    act(() => {
      latest.setActiveStage("run-sync");
    });
    expect(latest.activeStage).toBe("run-sync");

    // A command moves the work (a promotion preview now exists): server truth wins
    // and the override is discarded.
    rerender(
      <Probe
        model={readModel({
          previewId: "preview_1",
          review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } },
        })}
      />,
    );
    expect(latest.activeStage).toBe("create-items");
  });

  it("lets an explicit stage click win over a route-section handoff until the route target changes", () => {
    const { rerender } = render(
      <Probe
        model={readModel({
          requestUrl: "https://admin.example/catalog/integrations?section=source-observation-review&providerKey=tcgdex",
        })}
      />,
    );
    expect(latest.activeStage).toBe("review-changes");

    act(() => {
      latest.setActiveStage("run-sync");
    });
    expect(latest.activeStage).toBe("run-sync");

    rerender(
      <Probe
        model={readModel({
          requestUrl: "https://admin.example/catalog/integrations?section=promotion-preview&providerKey=tcgdex",
        })}
      />,
    );
    expect(latest.activeStage).toBe("create-items");
  });
});

describe("useImportToPromotionWorkspace — durable (storage-backed) selection", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
  });

  it("seeds the ephemeral selection from the URL when the URL carries one (deep link)", () => {
    render(
      <Probe
        model={readModel({
          requestUrl:
            "https://admin.example/catalog/integrations?providerKey=tcgdex&selectedObservationIds=obs_1,obs_2",
          review: { rows: [reviewRow("obs_1"), reviewRow("obs_2")], counts: { observed: 2, changed: 2 } },
        })}
      />,
    );
    expect([...latest.selectedObservationKeys].sort()).toEqual(["obs_1", "obs_2"]);
  });

  it("persists a selection change to durable storage instantly, without any URL write", () => {
    render(
      <Probe
        model={readModel({
          requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
          review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } },
        })}
      />,
    );

    act(() => {
      latest.setSelectedObservationKeys(new Set(["obs_1"]));
    });

    // Instant mirror: the checkbox reflects the new selection immediately.
    expect([...latest.selectedObservationKeys]).toEqual(["obs_1"]);

    // Durable: sessionStorage carries the working set for this scope, not the URL.
    const stored = window.sessionStorage.getItem("catalog.primaryWorkbench.observationSelection.tcgdex|none|none|none");
    expect(stored).toBe(JSON.stringify(["obs_1"]));
  });

  it("survives an unmount/remount with no URL selection — a reload with no deep link (the core fix)", () => {
    const model = readModel({
      requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
      review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } },
    });
    const { unmount } = render(<Probe model={model} />);

    act(() => {
      latest.setSelectedObservationKeys(new Set(["obs_1"]));
    });
    expect([...latest.selectedObservationKeys]).toEqual(["obs_1"]);

    // Simulate a reload: unmount, then mount fresh against the same URL (which
    // never carried the selection — it lives in storage, not the query string).
    unmount();
    render(<Probe model={model} />);

    expect([...latest.selectedObservationKeys]).toEqual(["obs_1"]);
  });

  it("clears the durable working set when the selection empties", () => {
    render(
      <Probe
        model={readModel({
          requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&selectedObservationIds=obs_1",
          review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } },
        })}
      />,
    );
    expect([...latest.selectedObservationKeys]).toEqual(["obs_1"]);

    act(() => {
      latest.setSelectedObservationKeys(new Set());
    });

    expect([...latest.selectedObservationKeys]).toEqual([]);
    expect(
      window.sessionStorage.getItem("catalog.primaryWorkbench.observationSelection.tcgdex|none|none|none"),
    ).toBeNull();
  });

  it("adopts a navigation-driven URL selection (deep link / pager) into the mirror and durable store", () => {
    const { rerender } = render(
      <Probe
        model={readModel({
          requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&selectedObservationIds=obs_1",
          review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } },
        })}
      />,
    );
    expect([...latest.selectedObservationKeys]).toEqual(["obs_1"]);

    // A pager / deep-link navigation lands a new URL selection — folded into the
    // ephemeral mirror and the durable store alike.
    rerender(
      <Probe
        model={readModel({
          requestUrl:
            "https://admin.example/catalog/integrations?providerKey=tcgdex&selectedObservationIds=obs_2,obs_3&reviewOffset=25",
          review: { rows: [reviewRow("obs_2"), reviewRow("obs_3")], counts: { observed: 2, changed: 2 } },
        })}
      />,
    );
    expect([...latest.selectedObservationKeys].sort()).toEqual(["obs_2", "obs_3"]);
  });

  it("keeps a 500-row selection durable without ever writing it to the URL", () => {
    render(
      <Probe
        model={readModel({
          requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
          review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } },
        })}
      />,
    );
    const bulkIds = Array.from({ length: 500 }, (_, index) => `obs_${index}`);

    act(() => {
      latest.setSelectedObservationKeys(new Set(bulkIds));
    });

    expect(latest.selectedObservationKeys.size).toBe(500);
    const stored = window.sessionStorage.getItem("catalog.primaryWorkbench.observationSelection.tcgdex|none|none|none");
    expect(JSON.parse(stored ?? "[]")).toHaveLength(500);
  });

  it("scopes the durable working set per provider/unit/import-scope/profile", () => {
    const { unmount } = render(
      <Probe
        model={readModel({
          requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex",
          review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } },
        })}
      />,
    );
    act(() => {
      latest.setSelectedObservationKeys(new Set(["obs_1"]));
    });
    unmount();

    // A different provider scope starts with an empty durable selection — the
    // tcgdex working set does not leak into it.
    render(
      <Probe
        model={readModel({
          requestUrl: "https://admin.example/catalog/integrations?providerKey=scryfall",
          review: { rows: [reviewRow("obs_x")], counts: { observed: 1, changed: 1 } },
        })}
      />,
    );
    expect([...latest.selectedObservationKeys]).toEqual([]);
  });

  it("computes selection-impact counts (eligible / reviewable) from the mirrored rows", () => {
    render(
      <Probe
        model={readModel({
          requestUrl:
            "https://admin.example/catalog/integrations?providerKey=tcgdex&selectedObservationIds=obs_eligible,obs_blocked",
          review: {
            rows: [
              reviewRow("obs_eligible", { status: "changed", promotionReadiness: { state: "eligible", blockers: [] } }),
              reviewRow("obs_blocked", { status: "observed", promotionReadiness: { state: "blocked", blockers: [] } }),
              reviewRow("obs_unselected", {
                status: "changed",
                promotionReadiness: { state: "eligible", blockers: [] },
              }),
            ],
            counts: { observed: 3, changed: 2 },
          },
        })}
      />,
    );

    // Both selected rows are reviewable (observed/changed); only one is eligible.
    expect(latest.selectedReviewableObservationCount).toBe(2);
    expect(latest.selectedEligibleObservationCount).toBe(1);
  });
});
