import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseInputs,
  runStagingEvidenceAuthority,
  STAGING_EVIDENCE_AUTHORITY_RUNNER_PATH,
} from "./staging-evidence-authority.mjs";

const head = "a".repeat(40);
const baseEnv = (root) => ({
  PROBE_BASE_URL: "https://marketplace.staging.chasesets.com",
  PROBE_ENVIRONMENT: "staging",
  PROBE_HEAD: head,
  PROBE_WORKTREE: root,
  PROBE_GOVERNED_PATHS: "scripts/foo.mjs",
  PROBE_OUT_FILE: join(root, "receipt.json"),
  PROBE_LOG_FILE: join(root, "authority.ndjson"),
  DEPLOY_MAX_AGE_SECONDS: "604800",
  PROBE_REQUEST_TIMEOUT_MS: "1000",
  PROBE_TOTAL_BUDGET_MS: "5000",
  PROBE_RUNNER_PATH: STAGING_EVIDENCE_AUTHORITY_RUNNER_PATH,
  GITHUB_TOKEN: "github-token-marker",
  MARKETPLACE_E2E_EMAIL: "probe@example.test",
  MARKETPLACE_E2E_PASSWORD: "password-marker",
});

const inputFor = (root) => parseInputs([], baseEnv(root), root);
const validExecuted = (root) => ({
  outcome: "ok",
  executedBytes: {
    files: [
      {
        path: "scripts/foo.mjs",
        committedBlobSha1: "2".repeat(40),
        onDiskBlobSha1: "2".repeat(40),
      },
      {
        path: "scripts/staging-evidence-authority.mjs",
        committedBlobSha1: "1".repeat(40),
        onDiskBlobSha1: "1".repeat(40),
      },
    ],
    head,
    mergedIntoOriginMain: true,
    porcelainEmpty: true,
    worktreeRoot: root,
  },
});
const validGeneration = {
  stop: null,
  deployment: {
    workflowFile: "platform-production.yml",
    workflowName: "Platform Deploy",
    jobName: "Deploy Staging",
    runId: "1",
    jobId: "2",
    runNumber: 1,
    runAttempt: 1,
    deployedHead: head,
    imageDigest: `sha256:${"3".repeat(64)}`,
    jobConclusion: "success",
    steps: [
      { name: "Activate immutable release before staging mutation", number: 1, conclusion: "success" },
      { name: "Deploy staging Kubernetes release", number: 2, conclusion: "success" },
      { name: "Mark staging applied", number: 3, conclusion: "success" },
    ],
    jobCompletedAt: "2026-10-20T00:00:00Z",
    ageSeconds: 1,
    inventory: {
      createdFrom: "2026-10-19T00:00:00Z",
      createdTo: "2026-10-20T00:00:00Z",
      runsTotalCount: 1,
      runsCollected: 1,
      runsInspected: 1,
      attemptsInspected: 1,
      jobsCollected: 1,
    },
    rejectedRuns: [],
  },
  deployGeneration: {
    runId: "1",
    runAttempt: 1,
    jobId: "2",
    jobCompletedAt: "2026-10-20T00:00:00Z",
    deployedHead: head,
  },
};
const validCompatibility = {
  outcome: "ok",
  compatibility: { deployablePathsChanged: 0, deployedHead: head, intendedHead: head, relation: "identical" },
};
const validMode = {
  url: "https://marketplace.staging.chasesets.com/api/marketplace/payment-provider-mode",
  httpStatus: 200,
  mode: "test",
  paymentProcessorKind: "stripe",
  moneyMovementKind: "stripe",
  deploymentEnvironment: "staging",
  observedAt: "2026-10-20T00:00:00Z",
};
const validWeb = {
  url: "https://marketplace.staging.chasesets.com/health/ready",
  httpStatus: 200,
  ok: true,
  service: "marketplace",
};
const validBackend = {
  url: "https://marketplace.staging.chasesets.com/api/health/ready",
  httpStatus: 200,
  aggregateStatus: "ok",
  checkCount: 1,
  degradedCheckNames: [],
};
const composeFakes = (root, overrides = {}) => ({
  input: inputFor(root),
  clock: () => Date.parse("2026-10-20T00:00:00Z"),
  readExecutedBytes: async () => validExecuted(root),
  observeProviderMode: async () => validMode,
  selectGeneration: async () => validGeneration,
  classifyRuntime: async () => validCompatibility,
  observeWebReadiness: async () => validWeb,
  observeBackendReadiness: async () => validBackend,
  requestProductHost: async () => ({
    httpStatus: 200,
    body: Buffer.from(JSON.stringify({ type: "session-started", sessionToken: "session_" + "a".repeat(36) })),
  }),
  ...overrides,
});

describe("staging evidence authority inputs", () => {
  it("AC-01 resolves every input without defaults and refuses unknown or credential argv", () => {
    const root = mkdtempSync(join(tmpdir(), "authority-input-"));
    const env = baseEnv(root);
    expect(parseInputs(["--head", "b".repeat(40), "--governed-path", "scripts/bar.mjs"], env).head).toBe(
      "b".repeat(40),
    );
    expect(() => parseInputs(["--runner-path", "scripts/other.mjs"], env)).toThrow("input-invalid");
    expect(() => parseInputs(["--marketplace-e2e-password", "secret"], env)).toThrow("input-forbidden-in-argv");
    expect(() => parseInputs([], { ...env, PROBE_GOVERNED_PATHS: "" })).toThrow("input-missing");
    expect(() => parseInputs([], { ...env, PROBE_TOTAL_BUDGET_MS: "1" })).toThrow("probe-budget-exhausted");
    expect(() => parseInputs([], { ...env, PROBE_RUNNER_PATH: undefined })).toThrow("input-missing");
    expect(() => parseInputs(["--unknown", "value"], env)).toThrow("input-invalid");
    expect(() => parseInputs(["--head", "b".repeat(40), "--head", "c".repeat(40)], env)).toThrow("input-invalid");
    expect(() => parseInputs(["--runner-path", "scripts/other.mjs"], env)).toThrow("input-invalid");
  });
});

describe("staging evidence authority composition", () => {
  it("AC-02 issues mode first and sign-in last", async () => {
    const root = mkdtempSync(join(tmpdir(), "authority-order-"));
    const env = baseEnv(root);
    const calls = [];
    const run = await runStagingEvidenceAuthority({
      ...composeFakes(root, {
        env,
        cwd: root,
        readExecutedBytes: async () => {
          calls.push("bytes");
          return validExecuted(root);
        },
        observeProviderMode: async () => {
          calls.push("mode");
          return validMode;
        },
        selectGeneration: async () => {
          calls.push("generation");
          return validGeneration;
        },
        classifyRuntime: async () => {
          calls.push("runtime");
          return validCompatibility;
        },
        observeWebReadiness: async () => {
          calls.push("web");
          return validWeb;
        },
        observeBackendReadiness: async () => {
          calls.push("backend");
          return validBackend;
        },
        requestProductHost: async ({ method, path }) => {
          calls.push(`${method}:${path}`);
          return {
            httpStatus: 200,
            body: Buffer.from(JSON.stringify({ type: "session-started", sessionToken: "opaque" })),
          };
        },
      }),
    });
    expect(calls).toEqual([
      "bytes",
      "mode",
      "generation",
      "runtime",
      "web",
      "backend",
      "POST:/api/auth/password-sign-in",
    ]);
    expect(run.exitCode).toBe(0);
    expect(run.value).toMatchObject({ result: "ok", ready: true, stop: null });
  });

  it("AC-02 stops before later product requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "authority-stop-order-"));
    const input = inputFor(root);
    const calls = [];
    const run = await runStagingEvidenceAuthority({
      ...composeFakes(root, {
        input,
        observeProviderMode: async () => {
          calls.push("mode");
          return { stop: "live-mode-detected", httpStatus: 200 };
        },
        requestProductHost: async () => {
          calls.push("sign-in");
          return { failure: "request-failed", httpStatus: null };
        },
      }),
    });
    expect(run.value).toMatchObject({ result: "failed", stop: "live-mode-detected" });
    expect(calls).toEqual(["mode"]);
  });

  it("AC-03 emits one closed result and persists only ok", async () => {
    const root = mkdtempSync(join(tmpdir(), "authority-result-"));
    const run = await runStagingEvidenceAuthority(composeFakes(root));
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(readFileSync(join(root, "receipt.json"), "utf8") + "\n");
    rmSync(join(root, "receipt.json"));
    const refused = await runStagingEvidenceAuthority(
      composeFakes(root, {
        readExecutedBytes: async () => ({ outcome: "refused", stop: "worktree-not-clean", path: "scripts/foo.mjs" }),
      }),
    );
    expect(refused.exitCode).toBe(2);
    expect(Object.keys(refused.value).sort()).toEqual(
      ["detail", "finishedAt", "ready", "result", "startedAt", "stop", "version"].sort(),
    );
    expect(readdirSync(root)).not.toContain("receipt.json");
  });

  it("AC-04 keeps planted secrets out of every output", async () => {
    const root = mkdtempSync(join(tmpdir(), "authority-redaction-"));
    const success = await runStagingEvidenceAuthority(composeFakes(root));
    expect(success.stdout).not.toMatch(/session_|github-token-marker|password-marker|probe@example\.test/i);
    expect(readFileSync(join(root, "authority.ndjson"), "utf8")).not.toMatch(
      /session_|github-token-marker|password-marker|probe@example\.test/i,
    );
    rmSync(join(root, "receipt.json"));
    const refusal = await runStagingEvidenceAuthority(
      composeFakes(root, {
        readExecutedBytes: async () => ({
          outcome: "refused",
          stop: "worktree-not-clean",
          path: "notes/someone@example.test.md",
        }),
      }),
    );
    expect(refusal.value).toMatchObject({
      result: "failed",
      stop: "redaction-scan-finding",
      detail: { input: null, path: null },
    });
    expect(refusal.stdout).not.toContain("someone@example.test");
    expect(readFileSync(join(root, "authority.ndjson"), "utf8")).not.toContain("someone@example.test");
  });

  it("AC-05 maps every stop to one result and exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "authority-stops-"));
    const input = inputFor(root);
    const rows = [
      ["input-missing", 2, "refused", async () => runStagingEvidenceAuthority({ argv: [], env: {} })],
      ["input-invalid", 2, "refused", async () => runStagingEvidenceAuthority({ argv: [1], env: {} })],
      [
        "unexpected-internal-error",
        1,
        "failed",
        async () =>
          runStagingEvidenceAuthority({
            argv: [],
            env: new Proxy(
              {},
              {
                get() {
                  throw new Error("private-planted");
                },
              },
            ),
          }),
      ],
      [
        "live-mode-detected",
        1,
        "failed",
        async () =>
          runStagingEvidenceAuthority({
            input,
            readExecutedBytes: async () => validExecuted(root),
            observeProviderMode: async () => ({ stop: "live-mode-detected" }),
          }),
      ],
      [
        "receipt-write-failed",
        1,
        "failed",
        async () =>
          runStagingEvidenceAuthority({
            ...composeFakes(root),
            input: { ...input, out: join(root, "missing", "receipt.json") },
          }),
      ],
      [
        "unexpected-internal-error",
        1,
        "failed",
        async () =>
          runStagingEvidenceAuthority({
            ...composeFakes(root),
            input,
            observeProviderMode: async () => {
              throw new Error("private exception");
            },
          }),
      ],
      [
        "auth-failed",
        1,
        "failed",
        async () =>
          runStagingEvidenceAuthority({
            ...composeFakes(root),
            input,
            requestProductHost: async () => ({ failure: "request-timeout", httpStatus: null }),
          }),
      ],
    ];
    for (const [stop, exitCode, result, run] of rows) {
      const observed = await run();
      expect(observed).toMatchObject({ exitCode, value: { stop, result, ready: false } });
      expect(Object.keys(observed.value).sort()).toEqual(
        ["detail", "finishedAt", "ready", "result", "startedAt", "stop", "version"].sort(),
      );
    }
  });

  it("AC-05 emits a single closed refusal object for missing inputs", async () => {
    const run = await runStagingEvidenceAuthority({ argv: ["--environment", "staging"], env: {} });
    expect(run.exitCode).toBe(2);
    expect(run.value).toMatchObject({
      version: "staging-evidence-authority/v1",
      result: "refused",
      ready: false,
      stop: "input-missing",
    });
    expect(Object.keys(run.value).sort()).toEqual(
      ["detail", "finishedAt", "ready", "result", "startedAt", "stop", "version"].sort(),
    );
  });
});

describe("staging evidence authority live wiring", () => {
  it("AC-06 runs captured shapes through the real composition", async () => {
    const root = mkdtempSync(join(tmpdir(), "authority-real-"));
    mkdirSync(join(root, "scripts"));
    const source = readFileSync(new URL("./staging-evidence-authority.mjs", import.meta.url), "utf8");
    writeFileSync(join(root, "scripts", "staging-evidence-authority.mjs"), source);
    writeFileSync(join(root, "scripts", "foo.mjs"), "export const version = 1;\n");
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "release-note.md"), "deployed\n");
    const git = (args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git(["init", "-q"]);
    git(["config", "user.email", "authority@example.test"]);
    git(["config", "user.name", "Authority Test"]);
    git(["add", "."]);
    git(["commit", "-qm", "deployed"]);
    const deployedHead = git(["rev-parse", "HEAD"]).toString().trim();
    writeFileSync(join(root, "docs", "release-note.md"), "intended\n");
    git(["add", "."]);
    git(["commit", "-qm", "intended"]);
    const intendedHead = git(["rev-parse", "HEAD"]).toString().trim();
    git(["update-ref", "refs/remotes/origin/main", intendedHead]);

    const platform = JSON.parse(
      readFileSync(new URL("./fixtures/staging-deploy-generation/captured-platform-deploy.json", import.meta.url)),
    );
    const capturedRun = platform.runs[0];
    const capturedJob = platform.jobs[`${capturedRun.id}/${capturedRun.run_attempt}`].jobs.find(
      (candidate) => candidate.name === "Deploy Staging",
    );
    const runId = 9000000301;
    const jobId = 9100000301;
    const run = { ...capturedRun, id: runId, created_at: "2026-10-19T12:32:46Z", updated_at: "2026-10-19T12:56:57Z" };
    const job = {
      ...capturedJob,
      id: jobId,
      run_id: runId,
      head_sha: deployedHead,
      created_at: "2026-10-20T00:00:00Z",
      started_at: "2026-10-20T00:00:00Z",
      completed_at: "2026-10-20T00:00:10Z",
      steps: capturedJob.steps.map((step) => ({
        ...step,
        status: "completed",
        conclusion: "success",
        started_at: "2026-10-20T00:00:00Z",
        completed_at: "2026-10-20T00:00:10Z",
      })),
    };
    const capturedLog = readFileSync(
      new URL("./fixtures/staging-evidence-authority/deploy-log.txt", import.meta.url),
      "utf8",
    );
    const log = capturedLog.replaceAll("a".repeat(40), deployedHead);
    const readiness = JSON.parse(
      readFileSync(new URL("./fixtures/staging-evidence-authority/product-readiness.json", import.meta.url)),
    );
    const api = "https://api.github.com/repos/chase-sets/chase-sets";
    const now = Date.parse("2026-10-20T03:00:00Z");
    const requests = [];
    const transport = async (url, init = {}) => {
      const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
      requests.push({ url, method: init.method ?? "GET", headers });
      if (url.includes("/actions/workflows/platform-production.yml/runs?"))
        return Response.json({ total_count: 1, workflow_runs: [run] });
      if (url.includes(`/actions/runs/${runId}/attempts/1/jobs`)) return Response.json({ total_count: 1, jobs: [job] });
      if (url === `${api}/actions/jobs/${jobId}/logs`)
        return new Response(null, {
          status: 302,
          headers: { location: "https://synthetic.blob.core.windows.net/log" },
        });
      if (url === "https://synthetic.blob.core.windows.net/log") return new Response(log, { status: 200 });
      const parsed = new URL(url);
      if (parsed.pathname === "/api/marketplace/payment-provider-mode")
        return Response.json({
          mode: "test",
          paymentProcessorKind: "stripe",
          moneyMovementKind: "stripe",
          deploymentEnvironment: "staging",
          observedAt: "2026-10-20T03:00:00Z",
        });
      if (parsed.pathname === "/health/ready")
        return Response.json({
          ...readiness.webReadiness,
          checkedAt: "2026-10-20T03:00:00Z",
          origin: "https://marketplace.staging.chasesets.com",
        });
      if (parsed.pathname === "/api/health/ready") return Response.json(readiness.backendReadiness);
      if (parsed.pathname === "/api/auth/password-sign-in") return Response.json(readiness.signIn);
      return new Response(null, { status: 404 });
    };
    const ioRoot = mkdtempSync(join(tmpdir(), "authority-real-io-"));
    const env = {
      ...baseEnv(root),
      PROBE_HEAD: intendedHead,
      PROBE_OUT_FILE: join(ioRoot, "receipt.json"),
      PROBE_LOG_FILE: join(ioRoot, "authority.ndjson"),
    };
    const runResult = await runStagingEvidenceAuthority({ env, argv: [], cwd: root, transport, clock: () => now });
    expect(runResult).toMatchObject({ exitCode: 0, value: { result: "ok", ready: true, stop: null } });
    expect(runResult.value.deployGeneration.deployedHead).toBe(deployedHead);
    expect(runResult.value.compatibility).toMatchObject({
      deployedHead,
      intendedHead,
      relation: "deployed-is-ancestor",
    });
    expect(requests[0].url).toContain("/api/marketplace/payment-provider-mode");
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      url: "https://marketplace.staging.chasesets.com/api/auth/password-sign-in",
    });
    expect(requests.slice(0, 1).every(({ headers }) => !headers.authorization && !headers.cookie)).toBe(true);
    expect(
      requests.filter(({ url }) => url.startsWith(api)).every(({ headers }) => Boolean(headers.authorization)),
    ).toBe(true);
    expect(
      requests
        .filter(({ url }) => new URL(url).origin === "https://marketplace.staging.chasesets.com")
        .every(
          ({ headers }) =>
            (!headers.authorization && !headers.cookie) || headers["content-type"] === "application/json",
        ),
    ).toBe(true);
    expect(runResult.stdout).toBe(readFileSync(join(ioRoot, "receipt.json"), "utf8") + "\n");
    expect(requests.slice(0, 1)[0].headers.authorization).toBeUndefined();
  });
});
