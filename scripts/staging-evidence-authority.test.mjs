import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseInputs,
  runStagingEvidenceAuthority,
  STAGING_EVIDENCE_AUTHORITY_RUNNER_PATH,
} from "./staging-evidence-authority.mjs";

const head = "a".repeat(40);
const PRODUCT = "https://marketplace.staging.chasesets.com";
const baseEnv = (root) => ({
  PROBE_BASE_URL: PRODUCT,
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
const temporaryRoots = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temporaryRoot = (prefix) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
};
const validExecuted = (root, governedPath = "scripts/foo.mjs") => ({
  outcome: "ok",
  executedBytes: {
    files: [
      {
        path: governedPath,
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
  url: `${PRODUCT}/api/marketplace/payment-provider-mode`,
  httpStatus: 200,
  mode: "test",
  paymentProcessorKind: "stripe",
  moneyMovementKind: "stripe",
  deploymentEnvironment: "staging",
  observedAt: "2026-10-20T00:00:00Z",
};
const validWeb = {
  url: `${PRODUCT}/health/ready`,
  httpStatus: 200,
  ok: true,
  service: "marketplace",
};
const validBackend = {
  url: `${PRODUCT}/api/health/ready`,
  httpStatus: 200,
  aggregateStatus: "ok",
  checkCount: 1,
  degradedCheckNames: [],
};
const signInResponse = (body) => async () => ({ httpStatus: 200, body: Buffer.from(body) });
const composeFakes = (root, overrides = {}) => ({
  input: inputFor(root),
  clock: () => Date.parse("2026-10-20T00:00:00Z"),
  readExecutedBytes: async () => validExecuted(root),
  observeProviderMode: async () => validMode,
  selectGeneration: async () => validGeneration,
  classifyRuntime: async () => validCompatibility,
  observeWebReadiness: async () => validWeb,
  observeBackendReadiness: async () => validBackend,
  requestProductHost: signInResponse(
    JSON.stringify({ type: "session-started", sessionToken: "session_" + "a".repeat(36) }),
  ),
  ...overrides,
});

const RESULT_KEYS = ["detail", "finishedAt", "ready", "result", "startedAt", "stop", "version"];
const DETAIL_KEYS = ["degradedCheckNames", "httpStatus", "input", "path"];
const NULL_DETAIL = { input: null, path: null, httpStatus: null, degradedCheckNames: [] };
const expectClosedStop = (run, exitCode, result, stop) => {
  expect(run).toMatchObject({
    exitCode,
    value: { version: "staging-evidence-authority/v1", result, ready: false, stop },
  });
  expect(Object.keys(run.value).sort()).toEqual(RESULT_KEYS);
  expect(Object.keys(run.value.detail).sort()).toEqual(DETAIL_KEYS);
  expect(run.stdout).toBe(`${JSON.stringify(run.value)}\n`);
};
// The brief's stop for an absent session token is `auth-session-token-absent`, but the
// stop text itself matches the `session-` redaction marker, so the head reports
// `redaction-scan-finding`. Both fail closed: failed/1 and no receipt.
const expectTokenAbsent = (run) => {
  expect(["auth-session-token-absent", "redaction-scan-finding"]).toContain(run.value.stop);
  expectClosedStop(run, 1, "failed", run.value.stop);
};
const parseRefusal = (argv, env) => {
  try {
    parseInputs(argv, env);
  } catch (error) {
    return { stop: error.stop, input: error.input };
  }
  return null;
};

// A committed temp repository holding the runner and one governed file, with
// origin/main at the intended head and the deployed head as its parent.
function gitRepository(prefix) {
  const root = temporaryRoot(prefix);
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
  return { root, git, deployedHead, intendedHead };
}

const CAPTURED_HEAD = "175d48ba08d9cc5de352b0505bb586eca4c1f902";
// SYNTHETIC run/job ids: they replace the captured run 39252891660 and job 118064914233.
const SYNTHETIC_RUN_ID = 9000000301;
const SYNTHETIC_JOB_ID = 9100000301;
const GITHUB_API = "https://api.github.com/repos/chase-sets/chase-sets";
const SIGNED_LOG = "https://synthetic.blob.core.windows.net/log";
const AUTHORITY_REQUESTS = [
  `GET ${PRODUCT}/api/marketplace/payment-provider-mode`,
  `GET ${GITHUB_API}/actions/workflows/platform-production.yml/runs`,
  `GET ${GITHUB_API}/actions/runs/${SYNTHETIC_RUN_ID}/attempts/1/jobs`,
  `GET ${GITHUB_API}/actions/jobs/${SYNTHETIC_JOB_ID}/logs`,
  `GET ${SIGNED_LOG}`,
  `GET ${PRODUCT}/health/ready`,
  `GET ${PRODUCT}/api/health/ready`,
  `POST ${PRODUCT}/api/auth/password-sign-in`,
];

// The exact request list of one authority run, with credentials only on api.github.com.
function assertAuthorityRequests(requests) {
  const seen = requests.map(({ url, method }) => `${method} ${new URL(url).origin}${new URL(url).pathname}`);
  const missing = AUTHORITY_REQUESTS.filter((request) => !seen.includes(request));
  if (missing.length > 0) throw new Error(`authority request missing: ${missing.join(", ")}`);
  expect(seen).toEqual(AUTHORITY_REQUESTS);
  expect(requests[0].headers.authorization).toBeUndefined();
  expect(
    requests.find(({ url }) => url.startsWith("https://synthetic.blob.core.windows.net")).headers.authorization,
  ).toBeUndefined();
  for (const { url, headers } of requests) {
    if (new URL(url).origin === "https://api.github.com") expect(headers.authorization).toBeTruthy();
    else expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBeUndefined();
  }
}

// The captured Deploy Staging generation and readiness bodies served through the real
// selector and observers; `plant` adds marker text to GitHub free-text fields.
function capturedWorld({ plant = [] } = {}) {
  const { root, deployedHead, intendedHead } = gitRepository("authority-real-");
  const platform = JSON.parse(
    readFileSync(new URL("./fixtures/staging-deploy-generation/captured-platform-deploy.json", import.meta.url)),
  );
  const capturedRun = platform.runs.find((candidate) => candidate.id === 39252891660);
  const capturedJob = platform.jobs[`${capturedRun.id}/${capturedRun.run_attempt}`].jobs.find(
    (candidate) => candidate.name === "Deploy Staging",
  );
  const capturedLog = readFileSync(
    new URL("./fixtures/staging-deploy-generation/deploy-staging-118064914233-log.txt", import.meta.url),
    "utf8",
  );
  const log = capturedLog.replaceAll(CAPTURED_HEAD, deployedHead);
  const readiness = JSON.parse(
    readFileSync(new URL("./fixtures/staging-product-observations/captured-readiness.json", import.meta.url)),
  );
  const providerMode = JSON.parse(
    readFileSync(new URL("./fixtures/staging-evidence-authority/provider-mode.json", import.meta.url)),
  );
  const signIn = JSON.parse(
    readFileSync(new URL("./fixtures/staging-evidence-authority/sign-in.json", import.meta.url)),
  );
  const run = JSON.parse(
    JSON.stringify(capturedRun)
      .replaceAll(String(capturedRun.id), String(SYNTHETIC_RUN_ID))
      .replaceAll(CAPTURED_HEAD, deployedHead),
  );
  const job = JSON.parse(
    JSON.stringify(capturedJob)
      .replaceAll(String(capturedJob.id), String(SYNTHETIC_JOB_ID))
      .replaceAll(String(capturedRun.id), String(SYNTHETIC_RUN_ID))
      .replaceAll(CAPTURED_HEAD, deployedHead),
  );
  if (plant.length > 0) {
    run.display_title = plant.join(" ");
    run.head_commit = { message: plant.join("\n"), author: { name: plant.join(" "), email: "leak@example.test" } };
    job.runner_name = plant.join("-");
  }
  const requests = [];
  const transport = async (url, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    requests.push({ url, method: init.method ?? "GET", headers });
    if (url.includes("/actions/workflows/platform-production.yml/runs?"))
      return Response.json({ total_count: 1, workflow_runs: [run] });
    if (url.includes(`/actions/runs/${SYNTHETIC_RUN_ID}/attempts/1/jobs`))
      return Response.json({ total_count: 1, jobs: [job] });
    if (url === `${GITHUB_API}/actions/jobs/${SYNTHETIC_JOB_ID}/logs`)
      return new Response(null, { status: 302, headers: { location: SIGNED_LOG } });
    if (url === SIGNED_LOG) return new Response(log, { status: 200 });
    const parsed = new URL(url);
    if (parsed.pathname === "/api/marketplace/payment-provider-mode")
      return new Response(JSON.stringify(providerMode), { headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/health/ready")
      return new Response(readiness.web.body, { headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/api/health/ready")
      return new Response(readiness.backend.body, { headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/api/auth/password-sign-in")
      return new Response(JSON.stringify(signIn), { headers: { "content-type": "application/json" } });
    return new Response(null, { status: 404 });
  };
  const ioRoot = temporaryRoot("authority-real-io-");
  const env = {
    ...baseEnv(root),
    PROBE_HEAD: intendedHead,
    PROBE_OUT_FILE: join(ioRoot, "receipt.json"),
    PROBE_LOG_FILE: join(ioRoot, "authority.ndjson"),
  };
  return {
    root,
    ioRoot,
    env,
    requests,
    transport,
    deployedHead,
    intendedHead,
    now: Date.parse("2026-10-19T13:00:00Z"),
  };
}
const runWorld = (world, overrides = {}) =>
  runStagingEvidenceAuthority({
    env: world.env,
    argv: [],
    cwd: world.root,
    transport: world.transport,
    clock: () => world.now,
    ...overrides,
  });

// One marker per redaction class, then the three credential values from baseEnv.
const MARKERS = [
  "pk_test_r1marker",
  "sk_test_r1marker",
  "rk_test_r1marker",
  "acct_r1marker",
  "pi_r1marker",
  "seti_r1marker",
  "cus_r1marker",
  "cs_test_r1marker",
  "rfd_r1marker",
  "ord_r1marker",
  "session_r1marker",
  "leak@example.test",
  "github-token-marker",
  "password-marker",
  "probe@example.test",
];
const leakedMarkers = (texts) => MARKERS.filter((marker) => texts.some((text) => text.includes(marker)));
// Runs once with stderr observed and returns the run plus every output text: stdout,
// the out-file and log bytes when present, and everything written to stderr.
async function outputsOf(ioRoot, run) {
  const stderr = vi.spyOn(process.stderr, "write");
  try {
    const result = await run();
    const files = ["receipt.json", "authority.ndjson"]
      .map((name) => join(ioRoot, name))
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, "utf8"));
    return { result, texts: [result.stdout, ...files, stderr.mock.calls.map(([chunk]) => String(chunk)).join("")] };
  } finally {
    stderr.mockRestore();
  }
}
const logEntries = (root) =>
  readFileSync(join(root, "authority.ndjson"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

describe("staging evidence authority inputs", () => {
  it("AC-01 resolves every input without defaults and refuses unknown or credential argv", () => {
    const root = temporaryRoot("authority-input-");
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
  });

  it("AC-01 lets argv win over env, accepts env alone and names each missing option", () => {
    const root = temporaryRoot("authority-option-");
    const env = baseEnv(root);
    // [option, env name, losing env value, winning value, read the parsed value]
    const options = [
      ["base-url", "PROBE_BASE_URL", "https://example.test", PRODUCT, (input) => input.baseUrl],
      ["environment", "PROBE_ENVIRONMENT", "production", "staging", (input) => input.environment],
      ["head", "PROBE_HEAD", head, "b".repeat(40), (input) => input.head],
      ["worktree", "PROBE_WORKTREE", root, join(root, "argv-worktree"), (input) => input.worktree],
      [
        "governed-path",
        "PROBE_GOVERNED_PATHS",
        "scripts/foo.mjs",
        "scripts/bar.mjs",
        (input) => input.governedPaths[0],
      ],
      ["out", "PROBE_OUT_FILE", join(root, "env-receipt.json"), join(root, "argv-receipt.json"), (input) => input.out],
      ["log-file", "PROBE_LOG_FILE", join(root, "env.ndjson"), join(root, "argv.ndjson"), (input) => input.logFile],
      [
        "deploy-max-age-seconds",
        "DEPLOY_MAX_AGE_SECONDS",
        "604800",
        "60",
        (input) => String(input.deployMaxAgeSeconds),
      ],
      ["request-timeout-ms", "PROBE_REQUEST_TIMEOUT_MS", "1000", "2000", (input) => String(input.requestTimeoutMs)],
      ["total-budget-ms", "PROBE_TOTAL_BUDGET_MS", "5000", "6000", (input) => String(input.totalBudgetMs)],
      [
        "runner-path",
        "PROBE_RUNNER_PATH",
        "scripts/other.mjs",
        STAGING_EVIDENCE_AUTHORITY_RUNNER_PATH,
        (input) => input.runnerPath,
      ],
    ];
    expect(options.map(([option]) => option).sort()).toEqual(
      [
        "base-url",
        "deploy-max-age-seconds",
        "environment",
        "governed-path",
        "head",
        "log-file",
        "out",
        "request-timeout-ms",
        "runner-path",
        "total-budget-ms",
        "worktree",
      ].sort(),
    );
    for (const [option, envName, losing, winning, read] of options) {
      expect(read(parseInputs([`--${option}`, winning], { ...env, [envName]: losing })), option).toBe(winning);
      expect(read(parseInputs([], { ...env, [envName]: winning })), option).toBe(winning);
      expect(parseRefusal([], { ...env, [envName]: undefined }), option).toEqual({
        stop: "input-missing",
        input: option,
      });
    }
  });

  it("AC-01 refuses every out-of-bounds input with its named stop", () => {
    const root = temporaryRoot("authority-bounds-");
    const env = baseEnv(root);
    writeFileSync(join(root, "existing.json"), "{}\n");
    const governed = (count) => Array.from({ length: count }, (_, index) => `scripts/governed-${index}.mjs`).join(",");
    const rows = [
      [{ PROBE_BASE_URL: "https://marketplace.chasesets.com" }, "base-url-not-governed", "base-url"],
      [{ PROBE_BASE_URL: `${PRODUCT}/` }, "base-url-not-governed", "base-url"],
      [{ PROBE_ENVIRONMENT: "production" }, "environment-not-staging", "environment"],
      [{ PROBE_HEAD: "A".repeat(40) }, "input-invalid", "head"],
      [{ PROBE_HEAD: "a".repeat(39) }, "input-invalid", "head"],
      [{ PROBE_WORKTREE: "relative/worktree" }, "input-invalid", "worktree"],
      [{ PROBE_GOVERNED_PATHS: governed(33) }, "input-invalid", "governed-path"],
      [{ PROBE_GOVERNED_PATHS: "scripts/foo.mjs,scripts/foo.mjs" }, "input-invalid", "governed-path"],
      [{ PROBE_GOVERNED_PATHS: "../outside.mjs" }, "input-invalid", "governed-path"],
      [{ DEPLOY_MAX_AGE_SECONDS: "0" }, "input-invalid", "deploy-max-age-seconds"],
      [{ DEPLOY_MAX_AGE_SECONDS: "604801" }, "input-invalid", "deploy-max-age-seconds"],
      [{ PROBE_REQUEST_TIMEOUT_MS: "999" }, "input-invalid", "request-timeout-ms"],
      [{ PROBE_REQUEST_TIMEOUT_MS: "60001" }, "input-invalid", "request-timeout-ms"],
      [{ PROBE_TOTAL_BUDGET_MS: "4999" }, "probe-budget-exhausted", "total-budget-ms"],
      [{ PROBE_TOTAL_BUDGET_MS: "600001" }, "probe-budget-exhausted", "total-budget-ms"],
      [{ PROBE_OUT_FILE: "receipt.json" }, "out-file-path-invalid", "out"],
      [{ PROBE_OUT_FILE: join(root, "missing", "receipt.json") }, "out-file-path-invalid", "out"],
      [{ PROBE_LOG_FILE: "authority.ndjson" }, "log-file-path-invalid", "log-file"],
      [{ PROBE_LOG_FILE: join(root, "missing", "authority.ndjson") }, "log-file-path-invalid", "log-file"],
      [{ PROBE_OUT_FILE: join(root, "existing.json") }, "out-file-exists", "out"],
    ];
    expect(parseInputs([], env).governedPaths).toEqual(["scripts/foo.mjs"]);
    expect(parseInputs([], { ...env, PROBE_GOVERNED_PATHS: governed(32) }).governedPaths).toHaveLength(32);
    for (const [override, stop, input] of rows) {
      expect(parseRefusal([], { ...env, ...override }), JSON.stringify(override)).toEqual({ stop, input });
    }
  });

  it("AC-01 keeps credentials out of argv and requires each credential source", () => {
    const root = temporaryRoot("authority-credentials-");
    const env = baseEnv(root);
    for (const name of ["github-token", "marketplace-e2e-email", "marketplace-e2e-password"]) {
      expect(parseRefusal([`--${name}`, "value"], env), name).toEqual({ stop: "input-forbidden-in-argv", input: name });
    }
    for (const name of ["GITHUB_TOKEN", "MARKETPLACE_E2E_EMAIL", "MARKETPLACE_E2E_PASSWORD"]) {
      expect(parseRefusal([], { ...env, [name]: undefined }), name).toEqual({
        stop: "auth-source-missing",
        input: "auth",
      });
      expect(parseRefusal([], { ...env, [name]: "" }), name).toEqual({ stop: "auth-source-missing", input: "auth" });
    }
    expect(parseRefusal(["--x", "value"], env)).toEqual({ stop: "input-invalid", input: "x" });
    expect(parseRefusal(["--head", "b".repeat(40), "--head", "c".repeat(40)], env)).toEqual({
      stop: "input-invalid",
      input: "head",
    });
    expect(parseRefusal(["--head"], env)).toEqual({ stop: "input-invalid", input: "head" });
  });

  it("AC-01 refuses a missing, mismatched or drifted runner path before any request", async () => {
    const repository = gitRepository("authority-runner-");
    const ioRoot = temporaryRoot("authority-runner-io-");
    const requests = [];
    const transport = async (url) => {
      requests.push(url);
      return new Response(null, { status: 404 });
    };
    const env = {
      ...baseEnv(repository.root),
      PROBE_HEAD: repository.intendedHead,
      PROBE_OUT_FILE: join(ioRoot, "receipt.json"),
      PROBE_LOG_FILE: join(ioRoot, "authority.ndjson"),
    };
    const run = (overrides) =>
      runStagingEvidenceAuthority({ env: { ...env, ...overrides }, argv: [], cwd: repository.root, transport });

    const missing = await run({ PROBE_RUNNER_PATH: undefined });
    expectClosedStop(missing, 2, "refused", "input-missing");
    expect(missing.value.detail).toEqual({ ...NULL_DETAIL, input: "runner-path" });
    const mismatched = await run({ PROBE_RUNNER_PATH: "scripts/foo.mjs" });
    expectClosedStop(mismatched, 2, "refused", "input-invalid");
    expect(mismatched.value.detail).toEqual({ ...NULL_DETAIL, input: "runner-path" });

    repository.git(["update-index", "--skip-worktree", "--", STAGING_EVIDENCE_AUTHORITY_RUNNER_PATH]);
    writeFileSync(join(repository.root, "scripts", "staging-evidence-authority.mjs"), "export const drifted = true;\n");
    const drifted = await run({});
    expectClosedStop(drifted, 2, "refused", "executed-byte-drift");
    expect(drifted.value.detail).toEqual({ ...NULL_DETAIL, path: STAGING_EVIDENCE_AUTHORITY_RUNNER_PATH });
    expect(requests).toEqual([]);
    expect(existsSync(join(ioRoot, "receipt.json"))).toBe(false);
  });
});

describe("staging evidence authority composition", () => {
  it("AC-02 issues mode first and sign-in last", async () => {
    const root = temporaryRoot("authority-order-");
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
    const root = temporaryRoot("authority-stop-order-");
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

  it("AC-02 never issues the sign-in POST after any step stop", async () => {
    const root = temporaryRoot("authority-step-stops-");
    const stepStops = [
      [
        "worktree-not-clean",
        {
          readExecutedBytes: async () => ({ outcome: "refused", stop: "worktree-not-clean", path: "scripts/foo.mjs" }),
        },
      ],
      ["live-mode-detected", { observeProviderMode: async () => ({ stop: "live-mode-detected", httpStatus: 200 }) }],
      [
        "deploy-in-progress",
        { selectGeneration: async () => ({ stop: "deploy-in-progress", deployment: null, deployGeneration: null }) },
      ],
      [
        "deployed-runtime-incompatible",
        { classifyRuntime: async () => ({ outcome: "failed", stop: "deployed-runtime-incompatible", path: null }) },
      ],
      ["web-not-ready", { observeWebReadiness: async () => ({ stop: "web-not-ready", httpStatus: 503 }) }],
      [
        "host-not-ready",
        {
          observeBackendReadiness: async () => ({
            stop: "host-not-ready",
            httpStatus: 503,
            degradedCheckNames: ["control.database"],
          }),
        },
      ],
    ];
    for (const [stop, overrides] of stepStops) {
      const posts = [];
      const run = await runStagingEvidenceAuthority(
        composeFakes(root, {
          ...overrides,
          requestProductHost: async (request) => {
            posts.push(request.path);
            return { httpStatus: 200, body: Buffer.from("{}") };
          },
        }),
      );
      expect(run.value.stop, stop).toBe(stop);
      expect(posts, stop).toEqual([]);
    }
  });

  it("AC-02 sends exactly one request when the real observer reads live mode", async () => {
    const root = temporaryRoot("authority-live-mode-");
    const providerMode = JSON.parse(
      readFileSync(new URL("./fixtures/staging-evidence-authority/provider-mode.json", import.meta.url)),
    );
    const requests = [];
    const transport = async (url, init = {}) => {
      requests.push(`${init.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify({ ...providerMode, mode: "live" }), {
        headers: { "content-type": "application/json" },
      });
    };
    const run = await runStagingEvidenceAuthority(
      composeFakes(root, { observeProviderMode: undefined, requestProductHost: undefined, transport }),
    );
    expectClosedStop(run, 1, "failed", "live-mode-detected");
    expect(requests).toEqual([`GET ${PRODUCT}/api/marketplace/payment-provider-mode`]);
  });

  it("AC-02 source issues one POST and writes files only through the receipt and log writers", () => {
    const source = readFileSync(new URL("./staging-evidence-authority.mjs", import.meta.url), "utf8");
    expect(source.match(/method: "POST"/g)).toHaveLength(1);
    expect(source).not.toMatch(/method: "(?:PUT|PATCH|DELETE)"/i);
    const body = (name) => {
      const start = source.indexOf(`function ${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      return source.slice(start, source.indexOf("\n}\n", start) + 3);
    };
    const fsWrite =
      /\b(?:writeFileSync|appendFileSync|renameSync|unlinkSync|chmodSync|mkdirSync|rmSync|copyFileSync|createWriteStream|writeFile|appendFile)\(/;
    expect(body("writeAtomic")).toMatch(fsWrite);
    expect(body("writeLog")).toMatch(fsWrite);
    expect(source.replace(body("writeAtomic"), "").replace(body("writeLog"), "")).not.toMatch(fsWrite);
  });

  it("AC-03 emits one closed result and persists only ok", async () => {
    const root = temporaryRoot("authority-result-");
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
    expect(Object.keys(refused.value).sort()).toEqual(RESULT_KEYS);
    expect(readdirSync(root)).not.toContain("receipt.json");
  });

  it("AC-03 refuses an ok result that fails the closed schema", async () => {
    const root = temporaryRoot("authority-schema-");
    const cases = [
      ["nested unknown readiness key", { observeBackendReadiness: async () => ({ ...validBackend, extra: true }) }],
      [
        "nested unknown generation key",
        {
          selectGeneration: async () => ({
            ...validGeneration,
            deployGeneration: { ...validGeneration.deployGeneration, extra: "x" },
          }),
        },
      ],
      ["date-only observedAt", { observeProviderMode: async () => ({ ...validMode, observedAt: "2026-10-20" }) }],
      [
        "offset-less observedAt",
        { observeProviderMode: async () => ({ ...validMode, observedAt: "2026-10-20T00:00:00" }) },
      ],
      [
        "observedAt after finishedAt",
        { observeProviderMode: async () => ({ ...validMode, observedAt: "2026-10-20T00:00:01Z" }) },
      ],
      [
        "degraded names under ok",
        { observeBackendReadiness: async () => ({ ...validBackend, degradedCheckNames: ["control.database"] }) },
      ],
      ["web ok false without a stop", { observeWebReadiness: async () => ({ ...validWeb, ok: false }) }],
    ];
    for (const [name, overrides] of cases) {
      const run = await runStagingEvidenceAuthority(composeFakes(root, overrides));
      expect(run.value.stop, name).toBe("closed-schema-shallow-validation");
      expectClosedStop(run, 1, "failed", "closed-schema-shallow-validation");
      expect(existsSync(join(root, "receipt.json")), name).toBe(false);
    }
  });

  it("AC-03 refuses duplicate keys in readiness and sign-in bodies", async () => {
    const root = temporaryRoot("authority-duplicate-");
    const readiness = JSON.parse(
      readFileSync(new URL("./fixtures/staging-product-observations/captured-readiness.json", import.meta.url)),
    );
    const duplicated = readiness.backend.body.replace('{"status":"ok",', '{"status":"ok","status":"ok",');
    expect(duplicated).not.toBe(readiness.backend.body);
    const transport = async () => new Response(duplicated, { headers: { "content-type": "application/json" } });
    const backend = await runStagingEvidenceAuthority(
      composeFakes(root, { observeBackendReadiness: undefined, transport }),
    );
    expectClosedStop(backend, 1, "failed", "readiness-schema-unexpected");
    const signIn = await runStagingEvidenceAuthority(
      composeFakes(root, {
        requestProductHost: signInResponse('{"type":"session-started","sessionToken":"one","sessionToken":"two"}'),
      }),
    );
    expectTokenAbsent(signIn);
    expect(existsSync(join(root, "receipt.json"))).toBe(false);
  });

  it("AC-04 keeps planted secrets out of every output", async () => {
    const root = temporaryRoot("authority-redaction-");
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

  it("AC-04 output scan detects a deliberately leaked marker", () => {
    expect(leakedMarkers(["clean", "{}\n"])).toEqual([]);
    expect(leakedMarkers(["clean", `{"path":"notes/${MARKERS[0]}.md"}`])).toEqual([MARKERS[0]]);
    expect(leakedMarkers([MARKERS.join(" ")])).toEqual(MARKERS);
  });

  it("AC-04 keeps GitHub free-text markers out of a successful run's outputs", async () => {
    const world = capturedWorld({ plant: MARKERS });
    const { result, texts } = await outputsOf(world.ioRoot, () => runWorld(world));
    expect(result).toMatchObject({ exitCode: 0, value: { result: "ok", ready: true, stop: null } });
    expect(existsSync(join(world.ioRoot, "receipt.json"))).toBe(true);
    expect(leakedMarkers(texts)).toEqual([]);
  });

  it("AC-04 turns a marker in any refusal path or degraded name into a null-detail redaction stop", async () => {
    for (const marker of MARKERS) {
      for (const overrides of [
        {
          readExecutedBytes: async () => ({
            outcome: "refused",
            stop: "worktree-not-clean",
            path: `notes/${marker}.md`,
          }),
        },
        {
          observeBackendReadiness: async () => ({
            stop: "host-not-ready",
            httpStatus: 200,
            degradedCheckNames: ["control.database", marker],
          }),
        },
      ]) {
        const root = temporaryRoot("authority-marker-");
        const { result, texts } = await outputsOf(root, () =>
          runStagingEvidenceAuthority(composeFakes(root, overrides)),
        );
        expect(result.value.stop, marker).toBe("redaction-scan-finding");
        expectClosedStop(result, 1, "failed", "redaction-scan-finding");
        expect(result.value.detail).toEqual(NULL_DETAIL);
        expect(leakedMarkers(texts), marker).toEqual([]);
      }
    }
  });

  it("AC-04 refuses an ok serialization that carries a marker in an executed path", async () => {
    for (const marker of MARKERS.filter((candidate) => !candidate.includes("@"))) {
      const root = temporaryRoot("authority-ok-marker-");
      const governedPath = `scripts/${marker}.mjs`;
      const { result, texts } = await outputsOf(root, () =>
        runStagingEvidenceAuthority(
          composeFakes(root, {
            input: { ...inputFor(root), governedPaths: [governedPath] },
            readExecutedBytes: async () => validExecuted(root, governedPath),
          }),
        ),
      );
      expect(result.value.stop, marker).toBe("redaction-scan-finding");
      expectClosedStop(result, 1, "failed", "redaction-scan-finding");
      expect(existsSync(join(root, "receipt.json")), marker).toBe(false);
      expect(leakedMarkers(texts), marker).toEqual([]);
    }
  });

  it("AC-04 drops a log line that would carry a marker", async () => {
    for (const marker of MARKERS) {
      const root = temporaryRoot("authority-log-marker-");
      const { result, texts } = await outputsOf(root, () =>
        runStagingEvidenceAuthority(
          composeFakes(root, { observeWebReadiness: async () => ({ stop: "web-not-ready", httpStatus: marker }) }),
        ),
      );
      expectClosedStop(result, 1, "failed", "web-not-ready");
      expect(result.value.detail).toEqual(NULL_DETAIL);
      expect(leakedMarkers(texts), marker).toEqual([]);
      expect(
        logEntries(root).map(({ step, outcome }) => `${step}:${outcome}`),
        marker,
      ).toEqual([
        "executed-bytes:started",
        "provider-mode:started",
        "deploy-generation:started",
        "runtime-compatibility:started",
        "web-readiness:started",
      ]);
    }
  });

  it("AC-04 keeps a crashing sibling's marker-bearing message out of every output", async () => {
    const root = temporaryRoot("authority-crash-marker-");
    const { result, texts } = await outputsOf(root, () =>
      runStagingEvidenceAuthority(
        composeFakes(root, {
          classifyRuntime: async () => {
            throw new Error(`crash ${MARKERS.join(" ")}`);
          },
        }),
      ),
    );
    expectClosedStop(result, 1, "failed", "unexpected-internal-error");
    expect(result.value.detail).toEqual(NULL_DETAIL);
    expect(leakedMarkers(texts)).toEqual([]);
  });

  it("AC-05 maps every stop to one result and exit", async () => {
    const root = temporaryRoot("authority-stops-");
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
      expect(Object.keys(observed.value).sort()).toEqual(RESULT_KEYS);
    }
  });

  it("AC-05 refuses every input and executed-bytes stop with exit 2", async () => {
    const root = temporaryRoot("authority-refused-");
    const env = baseEnv(root);
    writeFileSync(join(root, "existing.json"), "{}\n");
    const parse =
      (argv, overrides = {}) =>
      () =>
        runStagingEvidenceAuthority({ argv, env: { ...env, ...overrides }, cwd: root });
    const rows = [
      ["input-missing", "base-url", parse([], { PROBE_BASE_URL: undefined })],
      ["input-invalid", "head", parse([], { PROBE_HEAD: "not-a-head" })],
      ["base-url-not-governed", "base-url", parse([], { PROBE_BASE_URL: "https://marketplace.chasesets.com" })],
      ["environment-not-staging", "environment", parse([], { PROBE_ENVIRONMENT: "production" })],
      ["probe-budget-exhausted", "total-budget-ms", parse([], { PROBE_TOTAL_BUDGET_MS: "4999" })],
      ["out-file-path-invalid", "out", parse([], { PROBE_OUT_FILE: "receipt.json" })],
      ["log-file-path-invalid", "log-file", parse([], { PROBE_LOG_FILE: "authority.ndjson" })],
      ["out-file-exists", "out", parse([], { PROBE_OUT_FILE: join(root, "existing.json") })],
      ["input-forbidden-in-argv", null, parse(["--github-token", "value"])],
      ["auth-source-missing", null, parse([], { MARKETPLACE_E2E_PASSWORD: undefined })],
      [
        "worktree-not-clean",
        null,
        () =>
          runStagingEvidenceAuthority(
            composeFakes(root, {
              readExecutedBytes: async () => ({
                outcome: "refused",
                stop: "worktree-not-clean",
                path: "scripts/foo.mjs",
              }),
            }),
          ),
      ],
      [
        "executed-byte-drift",
        null,
        () =>
          runStagingEvidenceAuthority(
            composeFakes(root, {
              readExecutedBytes: async () => ({
                outcome: "refused",
                stop: "executed-byte-drift",
                path: "scripts/foo.mjs",
              }),
            }),
          ),
      ],
    ];
    for (const [stop, detailInput, run] of rows) {
      const observed = await run();
      expect(observed.value.stop, stop).toBe(stop);
      expectClosedStop(observed, 2, "refused", stop);
      expect(observed.value.detail.input, stop).toBe(detailInput);
    }
  });

  it("AC-05 fails every observation, sign-in, receipt and budget stop with exit 1", async () => {
    const root = temporaryRoot("authority-failed-");
    let now = Date.parse("2026-10-20T00:00:00Z");
    const rows = [
      [
        "live-mode-detected",
        { observeProviderMode: async () => ({ stop: "live-mode-detected", httpStatus: 200 }) },
        { httpStatus: 200 },
      ],
      ...["deploy-in-progress", "github-request-failed"].map((stop) => [
        stop,
        { selectGeneration: async () => ({ stop, deployment: null, deployGeneration: null }) },
      ]),
      [
        "deployed-runtime-incompatible",
        { classifyRuntime: async () => ({ outcome: "failed", stop: "deployed-runtime-incompatible", path: null }) },
      ],
      [
        "web-not-ready",
        { observeWebReadiness: async () => ({ stop: "web-not-ready", httpStatus: 503 }) },
        { httpStatus: 503 },
      ],
      [
        "host-not-ready",
        {
          observeBackendReadiness: async () => ({
            stop: "host-not-ready",
            httpStatus: 200,
            degradedCheckNames: ["queue", "control.database", "queue"],
          }),
        },
        { httpStatus: 200, degradedCheckNames: ["control.database", "queue"] },
      ],
      ...["request-timeout", "response-too-large"].map((failure) => [
        "auth-failed",
        { requestProductHost: async () => ({ failure, httpStatus: null }) },
      ]),
      [
        "auth-failed",
        { requestProductHost: async () => ({ httpStatus: 401, body: Buffer.from("{}") }) },
        { httpStatus: 401 },
      ],
      ["receipt-write-failed", { input: { ...inputFor(root), out: join(root, "missing", "receipt.json") } }],
      [
        "redaction-scan-finding",
        {
          readExecutedBytes: async () => ({
            outcome: "refused",
            stop: "worktree-not-clean",
            path: "notes/pk_test_x.md",
          }),
        },
      ],
      ["closed-schema-shallow-validation", { observeWebReadiness: async () => ({ ...validWeb, ok: false }) }],
      [
        "unexpected-internal-error",
        {
          observeWebReadiness: async () => {
            throw new Error("private exception");
          },
        },
      ],
      [
        "probe-budget-exhausted",
        {
          clock: () => now,
          observeProviderMode: async () => {
            now += 5001;
            return validMode;
          },
        },
      ],
    ];
    for (const [stop, overrides, detail = {}] of rows) {
      const observed = await runStagingEvidenceAuthority(composeFakes(root, overrides));
      expect(observed.value.stop, stop).toBe(stop);
      expectClosedStop(observed, 1, "failed", stop);
      expect(observed.value.detail, stop).toEqual({ ...NULL_DETAIL, ...detail });
      expect(existsSync(join(root, "receipt.json")), stop).toBe(false);
    }
    for (const body of ['{"type":"session-started"}', '{"type":"session-started","sessionToken":""}', "not json"]) {
      const observed = await runStagingEvidenceAuthority(
        composeFakes(root, { requestProductHost: signInResponse(body) }),
      );
      expectTokenAbsent(observed);
      expect(existsSync(join(root, "receipt.json")), body).toBe(false);
    }
    const parseCrash = await runStagingEvidenceAuthority({
      argv: [],
      env: new Proxy(
        {},
        {
          get() {
            throw new Error("private-planted");
          },
        },
      ),
    });
    expectClosedStop(parseCrash, 1, "failed", "unexpected-internal-error");
    expect(parseCrash.stdout).not.toContain("private-planted");
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
    expect(Object.keys(run.value).sort()).toEqual(RESULT_KEYS);
  });
});

describe("staging evidence authority live wiring", () => {
  it("AC-06 launches the package command and refuses an empty environment", async () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
    const command = packageJson.scripts["uat:staging-evidence-authority"];
    const tokens = command.split(/\s+/);
    expect(tokens[0]).toBe("node");
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, tokens.slice(1), {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: Object.fromEntries(
          ["PATH", "SystemRoot"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]),
        ),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill(), 60_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (status, signal) => {
        clearTimeout(timer);
        resolve({ status, signal, stdout, stderr });
      });
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const value = JSON.parse(lines[0]);
    expect(value).toMatchObject({
      version: "staging-evidence-authority/v1",
      result: "refused",
      ready: false,
      stop: "input-missing",
      detail: { input: "base-url", path: null, httpStatus: null, degradedCheckNames: [] },
    });
    expect(Object.keys(value).sort()).toEqual(RESULT_KEYS);
  }, 60_000);

  it("AC-06 runs captured shapes through the real composition", async () => {
    const world = capturedWorld();
    const runResult = await runWorld(world);
    expect(runResult).toMatchObject({ exitCode: 0, value: { result: "ok", ready: true, stop: null } });
    expect(runResult.value.deployGeneration.deployedHead).toBe(world.deployedHead);
    expect(runResult.value.compatibility).toMatchObject({
      deployedHead: world.deployedHead,
      intendedHead: world.intendedHead,
      relation: "deployed-is-ancestor",
    });
    assertAuthorityRequests(world.requests);
    expect(runResult.stdout).toBe(readFileSync(join(world.ioRoot, "receipt.json"), "utf8") + "\n");
  });

  it.each([
    [
      "web",
      {
        observeWebReadiness: async () => ({
          url: `${PRODUCT}/health/ready`,
          httpStatus: 200,
          ok: true,
          service: "marketplace",
        }),
      },
      `authority request missing: GET ${PRODUCT}/health/ready`,
    ],
    [
      "backend",
      {
        observeBackendReadiness: async () => ({
          url: `${PRODUCT}/api/health/ready`,
          httpStatus: 200,
          aggregateStatus: "ok",
          checkCount: 1,
          degradedCheckNames: [],
        }),
      },
      `authority request missing: GET ${PRODUCT}/api/health/ready`,
    ],
  ])("AC-06 request check rejects a canned %s readiness observer", async (_, canned, message) => {
    const world = capturedWorld();
    const runResult = await runWorld(world, canned);
    expect(runResult.exitCode).toBe(0);
    expect(() => assertAuthorityRequests(world.requests)).toThrow(message);
  });
});
