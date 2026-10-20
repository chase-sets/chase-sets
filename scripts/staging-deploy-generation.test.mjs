import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  readStagingDeployGeneration,
  selectStagingDeployGeneration,
  verifyDeployGeneration,
} from "./staging-deploy-generation.mjs";

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/staging-deploy-generation/${name}`, import.meta.url), "utf8");
// Live shapes captured read-only (see the fixture's `source`): runs 39252891660,
// 39135494514, 39079933000 and 39199416588, and job 118064914233's deploy log.
const captured = JSON.parse(fixture("captured-platform-deploy.json"));
const capturedLog = fixture("deploy-staging-118064914233-log.txt");
const source = readFileSync(new URL("./staging-deploy-generation.mjs", import.meta.url), "utf8");

const api = "https://api.github.com/repos/chase-sets/chase-sets";
const signedLogs = "https://synthetic.blob.core.windows.net/logs/";
const token = "synthetic-planted-token-5be2";
const now = "2026-10-19T13:00:00Z";
const governed = [
  "Activate immutable release before staging mutation",
  "Deploy staging Kubernetes release",
  "Mark staging applied",
];
const capturedHead = "175d48ba08d9cc5de352b0505bb586eca4c1f902";
const capturedDigest = "sha256:4cd0cee29ad60ca0c0169b19f415be0bda08141320c33c8be8766cd05e643b61";

const capturedDeployment = {
  workflowFile: "platform-production.yml",
  workflowName: "Platform Deploy",
  jobName: "Deploy Staging",
  runId: "39252891660",
  jobId: "118064914233",
  runNumber: 5153,
  runAttempt: 1,
  deployedHead: capturedHead,
  imageDigest: capturedDigest,
  jobConclusion: "success",
  steps: [
    { name: governed[0], number: 16, conclusion: "success" },
    { name: governed[1], number: 36, conclusion: "success" },
    { name: governed[2], number: 57, conclusion: "success" },
  ],
  jobCompletedAt: "2026-10-19T12:56:22Z",
  ageSeconds: 218,
  inventory: {
    createdFrom: "2026-09-07T13:00:00Z",
    createdTo: now,
    runsTotalCount: 4,
    runsCollected: 4,
    runsInspected: 4,
    attemptsInspected: 6,
    jobsCollected: 75,
  },
  rejectedRuns: [
    { runId: "39079933000", runAttempt: 1, jobId: "117534949742", reason: "job-not-success" },
    { runId: "39079933000", runAttempt: 2, jobId: "117547897109", reason: "deploy-not-applied" },
    { runId: "39135494514", runAttempt: 1, jobId: "117699986371", reason: "superseded" },
    { runId: "39135494514", runAttempt: 2, jobId: "117708990947", reason: "superseded" },
  ],
};
const capturedGeneration = {
  runId: "39252891660",
  runAttempt: 1,
  jobId: "118064914233",
  jobCompletedAt: "2026-10-19T12:56:22Z",
  deployedHead: capturedHead,
};

// --- GitHub Actions state served by the fake transport -----------------------

const emptyWorld = () => ({ runs: [], jobs: {}, logs: {} });
const capturedWorld = () => ({
  runs: structuredClone(captured.runs),
  jobs: structuredClone(captured.jobs),
  logs: { 118064914233: capturedLog },
});
const capturedJob = (attempt, id) => captured.jobs[attempt].jobs.find((job) => job.id === id);
const shift = (instant, seconds) => new Date(Date.parse(instant) + seconds * 1000).toISOString().replace(".000Z", "Z");

// Labeled synthetic controls: run ids from 9,000,000,000 and job ids from
// 9,100,000,000, a range no captured Platform Deploy object uses.
const step = (number, name, conclusion, startedAt, completedAt) => ({
  name,
  status: "completed",
  conclusion,
  number,
  started_at: startedAt,
  completed_at: completedAt,
});
function deployJob({ id, at, conclusion = "success", outcomes = ["success", "success", "success"], steps }) {
  return {
    id,
    name: "Deploy Staging",
    status: "completed",
    conclusion,
    created_at: shift(at, -900),
    started_at: shift(at, -840),
    completed_at: at,
    steps: steps ?? [
      step(1, "Set up job", "success", shift(at, -840), shift(at, -836)),
      step(16, governed[0], outcomes[0], shift(at, -660), shift(at, -659)),
      step(36, governed[1], outcomes[1], shift(at, -600), shift(at, -120)),
      step(57, governed[2], outcomes[2], shift(at, -10), shift(at, -10)),
    ],
  };
}
const runObject = ({ id, number, createdAt, updatedAt, status, attempts }) => ({
  id,
  name: "Platform Deploy",
  path: ".github/workflows/platform-production.yml",
  event: "workflow_dispatch",
  run_number: number,
  run_attempt: attempts,
  head_sha: "e".repeat(40),
  head_branch: "main",
  status,
  conclusion: status === "completed" ? "success" : null,
  pull_requests: [],
  created_at: createdAt,
  updated_at: updatedAt,
  run_started_at: createdAt,
});
function addRun(world, { id, number = 6000, createdAt, status = "completed", attempts }) {
  const times = attempts.flat().flatMap((job) => [job.completed_at, job.started_at].filter(Boolean));
  const last = times.reduce((latest, time) => (Date.parse(time) > Date.parse(latest) ? time : latest), createdAt);
  world.runs.push(runObject({ id, number, createdAt, updatedAt: shift(last, 30), status, attempts: attempts.length }));
  attempts.forEach((jobs, index) => {
    world.jobs[`${id}/${index + 1}`] = {
      total_count: jobs.length,
      jobs: jobs.map((job) => ({ ...job, run_id: id, run_attempt: index + 1 })),
    };
  });
  return world;
}
// Synthetic completed runs that ended before the age window: listed and counted,
// never inspected (they have no job listing to serve).
function addFillers(world, count, firstCreatedAt, everySeconds) {
  for (let index = 0; index < count; index++) {
    const createdAt = shift(firstCreatedAt, index * everySeconds);
    world.runs.push(
      runObject({
        id: 9_000_100_000 + index,
        number: 1000 + index,
        createdAt,
        updatedAt: shift(createdAt, 600),
        status: "completed",
        attempts: 1,
      }),
    );
  }
  return world;
}
// A deploy step log in the captured line format with its block logged at `at`.
function deployLog(at, sha, digest) {
  const block = {
    schemaVersion: "platform-kubernetes-deployment/v1",
    action: "deploy",
    release: "chase-sets-platform",
    namespace: "chase-sets-platform",
    image: `registry.digitalocean.com/chase-sets/chase-sets-platform:${sha}@${digest}`,
    startedAt: null,
    completedAt: null,
    result: "success",
  };
  const lines = JSON.stringify(block, null, 2).split("\n");
  return `${lines.map((line) => `${at.slice(0, 19)}.1694857Z ${line}`).join("\n")}\n`;
}
const syntheticHead = "a".repeat(40);
const syntheticDigest = `sha256:${"b".repeat(64)}`;
// A synthetic applied deploy whose log binds the synthetic head and digest.
function addApplied(world, { runId, jobId, number, createdAt, at, earlierAttempts = [] }) {
  addRun(world, { id: runId, number, createdAt, attempts: [...earlierAttempts, [deployJob({ id: jobId, at })]] });
  world.logs[jobId] = deployLog(shift(at, -130), syntheticHead, syntheticDigest);
  return world;
}
// The captured selected run and job under labeled synthetic ids, for controls
// that alter a captured fact (the run head or the log).
function relabeledWorld({ headSha = capturedHead, log = capturedLog } = {}) {
  const world = emptyWorld();
  const run = structuredClone(captured.runs.find(({ id }) => id === 39252891660));
  const job = structuredClone(capturedJob("39252891660/1", 118064914233));
  world.runs.push({ ...run, id: 9_000_000_301, head_sha: headSha });
  world.jobs["9000000301/1"] = {
    total_count: 1,
    jobs: [{ ...job, id: 9_100_000_301, run_id: 9_000_000_301, head_sha: headSha }],
  };
  world.logs[9_100_000_301] = log;
  return world;
}

const reply = (value) => (value instanceof Response ? value : Response.json(value));
function respond(world, url, { runsPage, jobsPage, signedLog } = {}) {
  if (url.startsWith(signedLogs))
    return reply(signedLog?.() ?? new Response(world.logs[url.slice(signedLogs.length).split("?")[0]] ?? ""));
  const path = url.slice(api.length);
  let match =
    /^\/actions\/workflows\/platform-production\.yml\/runs\?per_page=100&page=(\d+)&created=(\S+)\.\.(\S+)$/.exec(path);
  if (match) {
    const [page, from, to] = [Number(match[1]), Date.parse(match[2]), Date.parse(match[3])];
    const listed = world.runs
      .filter((run) => Date.parse(run.created_at) >= from && Date.parse(run.created_at) <= to)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
    const body = { total_count: listed.length, workflow_runs: listed.slice((page - 1) * 100, page * 100) };
    return reply(runsPage?.(body, { page, from: match[2], to: match[3] }) ?? body);
  }
  match = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100&page=(\d+)$/.exec(path);
  if (match && world.jobs[`${match[1]}/${match[2]}`]) {
    const listing = world.jobs[`${match[1]}/${match[2]}`];
    const page = Number(match[3]);
    const body = structuredClone({
      total_count: listing.total_count,
      jobs: listing.jobs.slice((page - 1) * 100, page * 100),
    });
    return reply(jobsPage?.(body, { run: Number(match[1]), attempt: Number(match[2]), page }) ?? body);
  }
  match = /^\/actions\/jobs\/(\d+)\/logs$/.exec(path);
  if (match)
    return new Response(null, { status: 302, headers: { location: `${signedLogs}${match[1]}?sig=synthetic` } });
  return new Response(null, { status: 404 });
}

async function select(world, options = {}, hooks = {}) {
  const requests = [];
  const transport = vi.fn(async (url, init) => {
    requests.push({ url, init });
    return respond(world, url, hooks);
  });
  const result = await selectStagingDeployGeneration({
    token,
    transport,
    requestTimeoutMs: 30_000,
    now,
    maxAgeSeconds: 604_800,
    ...options,
  });
  return { result, requests, paths: requests.map(({ url }) => url.replace(api, "")) };
}
const stopOf = async (world, options, hooks) => (await select(world, options, hooks)).result.stop;

async function verify(world, generation = capturedGeneration, options = {}, hooks = {}) {
  const requests = [];
  const transport = vi.fn(async (url, init) => {
    requests.push({ url, init });
    return respond(world, url, hooks);
  });
  const result = await verifyDeployGeneration(generation, {
    token,
    transport,
    requestTimeoutMs: 30_000,
    now,
    ...options,
  });
  return { result, requests };
}

describe("selectStagingDeployGeneration", () => {
  // AC-01: authority is the owning job's executed steps, never the run conclusion.
  it("binds the captured failure-concluded run's Deploy Staging", async () => {
    expect(captured.runs.find(({ id }) => id === 39252891660).conclusion).toBe("failure");
    const { result, paths } = await select(capturedWorld());
    expect(result).toEqual({ stop: null, deployment: capturedDeployment, deployGeneration: capturedGeneration });
    // One page of runs, one job listing per attempt, then the selected job's log.
    expect(paths).toEqual([
      "/actions/workflows/platform-production.yml/runs?per_page=100&page=1&created=2026-09-07T13:00:00Z..2026-10-19T13:00:00Z",
      "/actions/runs/39252891660/attempts/1/jobs?per_page=100&page=1",
      "/actions/runs/39199416588/attempts/1/jobs?per_page=100&page=1",
      "/actions/runs/39135494514/attempts/1/jobs?per_page=100&page=1",
      "/actions/runs/39135494514/attempts/2/jobs?per_page=100&page=1",
      "/actions/runs/39079933000/attempts/1/jobs?per_page=100&page=1",
      "/actions/runs/39079933000/attempts/2/jobs?per_page=100&page=1",
      "/actions/jobs/118064914233/logs",
      `${signedLogs}118064914233?sig=synthetic`,
    ]);
  });

  it("verifyDeployGeneration recomputes per phase and fails closed", async () => {
    expect((await verify(capturedWorld())).result).toEqual({ verdict: "current" });

    // The held job is still the authority when its completion equals the
    // rerun's lower bound. A strict `>` bound would incorrectly lose it.
    const equalWorld = addApplied(emptyWorld(), {
      runId: 9_000_000_400,
      jobId: 9_100_000_400,
      number: 6400,
      createdAt: "2026-10-19T12:56:22Z",
      at: "2026-10-19T12:56:22Z",
    });
    const equalGeneration = {
      runId: "9000000400",
      runAttempt: 1,
      jobId: "9100000400",
      jobCompletedAt: "2026-10-19T12:56:22Z",
      deployedHead: syntheticHead,
    };
    expect((await verify(equalWorld, equalGeneration)).result).toEqual({ verdict: "current" });

    const changed = [
      ["runId", "39252891661"],
      ["runAttempt", 2],
      ["jobId", "118064914234"],
      ["jobCompletedAt", "2026-10-19T12:56:21Z"],
      ["deployedHead", "0".repeat(40)],
    ];
    for (const [key, value] of changed)
      expect((await verify(capturedWorld(), { ...capturedGeneration, [key]: value })).result).toEqual({
        verdict: "deploy-generation-advanced",
      });

    const newer = addApplied(capturedWorld(), {
      runId: 9_000_000_401,
      jobId: 9_100_000_401,
      number: 6401,
      createdAt: "2026-10-19T12:57:00Z",
      at: "2026-10-19T12:57:22Z",
    });
    expect((await verify(newer)).result).toEqual({ verdict: "deploy-generation-advanced" });

    const indeterminate = addRun(capturedWorld(), {
      id: 9_000_000_402,
      createdAt: "2026-10-19T12:57:00Z",
      attempts: [
        [
          deployJob({
            id: 9_100_000_402,
            at: "2026-10-19T12:57:22Z",
            conclusion: "failure",
            outcomes: ["success", "success", "skipped"],
          }),
        ],
      ],
    });
    expect((await verify(indeterminate)).result).toEqual({ verdict: "deploy-generation-advanced" });

    const inProgress = addRun(capturedWorld(), {
      id: 9_000_000_403,
      createdAt: "2026-10-19T12:57:00Z",
      attempts: [[deployJob({ id: 9_100_000_403, at: "2026-10-19T12:57:22Z" })]],
    });
    inProgress.jobs["9000000403/1"].jobs[0].status = "in_progress";
    expect((await verify(inProgress)).result).toEqual({ verdict: "deploy-generation-advanced" });

    expect(
      (await verify(capturedWorld(), capturedGeneration, {}, { runsPage: () => new Response(null, { status: 503 }) }))
        .result,
    ).toEqual({
      verdict: "deploy-generation-unverifiable",
    });

    // A consumer reruns the fence immediately before each mutation. Once the
    // first mutation advances staging, the second phase must refuse.
    const phases = capturedWorld();
    let mutationCount = 0;
    const runPhase = async () => {
      const outcome = await verify(phases);
      if (outcome.result.verdict === "current") mutationCount++;
      return outcome;
    };
    const first = await runPhase();
    expect(first.result).toEqual({ verdict: "current" });
    expect(mutationCount).toBe(1);
    phases.runs = phases.runs.filter(({ id }) => id !== 39252891660);
    phases.jobs = Object.fromEntries(Object.entries(phases.jobs).filter(([key]) => !key.startsWith("39252891660/")));
    addApplied(phases, {
      runId: 9_000_000_404,
      jobId: 9_100_000_404,
      number: 6404,
      createdAt: "2026-10-19T12:57:00Z",
      at: "2026-10-19T12:57:22Z",
    });
    expect((await runPhase()).result).toEqual({ verdict: "deploy-generation-advanced" });
    expect(mutationCount).toBe(1);
  });

  it("skips coalesced and unexecuted jobs", async () => {
    // Captured run 39079933000: attempt 1 skipped Deploy Staging (zero steps,
    // placeholder times), attempt 2 coalesced (activation success, deploy and
    // applied skipped), both after the older synthetic applied deploy.
    const world = { runs: [], jobs: {}, logs: {} };
    world.runs.push(structuredClone(captured.runs.find(({ id }) => id === 39079933000)));
    world.jobs["39079933000/1"] = structuredClone(captured.jobs["39079933000/1"]);
    world.jobs["39079933000/2"] = structuredClone(captured.jobs["39079933000/2"]);
    const coalesced = { now: "2026-10-18T02:00:00Z" };
    expect(await stopOf(world, coalesced)).toBe("no-applied-deploy-found");

    addApplied(world, {
      runId: 9_000_000_101,
      jobId: 9_100_000_101,
      number: 5090,
      createdAt: "2026-10-17T19:50:00Z",
      at: "2026-10-17T20:30:00Z",
    });
    const { result } = await select(world, coalesced);
    expect(result.deployment).toMatchObject({
      runId: "9000000101",
      jobId: "9100000101",
      deployedHead: syntheticHead,
      jobCompletedAt: "2026-10-17T20:30:00Z",
      rejectedRuns: [
        { runId: "39079933000", runAttempt: 1, jobId: "117534949742", reason: "job-not-success" },
        { runId: "39079933000", runAttempt: 2, jobId: "117547897109", reason: "deploy-not-applied" },
      ],
    });
  });

  it("refuses a newer indeterminate job: job 117699986371's shape plus two synthetic shapes", async () => {
    const recorded = capturedJob("39135494514/1", 117699986371);
    const recordedShape = {
      conclusion: recorded.conclusion,
      outcomes: governed.map((name) => recorded.steps.find((entry) => entry.name === name).conclusion),
    };
    expect(recordedShape).toEqual({ conclusion: "failure", outcomes: ["success", "success", "skipped"] });
    const shapes = [
      recordedShape,
      { conclusion: "failure", outcomes: ["success", "failure", "skipped"] },
      { conclusion: "cancelled", outcomes: ["success", "skipped", "skipped"] },
    ];
    const withIndeterminate = (shape, at) =>
      addRun(capturedWorld(), {
        id: 9_000_000_201,
        createdAt: "2026-10-19T12:40:00Z",
        attempts: [[deployJob({ id: 9_100_000_201, at, ...shape })]],
      });
    for (const shape of shapes) {
      // Newer than, or exactly at, the newest applied job blocks selection.
      expect(await stopOf(withIndeterminate(shape, "2026-10-19T12:57:22Z"))).toBe("deploy-outcome-indeterminate");
      expect(await stopOf(withIndeterminate(shape, "2026-10-19T12:56:22Z"))).toBe("deploy-outcome-indeterminate");
      // Older than the newest applied job, it was superseded.
      const { result } = await select(withIndeterminate(shape, "2026-10-19T12:55:22Z"));
      expect(result.deployment.jobId).toBe("118064914233");
      expect(result.deployment.rejectedRuns).toContainEqual({
        runId: "9000000201",
        runAttempt: 1,
        jobId: "9100000201",
        reason: "superseded",
      });
      // With nothing applied, any indeterminate job blocks.
      const alone = addRun(emptyWorld(), {
        id: 9_000_000_202,
        createdAt: "2026-10-19T12:40:00Z",
        attempts: [[deployJob({ id: 9_100_000_202, at: "2026-10-19T12:55:00Z", ...shape })]],
      });
      expect(await stopOf(alone)).toBe("deploy-outcome-indeterminate");
    }
  });

  it("refuses renamed, missing or duplicated governed steps as step-inventory divergence", async () => {
    const at = "2026-10-19T12:58:00Z";
    const base = deployJob({ id: 9_100_000_211, at });
    const variants = {
      renamed: base.steps.map((entry) => (entry.number === 36 ? { ...entry, name: `${entry.name} (canary)` } : entry)),
      missing: base.steps.filter((entry) => entry.number !== 16),
      duplicated: [...base.steps, step(58, governed[2], "success", at, at)],
      "zero steps on a successful job": [],
    };
    const withSteps = (steps, jobAt = at) =>
      addRun(capturedWorld(), {
        id: 9_000_000_211,
        createdAt: "2026-10-19T12:40:00Z",
        attempts: [[{ ...deployJob({ id: 9_100_000_211, at: jobAt }), steps }]],
      });
    const control = withSteps(base.steps);
    control.logs[9_100_000_211] = deployLog(shift(at, -130), syntheticHead, syntheticDigest);
    expect((await select(control)).result.deployment.jobId).toBe("9100000211");
    for (const steps of Object.values(variants)) {
      expect(await stopOf(withSteps(steps))).toBe("deploy-step-inventory-divergence");
      // Terminal even when the divergent job is older than the newest applied one.
      expect(await stopOf(withSteps(steps, "2026-10-19T12:50:00Z"))).toBe("deploy-step-inventory-divergence");
    }
  });

  // AC-02: the head and digest come only from the deploy step's own block.
  it("binds deployedHead and imageDigest from the deploy block", async () => {
    const releasedAncestor = "1".repeat(40);
    const { result } = await select(relabeledWorld({ headSha: releasedAncestor }));
    expect(result.deployment).toMatchObject({ deployedHead: capturedHead, imageDigest: capturedDigest });
    expect(result.deployGeneration.deployedHead).toBe(capturedHead);
    expect(result.deployment.deployedHead).not.toBe(releasedAncestor);
  });

  it("refuses missing, duplicated, out-of-interval or echo-only logs as deploy-log-unbound", async () => {
    const lines = capturedLog.split("\n");
    const logs = {
      missing: "",
      duplicated: `${capturedLog}${capturedLog}`,
      // The block logged during activation, before the deploy step started.
      "out of interval": capturedLog.replaceAll("2026-10-19T12:53:08.", "2026-10-19T12:42:44."),
      // The activation echo and the deploy command echo name the same release.
      "echo only": `${lines.filter((line) => line.includes(capturedHead) && !line.includes('"image"')).join("\n")}\n`,
    };
    expect(logs["echo only"].split("\n")).toHaveLength(3);
    for (const log of Object.values(logs)) expect(await stopOf(relabeledWorld({ log }))).toBe("deploy-log-unbound");
  });

  // AC-03: the newest applied job by its own completion, across every attempt.
  it("selects the older run's re-run that completed last", async () => {
    const world = emptyWorld();
    addApplied(world, {
      runId: 9_000_000_401,
      jobId: 9_100_000_402,
      number: 6001,
      createdAt: "2026-10-19T08:00:00Z",
      at: "2026-10-19T12:40:00Z",
      earlierAttempts: [
        [
          deployJob({
            id: 9_100_000_401,
            at: "2026-10-19T08:30:00Z",
            conclusion: "failure",
            outcomes: ["failure", "skipped", "skipped"],
          }),
        ],
      ],
    });
    addApplied(world, {
      runId: 9_000_000_402,
      jobId: 9_100_000_403,
      number: 6002,
      createdAt: "2026-10-19T10:00:00Z",
      at: "2026-10-19T10:30:00Z",
    });
    const { result } = await select(world);
    expect(result.deployment).toMatchObject({
      runId: "9000000401",
      runNumber: 6001,
      runAttempt: 2,
      jobId: "9100000402",
      rejectedRuns: [
        { runId: "9000000401", runAttempt: 1, jobId: "9100000401", reason: "job-not-success" },
        { runId: "9000000402", runAttempt: 1, jobId: "9100000403", reason: "superseded" },
      ],
    });
  });

  it("finds an attempt-1 job that a filter=latest listing hides", async () => {
    // Captured: filter=latest lists only 39135494514's attempt 2; attempt 1's
    // executed deploy is still inventoried.
    expect((await select(capturedWorld())).result.deployment.rejectedRuns).toContainEqual({
      runId: "39135494514",
      runAttempt: 1,
      jobId: "117699986371",
      reason: "superseded",
    });
    // Synthetic and decisive: the newest applied deploy is attempt 1 of a run
    // whose attempt 2 skipped Deploy Staging.
    const world = emptyWorld();
    addApplied(world, {
      runId: 9_000_000_501,
      jobId: 9_100_000_501,
      createdAt: "2026-10-19T09:00:00Z",
      at: "2026-10-19T12:40:00Z",
    });
    world.runs.at(-1).run_attempt = 2;
    world.runs.at(-1).updated_at = "2026-10-19T12:50:00Z";
    const skipped = {
      ...deployJob({ id: 9_100_000_502, at: "2026-10-19T12:45:00Z", conclusion: "skipped" }),
      steps: [],
    };
    world.jobs["9000000501/2"] = { total_count: 1, jobs: [{ ...skipped, run_id: 9_000_000_501, run_attempt: 2 }] };
    addApplied(world, {
      runId: 9_000_000_502,
      jobId: 9_100_000_503,
      createdAt: "2026-10-19T10:00:00Z",
      at: "2026-10-19T10:30:00Z",
    });
    expect((await select(world)).result.deployment).toMatchObject({ runId: "9000000501", runAttempt: 1 });
  });

  it("refuses equal completions, two Deploy Staging jobs in one attempt and unfinished deploys", async () => {
    const pair = (secondAt) => {
      const world = emptyWorld();
      addApplied(world, {
        runId: 9_000_000_601,
        jobId: 9_100_000_601,
        createdAt: "2026-10-19T09:00:00Z",
        at: "2026-10-19T12:40:00Z",
      });
      return addApplied(world, {
        runId: 9_000_000_602,
        jobId: 9_100_000_602,
        createdAt: "2026-10-19T10:00:00Z",
        at: secondAt,
      });
    };
    expect(await stopOf(pair("2026-10-19T12:40:00Z"))).toBe("deploy-staging-job-ambiguous");
    expect((await select(pair("2026-10-19T12:40:01Z"))).result.deployment.jobId).toBe("9100000602");

    const twice = addRun(emptyWorld(), {
      id: 9_000_000_611,
      createdAt: "2026-10-19T09:00:00Z",
      attempts: [
        [
          deployJob({ id: 9_100_000_611, at: "2026-10-19T12:40:00Z" }),
          deployJob({ id: 9_100_000_612, at: "2026-10-19T12:41:00Z" }),
        ],
      ],
    });
    expect(await stopOf(twice)).toBe("deploy-staging-job-ambiguous");

    for (const status of ["queued", "in_progress", "waiting"]) {
      const world = capturedWorld();
      const unfinished = {
        ...deployJob({ id: 9_100_000_621, at: "2026-10-19T12:58:00Z" }),
        status,
        conclusion: null,
        completed_at: null,
      };
      addRun(world, {
        id: 9_000_000_621,
        createdAt: "2026-10-19T12:40:00Z",
        status: "in_progress",
        attempts: [[unfinished]],
      });
      expect(await stopOf(world)).toBe("deploy-in-progress");
    }
  });

  // AC-04: only a complete, closed inventory selects.
  it("refuses truncated, shifting, duplicate or capped inventories", async () => {
    // createdFrom = windowStart - 35 days, in both window modes.
    expect((await select(capturedWorld())).result.deployment.inventory.createdFrom).toBe("2026-09-07T13:00:00Z");
    const fenced = await select(capturedWorld(), { maxAgeSeconds: undefined, windowStart: "2026-10-19T12:56:22Z" });
    expect(fenced.paths[0]).toBe(
      "/actions/workflows/platform-production.yml/runs?per_page=100&page=1&created=2026-09-14T12:56:22Z..2026-10-19T13:00:00Z",
    );
    expect(fenced.result.deployGeneration).toEqual(capturedGeneration);

    // The decisive run (an old run re-run last) sits on page 2 of 112.
    const paged = () => {
      const world = emptyWorld();
      addFillers(world, 110, "2026-09-20T00:00:00Z", 3600);
      addApplied(world, {
        runId: 9_000_000_701,
        jobId: 9_100_000_702,
        createdAt: "2026-09-15T00:00:00Z",
        at: "2026-10-19T12:50:00Z",
        earlierAttempts: [
          [
            deployJob({
              id: 9_100_000_701,
              at: "2026-09-15T00:30:00Z",
              conclusion: "failure",
              outcomes: ["failure", "skipped", "skipped"],
            }),
          ],
        ],
      });
      return addApplied(world, {
        runId: 9_000_000_702,
        jobId: 9_100_000_703,
        createdAt: "2026-10-19T10:00:00Z",
        at: "2026-10-19T10:30:00Z",
      });
    };
    const complete = await select(paged());
    expect(complete.result.deployment).toMatchObject({ runId: "9000000701", runAttempt: 2 });
    expect(complete.result.deployment.inventory).toMatchObject({
      runsTotalCount: 112,
      runsCollected: 112,
      runsInspected: 2,
    });
    const onPageTwo = (change) => ({ runsPage: (body, { page }) => (page === 2 ? change(body) : body) });
    const truncations = {
      "short page": (body) => ({ ...body, workflow_runs: body.workflow_runs.filter(({ id }) => id !== 9_000_000_701) }),
      "empty page": (body) => ({ ...body, workflow_runs: [] }),
      "total changed": (body) => ({ ...body, total_count: body.total_count + 1 }),
      "repeated id": (body) => ({
        ...body,
        workflow_runs: [{ ...body.workflow_runs[0], id: 9_000_100_011 }, ...body.workflow_runs.slice(1)],
      }),
      "run outside the window": (body) => ({
        ...body,
        workflow_runs: body.workflow_runs.map((run) =>
          run.id === 9_000_000_701 ? { ...run, created_at: "2026-09-01T00:00:00Z" } : run,
        ),
      }),
      "foreign workflow": (body) => ({
        ...body,
        workflow_runs: body.workflow_runs.map((run) =>
          run.id === 9_000_000_701 ? { ...run, path: ".github/workflows/ci.yml" } : run,
        ),
      }),
    };
    for (const change of Object.values(truncations))
      expect(await stopOf(paged(), {}, onPageTwo(change))).toBe("deploy-run-inventory-incomplete");

    // 1,001 results split in halves; every half closes.
    const split = await select(addFillers(capturedWorld(), 997, "2026-09-08T00:00:00Z", 2700));
    expect(split.result.deployment).toEqual({
      ...capturedDeployment,
      inventory: { ...capturedDeployment.inventory, runsTotalCount: 1001, runsCollected: 1001 },
    });
    const firstPages = split.paths.filter((path) => path.includes("runs?per_page=100&page=1&"));
    expect(firstPages).toEqual([
      "/actions/workflows/platform-production.yml/runs?per_page=100&page=1&created=2026-09-07T13:00:00Z..2026-10-19T13:00:00Z",
      "/actions/workflows/platform-production.yml/runs?per_page=100&page=1&created=2026-09-07T13:00:00Z..2026-09-28T13:00:00Z",
      "/actions/workflows/platform-production.yml/runs?per_page=100&page=1&created=2026-09-28T13:00:01Z..2026-10-19T13:00:00Z",
    ]);
    // A window that cannot be split below the result cap never selects.
    const capped = await select(capturedWorld(), {}, { runsPage: (body) => ({ ...body, total_count: 1001 }) });
    expect(capped.result.stop).toBe("deploy-run-inventory-incomplete");
    expect(capped.requests.length).toBeLessThan(40);

    // Each attempt's job listing must close and carry only that attempt's jobs.
    const jobsChanged = (change) => ({
      jobsPage: (body, { run, attempt }) => (run === 39135494514 && attempt === 2 ? change(body) : body),
    });
    const jobChanges = {
      "short page": (body) => ({ ...body, jobs: body.jobs.slice(1) }),
      "other attempt": (body) => ({
        ...body,
        jobs: body.jobs.map((job, index) => (index === 0 ? { ...job, run_attempt: 1 } : job)),
      }),
      "other run": (body) => ({
        ...body,
        jobs: body.jobs.map((job, index) => (index === 0 ? { ...job, run_id: 39079933000 } : job)),
      }),
      "repeated id": (body) => ({
        ...body,
        jobs: [body.jobs[0], { ...body.jobs[1], id: body.jobs[0].id }, ...body.jobs.slice(2)],
      }),
      "over the cap": (body) => ({ ...body, total_count: 1001 }),
    };
    for (const change of Object.values(jobChanges))
      expect(await stopOf(capturedWorld(), {}, jobsChanged(change))).toBe("deploy-job-inventory-incomplete");

    // Captured cancelled run 39199416588 lists zero jobs: a non-terminal
    // no-deploy candidate, never deploy-staging-job-absent.
    expect(captured.jobs["39199416588/1"]).toEqual({ total_count: 0, jobs: [] });
    const cancelled = emptyWorld();
    cancelled.runs.push(structuredClone(captured.runs.find(({ id }) => id === 39199416588)));
    cancelled.jobs["39199416588/1"] = { total_count: 0, jobs: [] };
    expect(await stopOf(cancelled)).toBe("no-applied-deploy-found");

    // The source never reads a run's pull requests or conclusion.
    expect(source).not.toMatch(/pull_requests/);
    expect(new Set([...source.matchAll(/(\w+)\??\.conclusion\b/g)].map(([, owner]) => owner))).toEqual(
      new Set(["job", "step"]),
    );
    expect(source).not.toMatch(/\[\s*["'`]conclusion["'`]\s*\]/);
  });

  // AC-05: age and order come from the job's own completed_at.
  it("bounds age from job completed_at", async () => {
    // Run and job created_at, and the job's started_at, precede the window; only
    // its completed_at falls inside it.
    const { result } = await select(capturedWorld(), { maxAgeSeconds: 900 });
    expect(result.deployment).toMatchObject({ jobCompletedAt: "2026-10-19T12:56:22Z", ageSeconds: 218 });
    expect(result.deployment.inventory).toMatchObject({ runsInspected: 1, attemptsInspected: 1, jobsCollected: 15 });
    expect(capturedJob("39252891660/1", 118064914233).created_at).toBe("2026-10-19T12:42:03Z");
    // Completing exactly at the window start is inside it; a window one second later is stale.
    expect((await select(capturedWorld(), { maxAgeSeconds: 218 })).result.deployment.ageSeconds).toBe(218);
    expect(await stopOf(capturedWorld(), { maxAgeSeconds: 217 })).toBe("deploy-too-stale");
    expect(await stopOf(capturedWorld(), { now: "2026-10-19T12:56:21Z" })).toBe("future-instant-refused");
    expect(await stopOf(emptyWorld())).toBe("no-applied-deploy-found");

    // A skipped job's placeholder times (started after completed) never order.
    const placeholder = capturedJob("39079933000/1", 117534949742);
    expect(Date.parse(placeholder.started_at)).toBeGreaterThan(Date.parse(placeholder.completed_at));
    const world = capturedWorld();
    const skipped = {
      ...deployJob({ id: 9_100_000_801, at: "2026-10-19T12:59:00Z", conclusion: "skipped" }),
      started_at: "2026-10-19T12:59:01Z",
      steps: [],
    };
    addRun(world, { id: 9_000_000_801, createdAt: "2026-10-19T12:45:00Z", attempts: [[skipped]] });
    const selection = (await select(world)).result.deployment;
    expect(selection.jobId).toBe("118064914233");
    expect(selection.rejectedRuns).toContainEqual({
      runId: "9000000801",
      runAttempt: 1,
      jobId: "9100000801",
      reason: "job-not-success",
    });
  });

  // AC-07 through the selector's own reader.
  it("accepts a page above the product cap", async () => {
    const productCap = 1_048_576;
    const sized = (bytes, declared) => (body) => {
      const filler = body.workflow_runs.find(({ id }) => id >= 9_000_000_000);
      filler.display_title = "";
      filler.display_title = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(body)));
      const text = JSON.stringify(body);
      expect(Buffer.byteLength(text, "utf8")).toBe(bytes);
      return new Response(text, declared ? { headers: { "content-length": String(bytes) } } : undefined);
    };
    // A labeled synthetic 100-run page: the four captured runs and 96 fillers.
    const world = () => addFillers(capturedWorld(), 96, "2026-09-20T00:00:00Z", 3600);
    const accepted = {
      ...capturedDeployment,
      inventory: { ...capturedDeployment.inventory, runsTotalCount: 100, runsCollected: 100 },
    };
    expect(1_373_877).toBeGreaterThan(productCap);
    for (const declared of [false, true]) {
      for (const bytes of [1_373_877, 4_000_000]) {
        const { result } = await select(world(), {}, { runsPage: sized(bytes, declared) });
        expect(result.deployment).toEqual(accepted);
      }
      expect(await stopOf(world(), {}, { runsPage: sized(4_000_001, declared) })).toBe("github-request-failed");
    }
  });

  it("keeps a planted token out of the result and the signed log request", async () => {
    const { result, requests } = await select(capturedWorld());
    expect(JSON.stringify(result)).not.toContain(token);
    const signed = requests.filter(({ url }) => url.startsWith(signedLogs));
    expect(signed).toHaveLength(1);
    expect(signed[0].url).not.toContain(token);
    expect(signed[0].init.headers).toEqual({});
    for (const { url, init } of requests.filter((request) => !signed.includes(request))) {
      expect(url.startsWith(`${api}/`)).toBe(true);
      expect(init.headers.authorization).toBe(`Bearer ${token}`);
    }
  });

  it("maps GitHub read failures and the request timeout to github-request-failed", async () => {
    const unavailable = () => new Response(null, { status: 503 });
    expect(await stopOf(capturedWorld(), {}, { runsPage: unavailable })).toBe("github-request-failed");
    expect(await stopOf(capturedWorld(), {}, { jobsPage: unavailable })).toBe("github-request-failed");
    expect(await stopOf(capturedWorld(), {}, { signedLog: unavailable })).toBe("github-request-failed");
    // A transport that never answers settles at the caller's 50 ms timeout; the
    // reader's 30 s default would leave the selection pending.
    vi.useFakeTimers();
    try {
      const hung = vi.fn(() => new Promise(() => {}));
      const selection = selectStagingDeployGeneration({
        token,
        transport: hung,
        requestTimeoutMs: 50,
        now,
        maxAgeSeconds: 604_800,
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(await Promise.race([selection, Promise.resolve("pending")])).toEqual({
        stop: "github-request-failed",
        deployment: null,
        deployGeneration: null,
      });
      expect(hung).toHaveBeenCalledTimes(1);
      expect(hung.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses invalid inputs before any request", async () => {
    const transport = vi.fn();
    const valid = { token, transport, requestTimeoutMs: 30_000, now, maxAgeSeconds: 604_800 };
    for (const invalid of [
      { token: "" },
      { requestTimeoutMs: 0 },
      { now: "2026-10-19T13:00:00" },
      { maxAgeSeconds: 0 },
      { maxAgeSeconds: 604_801 },
      { windowStart: "2026-10-19T12:56:22Z" },
      { maxAgeSeconds: undefined },
      { maxAgeSeconds: undefined, windowStart: "2026-10-19" },
    ])
      await expect(selectStagingDeployGeneration({ ...valid, ...invalid })).rejects.toThrow(
        "staging-deploy-generation-input-invalid",
      );
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("readStagingDeployGeneration", () => {
  // AC-06: the deployment record is closed at every level.
  it("refuses every deployment schema rule", () => {
    const text = JSON.stringify({ deployment: capturedDeployment, deployGeneration: capturedGeneration });
    expect(readStagingDeployGeneration(text)).toEqual({
      deployment: capturedDeployment,
      deployGeneration: capturedGeneration,
    });
    const mutate = (change) => {
      const document = JSON.parse(text);
      change(document);
      return JSON.stringify(document);
    };
    const both = (key, value) => (document) => {
      document.deployment[key] = value;
      document.deployGeneration[key] = value;
    };
    const refused = {
      "not JSON": "{",
      "top-level unknown": mutate((document) => (document.extra = 1)),
      "deployment unknown": mutate((document) => (document.deployment.extra = 1)),
      "inventory unknown": mutate((document) => (document.deployment.inventory.pages = 1)),
      "step unknown": mutate((document) => (document.deployment.steps[0].status = "completed")),
      "rejected run unknown": mutate((document) => (document.deployment.rejectedRuns[0].conclusion = "failure")),
      "generation unknown": mutate((document) => (document.deployGeneration.imageDigest = capturedDigest)),
      "missing key": mutate((document) => delete document.deployment.ageSeconds),
      "duplicate key": text.replace('"runId":"39252891660"', '"runId":"39252891660","runId":"39252891660"'),
      "nested duplicate key": text.replace('"runsInspected":4', '"runsInspected":4,"runsInspected":4'),
      "date-only instant": mutate(both("jobCompletedAt", "2026-10-19")),
      "offset-less instant": mutate(both("jobCompletedAt", "2026-10-19T12:56:22")),
      "offset-less createdFrom": mutate(
        (document) => (document.deployment.inventory.createdFrom = "2026-09-07T13:00:00"),
      ),
      "numeric id": mutate(both("runId", 39252891660)),
      "leading-zero id": mutate(both("jobId", "0118064914233")),
      "numeric rejected job id": mutate((document) => (document.deployment.rejectedRuns[0].jobId = 117534949742)),
      "attempt 0": mutate(both("runAttempt", 0)),
      "attempt 101": mutate(both("runAttempt", 101)),
      "negative age": mutate((document) => (document.deployment.ageSeconds = -1)),
      "age above seven days": mutate((document) => (document.deployment.ageSeconds = 604_801)),
      "run number 0": mutate((document) => (document.deployment.runNumber = 0)),
      "step number 201": mutate((document) => (document.deployment.steps[1].number = 201)),
      "two steps": mutate((document) => document.deployment.steps.pop()),
      "four steps": mutate((document) => document.deployment.steps.push(document.deployment.steps[2])),
      "unsorted steps": mutate((document) => document.deployment.steps.reverse()),
      "skipped step": mutate((document) => (document.deployment.steps[2].conclusion = "skipped")),
      "job not success": mutate((document) => (document.deployment.jobConclusion = "failure")),
      "other workflow": mutate((document) => (document.deployment.workflowFile = "ci.yml")),
      "other job": mutate((document) => (document.deployment.jobName = "Deploy Production")),
      "short head": mutate(both("deployedHead", capturedHead.slice(1))),
      "digest without algorithm": mutate((document) => (document.deployment.imageDigest = capturedDigest.slice(7))),
      "collected not total": mutate((document) => (document.deployment.inventory.runsCollected = 3)),
      "inspected above total": mutate((document) => (document.deployment.inventory.runsInspected = 5)),
      "count above bound": mutate((document) => (document.deployment.inventory.jobsCollected = 100_001)),
      "unsorted rejected runs": mutate((document) => document.deployment.rejectedRuns.reverse()),
      "unknown rejection reason": mutate((document) => (document.deployment.rejectedRuns[0].reason = "coalesced")),
      "generation runId": mutate((document) => (document.deployGeneration.runId = "39252891661")),
      "generation runAttempt": mutate((document) => (document.deployGeneration.runAttempt = 2)),
      "generation jobId": mutate((document) => (document.deployGeneration.jobId = "118064914234")),
      "generation jobCompletedAt": mutate(
        (document) => (document.deployGeneration.jobCompletedAt = "2026-10-19T12:56:23Z"),
      ),
      "generation deployedHead": mutate((document) => (document.deployGeneration.deployedHead = "0".repeat(40))),
    };
    for (const [rule, value] of Object.entries(refused))
      expect(() => readStagingDeployGeneration(value), rule).toThrow("closed-schema-shallow-validation");
  });
});
