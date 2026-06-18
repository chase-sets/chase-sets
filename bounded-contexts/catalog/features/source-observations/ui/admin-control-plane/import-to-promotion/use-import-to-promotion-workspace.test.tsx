// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../primary-workbench-route-context";
import {
  useImportToPromotionWorkspace,
  type ImportToPromotionStageKey,
  type ImportToPromotionWorkspaceState,
} from "./use-import-to-promotion-workspace";

// The hook persists every selection change to the URL via the #1969 client-GET
// submit idiom; capture that submit so the persistence and its target href can be
// asserted without a data router. The hook only reaches for `useSubmit`.
const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
}));

vi.mock("react-router", () => ({
  useSubmit: () => mocks.submit,
}));

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

function lastSubmitTarget(): string {
  const lastCall = mocks.submit.mock.calls.at(-1);
  return (lastCall?.[1] as { action: string }).action;
}

describe("useImportToPromotionWorkspace — stage reconciliation with server truth", () => {
  beforeEach(() => {
    mocks.submit.mockReset();
  });

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
});

describe("useImportToPromotionWorkspace — URL-backed selection (single source of truth)", () => {
  beforeEach(() => {
    mocks.submit.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("seeds the ephemeral selection from the URL", () => {
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

  it("persists a selection change to the URL as a client GET navigation and updates the mirror instantly", () => {
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

    // Instant mirror: the checkbox reflects the new selection without waiting on the
    // revalidation round-trip.
    expect([...latest.selectedObservationKeys]).toEqual(["obs_1"]);

    // Persisted to the URL via the #1969 idiom: a replace GET navigation that
    // preserves scroll, with the new selection on the target href.
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    const submitOptions = mocks.submit.mock.calls[0]![1] as Record<string, unknown>;
    expect(submitOptions).toMatchObject({ method: "get", replace: true, preventScrollReset: true });
    const target = new URL(lastSubmitTarget(), "https://admin.example");
    expect(target.searchParams.get("selectedObservationIds")).toBe("obs_1");
    expect(target.searchParams.get("providerKey")).toBe("tcgdex");
  });

  it("clears the selection through the same URL write (no manual Save context round-trip)", () => {
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
    const target = new URL(lastSubmitTarget(), "https://admin.example");
    expect(target.searchParams.get("selectedObservationIds")).toBeNull();
  });

  it("adopts a navigation-driven URL selection (deep link / pager) into the mirror", () => {
    const { rerender } = render(
      <Probe
        model={readModel({
          requestUrl: "https://admin.example/catalog/integrations?providerKey=tcgdex&selectedObservationIds=obs_1",
          review: { rows: [reviewRow("obs_1")], counts: { observed: 1, changed: 1 } },
        })}
      />,
    );
    expect([...latest.selectedObservationKeys]).toEqual(["obs_1"]);

    // A pager / deep-link navigation lands a new URL selection — the new durable
    // truth — so the ephemeral mirror re-seeds from it.
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
