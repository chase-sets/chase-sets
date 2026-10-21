import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  classifyPreviewCleanupRun,
  observePreviewCleanupRun,
  readAttemptJobs,
} from "./preview-cleanup-run-observer.mjs";

const repository = "chase-sets/chase-sets";
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

// Synthetic run: id 1 and the example.test URL are not a real GitHub identity.
function run(conclusion = "success", event = "schedule") {
  return {
    id: 1,
    run_attempt: 1,
    name: "Platform Preview Cleanup",
    event,
    conclusion,
    html_url: "https://example.test/run/1",
  };
}

// Serves one run and its attempt's jobs the way the GitHub REST API pages them.
function githubApi({ observedRun, jobs, totalCount = jobs.length, perPage = 100 }) {
  const calls = [];
  const runPath = `/repos/${repository}/actions/runs/${observedRun.id}`;
  const jobsPage = new RegExp(`^${runPath}/attempts/${observedRun.run_attempt}/jobs\\?per_page=100&page=(\\d+)$`);
  async function fetchJson(path) {
    calls.push(path);
    if (path === runPath) return observedRun;
    const page = Number(jobsPage.exec(path)?.[1]);
    if (!page) throw new Error(`Unexpected GitHub API path ${path}`);
    return { total_count: totalCount, jobs: jobs.slice((page - 1) * perPage, page * perPage) };
  }
  return { calls, fetchJson };
}

describe("preview cleanup run observer", () => {
  it("classifies every terminal state of a scheduled preview cleanup run", () => {
    const cancelled = classifyPreviewCleanupRun({
      run: capturedRun,
      jobs: capturedJobsResponse.jobs,
      totalCount: capturedJobsResponse.total_count,
    });
    expect(cancelled).toMatchObject({ classification: "unreported", reason: "unfinished-jobs" });
    expect(cancelled.jobs).toHaveLength(capturedJobsResponse.total_count);
    expect(cancelled.listedJobs).toEqual([{ name: "Discover Preview Cleanup", conclusion: "cancelled" }]);

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

    // Each guard alone must hold these otherwise-silent cases. Without the
    // incomplete-job-list or missing-reporter guard the case is `clean`; without
    // the unknown-conclusion guard the posted reporter makes it `reported`,
    // because `clean` needs every conclusion known.
    expect(
      classifyPreviewCleanupRun({
        run: run(),
        jobs: [job("Discover Preview Cleanup", "success"), reporter()],
        totalCount: 3,
      }),
    ).toMatchObject({ classification: "unreported", reason: "incomplete-job-list" });
    expect(
      classifyPreviewCleanupRun({
        run: run(),
        jobs: [job("Discover Preview Cleanup", "success")],
        totalCount: 1,
      }),
    ).toMatchObject({ classification: "unreported", reason: "missing-reporter" });
    expect(
      classifyPreviewCleanupRun({
        run: run("failure"),
        jobs: [
          job("Discover Preview Cleanup", null),
          job("Destroy Preview", "failure"),
          reporter("success", "success"),
        ],
        totalCount: 3,
      }),
    ).toMatchObject({ classification: "unreported", reason: "unknown-conclusion" });
    expect(
      classifyPreviewCleanupRun({
        run: run(null),
        jobs: [job("Discover Preview Cleanup", "success"), reporter()],
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

  it("wires the observer to scheduled preview cleanup runs only", async () => {
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
    const observeJob = workflow.jobs.observe;
    expect(observeJob.if).toBe(
      "github.event_name == 'workflow_dispatch' || github.event.workflow_run.event == 'schedule'",
    );
    expect(observeJob.permissions).toEqual({ actions: "read", contents: "read", issues: "write" });

    const step = (name) => observeJob.steps.find((candidate) => candidate.name === name);
    const observeStep = step("Observe completed scheduled cleanup attempt");
    expect(observeStep.run).toBe("node scripts/preview-cleanup-run-observer.mjs observe");
    expect(observeStep.env).toMatchObject({
      OBSERVED_RUN_ID: "${{ inputs.run_id || github.event.workflow_run.id }}",
      OBSERVED_RUN_ATTEMPT: "${{ inputs.run_attempt || github.event.workflow_run.run_attempt }}",
    });
    const alertStep = step("Alert when cleanup was not reported");
    expect(alertStep.if).toBe("steps.observe.outputs.classification == 'unreported'");
    expect(alertStep.uses).toBe("./.github/actions/report-scheduled-workflow-alert");
    expect(alertStep.with).toEqual({
      "github-token": "${{ github.token }}",
      "workflow-name": "Platform Preview Cleanup",
      "alert-status": "failure",
      "alert-summary": "${{ steps.observe.outputs.summary }}",
      "alert-details": "${{ steps.observe.outputs.details }}",
      "dry-run": "${{ inputs.dry_run || 'false' }}",
    });

    // Synthetic event (run 7, attempt 2): the observer reads every page of that
    // attempt, and a posted in-run reporter keeps it from alerting.
    const observedRun = { ...run("failure"), id: 7, run_attempt: 2 };
    const api = githubApi({
      observedRun,
      jobs: [job("Discover Preview Cleanup", "failure"), reporter("success", "success")],
      perPage: 1,
    });
    const { record } = await observePreviewCleanupRun({
      repository,
      runId: observedRun.id,
      runAttempt: observedRun.run_attempt,
      fetchJson: api.fetchJson,
    });
    expect(record).toMatchObject({ classification: "reported", reason: null, alerted: false });
    expect(api.calls).toEqual([
      "/repos/chase-sets/chase-sets/actions/runs/7",
      "/repos/chase-sets/chase-sets/actions/runs/7/attempts/2/jobs?per_page=100&page=1",
      "/repos/chase-sets/chase-sets/actions/runs/7/attempts/2/jobs?per_page=100&page=2",
    ]);
  });

  it("records every job of the captured cancelled attempt and alerts with only its unfinished jobs", async () => {
    const api = githubApi({
      observedRun: capturedRun,
      jobs: capturedJobsResponse.jobs,
      totalCount: capturedJobsResponse.total_count,
    });
    const { record, details } = await observePreviewCleanupRun({
      repository,
      runId: 39037773622,
      runAttempt: 1,
      fetchJson: api.fetchJson,
    });

    expect(Object.keys(record)).toEqual([
      "schemaVersion",
      "runId",
      "runAttempt",
      "event",
      "runConclusion",
      "jobs",
      "reporterStepConclusion",
      "classification",
      "reason",
      "alerted",
    ]);
    expect(record).toMatchObject({
      schemaVersion: "preview-cleanup-run-observation/v1",
      runId: 39037773622,
      runAttempt: 1,
      event: "schedule",
      runConclusion: "cancelled",
      reporterStepConclusion: "skipped",
      classification: "unreported",
      reason: "unfinished-jobs",
      alerted: false,
    });
    expect(record.jobs).toHaveLength(10);
    expect(record.jobs).toEqual(capturedJobsResponse.jobs.map(({ name, conclusion }) => ({ name, conclusion })));
    expect(record.jobs).toContainEqual({ name: "Report Preview Cleanup Failure", conclusion: "success" });
    expect(details).toBe(
      [
        "Run: https://github.com/chase-sets/chase-sets/actions/runs/39037773622",
        "Attempt: 1",
        "Conclusion: cancelled",
        "- Discover Preview Cleanup: cancelled",
      ].join("\n"),
    );
  });

  it("refuses a dispatched run that is not a scheduled Platform Preview Cleanup run", async () => {
    // Synthetic runs: another workflow, and a cleanup run from a pull request close.
    for (const observedRun of [{ ...run(), name: "Platform PR" }, run("success", "pull_request_target")]) {
      const api = githubApi({ observedRun, jobs: [job("Discover Preview Cleanup", "success"), reporter()] });
      await expect(
        observePreviewCleanupRun({ repository, runId: 1, runAttempt: 1, fetchJson: api.fetchJson }),
      ).rejects.toThrow("The observed run is not a scheduled Platform Preview Cleanup run.");
      expect(api.calls).toEqual(["/repos/chase-sets/chase-sets/actions/runs/1"]);
    }
  });
});
