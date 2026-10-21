import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { classifyPreviewCleanupRun, readAttemptJobs } from "./preview-cleanup-run-observer.mjs";

const root = join(process.cwd(), "scripts", "fixtures", "preview-cleanup-run-observer");
const capturedRun = JSON.parse(readFileSync(join(root, "cancelled-run-39037773622.json"), "utf8"));
const capturedJobsResponse = JSON.parse(
  readFileSync(join(root, "cancelled-run-39037773622-attempt-1-jobs.json"), "utf8"),
);

function job(name, conclusion, steps = []) {
  return { id: name, name, conclusion, steps };
}

function reporter(conclusion = "success", stepConclusion = "skipped") {
  return job("Report Preview Cleanup Failure", conclusion, [
    { name: "Report workflow failure", conclusion: stepConclusion },
  ]);
}

function run(conclusion = "success", event = "schedule") {
  return { id: 1, name: "Platform Preview Cleanup", event, conclusion, html_url: "https://example.test/run/1" };
}

describe("preview cleanup run observer", () => {
  it("classifies every terminal state of a scheduled preview cleanup run", () => {
    const cancelled = classifyPreviewCleanupRun({
      run: capturedRun,
      jobs: capturedJobsResponse.jobs,
      totalCount: capturedJobsResponse.total_count,
    });
    expect(cancelled).toMatchObject({ classification: "unreported", reason: "unfinished-jobs" });
    expect(cancelled.jobs).toContainEqual({ name: "Discover Preview Cleanup", conclusion: "cancelled" });

    expect(
      classifyPreviewCleanupRun({
        run: run(),
        jobs: [job("Discover Preview Cleanup", "success"), reporter()],
        totalCount: 2,
      }),
    ).toMatchObject({ classification: "clean", reason: null });
    expect(
      classifyPreviewCleanupRun({
        run: run(),
        jobs: [job("Discover Stale Gate Namespaces", "skipped"), reporter()],
        totalCount: 2,
      }),
    ).toMatchObject({ classification: "clean", reason: null });
    expect(
      classifyPreviewCleanupRun({
        run: run("failure"),
        jobs: [job("Discover Preview Cleanup", "failure"), reporter("success", "success")],
        totalCount: 2,
      }),
    ).toMatchObject({ classification: "reported", reporterStepConclusion: "success" });

    expect(
      classifyPreviewCleanupRun({
        run: run("cancelled"),
        jobs: [job("Discover Preview Cleanup", "cancelled"), reporter("cancelled", null)],
        totalCount: 2,
      }),
    ).toMatchObject({ classification: "unreported", reason: "unfinished-jobs" });
    expect(
      classifyPreviewCleanupRun({
        run: run("cancelled"),
        jobs: [job("Discover Preview Cleanup", "cancelled")],
        totalCount: 1,
      }),
    ).toMatchObject({ classification: "unreported", reason: "missing-reporter" });
    expect(
      classifyPreviewCleanupRun({
        run: run("failure"),
        jobs: [job("Discover Preview Cleanup", "failure"), reporter("failure", "failure")],
        totalCount: 2,
      }),
    ).toMatchObject({ classification: "unreported", reason: "unfinished-jobs" });

    expect(
      classifyPreviewCleanupRun({
        run: run("cancelled"),
        jobs: [job("Discover Preview Cleanup", "cancelled")],
        totalCount: 2,
      }),
    ).toMatchObject({ classification: "unreported", reason: "incomplete-job-list" });
    expect(
      classifyPreviewCleanupRun({
        run: run(),
        jobs: [job("Discover Preview Cleanup", null), reporter()],
        totalCount: 2,
      }),
    ).toMatchObject({ classification: "unreported", reason: "unknown-conclusion" });
  });

  it("pages every jobs response until total_count is collected", async () => {
    const calls = [];
    const pages = [
      { total_count: 2, jobs: [job("first", "success")] },
      { total_count: 2, jobs: [job("second", "skipped")] },
    ];
    const result = await readAttemptJobs({
      repository: "chase-sets/chase-sets",
      runId: 7,
      runAttempt: 2,
      fetchJson: async (path) => {
        calls.push(path);
        return pages[calls.length - 1];
      },
    });
    expect(result).toEqual({ jobs: [...pages[0].jobs, ...pages[1].jobs], totalCount: 2 });
    expect(calls).toEqual([
      "/repos/chase-sets/chase-sets/actions/runs/7/attempts/2/jobs?per_page=100&page=1",
      "/repos/chase-sets/chase-sets/actions/runs/7/attempts/2/jobs?per_page=100&page=2",
    ]);
  });

  it("wires the observer to scheduled preview cleanup runs only", () => {
    const workflow = parseYaml(
      readFileSync(join(process.cwd(), ".github", "workflows", "platform-preview-cleanup-observer.yml"), "utf8"),
    );
    expect(workflow.on.workflow_run).toEqual({
      workflows: ["Platform Preview Cleanup"],
      types: ["completed"],
    });
    expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
      run_id: { required: true },
      run_attempt: { required: true },
      dry_run: { default: true, type: "boolean" },
    });
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.observe.permissions).toEqual({ actions: "read", contents: "read", issues: "write" });
    const source = readFileSync(join(process.cwd(), "scripts", "preview-cleanup-run-observer.mjs"), "utf8");
    expect(source).toContain("/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=${page}");
    expect(source).toContain('classification: "reported"');
    expect(workflow.jobs.observe.steps.map((step) => step.name)).toContain("Alert when cleanup was not reported");
    expect(
      workflow.jobs.observe.steps.find((step) => step.name === "Alert when cleanup was not reported").if,
    ).toContain("classification == 'unreported'");
  });
});
