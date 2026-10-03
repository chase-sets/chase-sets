// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogIntegrationRecentJobSummary } from "../../contracts";
import type { CatalogPrimaryWorkbenchReadModel } from "../../../api/primary-workbench-admin-contracts";
import { buildCatalogPrimaryWorkbenchReadModelForSurface } from "../../primary-workbench-read-model";
import {
  controlPlaneOverview,
  integrationJobSummary,
  profileReview,
  sourceObservationScope,
} from "../../primary-workbench-test-fixtures";
import { CatalogIntegrationImportJobsModule } from "./import-jobs-module";

const revalidate = vi.hoisted(() => vi.fn());

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useRevalidator: () => ({ revalidate, state: "idle" }),
  };
});

afterEach(() => {
  cleanup();
  revalidate.mockReset();
  vi.useRealTimers();
});

describe("CatalogIntegrationImportJobsModule", () => {
  it("contains a rejected import preview and keeps import operations mounted", async () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=scrydex:one-piece:single-card:source-observation-import&importScope=en:one-piece:op-01",
      scopes: { items: [sourceObservationScope({ provider_key: "scrydex" })], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ active: true, lifecycle: "active", providerKey: "scrydex" })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });
    const deferredImportPreview = Promise.reject(new Error("preview failed"));
    void deferredImportPreview.catch(() => undefined);

    await act(async () => {
      render(
        <CatalogIntegrationImportJobsModule readModel={readModel} deferredImportPreview={deferredImportPreview} />,
      );
    });

    await waitFor(() => {
      const banner = document.querySelector('[data-catalog-deferred-panel="unavailable"]');
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toContain("Import preflight");
      expect(screen.getByText("Provider import operations")).toBeTruthy();
    });
  });

  it("keeps secondary job timestamps out of the mobile card presentation", () => {
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
      scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
      profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
      controlPlaneOverview: controlPlaneOverview(),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationImportJobsModule readModel={readModel} />);

    const createdTimestamps = screen.getAllByText("Created 2026-06-09T00:59:00.000Z");
    const startedTimestamps = screen.getAllByText("Started 2026-06-09T01:00:00.000Z");

    expect(createdTimestamps).toHaveLength(2);
    expect(startedTimestamps).toHaveLength(2);
    for (const timestamp of [...createdTimestamps, ...startedTimestamps]) {
      expect(timestamp.parentElement?.className).toContain("hidden sm:block");
    }
  });

  it("shows observed usage counts, labels unavailable counts honestly, and omits unavailable cache counts", () => {
    const baseOverview = controlPlaneOverview();
    const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
      requestUrl:
        "https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=scrydex:one-piece:single-card:source-observation-import&importScope=en:one-piece:op-01",
      scopes: { items: [sourceObservationScope({ provider_key: "scrydex" })], total: 1, count: 1 },
      profileReviews: {
        items: [profileReview({ active: true, lifecycle: "active", providerKey: "scrydex" })],
        total: 1,
        count: 1,
      },
      controlPlaneOverview: controlPlaneOverview({
        unitActivity: {
          ...baseOverview.unitActivity,
          units: [
            {
              unitKey: "scrydex:one-piece:single-card:source-observation-import",
              recentJobs: [
                integrationJobSummary({
                  providerKey: "scrydex",
                  result: {
                    requested: 1,
                    imported: 1,
                    observed: 1,
                    reapplied: 0,
                    skipped: 0,
                    failed: 0,
                    outcomeCount: 1,
                    redactedFailureReasons: [],
                    usage: { actualRequestCount: 2, pageCount: 2, cacheHitCount: null, cacheMissCount: null },
                  },
                }),
                integrationJobSummary({
                  jobId: "job_usage_unavailable",
                  providerKey: "scrydex",
                  result: {
                    requested: 1,
                    imported: 0,
                    observed: 0,
                    reapplied: 0,
                    skipped: 0,
                    failed: 1,
                    outcomeCount: 1,
                    redactedFailureReasons: [],
                    usage: {
                      actualRequestCount: null,
                      pageCount: null,
                      cacheHitCount: null,
                      cacheMissCount: null,
                    },
                  },
                }),
              ],
            },
          ],
        },
      }),
      canManageCatalog: true,
    });

    render(<CatalogIntegrationImportJobsModule readModel={readModel} />);

    expect(screen.getAllByText("Requests: 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pages: 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Requests: Unavailable").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pages: Unavailable").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Cache:/)).toBeNull();
    expect(screen.queryByText(/not selected/)).toBeNull();
  });

  describe("TCGplayer operator status filter", () => {
    it("shows the loaded window under All statuses and exactly matching operator statuses in original order", () => {
      const readModel = tcgplayerReadModel(statusMatrixJobs());
      const loadedIds = readModel.importJobs.jobs.map((job) => job.jobId);

      render(<CatalogIntegrationImportJobsModule readModel={readModel} />);

      expect(statusSelect().value).toBe("all");
      expect(optionValues()).toEqual([
        "all",
        "queued",
        "running",
        "stale",
        "retried",
        "partial",
        "failed",
        "cancelled",
        "completed",
      ]);
      expect(visibleJobIds()).toEqual(loadedIds);

      const expectedByStatus: Record<string, readonly string[]> = {
        queued: ["job_queued"],
        running: ["job_running"],
        stale: ["job_stale"],
        retried: ["job_failed_retried"],
        partial: ["job_completed_partial_newer", "job_completed_partial_older"],
        failed: ["job_failed"],
        cancelled: ["job_cancelled"],
        completed: ["job_completed"],
      };
      for (const [status, expectedIds] of Object.entries(expectedByStatus)) {
        selectStatus(status);

        expect(statusSelect().value).toBe(status);
        expect(visibleJobIds()).toEqual(expectedIds);
        expect(visibleJobIds()).toEqual(loadedIds.filter((jobId) => expectedIds.includes(jobId)));
      }

      selectStatus("all");
      expect(visibleJobIds()).toEqual(loadedIds);
    });

    it("matches operatorStatus, not durable state, for a frozen snapshot", () => {
      const readModel = tcgplayerReadModel(statusMatrixJobs());
      expect(jobState(readModel, "job_completed_partial_older")).toBe("completed");
      expect(jobState(readModel, "job_failed_retried")).toBe("failed");
      const { rerender } = render(<CatalogIntegrationImportJobsModule readModel={readModel} />);
      selectStatus("partial");
      expect(visibleJobIds()).toEqual(["job_completed_partial_newer", "job_completed_partial_older"]);

      // Only operatorStatus changes; durable state, order, counts and IDs stay frozen.
      rerender(
        <CatalogIntegrationImportJobsModule
          readModel={withJobOverrides(readModel, { job_completed_partial_older: { operatorStatus: "completed" } })}
        />,
      );
      expect(visibleJobIds()).toEqual(["job_completed_partial_newer"]);

      selectStatus("completed");
      expect(visibleJobIds()).toEqual(["job_completed_partial_older", "job_completed"]);
      selectStatus("failed");
      expect(visibleJobIds()).toEqual(["job_failed"]);
    });

    it("keeps the control and loaded total for a no-match filter and suggests adjusting filters", () => {
      const readModel = tcgplayerReadModel(terminalJobs());
      render(<CatalogIntegrationImportJobsModule readModel={readModel} />);
      const statusBefore = moduleStatusText();
      const textBefore = textOutsideFilterAndTable();

      selectStatus("queued");

      expect(statusSelect().value).toBe("queued");
      expect(optionValues()).toHaveLength(9);
      expect(visibleJobIds()).toEqual([]);
      expect(filterSummary()).toEqual({ "Recent jobs": "2", Queued: "0" });
      expect(screen.getByText("No Queued found")).toBeTruthy();
      expect(screen.getByText("Try adjusting your filters.")).toBeTruthy();
      expect(screen.queryByText("No durable import jobs for this context")).toBeNull();
      expect(screen.queryByText(/Start a scoped provider import/)).toBeNull();
      expect(moduleStatusText()).toBe(statusBefore);
      expect(textOutsideFilterAndTable()).toBe(textBefore);

      selectStatus("all");
      expect(filterSummary()).toEqual({ "Recent jobs": "2", "All statuses": "2" });
      expect(visibleJobIds()).toEqual(["job_completed_partial", "job_completed"]);
    });

    it("keeps existing start-import guidance for an empty loaded window", () => {
      render(<CatalogIntegrationImportJobsModule readModel={tcgplayerReadModel([])} />);

      expect(statusSelect().value).toBe("all");
      expect(filterSummary()).toEqual({ "Recent jobs": "0", "All statuses": "0" });
      expect(screen.getByText("No durable import jobs for this context")).toBeTruthy();
      expect(screen.getByText(/Start a scoped provider import/)).toBeTruthy();
      expect(screen.queryByText("Try adjusting your filters.")).toBeNull();
    });

    it("renders no status filter for other providers", () => {
      const readModel = buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
        requestUrl:
          "https://admin.example/catalog/integrations?providerKey=tcgdex&unitKey=tcgdex:pokemon:card:import&importScope=en:3:base:base1",
        scopes: { items: [sourceObservationScope()], total: 1, count: 1 },
        profileReviews: { items: [profileReview({ active: true, lifecycle: "active" })], total: 1, count: 1 },
        controlPlaneOverview: controlPlaneOverview(),
        canManageCatalog: true,
      });

      render(<CatalogIntegrationImportJobsModule readModel={readModel} />);

      expect(screen.queryByLabelText("Status")).toBeNull();
      expect(document.querySelector("[data-catalog-import-job-status-filter]")).toBeNull();
      expect(screen.queryByText("Recent jobs")).toBeNull();
      expect(visibleJobIds()).toEqual(readModel.importJobs.jobs.map((job) => job.jobId));
      expect(visibleJobIds().length).toBeGreaterThan(0);
    });

    it("keeps the selection across same-context refreshes and recomputes membership", () => {
      const initial = tcgplayerReadModel([
        tcgplayerJob("job_a", { operatorStatus: "running", phase: "processing", startedAt: at(3) }),
        tcgplayerJob("job_b", { operatorStatus: "completed", phase: "completed", startedAt: at(2) }),
      ]);
      const { rerender } = render(<CatalogIntegrationImportJobsModule readModel={initial} />);
      selectStatus("running");
      expect(visibleJobIds()).toEqual(["job_a"]);

      const reordered = tcgplayerReadModel([
        tcgplayerJob("job_c", { operatorStatus: "running", phase: "processing", startedAt: at(5) }),
        tcgplayerJob("job_b", { operatorStatus: "completed", phase: "completed", startedAt: at(6) }),
        tcgplayerJob("job_a", { operatorStatus: "running", phase: "processing", startedAt: at(4) }),
      ]);
      rerender(<CatalogIntegrationImportJobsModule readModel={reordered} />);
      expect(statusSelect().value).toBe("running");
      expect(reordered.importJobs.jobs.map((job) => job.jobId)).toEqual(["job_b", "job_c", "job_a"]);
      expect(visibleJobIds()).toEqual(["job_c", "job_a"]);

      const runningCompleted = tcgplayerReadModel([
        tcgplayerJob("job_c", { operatorStatus: "completed", phase: "completed", startedAt: at(5) }),
        tcgplayerJob("job_b", { operatorStatus: "completed", phase: "completed", startedAt: at(6) }),
        tcgplayerJob("job_a", { operatorStatus: "completed", phase: "completed", startedAt: at(4) }),
      ]);
      rerender(<CatalogIntegrationImportJobsModule readModel={runningCompleted} />);
      expect(statusSelect().value).toBe("running");
      expect(visibleJobIds()).toEqual([]);
      expect(filterSummary()).toEqual({ "Recent jobs": "3", Running: "0" });
      expect(screen.getByText("No Running found")).toBeTruthy();
    });

    it.each([
      ["unitKey", { unitKey: "tcgplayer:mtg:single-card:source-observation-import" }],
      ["importScope", { importScope: "en:3:base-set" }],
      ["scopeRecordId", { scopeRecordId: "scope_record_other" }],
      ["providerKey", { providerKey: "scrydex" }],
    ] as const)("resets the selection when %s changes and does not restore it on return", (_field, change) => {
      const readModel = tcgplayerReadModel(statusMatrixJobs());
      const loadedIds = readModel.importJobs.jobs.map((job) => job.jobId);
      const changed: CatalogPrimaryWorkbenchReadModel = {
        ...readModel,
        routeContext: { ...readModel.routeContext, ...change },
      };
      const { rerender } = render(<CatalogIntegrationImportJobsModule readModel={readModel} />);
      selectStatus("partial");
      expect(visibleJobIds()).toHaveLength(2);

      rerender(<CatalogIntegrationImportJobsModule readModel={changed} />);
      expect(visibleJobIds()).toEqual(loadedIds);
      if ("providerKey" in change) {
        expect(screen.queryByLabelText("Status")).toBeNull();
      } else {
        expect(statusSelect().value).toBe("all");
      }

      rerender(<CatalogIntegrationImportJobsModule readModel={readModel} />);
      expect(statusSelect().value).toBe("all");
      expect(visibleJobIds()).toEqual(loadedIds);
    });

    it("keeps polling while every active row is hidden and filter changes emit no request", () => {
      vi.useFakeTimers();
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const submitSpy = vi.fn((event: Event) => event.preventDefault());
      document.addEventListener("submit", submitSpy);
      try {
        const readModel = tcgplayerReadModel(statusMatrixJobs());
        expect(readModel.importJobs.activeJobCount).toBeGreaterThan(0);
        render(<CatalogIntegrationImportJobsModule readModel={readModel} />);
        const statusBefore = moduleStatusText();

        selectStatus("completed");
        selectStatus("queued");
        selectStatus("completed");
        expect(revalidate).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(submitSpy).not.toHaveBeenCalled();
        expect(visibleJobIds()).toEqual(["job_completed"]);
        expect(moduleStatusText()).toBe(statusBefore);
        expect(screen.getByText("Live")).toBeTruthy();

        act(() => {
          vi.advanceTimersByTime(4_000);
        });
        expect(revalidate).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        document.removeEventListener("submit", submitSpy);
        fetchSpy.mockRestore();
      }
    });

    it("keeps hidden rows in the monotonic progress cache so progress never regresses", () => {
      const advanced = tcgplayerReadModel([
        tcgplayerJob("job_running", { operatorStatus: "running", phase: "processing", completed: 12, total: 24 }),
        tcgplayerJob("job_completed", { operatorStatus: "completed", phase: "completed", startedAt: at(1) }),
      ]);
      const { rerender } = render(<CatalogIntegrationImportJobsModule readModel={advanced} />);
      expect(screen.getAllByText("12/24 work units, 50% complete").length).toBeGreaterThan(0);

      selectStatus("completed");
      const regressed = tcgplayerReadModel([
        tcgplayerJob("job_running", { operatorStatus: "running", phase: "processing", completed: 3, total: 24 }),
        tcgplayerJob("job_completed", { operatorStatus: "completed", phase: "completed", startedAt: at(1) }),
      ]);
      rerender(<CatalogIntegrationImportJobsModule readModel={regressed} />);
      expect(visibleJobIds()).toEqual(["job_completed"]);

      selectStatus("all");
      expect(screen.getAllByText("12/24 work units, 50% complete").length).toBeGreaterThan(0);
      expect(screen.queryByText(/^3\/24 work units/)).toBeNull();
    });

    it("preserves lifecycle form intent, job ID and availability for visible rows", () => {
      const readModel = tcgplayerReadModel(statusMatrixJobs());
      render(<CatalogIntegrationImportJobsModule readModel={readModel} />);
      const retriedFormsBefore = lifecycleForms("job_failed_retried");
      const partialFormsBefore = lifecycleForms("job_completed_partial_newer");
      expect(retriedFormsBefore).toEqual([{ intent: "job.resume", jobId: "job_failed_retried" }]);
      expect(partialFormsBefore).toEqual([{ intent: "job.retry", jobId: "job_completed_partial_newer" }]);

      selectStatus("retried");
      expect(visibleJobIds()).toEqual(["job_failed_retried"]);
      expect(lifecycleForms("job_failed_retried")).toEqual(retriedFormsBefore);

      selectStatus("partial");
      expect(lifecycleForms("job_completed_partial_newer")).toEqual(partialFormsBefore);
    });
  });
});

const tcgplayerUnitKey = "tcgplayer:pokemon:single-card:source-observation-import";

function at(minute: number): string {
  return `2026-06-09T01:${String(minute).padStart(2, "0")}:00.000Z`;
}

function tcgplayerJob(
  jobId: string,
  overrides: Partial<CatalogIntegrationRecentJobSummary> = {},
): CatalogIntegrationRecentJobSummary {
  return integrationJobSummary({
    jobId,
    providerKey: "tcgplayer",
    unitKey: tcgplayerUnitKey,
    importScope: null,
    summary: `Synthetic job ${jobId}`,
    ...overrides,
  });
}

function statusMatrixJobs(): CatalogIntegrationRecentJobSummary[] {
  return [
    tcgplayerJob("job_queued", { operatorStatus: "queued", phase: "enqueued", startedAt: at(20) }),
    tcgplayerJob("job_completed_partial_newer", { operatorStatus: "partial", phase: "completed", startedAt: at(19) }),
    tcgplayerJob("job_running", { operatorStatus: "running", phase: "processing", startedAt: at(18) }),
    tcgplayerJob("job_failed_retried", { operatorStatus: "retried", phase: "failed", startedAt: at(17) }),
    tcgplayerJob("job_stale", { operatorStatus: "stale", phase: "processing", startedAt: at(16) }),
    tcgplayerJob("job_failed", { operatorStatus: "failed", phase: "failed", startedAt: at(15) }),
    tcgplayerJob("job_completed_partial_older", { operatorStatus: "partial", phase: "completed", startedAt: at(14) }),
    tcgplayerJob("job_cancelled", { operatorStatus: "cancelled", phase: "failed", startedAt: at(13) }),
    tcgplayerJob("job_completed", { operatorStatus: "completed", phase: "completed", startedAt: at(12) }),
  ];
}

function terminalJobs(): CatalogIntegrationRecentJobSummary[] {
  return [
    tcgplayerJob("job_completed_partial", { operatorStatus: "partial", phase: "completed", startedAt: at(9) }),
    tcgplayerJob("job_completed", { operatorStatus: "completed", phase: "completed", startedAt: at(8) }),
  ];
}

function tcgplayerReadModel(recentJobs: CatalogIntegrationRecentJobSummary[]): CatalogPrimaryWorkbenchReadModel {
  const baseOverview = controlPlaneOverview();
  return buildCatalogPrimaryWorkbenchReadModelForSurface("health", {
    requestUrl: `https://admin.example/catalog/integrations?providerKey=tcgplayer&unitKey=${encodeURIComponent(tcgplayerUnitKey)}&scopeRecordId=scope_record_one`,
    scopes: { items: [sourceObservationScope({ provider_key: "tcgplayer" })], total: 1, count: 1 },
    profileReviews: { items: [], total: 0, count: 0 },
    controlPlaneOverview: controlPlaneOverview({
      unitActivity: { ...baseOverview.unitActivity, units: [{ unitKey: tcgplayerUnitKey, recentJobs }] },
    }),
    canManageCatalog: true,
  });
}

function withJobOverrides(
  readModel: CatalogPrimaryWorkbenchReadModel,
  overrides: Record<string, Partial<CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"][number]>>,
): CatalogPrimaryWorkbenchReadModel {
  return {
    ...readModel,
    importJobs: {
      ...readModel.importJobs,
      jobs: readModel.importJobs.jobs.map((job) => ({ ...job, ...overrides[job.jobId] })),
    },
  };
}

function jobState(readModel: CatalogPrimaryWorkbenchReadModel, jobId: string): string | undefined {
  return readModel.importJobs.jobs.find((job) => job.jobId === jobId)?.state;
}

function statusSelect(): HTMLSelectElement {
  return screen.getByLabelText("Status") as HTMLSelectElement;
}

function optionValues(): string[] {
  return [...statusSelect().options].map((option) => option.value);
}

function selectStatus(value: string) {
  fireEvent.change(statusSelect(), { target: { value } });
}

function visibleJobIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>("tr[data-catalog-import-job-id]")].map(
    (row) => row.dataset.catalogImportJobId ?? "",
  );
}

function filterSummary(): Record<string, string> {
  const list = document.querySelector("[data-catalog-import-job-status-filter] dl");
  const terms = [...(list?.querySelectorAll("dt") ?? [])].map((term) => term.textContent ?? "");
  const values = [...(list?.querySelectorAll("dd") ?? [])].map((value) => value.textContent ?? "");
  return Object.fromEntries(terms.map((term, index) => [term, values[index] ?? ""]));
}

function moduleStatusText(): string {
  return screen.getByText(/^\d+ active$/).textContent ?? "";
}

// Everything the module renders except the filter block and the job rows/empty state,
// so a filter change cannot add or alter any other fact on the surface.
function textOutsideFilterAndTable(): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  for (const element of clone.querySelectorAll("[data-catalog-import-job-status-filter], table, [role='list']")) {
    element.remove();
  }
  for (const element of clone.querySelectorAll("[aria-busy]")) {
    element.remove();
  }
  return clone.textContent ?? "";
}

function lifecycleForms(jobId: string): { intent: string; jobId: string }[] {
  const row = document.querySelector(`tr[data-catalog-import-job-id="${jobId}"]`);
  return [...(row?.querySelectorAll("form") ?? [])].map((form) => ({
    intent: (form.querySelector('input[name="_intent"]') as HTMLInputElement | null)?.value ?? "",
    jobId: (form.querySelector('input[name="jobId"]') as HTMLInputElement | null)?.value ?? "",
  }));
}
