import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  classifyCountCaptureJob,
  collectCountCaptureDeployment,
  readCountCaptureExecutedDeployment,
  readCountCaptureWorkflowCapabilities,
} from "./catalog-count-capture-deployment.mjs";

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
const syntheticCiDefinition = `
name: Synthetic Pull Request CI
on: pull_request
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
`;
const syntheticStagingDefinition = `
name: Synthetic Staging Operations
on: workflow_dispatch
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
function syntheticJob(run, id, name, overrides = {}) {
  return {
    id,
    run_id: run.id,
    run_attempt: 1,
    head_sha: run.head_sha,
    name,
    status: "completed",
    conclusion: "success",
    started_at: "2026-10-13T07:00:10Z",
    completed_at: "2026-10-13T07:05:00Z",
    steps: [
      {
        name: "Run",
        number: 1,
        status: "completed",
        conclusion: "success",
        started_at: "2026-10-13T07:00:10Z",
        completed_at: "2026-10-13T07:05:00Z",
      },
    ],
    ...overrides,
  };
}

// The positive recorded fixture: the historical deploy run, the still-running
// synthetic #9587-shaped capture job and ordinary proven non-mutating CI jobs.
function positiveFixture() {
  const captureRun = syntheticRun(900001, ".github/workflows/catalog-staging-provider-uat.yml", syntheticRunnerSha, {
    status: "in_progress",
    conclusion: null,
    created_at: "2026-10-13T08:00:05Z",
    updated_at: "2026-10-13T08:01:00Z",
  });
  const ciRun = syntheticRun(900002, ".github/workflows/synthetic-ci.yml", "e".repeat(40), {
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
      ],
    ],
  ]);
  const definitions = new Map([
    [`${historicalRun.path}@${sha}`, historicalDefinition],
    [`${captureRun.path}@${syntheticRunnerSha}`, syntheticCaptureDefinition],
    [`${ciRun.path}@${ciRun.head_sha}`, syntheticCiDefinition],
    [`.github/workflows/synthetic-staging.yml@${"9".repeat(40)}`, syntheticStagingDefinition],
  ]);
  const logs = new Map([[deployment.jobId, historicalLog]]);
  return { runs, jobs, definitions, logs, captureRun, ciRun };
}

function fakeReader({ runs, jobs, definitions, logs }) {
  const runPage = /^\/actions\/runs\?per_page=100&page=(\d+)&created=(\S+)\.\.(\S+)$/;
  const jobPage = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=100&page=(\d+)$/;
  return {
    json: vi.fn(async (path) => {
      let match = runPage.exec(path);
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
      jobCount: 20,
      pageCount: 8,
      definitionCount: 3,
      nonMutatingJobCount: 6,
    });
    expect(reader.jobLog).toHaveBeenCalledExactlyOnceWith(deployment.jobId);
    expect(reader.json).not.toHaveBeenCalledWith(expect.stringContaining("/actions/runs/900003/"));
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

  it("classifies a same-repository reusable workflow by its callee at the same head", async () => {
    const caller = readCountCaptureWorkflowCapabilities(`
name: Synthetic Caller
on: pull_request
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
  it.each([
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
      "deploy-production": "non-mutating",
    });
    expect(capabilities("platform-staging-advisory-evidence.yml")).toMatchObject({
      "staging-advisory-evidence": "staging-mutator",
    });
    expect(capabilities("catalog-staging-provider-uat.yml")).toMatchObject({ "staging-provider-uat": "non-mutating" });
    expect(capabilities("platform-pr.yml")).toMatchObject({ "compose-preview-smoke": "reusable" });
    expect(capabilities("platform-compose-boot-smoke.yml")).toMatchObject({ verify: "non-mutating" });
  });
});
