// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { useLiveImportJobs, type LiveImportJobsState } from "./use-live-import-jobs";

const mocks = vi.hoisted(() => ({
  revalidate: vi.fn(),
}));

vi.mock("react-router", () => ({
  useRevalidator: () => ({ revalidate: mocks.revalidate }),
}));

type ImportJobRow = CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number];

// The hook only reads `readModel.importJobs.{activeJobCount, jobs}` — build the
// smallest typed slice that exercises it rather than the full read-model fixture.
function jobRow(overrides: Partial<ImportJobRow> = {}): ImportJobRow {
  return {
    jobId: "job-1",
    action: "scope.import",
    state: "running",
    operatorStatus: "running",
    summary: "tcgdex import",
    completed: 5,
    total: 10,
    progressPercent: 50,
    unitKey: null,
    providerKey: "tcgdex",
    importScope: null,
    profileVersion: null,
    profileSnapshot: null,
    scopeMatchesRoute: true,
    createdAt: "2026-06-18T00:00:00.000Z",
    startedAt: "2026-06-18T00:00:01.000Z",
    consistency: {
      schemaVersion: "catalog-integration-durable-job-v1",
      compatibilityPolicy: "integration-durable-job",
      duplicateSubmissionPolicy: "reuse-active-job",
      profileSnapshotPolicy: "snapshotted-at-enqueue",
      retryResumePolicy: "skip-completed-outcomes",
      partialFailurePolicy: "mixed-outcomes",
      workUnitClaimPolicy: "leased-work-units",
    },
    failureGroups: [],
    retryAvailable: false,
    resumeAvailable: false,
    cancelAvailable: true,
    sourceObservationReviewHref: "/catalog/integrations",
    auditEvidenceUrl: "/catalog/integrations",
    observationLinks: [],
    result: null,
    blockers: [],
    ...overrides,
  } as ImportJobRow;
}

function readModel(activeJobCount: number, jobs: readonly ImportJobRow[]): CatalogPrimaryWorkbenchReadModel {
  return {
    importJobs: { activeJobCount, jobs },
  } as unknown as CatalogPrimaryWorkbenchReadModel;
}

let latest: LiveImportJobsState;

function Probe({
  model,
  pendingJobDiscovery = false,
  pendingJobDiscoveryKey = null,
  pendingJobDiscoveryMs,
  pollMs,
}: Readonly<{
  model: CatalogPrimaryWorkbenchReadModel;
  pendingJobDiscovery?: boolean;
  pendingJobDiscoveryKey?: string | null;
  pendingJobDiscoveryMs?: number;
  pollMs?: number;
}>) {
  latest = useLiveImportJobs(model, { pendingJobDiscovery, pendingJobDiscoveryKey, pendingJobDiscoveryMs, pollMs });
  return null;
}

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
}

describe("useLiveImportJobs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.revalidate.mockReset();
    setDocumentHidden(false);
  });

  afterEach(() => {
    // Unmount probes between tests: this workspace's vitest config does not enable
    // globals, so testing-library's auto-cleanup is not registered and a left-over
    // mounted probe would keep its live interval running into the next test.
    cleanup();
    vi.useRealTimers();
  });

  it("does not poll when no jobs are active", () => {
    render(<Probe model={readModel(0, [jobRow({ state: "completed" })])} pollMs={1_000} />);

    expect(latest.live).toBe(false);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("revalidates on the interval while a job is active", () => {
    render(<Probe model={readModel(1, [jobRow()])} pollMs={1_000} />);

    expect(latest.live).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledTimes(3);
  });

  it("temporarily polls after a queued command before the active job projects", () => {
    render(
      <Probe
        model={readModel(0, [])}
        pendingJobDiscovery
        pendingJobDiscoveryKey="scope.import:tcgdex:ja:SV8"
        pendingJobDiscoveryMs={2_500}
        pollMs={1_000}
      />,
    );

    expect(latest.live).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(latest.live).toBe(false);
    const callsAfterDiscoveryTimeout = mocks.revalidate.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledTimes(callsAfterDiscoveryTimeout);
  });

  it("hands off queued-command discovery to active-job polling", () => {
    const { rerender } = render(
      <Probe
        model={readModel(0, [])}
        pendingJobDiscovery
        pendingJobDiscoveryKey="scope.import:tcgdex:ja:SV8"
        pendingJobDiscoveryMs={2_500}
        pollMs={1_000}
      />,
    );

    expect(latest.live).toBe(true);

    rerender(
      <Probe
        model={readModel(1, [jobRow()])}
        pendingJobDiscovery
        pendingJobDiscoveryKey="scope.import:tcgdex:ja:SV8"
        pendingJobDiscoveryMs={2_500}
        pollMs={1_000}
      />,
    );
    expect(latest.live).toBe(true);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledTimes(3);
  });

  it("stops polling once jobs settle on a terminal state", () => {
    const { rerender } = render(<Probe model={readModel(1, [jobRow()])} pollMs={1_000} />);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);

    rerender(
      <Probe
        model={readModel(0, [jobRow({ state: "completed", completed: 10, progressPercent: 100 })])}
        pollMs={1_000}
      />,
    );
    expect(latest.live).toBe(false);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // No further revalidations after the job settled.
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
  });

  it("pauses polling while the tab is hidden and resumes when visible", () => {
    render(<Probe model={readModel(1, [jobRow()])} pollMs={1_000} />);
    expect(latest.live).toBe(true);

    act(() => {
      setDocumentHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(latest.live).toBe(false);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();

    act(() => {
      setDocumentHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(latest.live).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    // Polling resumes and fires on the next interval tick after the tab is visible.
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
  });

  it("ignores a regressing server snapshot so progress stays monotonic", () => {
    const { rerender } = render(
      <Probe model={readModel(1, [jobRow({ completed: 6, progressPercent: 60 })])} pollMs={1_000} />,
    );

    expect(latest.jobProgress.get("job-1")).toMatchObject({ completed: 6, progressPercent: 60 });

    // An out-of-order read regresses completed; the gated value must not move back.
    rerender(<Probe model={readModel(1, [jobRow({ completed: 4, progressPercent: 40 })])} pollMs={1_000} />);
    expect(latest.jobProgress.get("job-1")).toMatchObject({ completed: 6, progressPercent: 60 });

    // A forward read advances it.
    rerender(<Probe model={readModel(1, [jobRow({ completed: 8, progressPercent: 80 })])} pollMs={1_000} />);
    expect(latest.jobProgress.get("job-1")).toMatchObject({ completed: 8, progressPercent: 80 });
  });

  it("always accepts a terminal snapshot even if completed appears lower", () => {
    const { rerender } = render(
      <Probe model={readModel(1, [jobRow({ completed: 9, progressPercent: 90 })])} pollMs={1_000} />,
    );
    expect(latest.jobProgress.get("job-1")).toMatchObject({ completed: 9 });

    rerender(
      <Probe
        model={readModel(0, [jobRow({ state: "failed", completed: 7, total: 10, progressPercent: 70 })])}
        pollMs={1_000}
      />,
    );
    // Terminal phases are always accepted by the reducer, so the settled snapshot wins.
    expect(latest.jobProgress.get("job-1")).toMatchObject({ completed: 7, progressPercent: 70 });
  });

  it("clears the interval on unmount", () => {
    const { unmount } = render(<Probe model={readModel(1, [jobRow()])} pollMs={1_000} />);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);

    unmount();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
  });
});
