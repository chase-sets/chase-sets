import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  classifyCountCaptureJob,
  collectCountCaptureDeployment,
  readCountCaptureExecutedDeployment,
  readCountCaptureExecutedRevision,
  readCountCaptureWorkflowCapabilities,
} from "./catalog-count-capture-deployment.mjs";
import { collectCaptureDeployment } from "./catalog-staging-count-lifecycle.mjs";

// Recorded evidence of Platform Deploy run 38349636491 (FINAL packet E/deploy.run.json,
// E/deploy.jobs.json, E/deploy-staging.log:5205-5239) and a reduced copy of its exact
// head-bound workflow at 7d81f3f3. Everything else below is labeled synthetic.
// Fixtures prove collector logic and shape only, never a live deployment.
const fixture = (name) =>
  readFileSync(
    new URL(`../bounded-contexts/catalog/features/scope-sync-batches/tests/fixtures/${name}`, import.meta.url),
    "utf8",
  );
const historicalRun = JSON.parse(fixture("historical-staging-run.json"));
const historicalJobs = JSON.parse(fixture("historical-staging-jobs.json")).jobs;
const historicalLog = fixture("historical-staging-deployment.txt");
const historicalDefinition = fixture("historical-staging-platform-production.yml.txt");
// Recorded attempt metadata of Platform PR run 38528671789 (GET .../runs/38528671789/attempts/1):
// head d2a2c4e2 executed its same-repository callee at the PR merge commit c77c0260.
// Only its own binding test reads it; no synthetic fact is keyed by its identity.
const recordedPrAttempt = JSON.parse(fixture("historical-pr-attempt.json"));
const [, recordedCallee, recordedMergeSha] = /^[^/]+\/[^/]+\/(.+)@([a-f0-9]{40})$/.exec(
  recordedPrAttempt.referenced_workflows[0].path,
);
const sha = "7d81f3f3309fc2a83ca3a70ee0ed5f51b45e4c0a";
const digest = "sha256:bde13c7a962cb4d6d0937bc8ac8b669ba9fd2d07a476dfc06cd05b3e602111e2";
const deployment = {
  environment: "staging",
  runId: "38349636491",
  attempt: 1,
  jobId: "115140065141",
  jobName: "Deploy Staging",
  stepNumber: 35,
  stepName: "Deploy staging Kubernetes release",
  conclusion: "success",
  startedAt: "2026-10-13T05:11:30Z",
  completedAt: "2026-10-13T05:15:20Z",
  sha,
  digest,
  logSha: sha,
  logDigest: digest,
};
const now = "2026-10-13T08:02:00Z";
const bound = { runId: "38349636491", attempt: 1, jobId: "115140065141", stepNumber: 35, sha, digest };

const syntheticRunnerSha = "c".repeat(40);
const syntheticCaptureDefinition = `
name: Catalog Staging Provider UAT
on: workflow_dispatch
permissions:
  contents: read
concurrency:
  group: platform-staging-mutating-operations
jobs:
  admit-reviewed-sha:
    name: Admit Reviewed Immutable SHA
    runs-on: ubuntu-latest
    steps:
      - run: "true"
  staging-provider-uat:
    name: Staging Provider Sync UAT (\${{ matrix.journey_scope }})
    runs-on: ubuntu-latest
    environment: staging
    strategy:
      matrix:
        journey_scope: [refresh]
    steps:
      - env:
          CATALOG_ADMIN_E2E_PASSWORD: \${{ secrets.CATALOG_ADMIN_E2E_PASSWORD }}
        run: "true"
  scope-sync-count-lifecycle:
    name: Scope Sync Count Lifecycle
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: staging
    permissions:
      contents: read
      actions: read
    steps:
      - name: Capture count lifecycle without confirmation
        env:
          CATALOG_ADMIN_E2E_EMAIL: \${{ vars.CATALOG_ADMIN_E2E_EMAIL || secrets.PLATFORM_ADMIN_EMAIL || '' }}
          CATALOG_ADMIN_E2E_PASSWORD: \${{ secrets.CATALOG_ADMIN_E2E_PASSWORD || secrets.PLATFORM_ADMIN_PASSWORD || '' }}
          GH_TOKEN: \${{ github.token }}
        run: pnpm exec tsx scripts/catalog-staging-count-lifecycle.mjs capture
`;
// The positive fixture's synthetic pull_request CI run executes its caller and its
// callee at its merge commit, which differs from its head.
const syntheticCiHead = "1".repeat(40);
const syntheticCiMerge = "2".repeat(40);
const syntheticCiCallee = ".github/workflows/synthetic-ci-callee.yml";
const reference = (path, sha, ref = "refs/pull/123/merge") => ({
  path: `synthetic/repository/${path}@${sha}`,
  ref,
  sha,
});
const syntheticCiDefinition = `
name: Synthetic Pull Request CI
on: [pull_request, push]
permissions:
  contents: read
  pull-requests: write
jobs:
  static:
    name: Static checks
    runs-on: ubuntu-24.04
    steps:
      - env:
          TURBO_TOKEN: \${{ secrets.TURBO_TOKEN }}
        run: "true"
  smoke:
    name: Deploy staging smoke
    runs-on: ubuntu-latest
    steps:
      - run: "true"
  compose-smoke:
    name: Compose Boot Smoke
    uses: ./.github/workflows/synthetic-ci-callee.yml
`;
const syntheticSafeCallee = `
name: Synthetic Callee
on: workflow_call
permissions:
  contents: read
jobs:
  verify:
    name: Verify
    runs-on: ubuntu-latest
    steps:
      - run: "true"
`;
const syntheticUnsafeCallee = `
name: Synthetic Callee
on: workflow_call
permissions:
  contents: read
jobs:
  verify:
    name: Verify
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - env:
          TOKEN: \${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
        run: "true"
`;
const syntheticStagingDefinition = `
name: Synthetic Staging Operations
on: workflow_dispatch
permissions:
  contents: read
jobs:
  recover-runtime:
    name: Recover runtime
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - env:
          TF_VAR_digitalocean_token: \${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
        run: "true"
  staging-advisory-evidence:
    name: Staging Advisory Evidence
    runs-on: ubuntu-latest
    environment: staging
    concurrency:
      group: platform-deploy-staging
    steps:
      - env:
          TF_VAR_digitalocean_token: \${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
        run: "true"
`;

function syntheticRun(id, path, headSha, overrides = {}) {
  return {
    id,
    name: "synthetic",
    path,
    event: "workflow_dispatch",
    workflow_id: id,
    run_attempt: 1,
    head_sha: headSha,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    created_at: "2026-10-13T07:00:00Z",
    updated_at: "2026-10-13T07:30:00Z",
    ...overrides,
  };
}
// A synthetic job whose one step ran for the job's whole (overridable) interval.
function syntheticJob(run, id, name, overrides = {}) {
  const { started_at = "2026-10-13T05:00:10Z", completed_at = "2026-10-13T07:05:00Z" } = overrides;
  return {
    id,
    run_id: run.id,
    run_attempt: 1,
    head_sha: run.head_sha,
    name,
    status: "completed",
    conclusion: "success",
    started_at,
    completed_at,
    steps: [
      {
        name: "Run",
        number: 1,
        status: completed_at ? "completed" : "in_progress",
        conclusion: completed_at ? "success" : null,
        started_at,
        completed_at,
      },
    ],
    ...overrides,
  };
}

// The positive fixture: the recorded historical deploy run, the still-running
// synthetic #9587-shaped capture job and the ordinary proven non-mutating jobs of a
// synthetic pull_request CI run whose definitions are served only at its merge commit.
function positiveFixture() {
  const captureRun = syntheticRun(900001, ".github/workflows/catalog-staging-provider-uat.yml", syntheticRunnerSha, {
    status: "in_progress",
    conclusion: null,
    created_at: "2026-10-13T08:00:05Z",
    updated_at: "2026-10-13T08:01:00Z",
  });
  const ciRun = syntheticRun(900002, ".github/workflows/synthetic-pr-ci.yml", syntheticCiHead, {
    event: "pull_request",
    created_at: "2026-10-13T07:55:00Z",
    updated_at: "2026-10-13T08:01:30Z",
    status: "in_progress",
    conclusion: null,
  });
  const oldRun = syntheticRun(900003, ".github/workflows/synthetic-ci.yml", "f".repeat(40), {
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:10:00Z",
  });
  const runs = [historicalRun, captureRun, ciRun, oldRun];
  const jobs = new Map([
    [`${historicalRun.id}/1`, historicalJobs],
    [
      `${captureRun.id}/1`,
      [
        syntheticJob(captureRun, 910001, "Admit Reviewed Immutable SHA", {
          started_at: "2026-10-13T08:00:10Z",
          completed_at: "2026-10-13T08:00:30Z",
        }),
        syntheticJob(captureRun, 910002, "Staging Provider Sync UAT (${{ matrix.journey_scope }})", {
          conclusion: "skipped",
          started_at: "2026-10-13T08:00:31Z",
          completed_at: "2026-10-13T08:00:31Z",
          steps: [],
        }),
        syntheticJob(captureRun, 910003, "Scope Sync Count Lifecycle", {
          status: "in_progress",
          conclusion: null,
          started_at: "2026-10-13T08:00:35Z",
          completed_at: null,
          steps: [],
        }),
      ],
    ],
    [
      `${ciRun.id}/1`,
      [
        syntheticJob(ciRun, 920001, "Static checks", { status: "in_progress", conclusion: null, completed_at: null }),
        syntheticJob(ciRun, 920002, "Deploy staging smoke", { completed_at: "2026-10-13T08:00:00Z" }),
        syntheticJob(ciRun, 920003, "Compose Boot Smoke / Verify", { completed_at: "2026-10-13T08:00:00Z" }),
      ],
    ],
  ]);
  const attempts = new Map([
    [
      `${ciRun.id}/1`,
      { ...ciRun, referenced_workflows: [reference(syntheticCiCallee, syntheticCiMerge, "refs/pull/456/merge")] },
    ],
  ]);
  const definitions = new Map([
    [`${historicalRun.path}@${sha}`, historicalDefinition],
    [`${captureRun.path}@${syntheticRunnerSha}`, syntheticCaptureDefinition],
    [`${ciRun.path}@${syntheticCiMerge}`, syntheticCiDefinition],
    [`${syntheticCiCallee}@${syntheticCiMerge}`, syntheticSafeCallee],
    [`.github/workflows/synthetic-staging.yml@${"9".repeat(40)}`, syntheticStagingDefinition],
  ]);
  const logs = new Map([[deployment.jobId, historicalLog]]);
  return { runs, jobs, attempts, definitions, logs, captureRun, ciRun };
}

// Unless a case records an attempt's own object, an attempt repeats its listed run.
function fakeReader({ runs, jobs, attempts = new Map(), definitions, logs }) {
  const runPage = /^\/actions\/runs\?per_page=100&page=(\d+)&created=(\S+)\.\.(\S+)$/;
  const jobPage = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100&page=(\d+)$/;
  const attemptRead = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)$/;
  return {
    json: vi.fn(async (path) => {
      let match = attemptRead.exec(path);
      if (match) {
        const run = runs.find((candidate) => String(candidate.id) === match[1]);
        if (!run) throw new Error("synthetic-unexpected-attempt-read");
        return attempts.get(`${match[1]}/${match[2]}`) ?? { ...run, run_attempt: Number(match[2]) };
      }
      match = runPage.exec(path);
      if (match) {
        const [, page, from, to] = match;
        const inRange = runs.filter(
          (run) => Date.parse(run.created_at) >= Date.parse(from) && Date.parse(run.created_at) < Date.parse(to) + 1000,
        );
        return { total_count: inRange.length, workflow_runs: inRange.slice((page - 1) * 100, page * 100) };
      }
      match = jobPage.exec(path);
      if (match) {
        const list = jobs.get(`${match[1]}/${match[2]}`);
        if (!list) throw new Error("synthetic-unexpected-jobs-read");
        return { total_count: list.length, jobs: list.slice((match[3] - 1) * 100, match[3] * 100) };
      }
      throw new Error("synthetic-unexpected-path");
    }),
    workflow: vi.fn(async (path, ref) => {
      const text = definitions.get(`${path}@${ref}`);
      if (text === undefined) throw new Error("synthetic-unexpected-definition");
      return text;
    }),
    jobLog: vi.fn(async (jobId) => {
      const log = logs.get(jobId);
      if (log === undefined) throw new Error("synthetic-unexpected-log");
      return log;
    }),
  };
}

const collect = (fixtureValue, input = deployment) =>
  collectCountCaptureDeployment(fakeReader(fixtureValue), input, now);

// A synthetic job that can dispatch any workflow with the run's own token.
const dispatcherDefinition = (workflowPermissions, jobPermissions) => `
name: Synthetic Dispatcher
on: workflow_dispatch
${workflowPermissions}jobs:
  dispatch:
    name: Synthetic Dispatch
    runs-on: ubuntu-latest
${jobPermissions}    steps:
      - env:
          GH_TOKEN: \${{ github.token }}
        run: gh workflow run synthetic-deploy.yml
`;
function addDispatcher(value, workflowPermissions, jobPermissions) {
  const run = syntheticRun(950001, ".github/workflows/synthetic-dispatcher.yml", "8".repeat(40), {
    created_at: "2026-10-13T07:50:00Z",
    updated_at: "2026-10-13T07:55:00Z",
  });
  value.runs.push(run);
  value.jobs.set(`${run.id}/1`, [
    syntheticJob(run, 951001, "Synthetic Dispatch", { completed_at: "2026-10-13T07:55:00Z" }),
  ]);
  value.definitions.set(`${run.path}@${run.head_sha}`, dispatcherDefinition(workflowPermissions, jobPermissions));
}

// A synthetic pull_request run whose head and merge commits are distinct; each
// attempt's object records the callee GitHub executed and at which revision.
// Exactly one of its jobs executes: "Smoke" through the callee, or the caller's
// own "Direct" job, which only the caller's executed revision decides.
const syntheticPrHead = "d".repeat(40);
const syntheticMerge = "b".repeat(40);
const syntheticCaller = (directMutates) => `
name: Synthetic Pull Request Caller
on: pull_request
permissions:
  contents: read
jobs:
  smoke:
    name: Smoke
    uses: ./.github/workflows/synthetic-callee.yml
  direct:
    name: Direct
    runs-on: ubuntu-latest
${directMutates ? "    environment: staging\n" : ""}    steps:
      - env:
          TOKEN: \${{ secrets.${directMutates ? "DIGITALOCEAN_ACCESS_TOKEN" : "GITHUB_TOKEN"} }}
        run: "true"
`;
// The hostile run is listed after the positive fixture's pull_request CI run, so
// its cases make that run head-sourced: a wrong-revision read of the base cannot
// end collection before the hostile run's own attempt is reached.
function headSourcedCi(value) {
  const run = { ...value.ciRun, event: "push" };
  value.runs[value.runs.indexOf(value.ciRun)] = run;
  value.ciRun = run;
  value.attempts.set(`${run.id}/1`, {
    ...run,
    referenced_workflows: [reference(syntheticCiCallee, run.head_sha, "refs/heads/main")],
  });
  value.definitions.set(`${run.path}@${run.head_sha}`, syntheticCiDefinition);
  value.definitions.set(`${syntheticCiCallee}@${run.head_sha}`, syntheticSafeCallee);
}
function addPullRequestRun(
  value,
  {
    event = "pull_request",
    references = [reference(".github/workflows/synthetic-callee.yml", syntheticMerge)],
    laterReferences = references,
    runAttempt = 1,
    attemptOverrides = {},
    executes = "Smoke / Verify",
    mergeCallee = syntheticSafeCallee,
    mergeDirectMutates = false,
  } = {},
) {
  headSourcedCi(value);
  const run = syntheticRun(960001, ".github/workflows/synthetic-pr.yml", syntheticPrHead, {
    event,
    run_attempt: runAttempt,
    created_at: "2026-10-13T07:50:00Z",
    updated_at: "2026-10-13T07:58:00Z",
  });
  value.runs.push(run);
  const skipped = executes === "Direct" ? "Smoke" : "Direct";
  for (let attempt = 1; attempt <= runAttempt; attempt++) {
    value.jobs.set(
      `${run.id}/${attempt}`,
      [
        syntheticJob(run, 961000 + attempt, executes, {
          started_at: "2026-10-13T07:50:10Z",
          completed_at: "2026-10-13T07:58:00Z",
        }),
        syntheticJob(run, 962000 + attempt, skipped, {
          conclusion: "skipped",
          started_at: "2026-10-13T07:50:10Z",
          completed_at: "2026-10-13T07:50:10Z",
          steps: [],
        }),
      ].map((job) => ({ ...job, run_attempt: attempt })),
    );
    value.attempts.set(`${run.id}/${attempt}`, {
      ...run,
      run_attempt: attempt,
      referenced_workflows: attempt === runAttempt ? laterReferences : references,
      ...attemptOverrides,
    });
  }
  for (const [revision, directMutates, callee] of [
    [syntheticPrHead, false, syntheticSafeCallee],
    [syntheticMerge, mergeDirectMutates, mergeCallee],
  ]) {
    value.definitions.set(`${run.path}@${revision}`, syntheticCaller(directMutates));
    value.definitions.set(`.github/workflows/synthetic-callee.yml@${revision}`, callee);
  }
  return run;
}

describe("rejects unbound deployment collector", () => {
  it("binds the historical executed job's own step log, not a workflow conclusion", () => {
    const job = historicalJobs.find((candidate) => String(candidate.id) === deployment.jobId);
    expect(readCountCaptureExecutedDeployment(job, historicalLog, deployment)).toEqual(bound);
  });

  it("binds with the still-running isolated capture job and ordinary proven non-mutating jobs", async () => {
    const value = positiveFixture();
    const reader = fakeReader(value);
    expect(await collectCountCaptureDeployment(reader, deployment, now)).toEqual({
      collectedAt: now,
      outcome: "bound",
      reason: null,
      binding: bound,
      createdFrom: "2026-09-08T05:11:30Z",
      runCount: 4,
      attemptCount: 3,
      jobCount: 21,
      pageCount: 12,
      definitionCount: 4,
      nonMutatingJobCount: 7,
    });
    expect(reader.jobLog).toHaveBeenCalledExactlyOnceWith(deployment.jobId);
    expect(reader.json).not.toHaveBeenCalledWith(expect.stringContaining("/actions/runs/900003/"));
    // The pull_request caller and its callee are read at the attempt's merge commit, never its head.
    expect(reader.workflow).toHaveBeenCalledWith(value.ciRun.path, syntheticCiMerge);
    expect(reader.workflow).toHaveBeenCalledWith(syntheticCiCallee, syntheticCiMerge);
    expect(reader.workflow).not.toHaveBeenCalledWith(expect.anything(), value.ciRun.head_sha);
  });

  it("binds the recorded pull_request attempt to its merge commit, never its head", () => {
    // The attempt object is its own listed run: every field read here is GitHub's.
    expect(readCountCaptureExecutedRevision(recordedPrAttempt, recordedPrAttempt.run_attempt, recordedPrAttempt)).toBe(
      "c77c02608571d9ce55827bfa877fe68d3d85b1d0",
    );
    expect(recordedPrAttempt.head_sha).toBe("d2a2c4e2c69deed324900c1da32c0bec1b6cc96a");
  });

  it("keys no synthetic fixture fact by the recorded pull_request attempt", () => {
    const hostile = positiveFixture();
    addPullRequestRun(hostile);
    for (const value of [positiveFixture(), hostile]) {
      const synthetic = JSON.stringify([value.runs, [...value.jobs], [...value.attempts], [...value.definitions]]);
      for (const recorded of [
        String(recordedPrAttempt.id),
        recordedPrAttempt.head_sha,
        recordedMergeSha,
        recordedPrAttempt.path,
        recordedCallee,
      ])
        expect(synthetic).not.toContain(recorded);
    }
  });

  it("keeps a genuinely completed earlier mutator outside the window", async () => {
    const value = positiveFixture();
    const run = syntheticRun(930001, ".github/workflows/synthetic-staging.yml", "9".repeat(40), {
      created_at: "2026-10-13T05:00:00Z",
      updated_at: "2026-10-13T05:12:00Z",
    });
    value.runs.push(run);
    value.jobs.set(`${run.id}/1`, [
      syntheticJob(run, 931001, "Recover runtime", {
        started_at: "2026-10-13T05:01:00Z",
        completed_at: "2026-10-13T05:05:00Z",
        steps: [
          {
            name: "Run",
            number: 1,
            status: "completed",
            conclusion: "success",
            started_at: "2026-10-13T05:01:00Z",
            completed_at: "2026-10-13T05:05:00Z",
          },
        ],
      }),
    ]);
    expect(await collect(value)).toMatchObject({ outcome: "bound", binding: bound });
  });

  it("binds when a later job's equivalent token is read-only", async () => {
    const value = positiveFixture();
    addDispatcher(value, "permissions:\n  actions: read\n  contents: read\n", "");
    expect(await collect(value)).toMatchObject({ outcome: "bound", binding: bound });
  });

  it("splits a filtered range above GitHub's 1,000-result cap and still pages it completely", async () => {
    const value = positiveFixture();
    for (let index = 0; index < 1500; index++)
      value.runs.push(
        syntheticRun(800000 + index, ".github/workflows/synthetic-ci.yml", "f".repeat(40), {
          created_at: new Date(Date.parse("2026-09-10T00:00:00Z") + index * 60_000).toISOString().replace(".000Z", "Z"),
          updated_at: "2026-10-01T00:10:00Z",
        }),
      );
    expect(await collect(value)).toMatchObject({ outcome: "bound", runCount: 1504 });
  });

  it("does not let a name decide capability: a deploy-sounding job without staging credentials passes", async () => {
    const definitions = readCountCaptureWorkflowCapabilities(syntheticCiDefinition);
    expect(await classifyCountCaptureJob(definitions, "Deploy staging smoke")).toBe("non-mutating");
    expect(
      await classifyCountCaptureJob(
        readCountCaptureWorkflowCapabilities(syntheticStagingDefinition),
        "Recover runtime",
      ),
    ).toBe("staging-mutator");
  });

  it.each([
    ["workflow-level Actions write", "staging-mutator", "permissions:\n  actions: write\n", ""],
    [
      "job-level Actions write",
      "staging-mutator",
      "permissions:\n  contents: read\n",
      "    permissions:\n      actions: write\n",
    ],
    ["workflow write-all", "staging-mutator", "permissions: write-all\n", ""],
    ["job write-all", "staging-mutator", "permissions: {}\n", "    permissions: write-all\n"],
    ["an undeclared repository default", "staging-mutator", "", ""],
    ["read-all", "non-mutating", "permissions: read-all\n", ""],
    ["explicit Actions read", "non-mutating", "permissions:\n  actions: read\n  contents: read\n", ""],
    ["no permissions", "non-mutating", "permissions: {}\n", ""],
  ])("classifies a job dispatching with %s as %s", async (_case, expected, workflowPermissions, jobPermissions) => {
    expect(
      await classifyCountCaptureJob(
        readCountCaptureWorkflowCapabilities(dispatcherDefinition(workflowPermissions, jobPermissions)),
        "Synthetic Dispatch",
      ),
    ).toBe(expected);
  });

  it("does not let a reusable caller with Actions write delegate its capability", async () => {
    const caller = readCountCaptureWorkflowCapabilities(`
name: Synthetic Caller
on: workflow_dispatch
permissions:
  actions: write
jobs:
  smoke:
    name: Smoke
    uses: ./.github/workflows/synthetic-callee.yml
`);
    const readCallee = vi.fn(async () => readCountCaptureWorkflowCapabilities(syntheticSafeCallee));
    expect(await classifyCountCaptureJob(caller, "Smoke / Verify", readCallee)).toBe("staging-mutator");
  });

  it("classifies a same-repository reusable workflow by its callee at the same head", async () => {
    const caller = readCountCaptureWorkflowCapabilities(`
name: Synthetic Caller
on: pull_request
permissions:
  contents: read
jobs:
  smoke:
    name: Compose Boot Smoke
    uses: ./.github/workflows/synthetic-callee.yml
  remote:
    name: Remote Call
    uses: synthetic/elsewhere/.github/workflows/x.yml@main
`);
    const callee = (environment, nested = false) =>
      readCountCaptureWorkflowCapabilities(`
name: Synthetic Callee
on: workflow_call
permissions:
  contents: read
jobs:
  verify:
    name: Compose Boot Smoke | target=\${{ inputs.target_sha }}
    runs-on: ubuntu-latest
    ${environment ? `environment: ${environment}` : ""}
    steps:
      - env:
          TOKEN: \${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
        run: "true"
${nested ? "  again:\n    uses: ./.github/workflows/synthetic-callee.yml" : ""}
`);
    const readCallee = (definitions) =>
      vi.fn(async (path) => (path === ".github/workflows/synthetic-callee.yml" ? definitions : []));
    const name = "Compose Boot Smoke / Compose Boot Smoke | target=abc";
    expect(await classifyCountCaptureJob(caller, name, readCallee(callee(null)))).toBe("non-mutating");
    expect(await classifyCountCaptureJob(caller, name, readCallee(callee("staging")))).toBe("staging-mutator");
    expect(await classifyCountCaptureJob(caller, "Compose Boot Smoke", readCallee(callee(null, true)))).toBe(
      "staging-mutator",
    );
    expect(await classifyCountCaptureJob(caller, "Compose Boot Smoke / Unlisted", readCallee(callee(null)))).toBe(
      "unclassified",
    );
    expect(await classifyCountCaptureJob(caller, "Remote Call / verify", readCallee(callee(null)))).toBe(
      "staging-mutator",
    );
  });

  const stagingRun = (overrides) =>
    syntheticRun(930001, ".github/workflows/synthetic-staging.yml", "9".repeat(40), {
      created_at: "2026-10-13T05:00:00Z",
      updated_at: "2026-10-13T06:00:00Z",
      ...overrides,
    });
  // A staging mutator listed with the given timing; the run's update postdates the window.
  const stagingMutator = (value, job) => {
    const run = stagingRun();
    value.runs.push(run);
    value.jobs.set(`${run.id}/1`, [syntheticJob(run, 931001, "Recover runtime", job)]);
  };
  const executedStep = (started_at, completed_at) => ({
    name: "Run",
    number: 1,
    status: "completed",
    conclusion: "success",
    started_at,
    completed_at,
  });
  it.each([
    [
      "a selected job without executed times",
      (value) =>
        value.jobs.set(
          `${historicalRun.id}/1`,
          historicalJobs.map((job) =>
            String(job.id) === deployment.jobId ? { ...job, started_at: null, completed_at: null } : job,
          ),
        ),
      "selected-job-unexecuted",
    ],
    [
      "a mutator claiming completion before it started",
      (value) =>
        stagingMutator(value, {
          started_at: "2026-10-13T05:20:00Z",
          completed_at: "2026-10-13T05:05:00Z",
          steps: [executedStep("2026-10-13T05:20:00Z", "2026-10-13T05:25:00Z")],
        }),
      "malformed-response",
    ],
    [
      "a step-free mutator claiming completion before it started",
      (value) =>
        stagingMutator(value, { started_at: "2026-10-13T05:20:00Z", completed_at: "2026-10-13T05:05:00Z", steps: [] }),
      "staging-mutation-overlap",
    ],
    [
      "a mutator whose executed step falls outside its claimed interval",
      (value) =>
        stagingMutator(value, {
          started_at: "2026-10-13T05:00:00Z",
          completed_at: "2026-10-13T05:10:00Z",
          steps: [executedStep("2026-10-13T05:00:00Z", "2026-10-13T05:20:00Z")],
        }),
      "malformed-response",
    ],
    [
      "a mutator whose executed step has no times",
      (value) =>
        stagingMutator(value, {
          started_at: "2026-10-13T05:00:00Z",
          completed_at: "2026-10-13T05:10:00Z",
          steps: [executedStep(null, null)],
        }),
      "malformed-response",
    ],
    [
      "a completed mutator without executed times",
      (value) =>
        stagingMutator(value, {
          started_at: null,
          completed_at: null,
          steps: [executedStep("2026-10-13T05:00:00Z", "2026-10-13T05:05:00Z")],
        }),
      "malformed-response",
    ],
    [
      "a later job dispatching with explicit job-level Actions write",
      (value) => addDispatcher(value, "permissions:\n  contents: read\n", "    permissions:\n      actions: write\n"),
      "staging-mutation-overlap",
    ],
    [
      "a later job dispatching with inherited Actions write",
      (value) => addDispatcher(value, "permissions:\n  actions: write\n  contents: read\n", ""),
      "staging-mutation-overlap",
    ],
    [
      "a later job dispatching with job-level write-all",
      (value) => addDispatcher(value, "permissions: {}\n", "    permissions: write-all\n"),
      "staging-mutation-overlap",
    ],
    [
      "an unclassified job",
      (value) => {
        const run = stagingRun();
        value.runs.push(run);
        value.jobs.set(`${run.id}/1`, [
          syntheticJob(run, 931001, "Unlisted maintenance", { completed_at: "2026-10-13T06:00:00Z" }),
        ]);
      },
      "deployment-capability-unknown",
    ],
    [
      "a renamed mutator",
      (value) => {
        const run = stagingRun();
        value.runs.push(run);
        value.jobs.set(`${run.id}/1`, [
          syntheticJob(run, 931001, "Recover runtime", { completed_at: "2026-10-13T06:00:00Z" }),
        ]);
      },
      "staging-mutation-overlap",
    ],
    [
      "a later sequenced advisory evidence job holding staging credentials",
      (value) => {
        const run = stagingRun({ created_at: "2026-10-13T05:16:00Z", updated_at: "2026-10-13T05:40:00Z" });
        value.runs.push(run);
        value.jobs.set(`${run.id}/1`, [
          syntheticJob(run, 931001, "Staging Advisory Evidence", {
            started_at: "2026-10-13T05:16:30Z",
            completed_at: "2026-10-13T05:40:00Z",
          }),
        ]);
      },
      "staging-mutation-overlap",
    ],
    [
      "an overlapping failed deploy",
      (value) => {
        const run = syntheticRun(940001, historicalRun.path, sha, {
          created_at: "2026-10-13T05:12:00Z",
          updated_at: "2026-10-13T05:30:00Z",
          conclusion: "failure",
        });
        value.runs.push(run);
        value.jobs.set(`${run.id}/1`, [
          syntheticJob(run, 941001, "Deploy Staging", { conclusion: "failure", completed_at: "2026-10-13T05:30:00Z" }),
        ]);
      },
      "staging-mutation-overlap",
    ],
    [
      "an in-progress deploy",
      (value) => {
        const run = syntheticRun(940001, historicalRun.path, sha, {
          status: "in_progress",
          conclusion: null,
          created_at: "2026-10-13T08:01:00Z",
          updated_at: "2026-10-13T08:01:30Z",
        });
        value.runs.push(run);
        value.jobs.set(`${run.id}/1`, [
          syntheticJob(run, 941001, "Deploy Staging", {
            status: "queued",
            conclusion: null,
            started_at: null,
            completed_at: null,
            steps: [],
          }),
        ]);
      },
      "staging-mutation-overlap",
    ],
    [
      "an earlier-started deploy that finished after the selected step began",
      (value) => {
        const run = syntheticRun(940001, historicalRun.path, sha, {
          created_at: "2026-10-13T05:00:00Z",
          updated_at: "2026-10-13T05:16:00Z",
        });
        value.runs.push(run);
        value.jobs.set(`${run.id}/1`, [
          syntheticJob(run, 941001, "Deploy Staging", {
            started_at: "2026-10-13T05:09:00Z",
            completed_at: "2026-10-13T05:16:00Z",
          }),
        ]);
      },
      "staging-mutation-overlap",
    ],
    [
      "a re-run attempt of the selected deploy",
      (value) => {
        const run = value.runs[0];
        value.runs[0] = { ...run, run_attempt: 2, updated_at: "2026-10-13T06:00:00Z" };
        value.jobs.set(`${run.id}/2`, [
          {
            ...syntheticJob(run, 115150000000, "Deploy Staging", { completed_at: "2026-10-13T06:00:00Z" }),
            run_attempt: 2,
          },
        ]);
      },
      "staging-mutation-overlap",
    ],
    [
      "a dynamic workflow without a head-bound definition",
      (value) => {
        const run = stagingRun({ path: "dynamic/dependabot/dependabot-updates" });
        value.runs.push(run);
        value.jobs.set(`${run.id}/1`, [
          syntheticJob(run, 931001, "Dependabot", { completed_at: "2026-10-13T06:00:00Z" }),
        ]);
      },
      "deployment-capability-unknown",
    ],
    [
      "truncated runs",
      (value) => {
        const reader = fakeReader(value);
        const json = reader.json.getMockImplementation();
        value.reader = {
          ...reader,
          json: async (path) => {
            const body = await json(path);
            return path.startsWith("/actions/runs?") ? { ...body, workflow_runs: body.workflow_runs.slice(1) } : body;
          },
        };
      },
      "inventory-truncated",
    ],
    [
      "truncated jobs",
      (value) => {
        const reader = fakeReader(value);
        const json = reader.json.getMockImplementation();
        value.reader = {
          ...reader,
          json: async (path) => {
            const body = await json(path);
            return path.includes("/jobs?") ? { ...body, total_count: body.total_count + 1 } : body;
          },
        };
      },
      "inventory-truncated",
    ],
    [
      "an inventory that changes between pages",
      (value) => {
        for (let index = 0; index < 150; index++)
          value.runs.push(
            syntheticRun(700000 + index, ".github/workflows/synthetic-ci.yml", "f".repeat(40), {
              created_at: "2026-10-02T00:00:00Z",
              updated_at: "2026-10-02T00:10:00Z",
            }),
          );
        const reader = fakeReader(value);
        const json = reader.json.getMockImplementation();
        value.reader = {
          ...reader,
          json: async (path) => {
            const body = await json(path);
            return path.startsWith("/actions/runs?per_page=100&page=2&")
              ? { ...body, total_count: body.total_count + 1 }
              : body;
          },
        };
      },
      "inventory-changed",
    ],
    [
      "a filtered range that cannot be split under the cap",
      (value) => {
        const reader = fakeReader(value);
        value.reader = { ...reader, json: async () => ({ total_count: 1001, workflow_runs: [] }) };
      },
      "inventory-cap",
    ],
    [
      "an HTTP failure",
      (value) => {
        value.reader = { ...fakeReader(value), workflow: async () => Promise.reject(new Error("synthetic-503")) };
      },
      "http-failure",
    ],
    ["a deleted collector read", (value) => (value.reader = { json: async () => undefined }), "malformed-response"],
    [
      "a selected job whose step was skipped",
      (value) =>
        value.jobs.set(
          `${historicalRun.id}/1`,
          historicalJobs.map((job) =>
            String(job.id) === deployment.jobId
              ? {
                  ...job,
                  steps: job.steps.map((step) => (step.number === 35 ? { ...step, conclusion: "skipped" } : step)),
                }
              : job,
          ),
        ),
      "selected-job-unexecuted",
    ],
    [
      "a log block outside the executed step",
      (value) =>
        value.logs.set(deployment.jobId, historicalLog.replaceAll("2026-10-13T05:15:20.7", "2026-10-13T05:15:21.7")),
      "deploy-log-unbound",
    ],
    [
      "a duplicated log block",
      (value) => value.logs.set(deployment.jobId, `${historicalLog}\n${historicalLog}`),
      "deploy-log-unbound",
    ],
    [
      "a log binding another image",
      (value) => value.logs.set(deployment.jobId, historicalLog.replace(digest.slice(7), "0".repeat(64))),
      "deploy-image-mismatch",
    ],
  ])("returns unknown for %s", async (_case, mutate, reason) => {
    const value = positiveFixture();
    mutate(value);
    const result = await collectCountCaptureDeployment(value.reader ?? fakeReader(value), deployment, now);
    expect(result).toMatchObject({ outcome: "unknown", reason, binding: null });
  });

  // Each executed-revision case counts only once collection reached the hostile
  // run's own last attempt; the caller and callee are harmless at its head.
  it.each([
    [
      "a pull_request caller whose own job changed capability at its merge commit",
      { executes: "Direct", mergeDirectMutates: true },
      "staging-mutation-overlap",
    ],
    [
      "a pull_request caller whose callee changed capability at its merge commit",
      { mergeCallee: syntheticUnsafeCallee },
      "staging-mutation-overlap",
    ],
    [
      "a pull_request attempt without a merge-bound reference",
      { executes: "Direct", references: [] },
      "deployment-capability-unknown",
    ],
    [
      "a pull_request attempt with ambiguous merge revisions",
      {
        executes: "Direct",
        references: [
          reference(".github/workflows/synthetic-callee.yml", syntheticMerge),
          reference(".github/workflows/synthetic-other.yml", "e".repeat(40)),
        ],
      },
      "deployment-capability-unknown",
    ],
    [
      "a pull_request re-run attempt that lost its merge-bound reference",
      { executes: "Direct", runAttempt: 2, laterReferences: [] },
      "deployment-capability-unknown",
    ],
    [
      "an attempt object that disagrees with its listed run",
      { attemptOverrides: { head_sha: "e".repeat(40) } },
      "malformed-response",
    ],
    [
      "a pull_request_target run whose executed revision is not recorded",
      { executes: "Direct", event: "pull_request_target" },
      "deployment-capability-unknown",
    ],
    [
      "a head-bound caller whose callee reference names another revision",
      {
        event: "workflow_dispatch",
        references: [reference(".github/workflows/synthetic-callee.yml", syntheticMerge, "refs/heads/main")],
      },
      "deployment-capability-unknown",
    ],
    [
      "a head-bound caller whose callee is not referenced",
      { event: "workflow_dispatch", references: [] },
      "deployment-capability-unknown",
    ],
  ])("returns unknown for %s", async (_case, options, reason) => {
    const value = positiveFixture();
    const target = addPullRequestRun(value, options);
    const reader = fakeReader(value);
    const result = await collectCountCaptureDeployment(reader, deployment, now);
    expect(reader.json).toHaveBeenCalledWith(`/actions/runs/${target.id}/attempts/${target.run_attempt}`);
    expect(result).toMatchObject({ outcome: "unknown", reason, binding: null });
  });

  it("binds the isolated base with a hostile run that is harmless at both revisions", async () => {
    const value = positiveFixture();
    const target = addPullRequestRun(value, { executes: "Direct" });
    const reader = fakeReader(value);
    expect(await collectCountCaptureDeployment(reader, deployment, now)).toMatchObject({
      outcome: "bound",
      binding: bound,
    });
    expect(reader.workflow).toHaveBeenCalledWith(target.path, syntheticMerge);
    expect(reader.workflow).not.toHaveBeenCalledWith(target.path, syntheticPrHead);
  });

  it("returns unknown for a selected deployment claim that does not match the executed job", async () => {
    expect(await collect(positiveFixture(), { ...deployment, attempt: 2 })).toMatchObject({
      outcome: "unknown",
      reason: "selected-job-unexecuted",
    });
    // Naming another job leaves the real executed deploy unexplained after the window opened.
    expect(await collect(positiveFixture(), { ...deployment, jobId: "1" })).toMatchObject({
      outcome: "unknown",
      reason: "staging-mutation-overlap",
    });
    const withoutDeploy = positiveFixture();
    withoutDeploy.jobs.set(
      `${historicalRun.id}/1`,
      historicalJobs.filter((job) => String(job.id) !== deployment.jobId),
    );
    expect(await collect(withoutDeploy)).toMatchObject({ outcome: "unknown", reason: "selected-job-missing" });
  });
});

describe("classifies the current head-bound workflow definitions", () => {
  const capabilities = (file) =>
    Object.fromEntries(
      readCountCaptureWorkflowCapabilities(readFileSync(`.github/workflows/${file}`, "utf8")).map((definition) => [
        definition.key,
        definition.capability,
      ]),
    );
  it("parses every workflow and keeps staging deployers, advisory evidence and sign-in-only jobs apart", () => {
    for (const file of readdirSync(".github/workflows").filter((name) => /\.ya?ml$/.test(name)))
      expect(() =>
        readCountCaptureWorkflowCapabilities(readFileSync(`.github/workflows/${file}`, "utf8")),
      ).not.toThrow();
    expect(capabilities("platform-production.yml")).toMatchObject({
      "deploy-staging": "staging-mutator",
      "reconcile-managed-postgres-ca-staging": "staging-mutator",
      "dispatch-ephemeral-verification": "staging-mutator",
      "deploy-production": "non-mutating",
    });
    expect(capabilities("platform-release-candidate.yml")).toMatchObject({
      "dispatch-release-candidate": "staging-mutator",
    });
    expect(capabilities("platform-staging-advisory-evidence.yml")).toMatchObject({
      "staging-advisory-evidence": "staging-mutator",
    });
    expect(capabilities("catalog-staging-provider-uat.yml")).toMatchObject({ "staging-provider-uat": "non-mutating" });
    expect(capabilities("platform-pr.yml")).toMatchObject({ "compose-preview-smoke": "reusable" });
    expect(capabilities("platform-compose-boot-smoke.yml")).toMatchObject({ verify: "non-mutating" });
  });
});

describe("count capture runner collector wiring", () => {
  it("passes the #9583 deployment block, not its authority envelope, to the collector", async () => {
    const value = positiveFixture();
    const reader = fakeReader(value);
    await expect(collectCaptureDeployment(reader, deployment, now)).resolves.toMatchObject({ outcome: "bound" });

    const mutantReader = fakeReader(value);
    await expect(collectCaptureDeployment(mutantReader, { deployment }, now)).resolves.toMatchObject({
      outcome: "unknown",
      reason: "authority-invalid",
    });
    expect(mutantReader.json).not.toHaveBeenCalled();
  });
});
