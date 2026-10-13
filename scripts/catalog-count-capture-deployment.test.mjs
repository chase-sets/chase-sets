import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  collectCountCaptureDeployment,
  readCountCaptureExecutedDeployment,
} from "./catalog-count-capture-deployment.ts";
import { syntheticCountCaptureAuthority } from "../bounded-contexts/catalog/features/scope-sync-batches/tests/count-capture-fixture.ts";

describe("rejects unbound deployment collector", () => {
  it("reads the unchanged FINAL packet's historical executed job and log, not a workflow conclusion", () => {
    // Exact staging job from FINAL E/deploy.jobs.json and log lines 5217-5239.
    // This is historical job parsing only, not current pod, host, or live-run proof.
    const job = JSON.parse(
      readFileSync(
        new URL(
          "../bounded-contexts/catalog/features/scope-sync-batches/tests/fixtures/historical-staging-job.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const log = readFileSync(
      new URL(
        "../bounded-contexts/catalog/features/scope-sync-batches/tests/fixtures/historical-staging-deployment.txt",
        import.meta.url,
      ),
      "utf8",
    );
    expect(readCountCaptureExecutedDeployment(job, log, 35)).toMatchObject({
      runId: "38349636491",
      attempt: 1,
      jobId: "115140065141",
      jobName: "Deploy Staging",
      stepNumber: 35,
      stepName: "Deploy staging Kubernetes release",
      conclusion: "success",
      startedAt: "2026-10-13T05:11:30.000Z",
      completedAt: "2026-10-13T05:15:20.000Z",
      sha: "7d81f3f3309fc2a83ca3a70ee0ed5f51b45e4c0a",
      digest: "sha256:bde13c7a962cb4d6d0937bc8ac8b669ba9fd2d07a476dfc06cd05b3e602111e2",
    });
  });
  const now = "2026-10-13T08:02:00.000Z";
  function fixture() {
    const authority = syntheticCountCaptureAuthority();
    const run = {
      id: 100,
      workflow_id: 1,
      run_attempt: 1,
      head_sha: authority.runnerSha,
      status: "completed",
      created_at: "2026-10-13T07:30:00Z",
      updated_at: "2026-10-13T07:50:00Z",
    };
    const job = {
      id: 200,
      run_id: 100,
      run_attempt: 1,
      head_sha: authority.runnerSha,
      name: authority.deployment.jobName,
      status: "completed",
      conclusion: "success",
      started_at: "2026-10-13T07:35:00Z",
      completed_at: "2026-10-13T07:50:00Z",
      steps: [
        {
          name: authority.deployment.stepName,
          number: 35,
          status: "completed",
          conclusion: "success",
          started_at: authority.deployment.startedAt,
          completed_at: authority.deployment.completedAt,
        },
      ],
    };
    const responses = new Map([
      [
        "/actions/workflows?per_page=100&page=1",
        { total_count: 1, workflows: [{ id: 1, path: ".github/workflows/synthetic.yml" }] },
      ],
      ["/actions/runs?per_page=100&page=1", { total_count: 1, workflow_runs: [run] }],
      ["/actions/runs/100/attempts/1/jobs?per_page=100&page=1", { total_count: 1, jobs: [job] }],
    ]);
    const reader = {
      json: vi.fn(async (path) => responses.get(path)),
      jobLog: vi.fn(async () =>
        JSON.stringify(
          {
            schemaVersion: "platform-kubernetes-deployment/v1",
            action: "deploy",
            namespace: "chase-sets-platform",
            result: "success",
            image: `synthetic:${authority.runnerSha}@${authority.deployment.digest}`,
            workloads: { deployments: [] },
          },
          null,
          2,
        ),
      ),
    };
    return { authority, run, job, responses, reader };
  }
  it("collects workflows, all runs, attempts, jobs and the executed job log itself", async () => {
    const f = fixture();
    expect(await collectCountCaptureDeployment(f.reader, f.authority, now)).toMatchObject({
      complete: true,
      overlap: false,
      workflowCount: 1,
      runCount: 1,
      attemptCount: 1,
      jobCount: 1,
      pageCount: 6,
    });
    expect(f.reader.jobLog).toHaveBeenCalledWith("200");
  });
  it("does not assume a renamed staging recovery is harmless", async () => {
    const f = fixture();
    f.responses.set("/actions/runs/100/attempts/1/jobs?per_page=100&page=1", {
      total_count: 2,
      jobs: [
        f.job,
        {
          ...f.job,
          id: 201,
          name: "Recover runtime",
          conclusion: "failure",
          steps: [{ ...f.job.steps[0], name: "Apply release" }],
        },
      ],
    });
    expect(await collectCountCaptureDeployment(f.reader, f.authority, now)).toMatchObject({ complete: false });
  });
  it("refuses an inventory that changes behind the collector frontier", async () => {
    const f = fixture();
    let reads = 0;
    f.reader.json.mockImplementation(async (path) => {
      if (path === "/actions/runs?per_page=100&page=1" && ++reads > 1)
        return { total_count: 2, workflow_runs: [f.run, { ...f.run, id: 101 }] };
      return f.responses.get(path);
    });
    expect(await collectCountCaptureDeployment(f.reader, f.authority, now)).toMatchObject({ complete: false });
  });
  it.each([
    "skipped-job",
    "missing-step",
    "truncated-runs",
    "truncated-jobs",
    "wrong-attempt",
    "wrong-image",
    "collector-deleted",
  ])("refuses %s without inheriting run success", async (mode) => {
    const f = fixture();
    if (mode === "skipped-job") {
      f.job.conclusion = "skipped";
      f.job.steps = [];
    }
    if (mode === "missing-step") f.job.steps = [];
    if (mode === "wrong-attempt") f.job.run_attempt = 2;
    if (mode === "truncated-runs")
      f.responses.set("/actions/runs?per_page=100&page=1", { total_count: 2, workflow_runs: [f.run] });
    if (mode === "truncated-jobs")
      f.responses.set("/actions/runs/100/attempts/1/jobs?per_page=100&page=1", { total_count: 2, jobs: [f.job] });
    if (mode === "wrong-image")
      f.reader.jobLog.mockResolvedValue(
        (await f.reader.jobLog()).replace(f.authority.deployment.digest, `sha256:${"d".repeat(64)}`),
      );
    if (mode === "collector-deleted") f.reader.json.mockResolvedValue(undefined);
    expect((await collectCountCaptureDeployment(f.reader, f.authority, now)).complete).toBe(false);
  });
  it("does not hide an earlier-started failure in another workflow", async () => {
    const f = fixture();
    f.responses.set("/actions/workflows?per_page=100&page=1", {
      total_count: 2,
      workflows: [
        { id: 1, path: "synthetic.yml" },
        { id: 2, path: "synthetic-other.yml" },
      ],
    });
    f.responses.set("/actions/runs?per_page=100&page=1", {
      total_count: 2,
      workflow_runs: [f.run, { ...f.run, id: 101, workflow_id: 2, created_at: "2026-10-13T06:00:00Z" }],
    });
    f.responses.set("/actions/runs/101/attempts/1/jobs?per_page=100&page=1", {
      total_count: 1,
      jobs: [{ ...f.job, id: 201, run_id: 101, conclusion: "failure" }],
    });
    expect(await collectCountCaptureDeployment(f.reader, f.authority, now)).toMatchObject({
      complete: false,
      overlap: true,
    });
  });
});
