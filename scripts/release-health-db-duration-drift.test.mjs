import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { SUBCOMMANDS } from "./ops.mjs";
import {
  MAX_LOG_BYTES,
  buildDbDurationDigest,
  classifyDbJob,
  classifyDbJobPair,
  collectDbDurationJobs,
  dbWorkspaceCensus,
  dbDurationExitCode,
  parseDbDurationArgs,
  readBoundedBody,
  recomputeDbDurationBaseline,
  reconcileDbDurationIssues,
  runDbDurationDrift,
  upperMedian,
} from "./release-health-db-duration-drift.mjs";

const workspaceName = "@chase-sets/synthetic-db";
const workspaceNames = [workspaceName];
const checkedAt = "2026-10-06T00:00:00Z";
const headSha = "a".repeat(40);
const empty = () => ({ schemaVersion: "db-duration-baseline/v1", recomputes: [] });
const observed = (count, ms = 240000) =>
  Array.from({ length: count }, (_, i) => ({
    jobId: i + 1,
    runId: i + 101,
    completedAt: "2026-10-05T12:00:00Z",
    workspaces: { [workspaceName]: ms },
    jobWallMs: ms,
  }));
const collection = (count, ms) => ({ status: "complete", reasons: [], excluded: [], jobs: observed(count, ms) });
const baseline = () => ({
  ...empty(),
  recomputes: [
    {
      recomputedAt: "2026-10-05T00:00:00Z",
      sampleJobIds: Array.from({ length: 20 }, (_, i) => i + 101),
      workspaces: { [workspaceName]: 240000 },
      jobWallMs: 240000,
      cause: "initial (#6660 split)",
    },
  ],
});
const options = {
  topology: "monolithic/v1",
  checkedAt,
  headSha,
  repository: "synthetic/repository",
  token: "synthetic-test-token",
  workspaceNames,
};
const workflowEnv = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "schedule",
  GITHUB_WORKFLOW_REF: "synthetic/repository/.github/workflows/platform-db-duration-drift.yml@refs/heads/main",
};
const workspaces = [{ name: workspaceName, packageJson: { scripts: { "test:db:one": "vitest" } } }];
const roots = [];

async function scratch(record = empty()) {
  const root = await mkdtemp(path.join(tmpdir(), "db-duration-drift-test-"));
  roots.push(root);
  const baselinePath = path.join(root, "baseline.json");
  await writeFile(baselinePath, `${JSON.stringify(record)}\n`);
  return { root, baselinePath, outPath: path.join(root, "digest.json") };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function summary(names = workspaceNames, ms = 240000) {
  return {
    schemaVersion: "run-workspaces-summary/v1",
    scriptName: "test:db",
    concurrency: 2,
    eligibleCount: names.length,
    completedCount: names.length,
    passedCount: names.length,
    failedCount: 0,
    elapsedMs: ms,
    unhintedTasks: [],
    tasks: names.map((workspace) => ({
      workspace,
      script: "test:db",
      estimatedDurationSeconds: 240,
      usedFallback: false,
      actualDurationMs: ms,
      outcome: "passed",
    })),
  };
}

function source(count = 1) {
  const runs = Array.from({ length: count }, (_, index) => ({
    id: index + 101,
    event: "merge_group",
    path: ".github/workflows/platform-pr.yml",
    head_sha: headSha,
    run_attempt: 1,
    created_at: "2026-10-05T11:55:00Z",
  }));
  const jobs = runs.map((run, index) => ({
    id: index + 1,
    run_id: run.id,
    head_sha: headSha,
    run_attempt: 1,
    name: "DB Profile Tests",
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-05T11:56:00Z",
    completed_at: "2026-10-05T12:00:00Z",
    steps: [
      {
        name: "Run DB-profile tests",
        status: "completed",
        conclusion: "success",
        started_at: "2026-10-05T11:56:01Z",
        completed_at: "2026-10-05T11:59:59Z",
      },
    ],
  }));
  const logs = jobs.map(() => `2026-10-05T12:00:00.000Z RUN_WORKSPACES_SUMMARY ${JSON.stringify(summary())}\n`);
  return { runs, jobs, logs };
}

function github(data, alter = () => undefined) {
  return vi.fn(async (url, request) => {
    const parsed = new URL(url);
    const suffix = parsed.pathname.replace("/repos/synthetic/repository/", "");
    const override = alter(suffix, parsed, request);
    if (override) return override;
    if (/^actions\/jobs\/\d+$/.test(suffix))
      return Response.json(data.jobs.find((job) => job.id === Number(suffix.split("/")[2])));
    if (/^actions\/runs\/\d+$/.test(suffix))
      return Response.json(data.runs.find((run) => run.id === Number(suffix.split("/")[2])));
    if (suffix.endsWith("/runs")) {
      const [from, to] = parsed.searchParams.get("created").split("..").map(Date.parse);
      const runs = data.runs.filter((run) => Date.parse(run.created_at) >= from && Date.parse(run.created_at) <= to);
      const page = Number(parsed.searchParams.get("page"));
      const size = Number(parsed.searchParams.get("per_page"));
      return Response.json(
        { total_count: runs.length, workflow_runs: runs.slice((page - 1) * size, page * size) },
        { headers: page * size < runs.length ? { link: `<${url}>; rel="next"` } : {} },
      );
    }
    if (suffix.endsWith("/jobs")) {
      const runId = Number(suffix.split("/")[2]);
      const jobs = data.jobs.filter((job) => job.run_id === runId);
      return Response.json({ total_count: jobs.length, jobs });
    }
    if (suffix.endsWith("/logs")) return new Response(data.logs[Number(suffix.split("/")[2]) - 1]);
    throw new Error(`Unexpected synthetic API request: ${suffix}`);
  });
}

function splitSource(count = 1) {
  const data = source(count);
  data.jobs = data.runs.flatMap((run, index) =>
    ["api", "other"].map((group, cell) => ({
      ...structuredClone(data.jobs[index]),
      id: index * 2 + cell + 1,
      name: `DB Profile Tests (${group})`,
      started_at: cell === 0 ? "2026-10-05T11:55:30Z" : "2026-10-05T11:56:00Z",
    })),
  );
  data.logs = data.jobs.map(
    (job) =>
      `RUN_WORKSPACES_SUMMARY ${JSON.stringify(
        summary(job.name.endsWith("(api)") ? ["@chase-sets/app-platform-api"] : workspaceNames),
      )}`,
  );
  return data;
}

describe("isolated DB pair observation", () => {
  const splitOptions = {
    ...options,
    topology: "api-other/v1",
    workspaceNames: ["@chase-sets/app-platform-api", workspaceName],
  };

  it("joins two real jobs into one API-anchored span and keeps 20 observations, not 20 shards", async () => {
    const data = splitSource(20);
    const result = await collectDbDurationJobs({ ...splitOptions, fetchImpl: github(data) });
    expect(result.status).toBe("complete");
    expect(result.jobs).toHaveLength(20);
    expect(result.jobs[0]).toMatchObject({
      jobId: 39,
      runId: 120,
      runAttempt: 1,
      headSha,
      jobWallMs: 270000,
      topology: "api-other/v1",
      sources: [{ jobId: 39 }, { jobId: 40 }],
    });
    expect(Object.keys(result.jobs[0].workspaces).sort()).toEqual(splitOptions.workspaceNames.sort());
    expect(buildDbDurationDigest({ ...splitOptions, baseline: empty(), collection: result }).cohortReady).toBe(true);
    const ten = await collectDbDurationJobs({ ...splitOptions, fetchImpl: github(splitSource(10)) });
    expect(buildDbDurationDigest({ ...splitOptions, baseline: empty(), collection: ten }).cohortReady).toBe(false);
  });

  it.each([
    ["missing", (d) => d.jobs.pop()],
    ["duplicate", (d) => d.jobs.push({ ...d.jobs[1], id: 3 })],
    [
      "cross-head",
      (d) => {
        d.jobs[1].head_sha = "b".repeat(40);
      },
    ],
    [
      "cross-run",
      (d) => {
        d.jobs[1].run_id = 999;
      },
    ],
    [
      "cross-attempt",
      (d) => {
        d.runs[0].run_attempt = 2;
        d.jobs[1].run_attempt = 2;
      },
    ],
    [
      "missing step",
      (d) => {
        d.jobs[1].steps = [];
      },
    ],
    [
      "skipped step",
      (d) => {
        d.jobs[1].steps[0].conclusion = "skipped";
      },
    ],
    [
      "before creation",
      (d) => {
        d.jobs[0].started_at = "2026-10-05T11:54:00Z";
      },
    ],
    [
      "future",
      (d) => {
        d.jobs[1].completed_at = "2026-10-06T00:01:00Z";
      },
    ],
  ])("refuses %s pair authority", async (_name, mutate) => {
    const data = splitSource();
    mutate(data);
    const result = await collectDbDurationJobs({ ...splitOptions, fetchImpl: github(data) });
    expect(result.status).toBe("unknown");
    expect(buildDbDurationDigest({ ...splitOptions, baseline: empty(), collection: result }).cohortReady).toBe(false);
  });

  it.each([0, 1])("excludes every red, skipped or incomplete summary in cell %s", async (cell) => {
    for (const state of [
      "failure",
      "cancelled",
      "skipped",
      "missing-summary",
      "duplicate-summary",
      "overlap",
      "empty",
    ]) {
      const data = splitSource();
      if (["failure", "cancelled", "skipped"].includes(state)) data.jobs[cell].conclusion = state;
      if (state === "missing-summary") data.logs[cell] = "";
      if (state === "duplicate-summary") data.logs[cell] += `\n${data.logs[cell]}`;
      if (state === "overlap")
        data.logs[cell] = `RUN_WORKSPACES_SUMMARY ${JSON.stringify(summary(splitOptions.workspaceNames))}`;
      if (state === "empty") data.logs[cell] = `RUN_WORKSPACES_SUMMARY ${JSON.stringify(summary([]))}`;
      const result = await collectDbDurationJobs({ ...splitOptions, fetchImpl: github(data) });
      expect(result.jobs).toEqual([]);
      expect(result.excluded).toHaveLength(1);
    }
  });

  it("never joins attempts by timing proximity or inherits a monolithic cohort", async () => {
    const data = splitSource();
    const pair = data.jobs.map((job, index) => ({ job, log: data.logs[index] }));
    pair[1].job.run_attempt = 2;
    data.runs[0].run_attempt = 2;
    expect(() =>
      classifyDbJobPair({ run: data.runs[0], members: pair, workspaceNames: splitOptions.workspaceNames }),
    ).toThrow("Cross-attempt");
    const historical = await collectDbDurationJobs({ ...splitOptions, fetchImpl: github(source(20)) });
    expect(historical.jobs).toEqual([]);
    expect(historical.excluded.every((item) => item.reason === "different-topology")).toBe(true);
  });

  it("resolves each schema-v1 baseline anchor to the complete same-attempt pair", async () => {
    const data = splitSource(20);
    const baselineJobIds = data.jobs.filter((job) => job.name.endsWith("(api)")).map((job) => job.id);
    const result = await collectDbDurationJobs({ ...splitOptions, baselineJobIds, fetchImpl: github(data) });
    expect(result.status).toBe("complete");
    expect(result.baselineTopology).toBe("api-other/v1");
    expect(result.baselineSources.map((entry) => entry.jobId)).toEqual(baselineJobIds);
    expect(result.baselineSources.every((entry) => entry.sources.length === 2)).toBe(true);
    data.jobs[1].conclusion = "cancelled";
    expect((await collectDbDurationJobs({ ...splitOptions, baselineJobIds, fetchImpl: github(data) })).status).toBe(
      "unknown",
    );
  });

  it("leaves an old wall definition pending instead of comparing split spans to monolithic walls", () => {
    const result = { ...collection(20), topology: "api-other/v1", baselineTopology: "monolithic/v1" };
    const digest = buildDbDurationDigest({ ...splitOptions, baseline: baseline(), collection: result });
    expect(digest.state).toBe("baseline-pending");
    expect(digest.topologyChanged).toBe(true);
    expect(digest.verdicts).toBeUndefined();
  });
});

// Synthetic history: recent candidates followed by runs beyond the re-run horizon.
function wideSource(recent = 20) {
  const data = source(2500);
  data.runs.forEach((run, i) => {
    run.created_at = i < recent ? "2026-12-07T11:55:00Z" : "2026-11-01T11:55:00Z";
    const date = i < recent ? "2026-12-07" : "2026-11-01";
    const job = data.jobs[i];
    job.started_at = `${date}T11:56:00Z`;
    job.completed_at = `${date}T12:00:00Z`;
    job.steps[0].started_at = `${date}T11:56:01Z`;
    job.steps[0].completed_at = `${date}T11:59:59Z`;
  });
  return data;
}

describe("bounded collection proof", () => {
  const later = "2026-12-08T00:00:00Z";
  it("ratified detection reads only its bounded window", async () => {
    const paths = await scratch(baseline());
    const data = wideSource();
    const fetchImpl = github(data);
    const digest = await runDbDurationDrift({ ...options, ...paths, workspaces, checkedAt: later, fetchImpl });
    expect(digest.state).toBe("ratified");
    expect(digest.verdicts).toHaveLength(2);
    expect(digest.includedJobIds).toEqual(Array.from({ length: 10 }, (_, i) => 20 - i));
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("created")).toBe(
      "2026-10-24T00:00:00.000Z..2026-12-08T00:00:00Z",
    );
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("/logs"))).toHaveLength(10);
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/jobs"))).toHaveLength(20);
  });

  it("recompute proves the latest 20 without exhausting the window total", async () => {
    const paths = await scratch();
    const fetchImpl = github(wideSource());
    const digest = await runDbDurationDrift({
      ...options,
      ...paths,
      workspaces,
      checkedAt: later,
      fetchImpl,
      recompute: true,
      cause: "initial (#6660 split)",
      env: {},
    });
    const ids = Array.from({ length: 20 }, (_, i) => 20 - i);
    expect(digest.recompute?.sampleJobIds).toEqual(ids);
    expect(JSON.parse(await readFile(paths.baselinePath, "utf8")).recomputes).toEqual([digest.recompute]);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("created")).toBe(
      "2026-10-05T04:44:41Z..2026-12-08T00:00:00Z",
    );
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("/logs"))).toHaveLength(20);
  });

  it("late re-run inside the proof horizon is still selected", async () => {
    const paths = await scratch(baseline());
    const data = wideSource(100);
    data.runs[100].created_at = "2026-11-08T13:00:00Z";
    data.jobs[100].started_at = "2026-12-07T12:56:00Z";
    data.jobs[100].completed_at = "2026-12-07T13:00:00Z";
    data.jobs[100].steps[0].started_at = "2026-12-07T12:56:01Z";
    data.jobs[100].steps[0].completed_at = "2026-12-07T12:59:59Z";
    data.runs[100].run_attempt = data.jobs[100].run_attempt = 2;
    const fetchImpl = github(data);
    const digest = await runDbDurationDrift({ ...options, ...paths, workspaces, checkedAt: later, fetchImpl });
    expect(digest.state).toBe("ratified");
    expect(digest.includedJobIds).toEqual([101, ...Array.from({ length: 9 }, (_, i) => 100 - i)]);
    expect(fetchImpl.mock.calls.filter(([url]) => url.endsWith("/logs"))).toHaveLength(10);
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/runs"))).toHaveLength(2);
  });

  it("1000 runs scanned without proof is unknown", async () => {
    const data = wideSource(2500);
    data.jobs.forEach((job) => {
      job.conclusion = "skipped";
    });
    const fetchImpl = github(data);
    const result = await collectDbDurationJobs({ ...options, checkedAt: later, fetchImpl });
    expect(result.status).toBe("unknown");
    expect(result.reasons).toEqual(["Collection cap exhausted."]);
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/jobs"))).toHaveLength(1000);
    expect(fetchImpl.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/runs"))).toHaveLength(10);
    expect(
      buildDbDurationDigest({ ...options, checkedAt: later, baseline: empty(), collection: result }).cohortReady,
    ).toBe(false);
  });
});

describe("DB duration command", () => {
  it("recompute command reports insufficient-cohort without writes", async () => {
    const paths = await scratch();
    const before = await readFile(paths.baselinePath, "utf8");
    const digest = await runDbDurationDrift({
      ...options,
      ...paths,
      workspaces,
      fetchImpl: github(source(19)),
      recompute: true,
      cause: "initial (#6660 split)",
      env: {},
    });
    expect(digest.state).toBe("insufficient-cohort");
    expect(await readFile(paths.baselinePath, "utf8")).toBe(before);
  });

  it("recompute is refused in CI and with publish", async () => {
    for (const mode of [{ env: { GITHUB_ACTIONS: "true" } }, { env: {}, publishIssues: true }]) {
      const paths = await scratch();
      const before = await readFile(paths.baselinePath, "utf8");
      const fetchImpl = github(source(20));
      const digest = await runDbDurationDrift({
        ...options,
        ...paths,
        workspaces,
        fetchImpl,
        recompute: true,
        cause: "initial (#6660 split)",
        ...mode,
      });
      expect(digest.state).toBe("unknown");
      expect(digest.error).toBe("Recompute is local-only and cannot publish issues.");
      expect(await readFile(paths.baselinePath, "utf8")).toBe(before);
      expect(fetchImpl.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
    }
  });

  it("parses CLI flags and cause without enabling absent or false modes", () => {
    expect(parseDbDurationArgs([])).toEqual({ recompute: false, publishIssues: false, cause: null });
    expect(parseDbDurationArgs(["--recompute", "--cause", "initial (#6660 split)"])).toEqual({
      recompute: true,
      publishIssues: false,
      cause: "initial (#6660 split)",
    });
    expect(parseDbDurationArgs(["--recompute", "false", "--publish-issues", "true"])).toEqual({
      recompute: false,
      publishIssues: true,
      cause: null,
    });
    expect(parseDbDurationArgs(["--recompute", "true", "--publish-issues", "false"])).toEqual({
      recompute: true,
      publishIssues: false,
      cause: null,
    });
  });

  it.each([
    ["unknown", 1],
    ["insufficient-cohort", 1],
    ["baseline-pending", 0],
    ["ratified", 0],
    ["insufficient-sample", 0],
  ])("maps CLI state %s to exit %s", (state, code) => {
    expect(dbDurationExitCode(state)).toBe(code);
  });
});

describe("DB duration recompute", () => {
  it("uses the observed upper middle integer", () => {
    expect(upperMedian([4, 1, 3, 2])).toBe(3);
    expect(upperMedian([9, 1, 4])).toBe(4);
  });

  it.each([0, 1, 19])("refuses %s eligible jobs without changing bytes", async (count) => {
    const paths = await scratch();
    const before = await readFile(paths.baselinePath, "utf8");
    await expect(
      recomputeDbDurationBaseline({
        ...options,
        ...paths,
        collection: collection(count),
        cause: "initial (#6660 split)",
      }),
    ).rejects.toThrow("insufficient-cohort");
    expect(await readFile(paths.baselinePath, "utf8")).toBe(before);
  });

  it.each([20, 21])("selects exactly the latest 20 of %s with completion and ID ordering", async (count) => {
    const paths = await scratch();
    const cohort = collection(count);
    cohort.jobs[0].completedAt = "2026-10-05T13:00:00Z";
    cohort.jobs.forEach((job, i) => {
      job.workspaces[workspaceName] = i + 1;
      job.jobWallMs = i + 1;
    });
    const entry = await recomputeDbDurationBaseline({
      ...options,
      ...paths,
      collection: cohort,
      cause: "initial (#6660 split)",
    });
    expect(entry.sampleJobIds).toEqual([1, ...Array.from({ length: 19 }, (_, i) => count - i)]);
    expect(entry.workspaces[workspaceName]).toBe(count === 20 ? 11 : 12);
    expect(JSON.parse(await readFile(paths.baselinePath, "utf8")).recomputes).toEqual([entry]);
  });

  it("recompute refuses an uncaused step-up", async () => {
    const paths = await scratch(baseline());
    const before = await readFile(paths.baselinePath, "utf8");
    await expect(
      recomputeDbDurationBaseline({ ...options, ...paths, collection: collection(20, 300001) }),
    ).rejects.toThrow("Uncaused step-up");
    expect(await readFile(paths.baselinePath, "utf8")).toBe(before);
    await recomputeDbDurationBaseline({
      ...options,
      ...paths,
      collection: collection(20, 300001),
      cause: "Changed workload (#123)",
    });
    expect(JSON.parse(await readFile(paths.baselinePath, "utf8")).recomputes).toHaveLength(2);
  });

  it("refuses duplicates, unknown authority and unnamed initial cause without writes", async () => {
    const paths = await scratch();
    const before = await readFile(paths.baselinePath, "utf8");
    const duplicates = collection(20);
    duplicates.jobs[1].jobId = 1;
    for (const cohort of [duplicates, { ...collection(20), status: "unknown" }]) {
      await expect(recomputeDbDurationBaseline({ ...options, ...paths, collection: cohort })).rejects.toThrow();
    }
    await expect(recomputeDbDurationBaseline({ ...options, ...paths, collection: collection(20) })).rejects.toThrow(
      "First recompute",
    );
    expect(await readFile(paths.baselinePath, "utf8")).toBe(before);
  });
});

describe("DB duration collection", () => {
  it("uses the runner census including partition-only workspaces", () => {
    expect(
      dbWorkspaceCensus([...workspaces, { name: "@chase-sets/no-db", packageJson: { scripts: { test: "vitest" } } }]),
    ).toEqual(workspaceNames);
  });

  it.each([
    [
      "scoped-green",
      (d) => {
        d.logs[0] = `RUN_WORKSPACES_SUMMARY ${JSON.stringify(summary(["@chase-sets/other"]))}`;
      },
      "scoped-summary",
    ],
    [
      "failed",
      (d) => {
        d.jobs[0].conclusion = "failure";
      },
      "job-failure",
    ],
    [
      "skipped",
      (d) => {
        d.jobs[0].conclusion = "skipped";
      },
      "job-skipped",
    ],
    [
      "cancelled",
      (d) => {
        d.jobs[0].conclusion = "cancelled";
      },
      "job-cancelled",
    ],
    [
      "malformed",
      (d) => {
        d.logs[0] = "RUN_WORKSPACES_SUMMARY {}";
      },
      "malformed-summary",
    ],
    [
      "summary-less",
      (d) => {
        d.logs[0] = "executed without summary";
      },
      "summary-less",
    ],
    [
      "duplicate summary",
      (d) => {
        d.logs[0] += d.logs[0];
      },
      "duplicate-summary",
    ],
    [
      "duplicate workspace",
      (d) => {
        d.logs[0] = `RUN_WORKSPACES_SUMMARY ${JSON.stringify(summary([workspaceName, workspaceName]))}`;
      },
      "duplicate-workspace",
    ],
  ])("excludes %s by reason", async (_name, mutate, reason) => {
    const data = source();
    mutate(data);
    const fetchImpl = github(data);
    const result = await collectDbDurationJobs({ ...options, fetchImpl });
    expect(result.status).toBe("complete");
    expect(result.jobs).toEqual([]);
    expect(result.excluded[0].reason).toBe(reason);
    if (["job-skipped", "job-failure", "job-cancelled"].includes(reason))
      expect(fetchImpl.mock.calls.some(([url]) => url.endsWith("/logs"))).toBe(false);
  });

  it("ignores removed workspaces but never uses summary eligibleCount as census", () => {
    const data = source();
    const result = classifyDbJob({
      run: data.runs[0],
      job: data.jobs[0],
      log: `RUN_WORKSPACES_SUMMARY ${JSON.stringify(summary([workspaceName, "@chase-sets/removed"]))}`,
      workspaceNames,
    });
    expect(result.eligible).toBe(true);
    expect(Object.keys(result.workspaces)).toEqual(workspaceNames);
    expect(
      classifyDbJob({
        run: { ...data.runs[0], event: "pull_request" },
        job: data.jobs[0],
        log: data.logs[0],
        workspaceNames,
      }).reason,
    ).toBe("not-merge-group");
  });

  it.each([
    ["run source omission", "actions/workflows/platform-pr.yml/runs", { total_count: 1, workflow_runs: [] }],
    ["run cap", "actions/workflows/platform-pr.yml/runs", { total_count: 1001, workflow_runs: [] }],
    [
      "incomplete run pagination",
      "actions/workflows/platform-pr.yml/runs",
      { total_count: 2, workflow_runs: source().runs },
    ],
    [
      "duplicate runs",
      "actions/workflows/platform-pr.yml/runs",
      { total_count: 2, workflow_runs: [...source().runs, ...source().runs] },
    ],
    ["omitted job source", "actions/runs/101/jobs", { total_count: 0, jobs: [] }],
    ["incomplete job pagination", "actions/runs/101/jobs", { total_count: 2, jobs: source().jobs }],
  ])("%s is unknown and cannot be ready or publish", async (_name, suffix, payload) => {
    const fetchImpl = github(source(), (actual) => (actual === suffix ? Response.json(payload) : undefined));
    const result = await collectDbDurationJobs({ ...options, fetchImpl });
    expect(result.status).toBe("unknown");
    const digest = buildDbDurationDigest({ ...options, baseline: empty(), collection: result });
    expect(digest.state).toBe("unknown");
    expect(digest.cohortReady).toBe(false);
    const publish = vi.fn();
    expect(await reconcileDbDurationIssues(digest, { ...options, fetchImpl: publish })).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["step", "identity", "timestamps", "log unavailable"])(
    "refuses %s authority instead of inheriting workflow success",
    async (mode) => {
      const data = source();
      if (mode === "step") data.jobs[0].steps = [];
      if (mode === "identity") data.jobs[0].head_sha = "b".repeat(40);
      if (mode === "timestamps") data.jobs[0].completed_at = null;
      const fetchImpl = github(data, (suffix) =>
        mode === "log unavailable" && suffix.endsWith("/logs") ? new Response("", { status: 404 }) : undefined,
      );
      expect((await collectDbDurationJobs({ ...options, fetchImpl })).status).toBe("unknown");
    },
  );

  it("accepts the largest allowed response; rejects cap+1 and endless input", async () => {
    expect(
      (await readBoundedBody(new Response("x".repeat(MAX_LOG_BYTES)), MAX_LOG_BYTES, AbortSignal.timeout(5000))).length,
    ).toBe(MAX_LOG_BYTES);
    await expect(
      readBoundedBody(new Response("x".repeat(MAX_LOG_BYTES + 1)), MAX_LOG_BYTES, AbortSignal.timeout(5000)),
    ).rejects.toThrow("exceeds");
    const endless = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
      }),
    );
    await expect(readBoundedBody(endless, 2048, AbortSignal.timeout(5000))).rejects.toThrow("exceeds");
  });

  it("aborts a stalled body and records oversized log authority as unknown", async () => {
    const controller = new AbortController();
    const stalled = readBoundedBody(new Response(new ReadableStream({})), MAX_LOG_BYTES, controller.signal);
    controller.abort(new Error("synthetic read deadline"));
    await expect(stalled).rejects.toThrow("synthetic read deadline");
    const fetchImpl = github(source(), (suffix) =>
      suffix.endsWith("/logs") ? new Response("x".repeat(MAX_LOG_BYTES + 1)) : undefined,
    );
    const result = await collectDbDurationJobs({ ...options, fetchImpl });
    expect(result.status).toBe("unknown");
    expect(result.reasons[0]).toContain("exceeds");
  });

  it("collects all bounded pages and rejects changed totals", async () => {
    const data = source(2);
    for (const changedTotal of [false, true]) {
      const fetchImpl = github(data, (suffix, url) => {
        if (!suffix.endsWith("/runs")) return undefined;
        const page = Number(url.searchParams.get("page"));
        return Response.json(
          { total_count: changedTotal && page === 2 ? 3 : 2, workflow_runs: [data.runs[page - 1]] },
          {
            headers: page === 1 ? { link: '<https://api.github.com/synthetic?page=2>; rel="next"' } : {},
          },
        );
      });
      const result = await collectDbDurationJobs({ ...options, fetchImpl });
      expect(result.status).toBe(changedTotal ? "unknown" : "complete");
      if (!changedTotal) expect(result.jobs).toHaveLength(2);
    }
  });

  it("retains unique eligible jobs from all run attempts, not only the latest attempt", async () => {
    const data = source(2);
    data.runs = [{ ...data.runs[0], run_attempt: 2 }];
    data.jobs[1] = { ...data.jobs[1], run_id: data.runs[0].id, run_attempt: 2 };
    const fetchImpl = github(data);
    const result = await collectDbDurationJobs({ ...options, fetchImpl });
    expect(result.status).toBe("complete");
    expect(result.jobs.map((job) => job.jobId)).toEqual([2, 1]);
    expect(fetchImpl.mock.calls.some(([url]) => new URL(url).searchParams.get("filter") === "all")).toBe(true);
    data.jobs[1].run_attempt = 1;
    expect((await collectDbDurationJobs({ ...options, fetchImpl: github(data) })).status).toBe("unknown");
  });

  it.each([0, -1, 1.5, "1", undefined, 3])("rejects invalid all-attempt job identity %s", async (attempt) => {
    const data = source(2);
    data.runs = [{ ...data.runs[0], run_attempt: 2 }];
    data.jobs[0].run_attempt = attempt;
    data.jobs[1] = { ...data.jobs[1], run_id: data.runs[0].id, run_attempt: 2 };
    const result = await collectDbDurationJobs({ ...options, fetchImpl: github(data) });
    expect(result.status).toBe("unknown");
    expect(result.reasons).toEqual(["Job identity mismatch: 1"]);
  });

  it("does not let the latest successful attempt hide missing earlier execution authority", async () => {
    const data = source(2);
    data.runs = [{ ...data.runs[0], run_attempt: 2 }];
    data.jobs[0].steps = [];
    data.jobs[1] = { ...data.jobs[1], run_id: data.runs[0].id, run_attempt: 2 };
    const result = await collectDbDurationJobs({ ...options, fetchImpl: github(data) });
    expect(result.status).toBe("unknown");
    expect(result.reasons).toEqual(["DB execution step authority missing: 1"]);
  });

  it("wires the ops command and daily registered workflow to the exact state/cohort artifact", async () => {
    expect(SUBCOMMANDS["release-health:db-duration-drift"].script).toBe("release-health-db-duration-drift.mjs");
    const workflow = parse(
      await readFile(new URL("../.github/workflows/platform-db-duration-drift.yml", import.meta.url), "utf8"),
    );
    expect(workflow.on.schedule).toEqual([{ cron: "0 16 * * *" }]);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read", issues: "write" });
    expect(workflow.jobs.digest["timeout-minutes"]).toBe(10);
    expect(workflow.jobs.digest.steps.find((step) => step.run)?.run).toContain(
      "release-health:db-duration-drift --publish-issues",
    );
    const upload = workflow.jobs.digest.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload.if).toBe("always()");
    expect(upload.with.path).toBe("artifacts/release-health/db-duration-drift.json");
    expect(upload.with["if-no-files-found"]).toBe("error");
    expect(workflow.jobs.reporter).toMatchObject({
      needs: "digest",
      if: "${{ always() }}",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 5,
      permissions: { contents: "read", issues: "write" },
      steps: [
        { uses: "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10" },
        {
          if: "${{ contains(needs.*.result, 'failure') }}",
          uses: "./.github/actions/report-scheduled-workflow-alert",
          with: {
            "github-token": "${{ github.token }}",
            "workflow-name": "Platform DB Duration Drift",
            "alert-status": "failure",
          },
        },
      ],
    });
  });
});

describe("bootstrap and ratified lifecycle", () => {
  it.each([0, 19, 20])(
    "bootstrap with %s jobs is pending in default and publish modes, never healthy",
    async (count) => {
      const paths = await scratch();
      for (const publishIssues of [false, true]) {
        const fetchImpl = github(source(count));
        const digest = await runDbDurationDrift({ ...options, ...paths, workspaces, fetchImpl, publishIssues });
        expect(digest.state).toBe("baseline-pending");
        expect(digest.cohortReady).toBe(count === 20);
        expect(digest.eligibleCount).toBe(count);
        expect(digest.verdicts).toBeUndefined();
        expect(fetchImpl.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
        expect(JSON.parse(await readFile(paths.outPath, "utf8"))).toEqual(digest);
        expect(JSON.parse(await readFile(paths.baselinePath, "utf8"))).toEqual(empty());
      }
    },
  );

  it("ratified ten-job medians open, update and recovery-close one canonical issue per key", async () => {
    const requests = [];
    let issues = [];
    const fetchImpl = async (url, request) => {
      requests.push([url, request]);
      const body = request.body ? JSON.parse(request.body) : undefined;
      if (request.method === "GET")
        return Response.json({ total_count: issues.length, incomplete_results: false, items: issues });
      if (request.method === "POST" && url.endsWith("/issues"))
        issues.push({ ...body, id: issues.length + 1, number: issues.length + 1 });
      return Response.json({});
    };
    const digest = buildDbDurationDigest({ ...options, baseline: baseline(), collection: collection(10, 300001) });
    expect(await reconcileDbDurationIssues(digest, { ...options, fetchImpl, env: workflowEnv })).toEqual([
      { key: workspaceName, action: "opened" },
      { key: "jobWall", action: "opened" },
    ]);
    expect(
      (await reconcileDbDurationIssues(digest, { ...options, fetchImpl, env: workflowEnv })).map((a) => a.action),
    ).toEqual(["updated", "updated"]);
    const recovered = buildDbDurationDigest({ ...options, baseline: baseline(), collection: collection(10, 300000) });
    expect(
      (await reconcileDbDurationIssues(recovered, { ...options, fetchImpl, env: workflowEnv })).map((a) => a.action),
    ).toEqual(["closed", "closed"]);
    expect(requests.filter(([url]) => url.endsWith("/comments"))).toHaveLength(2);
    expect(issues).toHaveLength(2);
  });

  it("insufficient, single slow and slow-only-scoped samples never file issues", async () => {
    const cohorts = [collection(9), collection(10)];
    cohorts[1].jobs[0].workspaces[workspaceName] = 900000;
    const data = source(11);
    data.logs[10] = `RUN_WORKSPACES_SUMMARY ${JSON.stringify(summary(["@chase-sets/other"], 900000))}`;
    cohorts.push(await collectDbDurationJobs({ ...options, fetchImpl: github(data) }));
    for (const cohort of cohorts) {
      const digest = buildDbDurationDigest({ ...options, baseline: baseline(), collection: cohort });
      const fetchImpl = vi.fn(async () => Response.json({ total_count: 0, incomplete_results: false, items: [] }));
      expect(await reconcileDbDurationIssues(digest, { ...options, fetchImpl, env: workflowEnv })).toEqual([]);
      expect(fetchImpl.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
    }
  });

  it("populated-to-empty input never closes issues; malformed and missing input are unknown", async () => {
    const paths = await scratch(baseline());
    const fetchImpl = github(source(20));
    await writeFile(paths.baselinePath, JSON.stringify(empty()));
    expect((await runDbDurationDrift({ ...options, ...paths, workspaces, fetchImpl, publishIssues: true })).state).toBe(
      "baseline-pending",
    );
    await writeFile(paths.baselinePath, "{}");
    expect((await runDbDurationDrift({ ...options, ...paths, workspaces, fetchImpl })).state).toBe("unknown");
    await rm(paths.baselinePath);
    expect((await runDbDurationDrift({ ...options, ...paths, workspaces, fetchImpl })).state).toBe("unknown");
    expect(fetchImpl.mock.calls.every(([, request]) => request.method === "GET")).toBe(true);
  });

  it("enforces the 14-day detection window and does not close absent baseline keys", () => {
    const cohort = collection(10);
    cohort.jobs[0].completedAt = "2026-09-01T00:00:00Z";
    expect(buildDbDurationDigest({ ...options, baseline: baseline(), collection: cohort }).state).toBe(
      "insufficient-sample",
    );
    const record = baseline();
    record.recomputes[0].workspaces = { "@chase-sets/removed": 240000 };
    expect(buildDbDurationDigest({ ...options, baseline: record, collection: collection(10) }).verdicts[0].state).toBe(
      "unbaselined",
    );
  });

  it("restricts publication to the registered workflow and rejects ambiguous issues before mutation", async () => {
    const digest = buildDbDurationDigest({ ...options, baseline: baseline(), collection: collection(10, 300001) });
    await expect(reconcileDbDurationIssues(digest, { ...options, env: {} })).rejects.toThrow("registered");
    const fetchImpl = vi.fn(async () =>
      Response.json({
        total_count: 1,
        incomplete_results: false,
        items: [{ id: 1, number: 1, title: `DB duration drift: ${workspaceName}`, body: "unowned", state: "open" }],
      }),
    );
    await expect(reconcileDbDurationIssues(digest, { ...options, fetchImpl, env: workflowEnv })).rejects.toThrow(
      "Ambiguous",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retains successful issue actions when later publication fails", async () => {
    const paths = await scratch(baseline());
    const data = source(10);
    data.logs = data.logs.map(() => `RUN_WORKSPACES_SUMMARY ${JSON.stringify(summary(workspaceNames, 300001))}`);
    data.jobs.forEach((job) => {
      job.started_at = "2026-10-05T11:54:00Z";
    });
    data.runs.forEach((run) => {
      run.created_at = "2026-10-05T11:53:00Z";
    });
    let writes = 0;
    const fetchImpl = github(data, (suffix, _url, request) => {
      if (suffix.endsWith("search/issues"))
        return Response.json({ total_count: 0, incomplete_results: false, items: [] });
      if (request.method === "POST")
        return ++writes === 1 ? Response.json({ id: 1 }) : new Response("", { status: 503 });
      return undefined;
    });
    const digest = await runDbDurationDrift({
      ...options,
      ...paths,
      workspaces,
      fetchImpl,
      publishIssues: true,
      env: workflowEnv,
    });
    expect(digest.state).toBe("unknown");
    expect(digest.error).toBe("GitHub 503: issues");
    expect(writes).toBe(2);
    expect(digest.issueActions).toEqual([{ key: workspaceName, action: "opened" }]);
    expect(JSON.parse(await readFile(paths.outPath, "utf8")).issueActions).toEqual(digest.issueActions);
  });
});
