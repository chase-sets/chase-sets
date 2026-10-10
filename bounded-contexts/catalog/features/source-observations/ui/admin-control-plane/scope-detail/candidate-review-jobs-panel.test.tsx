// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CatalogMergeCandidateBulkJob } from "../../../api/runtime";
import {
  CatalogScopeCandidateReviewJobsPanel,
  candidateReviewJobsPageHref,
  promotedCatalogItemIds,
} from "./candidate-review-jobs-panel";

afterEach(cleanup);

describe("CatalogScopeCandidateReviewJobsPanel", () => {
  it("lists active progress, completed counts and promoted Catalog Items, with a next-page control", () => {
    const { container } = render(
      <CatalogScopeCandidateReviewJobsPanel
        jobs={{
          active: [job("job_running", { status: "running", completed: 40, total: 125 })],
          failedJobs: [],
          completed: {
            items: [job("job_done", { status: "completed", completed: 125, total: 125, catalogItemId: "item_abra" })],
            cursor: "cursor_older",
          },
          failed: false,
        }}
        nextPageHref={candidateReviewJobsPageHref("/catalog/scopes/scope_base_set", "cursor_older")}
        firstPageHref={null}
      />,
    );

    expect(container.querySelector('[data-candidate-review-job-id="job_running"]')).toBeTruthy();
    expect(screen.getAllByText("40 of 125 candidates processed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No outcome counts yet.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("120 promoted · 0 deferred · 5 skipped · 0 failed").length).toBeGreaterThan(0);
    expect(container.querySelector('[data-promoted-catalog-item-id="item_abra"]')).toBeTruthy();
    const next = container.querySelector('[data-candidate-review-jobs-next-page="true"]');
    expect(next?.getAttribute("href")).toBe("/catalog/scopes/scope_base_set?candidateJobsCursor=cursor_older");
    expect(screen.queryByText("Newest completed jobs")).toBeNull();
  });

  it("offers the newest page from an older page and hides next on the last page", () => {
    const { container } = render(
      <CatalogScopeCandidateReviewJobsPanel
        jobs={{
          active: [],
          failedJobs: [],
          completed: { items: [job("job_oldest", { status: "completed" })] },
          failed: false,
        }}
        nextPageHref={null}
        firstPageHref="/catalog/scopes/scope_base_set"
      />,
    );

    expect(screen.getByText("Newest completed jobs").closest("a")?.getAttribute("href")).toBe(
      "/catalog/scopes/scope_base_set",
    );
    expect(container.querySelector('[data-candidate-review-jobs-next-page="true"]')).toBeNull();
  });

  it("shows the empty state and a degraded banner when the list could not load", () => {
    render(
      <CatalogScopeCandidateReviewJobsPanel
        jobs={{ active: [], failedJobs: [], completed: { items: [] }, failed: true }}
        nextPageHref={null}
        firstPageHref={null}
      />,
    );

    expect(screen.getByText("Candidate review jobs could not be loaded")).toBeTruthy();
    expect(screen.getAllByText("No candidate review jobs to show").length).toBeGreaterThan(0);
  });

  it("keeps a failed job's reference, status, progress and retained error visible after reload", () => {
    const failedJob = {
      ...job("job_missing_units", { status: "failed", completed: 1, total: 3 }),
      errorMessage: "Catalog Merge Candidate bulk job is missing enumerated work units.",
    };
    const { container } = render(
      <CatalogScopeCandidateReviewJobsPanel
        jobs={{ active: [], failedJobs: [failedJob], completed: { items: [] }, failed: false }}
        nextPageHref={null}
        firstPageHref={null}
      />,
    );
    expect(container.querySelector('[data-candidate-review-job-id="job_missing_units"]')).toBeTruthy();
    for (const text of [
      "job_missing_units",
      "failed",
      "1 of 3 candidates processed",
      failedJob.errorMessage,
      "No outcome counts recorded.",
    ]) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText("No candidate review jobs to show")).toBeNull();
  });

  it("collects only promoted outcomes' Catalog Items, once each", () => {
    const completed = job("job_done", { status: "completed", catalogItemId: "item_abra" });
    expect(
      promotedCatalogItemIds({
        ...completed,
        result: completed.result && {
          ...completed.result,
          outcomes: [
            ...completed.result.outcomes,
            { candidateId: "cand_dup", status: "promoted", catalogItemId: "item_abra", reason: null },
            { candidateId: "cand_skip", status: "skipped-not-eligible", catalogItemId: "item_other", reason: "x" },
          ],
        },
      }),
    ).toEqual(["item_abra"]);
  });
});

function job(
  jobId: string,
  input: Readonly<{
    status: CatalogMergeCandidateBulkJob["status"];
    completed?: number;
    total?: number;
    catalogItemId?: string;
  }>,
): CatalogMergeCandidateBulkJob {
  const terminal = input.status === "completed";
  return {
    jobId,
    kind: "merge-candidate-promote",
    scopeRecordId: "scope_base_set",
    reason: "Promote all ready candidates in the scope.",
    status: input.status,
    progress: {
      phase: terminal ? "completed" : "processing",
      completed: input.completed ?? 0,
      total: input.total ?? 0,
      currentName: null,
      status: null,
    },
    result: terminal
      ? {
          requested: 125,
          promoted: 120,
          deferred: 0,
          skippedNotEligible: 5,
          failed: 0,
          outcomes: [
            { candidateId: "cand_1", status: "promoted", catalogItemId: input.catalogItemId ?? null, reason: null },
          ],
        }
      : null,
    errorMessage: null,
    createdAt: "2026-10-09T00:00:00.000Z",
    startedAt: "2026-10-09T00:00:01.000Z",
    completedAt: terminal ? "2026-10-09T00:02:00.000Z" : null,
    updatedAt: "2026-10-09T00:02:00.000Z",
  };
}
