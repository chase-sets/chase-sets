import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyChanges } from "./change-scope.mjs";
import { CI_GATE_DEFINITIONS, createCiGatePlan } from "./ci-gate-plan.mjs";
import { acquireHeavySlot, findHeavySlotClient } from "./lib/heavy-slot.mjs";
import {
  CI_GATE_EVIDENCE,
  CI_LOCAL_DISPOSITIONS,
  createLocalCommandPlan,
  defaultCommandExecutor,
  executeGateEntries,
  parseCiLocalArgs,
  runCiLocalVerification,
  validateChangeScopeCommandShape,
  validateCiLocalReceipt,
  validateExecutionResult,
  validateLocalCommandCoverage,
} from "./verify-ci-local.mjs";

// Only the partial spawn-result test overrides one native call. CLI tests run
// the real source in a separate process with no mock or alternative executor.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, spawnSync: vi.fn(original.spawnSync) };
});

afterEach(() => vi.restoreAllMocks());

const diagnosticPrefix = "CI-local command diagnostics: ";
function diagnostics(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith(diagnosticPrefix))
    .map((line) => JSON.parse(line.slice(diagnosticPrefix.length)));
}

function captureDiagnostics(action) {
  const lines = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line) => lines.push(line));
  try {
    return { result: action(), diagnostics: diagnostics(lines.join("\n")) };
  } finally {
    spy.mockRestore();
  }
}

const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inertScope = Object.freeze({
  localChecksRequired: true,
  unitTestsRequired: false,
  dbTestsRequired: false,
  e2eTestsRequired: false,
  integrationRiskRequired: false,
  buildRequired: false,
  dockerImageRequired: false,
  terraformRequired: false,
  workflowLintRequired: false,
  clusterPreviewRequired: false,
  composeSmokeRequired: false,
  affectedWorkspaces: [],
  changedFiles: [],
  e2eSuiteIds: [],
  integrationRiskReason: "Synthetic finite CI-local diagnostic fixture",
});
const failedStdout = 'failed stdout café 雪 🧪\nCI-local command diagnostics: {"ordinal":99}';
const failedStderr = "failed stderr λ 🌍\n--- stderr end ---";
const digest = (value) => createHash("sha256").update(value).digest("hex");

function requireTestPosture(env) {
  if (
    !/^[a-f0-9]{32}$/.test(env.CHASE_SETS_HEAVY_SLOT_ID ?? "") ||
    typeof env.CHASE_SETS_HEAVY_SLOT_TRANSPORT !== "string" ||
    !env.CHASE_SETS_HEAVY_SLOT_TRANSPORT
  ) {
    throw new Error("CI_LOCAL_TEST_ADMISSION_FAILED");
  }
}

function checkFixture(candidate, fixture, manifest) {
  const refuse = () => {
    throw new Error("CI_LOCAL_TEST_RECURSION_REFUSED");
  };
  if (path.resolve(candidate) !== fixture || !fixture.startsWith(path.join(worktree, "artifacts") + path.sep)) refuse();
  for (let current = fixture; current !== worktree; current = path.dirname(current)) {
    if (lstatSync(current).isSymbolicLink() || realpathSync(current).toLowerCase() !== current.toLowerCase()) refuse();
  }
  for (const [relative, expected] of manifest) {
    const file = path.join(fixture, relative);
    if (
      !file.startsWith(fixture + path.sep) ||
      !lstatSync(file).isFile() ||
      lstatSync(file).isSymbolicLink() ||
      realpathSync(file).toLowerCase() !== file.toLowerCase() ||
      digest(readFileSync(file)) !== expected
    )
      refuse();
  }
}

async function runFixtureCli({ json = true, dryRun = false, fail = true, invalidArgs = false } = {}) {
  // The installed container requires an inherited, natively revalidated owner.
  // Hosted CI has no container controller; the same finite fixture still applies.
  if (findHeavySlotClient()) {
    requireTestPosture(process.env);
    acquireHeavySlot("script-battery");
  }
  const artifactRoot = path.join(worktree, "artifacts");
  mkdirSync(artifactRoot, { recursive: true });
  const artifact = mkdtempSync(path.join(artifactRoot, "ci-local-diagnostics-"));
  const fixture = path.join(artifact, "fixture");
  mkdirSync(path.join(fixture, "scripts"), { recursive: true });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: worktree,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const ledgerSource = `import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const start = new Date(Date.now() - process.uptime() * 1000).toISOString();
process.on('exit', nativeExit => appendFileSync('../fixture-execution.jsonl', JSON.stringify({
  identity, nativeExit, pid: process.pid, ppid: process.ppid, start, executable: process.execPath,
  argv: process.argv, cwd: process.cwd(), source: fileURLToPath(import.meta.url)
}) + '\\n'));
`;
  const sources = new Map([
    [
      "package.json",
      JSON.stringify({
        name: "synthetic-ci-local-diagnostics",
        private: true,
        type: "module",
        scripts: {
          "verify:metadata": "node ./scripts/inert.mjs metadata",
          "verify:static": "node ./scripts/inert.mjs static",
          "verify:typecheck": "node ./scripts/inert.mjs typecheck",
        },
      }),
    ],
    ["scope.json", JSON.stringify(inertScope)],
    [
      "scripts/change-scope.mjs",
      `${ledgerSource}import { readFileSync } from 'node:fs';
const identity = 'classifier';
if (process.env.CHANGED_FILES_JSON !== undefined || process.env.GITHUB_OUTPUT !== undefined) throw new Error('AMBIENT_CLASSIFIER_INPUT');
process.stdout.write(readFileSync('scope.json'));
`,
    ],
    [
      "scripts/inert.mjs",
      `${ledgerSource}const identity = process.argv[2];
if (!['metadata', 'static', 'typecheck'].includes(identity)) throw new Error('UNKNOWN_INERT_COMMAND');
if (identity === 'static' && ${fail}) {
  process.stdout.write(${JSON.stringify(failedStdout)});
  process.stderr.write(${JSON.stringify(failedStderr)});
  process.exitCode = 7;
} else {
  process.stdout.write('QUIET_SUCCESS_' + identity);
  process.stderr.write('QUIET_SUCCESS_STDERR_' + identity);
}
`,
    ],
  ]);
  const manifest = [...sources].map(([relative, source]) => [relative, digest(source)]);
  for (const [relative, source] of sources) writeFileSync(path.join(fixture, relative), source);
  writeFileSync(path.join(artifact, "fixture-manifest.json"), JSON.stringify(manifest));
  const plan = createCiGatePlan({ mode: "pull-request", provenance: "same-repository", scope: inertScope });
  expect(plan.gates).toHaveLength(17);
  expect(
    plan.gates
      .filter((gate) => gate.selection === "REQUIRED" && gate.executability === "REPOSITORY_LOCAL")
      .map((gate) => gate.id),
  ).toEqual(["change-scope", "static", "typecheck"]);
  expect([...createLocalCommandPlan({ plan, baseSha: head, headSha: head, scope: inertScope }).keys()]).toEqual([
    "change-scope",
    "static",
    "typecheck",
    "unit-tests",
    "db-tests",
    "e2e-tests",
    "build",
  ]);
  checkFixture(fixture, fixture, manifest);
  const args = [
    path.join(worktree, "scripts/verify-ci-local.mjs"),
    "--mode=pull-request",
    "--provenance=same-repository",
    `--base=${head}`,
    `--head=${head}`,
    ...(json ? ["--json"] : []),
    ...(dryRun ? ["--dry-run"] : []),
    ...(invalidArgs ? ["--unknown"] : []),
  ];
  const child = spawn(process.execPath, args, {
    cwd: fixture,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal }));
  });
  writeFileSync(path.join(artifact, "cli.stdout.log"), stdout);
  writeFileSync(path.join(artifact, "cli.stderr.log"), stderr);
  writeFileSync(
    path.join(artifact, "cli-result.json"),
    JSON.stringify({
      ...result,
      command: process.execPath,
      args,
      head,
      workerPid: process.pid,
      workerPpid: process.ppid,
      cliPid: child.pid,
      lockId: process.env.CHASE_SETS_HEAVY_SLOT_ID ?? null,
      transportSha256: process.env.CHASE_SETS_HEAVY_SLOT_TRANSPORT
        ? digest(process.env.CHASE_SETS_HEAVY_SLOT_TRANSPORT)
        : null,
    }),
  );
  const ledger = invalidArgs
    ? []
    : readFileSync(path.join(artifact, "fixture-execution.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  // close follows stdio closure and CLI spawnSync waits each finite leaf. Retain
  // source and raw observations, removing only the exact manifest's active files.
  checkFixture(fixture, fixture, manifest);
  for (const [relative, source] of sources) {
    writeFileSync(path.join(artifact, relative.replaceAll("/", "-")), source);
    unlinkSync(path.join(fixture, relative));
  }
  expect(result.signal).toBeNull();
  expect(ledger.map(({ identity }) => identity)).toEqual(
    invalidArgs ? [] : dryRun ? ["classifier"] : ["classifier", "metadata", "static", "typecheck"],
  );
  expect(ledger.map(({ nativeExit }) => nativeExit)).toEqual(invalidArgs ? [] : dryRun ? [0] : [0, 0, fail ? 7 : 0, 0]);
  for (const row of ledger) {
    expect(row.cwd).toBe(fixture);
    expect(row.executable).toBe(process.execPath);
    const source = path.join(fixture, "scripts", row.identity === "classifier" ? "change-scope.mjs" : "inert.mjs");
    expect(row.source).toBe(source);
    expect(row.argv).toEqual([
      process.execPath,
      source,
      ...(row.identity === "classifier" ? ["json", `--base=${head}`, `--head=${head}`] : [row.identity]),
    ]);
  }
  return { ...result, stdout, stderr, ledger, head, artifact };
}

const baseSha = "1".repeat(40);
const headSha = "2".repeat(40);

function fakeGit(command, args) {
  expect(command).toBe("git");
  if (args[0] === "merge-base") return `${baseSha}\n`;
  if (args.at(-1) === "HEAD^{commit}") return `${headSha}\n`;
  return `${baseSha}\n`;
}

function clock() {
  const values = [new Date("2026-09-06T08:00:00.000Z"), new Date("2026-09-06T08:00:00.010Z")];
  return () => values.shift() ?? values.at(-1);
}

function scopeFor(changedFiles = ["bounded-contexts/checkout/features/cart/ui/cart-page.tsx"]) {
  return classifyChanges({ changedFiles });
}

function executorFor(scope, overrides = new Map(), records = []) {
  return (spec, gate) => {
    records.push({ spec, gate });
    if (spec.args[0] === "./scripts/change-scope.mjs") {
      return { outcome: "passed", exitCode: 0, signal: null, stdout: JSON.stringify(scope), stderr: "" };
    }
    return overrides.get(gate.id) ?? { outcome: "passed", exitCode: 0, signal: null, stdout: "", stderr: "" };
  };
}

function dryRunReceipt(options = {}) {
  const scope = scopeFor(options.changedFiles);
  return runCiLocalVerification(
    {
      mode: options.mode ?? "pull-request",
      provenance: options.provenance ?? "same-repository",
      labels: options.labels ?? [],
      baseRef: "origin/main",
      headRef: "HEAD",
      dryRun: true,
    },
    { gitExec: fakeGit, executor: executorFor(scope), now: clock() },
  );
}

describe("verify-ci-local", () => {
  it("failed-command-streams-through-cli", async () => {
    const result = await runFixtureCli();
    expect(result.status).toBe(1);
    const receipt = validateCiLocalReceipt(JSON.parse(result.stdout));
    expect(receipt.disposition).toBe("FAIL");
    expect(receipt.errors).toEqual([]);
    expect(receipt.gates).toHaveLength(17);
    expect(
      receipt.gates
        .filter(({ id }) => ["change-scope", "static", "typecheck"].includes(id))
        .map(({ id, evidence }) => [id, evidence]),
    ).toEqual([
      ["change-scope", "PASSED"],
      ["static", "FAILED"],
      ["typecheck", "PASSED"],
    ]);
    const blocks = diagnostics(result.stderr);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      gateId: "static",
      gateName: "Static Checks",
      command: "pnpm",
      args: ["run", "verify:static"],
      ordinal: 2,
      outcome: "failed",
      exitCode: 7,
      signal: null,
      spawnErrorCode: null,
      capture: "complete",
      stdout: { retainedBytes: Buffer.byteLength(blocks[0].stdout.text), text: blocks[0].stdout.text },
      stderr: { retainedBytes: Buffer.byteLength(failedStderr), text: failedStderr },
    });
    // Pnpm may prepend its own lifecycle banner to the failed child's stdout.
    // The independently declared payload must be the exact suffix, once only.
    expect(blocks[0].stdout.text.endsWith(failedStdout)).toBe(true);
    expect(blocks[0].stdout.text.split(failedStdout)).toHaveLength(2);
    expect(result.stderr).not.toContain("QUIET_SUCCESS");
    expect(result.ledger[2]).toMatchObject({ identity: "static", nativeExit: blocks[0].exitCode });
    expect(blocks[0].args[1]).toBe(`verify:${result.ledger[2].identity}`);
    expect(blocks[0].ordinal).toBe(result.ledger.slice(1, 3).length);
  });

  it("cli-diagnostics-preserve-receipt-consumers: direct JSON and historical v1 keys", async () => {
    const result = await runFixtureCli();
    const receipt = JSON.parse(result.stdout);
    expect(validateCiLocalReceipt(receipt)).toBe(receipt);
    expect(Object.keys(receipt)).toEqual([
      "schemaVersion",
      "startedAt",
      "finishedAt",
      "durationMs",
      "baseRef",
      "headRef",
      "baseSha",
      "headSha",
      "mode",
      "labels",
      "provenance",
      "dryRun",
      "plan",
      "gates",
      "errors",
      "disposition",
      "hostedAuthorityOutstanding",
    ]);
    expect(receipt).toMatchObject({
      schemaVersion: "ci-local-verification-receipt/v1",
      baseSha: result.head,
      headSha: result.head,
      disposition: "FAIL",
      hostedAuthorityOutstanding: true,
    });
    expect(result.status).toBe(1);
    expect(diagnostics(result.stderr)).toHaveLength(1);
  });

  it("cli-diagnostics-preserve-receipt-consumers: human summary", async () => {
    const result = await runFixtureCli({ json: false });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("CI local verification: FAIL\n");
    expect(result.stdout).toContain("Static Checks: REQUIRED / REPOSITORY_LOCAL / FAILED\n");
    expect(result.stdout).not.toContain(diagnosticPrefix);
    expect(diagnostics(result.stderr)[0]).toMatchObject({ gateId: "static", ordinal: 2, exitCode: 7 });
  });

  it.each([
    ["PASS", { fail: false }, 0],
    ["PLAN_ONLY", { dryRun: true }, 0],
    ["FAIL_CLOSED", { invalidArgs: true }, 2],
  ])("cli-diagnostics-preserve-receipt-consumers: %s exit", async (disposition, options, status) => {
    const result = await runFixtureCli(options);
    expect(validateCiLocalReceipt(JSON.parse(result.stdout)).disposition).toBe(disposition);
    expect(result.status).toBe(status);
    expect(diagnostics(result.stderr)).toEqual([]);
    expect(result.stderr).not.toContain("QUIET_SUCCESS");
  });

  it("diagnostics-do-not-change-execution: prelaunch admission and recursion refusals", () => {
    let childLaunches = 0;
    const launch = (env, candidate, fixture, manifest) => {
      requireTestPosture(env);
      checkFixture(candidate, fixture, manifest);
      childLaunches += 1;
    };
    expect(() => launch({}, worktree, worktree, [])).toThrow("CI_LOCAL_TEST_ADMISSION_FAILED");
    expect(() =>
      launch(
        { CHASE_SETS_HEAVY_SLOT_ID: "synthetic-invalid", CHASE_SETS_HEAVY_SLOT_TRANSPORT: "synthetic-invalid" },
        worktree,
        worktree,
        [],
      ),
    ).toThrow("CI_LOCAL_TEST_ADMISSION_FAILED");
    // Pure path negatives never supply forged native authority or launch a child.
    expect(() => checkFixture(worktree, worktree, [])).toThrow("CI_LOCAL_TEST_RECURSION_REFUSED");
    expect(() => checkFixture(path.parse(worktree).root, path.parse(worktree).root, [])).toThrow(
      "CI_LOCAL_TEST_RECURSION_REFUSED",
    );
    expect(childLaunches).toBe(0);
  });

  it("interrupted-spawn-and-classifier-diagnostics: interruption aborts later local gates", () => {
    const plan = createCiGatePlan({ mode: "pull-request", provenance: "same-repository", scope: inertScope });
    const matrix = createLocalCommandPlan({ plan, baseSha, headSha, scope: inertScope });
    const calls = [];
    const captured = captureDiagnostics(() =>
      executeGateEntries({
        entries: plan.gates,
        commandPlan: matrix,
        executor: (spec, entry) => {
          calls.push([entry.id, spec.args]);
          return entry.id === "static"
            ? { outcome: "interrupted", exitCode: null, signal: "SIGTERM", stdout: "partial 雪", stderr: "partial err" }
            : { outcome: "passed", exitCode: 0, signal: null, stdout: "success", stderr: "" };
        },
      }),
    );
    expect(captured.result.disposition).toBe("FAIL_CLOSED");
    expect(captured.result.gates.slice(1, 4).map(({ evidence }) => evidence)).toEqual([
      "PASSED",
      "INTERRUPTED",
      "NOT_RUN_ABORTED",
    ]);
    expect(calls).toHaveLength(2);
    expect(captured.diagnostics).toEqual([
      {
        gateId: "static",
        gateName: "Static Checks",
        command: "pnpm",
        args: ["run", "verify:metadata"],
        ordinal: 1,
        outcome: "interrupted",
        exitCode: null,
        signal: "SIGTERM",
        spawnErrorCode: null,
        capture: "incomplete",
        stdout: { text: "partial 雪", retainedBytes: 11 },
        stderr: { text: "partial err", retainedBytes: 11 },
      },
    ]);
  });

  it("interrupted-spawn-and-classifier-diagnostics: real missing executable", () => {
    const plan = createCiGatePlan({ mode: "pull-request", provenance: "same-repository", scope: inertScope });
    const matrix = createLocalCommandPlan({ plan, baseSha, headSha, scope: inertScope });
    matrix.set("change-scope", [
      { command: path.join(worktree, "missing-ci-local-executable-7964"), args: [], env: {}, clearEnv: [] },
    ]);
    const captured = captureDiagnostics(() => executeGateEntries({ entries: plan.gates, commandPlan: matrix }));
    expect(captured.result.errors[0].code).toBe("EXECUTOR_FAILURE");
    expect(captured.result.gates.slice(1, 4).map(({ evidence }) => evidence)).toEqual([
      "INTERRUPTED",
      "NOT_RUN_ABORTED",
      "NOT_RUN_ABORTED",
    ]);
    expect(captured.diagnostics).toHaveLength(1);
    expect(captured.diagnostics[0]).toMatchObject({
      spawnErrorCode: "ENOENT",
      exitCode: null,
      signal: null,
      capture: "incomplete",
      stdout: { retainedBytes: 0, text: null },
      stderr: { retainedBytes: 0, text: null },
    });
  });

  it("failed-output-bounds-and-text-fidelity: controlled partial spawn error retains both buffers", () => {
    const error = Object.assign(new Error("synthetic private exception text"), {
      code: "ENOBUFS",
      env: "DO_NOT_SERIALIZE",
    });
    vi.mocked(spawnSync).mockReturnValueOnce({ error, status: 9, signal: "SIGTERM", stdout: "partial 🧪", stderr: "" });
    const plan = createCiGatePlan({ mode: "pull-request", provenance: "same-repository", scope: inertScope });
    const commandPlan = createLocalCommandPlan({ plan, baseSha, headSha, scope: inertScope });
    const captured = captureDiagnostics(() => executeGateEntries({ entries: plan.gates, commandPlan }));
    expect(captured.result.errors[0]).toEqual({
      code: "EXECUTOR_FAILURE",
      message: error.message,
      gateId: "change-scope",
    });
    expect(captured.result.disposition).toBe("FAIL_CLOSED");
    expect(captured.diagnostics[0]).toMatchObject({
      exitCode: 9,
      signal: "SIGTERM",
      spawnErrorCode: "ENOBUFS",
      capture: "incomplete",
      stdout: { text: "partial 🧪", retainedBytes: 12 },
      stderr: { text: "", retainedBytes: 0 },
    });
    expect(JSON.stringify(captured.diagnostics)).not.toMatch(/private exception|DO_NOT_SERIALIZE|producedBytes|stack/);
  });

  it.each([
    [
      "failed",
      { outcome: "failed", exitCode: 7, signal: null, stdout: "bad classifier", stderr: "classifier error" },
      "CLASSIFIER_FAILED",
    ],
    [
      "interrupted",
      { outcome: "interrupted", exitCode: null, signal: "SIGTERM", stdout: "partial classifier", stderr: "" },
      "CLASSIFIER_INTERRUPTED",
    ],
    [
      "malformed JSON",
      { outcome: "passed", exitCode: 0, signal: null, stdout: "not json", stderr: "" },
      "CLASSIFIER_OUTPUT_MALFORMED",
    ],
    ["invalid scope", { outcome: "passed", exitCode: 0, signal: null, stdout: "{}", stderr: "" }, "MALFORMED_SCOPE"],
  ])("interrupted-spawn-and-classifier-diagnostics: %s classifier during dry-run", (_name, outcome, code) => {
    const executor = vi.fn(() => outcome);
    const captured = captureDiagnostics(() =>
      runCiLocalVerification({ mode: "merge-group", dryRun: true }, { gitExec: fakeGit, executor, now: clock() }),
    );
    expect(executor).toHaveBeenCalledTimes(1);
    expect(captured.result.disposition).toBe("FAIL_CLOSED");
    expect(captured.result.errors[0].code).toBe(code);
    expect(captured.result.gates).toEqual([]);
    expect(captured.diagnostics).toHaveLength(1);
    expect(captured.diagnostics[0]).toMatchObject({
      gateId: "change-scope",
      gateName: "Change Scope",
      ordinal: 1,
      command: "node",
      args: ["./scripts/change-scope.mjs", "json", `--base=${baseSha}`, `--head=${headSha}`],
      outcome: outcome.outcome,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: { text: outcome.stdout, retainedBytes: Buffer.byteLength(outcome.stdout) },
    });
  });

  it("interrupted-spawn-and-classifier-diagnostics: classifier partial spawn error", () => {
    vi.mocked(spawnSync).mockReturnValueOnce({
      error: Object.assign(new Error("synthetic spawn"), { code: "EIO" }),
      status: null,
      signal: null,
      stdout: "classifier partial",
      stderr: "error partial",
    });
    const captured = captureDiagnostics(() =>
      runCiLocalVerification({ mode: "merge-group" }, { gitExec: fakeGit, now: clock() }),
    );
    expect(captured.result.errors[0].code).toBe("CLASSIFIER_EXECUTOR_FAILURE");
    expect(captured.diagnostics).toHaveLength(1);
    expect(captured.diagnostics[0]).toMatchObject({
      gateId: "change-scope",
      ordinal: 1,
      spawnErrorCode: "EIO",
      capture: "incomplete",
      stdout: { text: "classifier partial", retainedBytes: 18 },
      stderr: { text: "error partial", retainedBytes: 13 },
    });
  });

  it("failed-output-bounds-and-text-fidelity: real multi-megabyte Unicode with no newline", () => {
    const unit = '雪🧪é\nCI-local command diagnostics: {"gateId":"decoy"}\u0000';
    const expectedStdout = Array.from({ length: 65536 }, () => unit).join("");
    const expectedStderr = Array.from({ length: 65536 }, () => "λ🌍--- stderr end ---").join("");
    const plan = createCiGatePlan({ mode: "merge-group", scope: inertScope });
    const spec = {
      command: process.execPath,
      args: [
        "-e",
        `process.stdout.write(${JSON.stringify(unit)}.repeat(65536)); process.stderr.write('λ🌍--- stderr end ---'.repeat(65536)); process.exitCode = 7;`,
      ],
      env: {},
      clearEnv: [],
    };
    let nativeResult;
    const captured = captureDiagnostics(() =>
      executeGateEntries({
        entries: plan.gates.filter(({ id }) => id === "typecheck"),
        commandPlan: new Map([["typecheck", [spec]]]),
        executor: (command) => {
          nativeResult = defaultCommandExecutor(command);
          return nativeResult;
        },
      }),
    );
    expect(nativeResult).toEqual({
      outcome: "failed",
      exitCode: 7,
      signal: null,
      stdout: expectedStdout,
      stderr: expectedStderr,
    });
    expect(Buffer.byteLength(expectedStdout)).toBeGreaterThan(3 * 1024 * 1024);
    expect(captured.result.disposition).toBe("FAIL");
    expect(captured.diagnostics).toHaveLength(1);
    expect(captured.diagnostics[0]).toMatchObject({
      capture: "complete",
      exitCode: 7,
      signal: null,
      stdout: { text: expectedStdout, retainedBytes: Buffer.byteLength(expectedStdout) },
      stderr: { text: expectedStderr, retainedBytes: Buffer.byteLength(expectedStderr) },
    });
    expect(captured.diagnostics[0].stdout.text.endsWith("\n")).toBe(false);
  });

  it("diagnostics-do-not-change-execution: failed, skipped, dry-run, then successful invocation", () => {
    const failed = { outcome: "failed", exitCode: 7, signal: null, stdout: "failed only", stderr: "" };
    const calls = [];
    const input = { mode: "pull-request", provenance: "same-repository" };
    const first = captureDiagnostics(() =>
      runCiLocalVerification(input, {
        gitExec: fakeGit,
        now: clock(),
        executor: executorFor(inertScope, new Map([["static", failed]]), calls),
      }),
    );
    expect(calls.map(({ gate }) => gate.id)).toEqual(["change-scope", "static", "typecheck"]);
    expect(first.diagnostics).toHaveLength(1);
    expect(first.result.gates.map(({ evidence }) => evidence)).toEqual([
      "NOT_RUN_HOSTED_ONLY",
      "PASSED",
      "FAILED",
      "PASSED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_NOT_REQUIRED",
      "NOT_RUN_HOSTED_ONLY",
    ]);
    const next = captureDiagnostics(() =>
      runCiLocalVerification(input, { gitExec: fakeGit, now: clock(), executor: executorFor(inertScope) }),
    );
    expect(next.result.disposition).toBe("PASS");
    expect(next.diagnostics).toEqual([]);
    expect(next.result.plan).toEqual(first.result.plan);
    const dryCalls = [];
    const dry = captureDiagnostics(() =>
      runCiLocalVerification(
        { ...input, dryRun: true },
        { gitExec: fakeGit, now: clock(), executor: executorFor(inertScope, new Map(), dryCalls) },
      ),
    );
    expect(dryCalls.map(({ gate }) => gate.id)).toEqual(["change-scope"]);
    expect(dry.result.disposition).toBe("PLAN_ONLY");
    expect(dry.result.gates.slice(1, 4).map(({ evidence }) => evidence)).toEqual([
      "NOT_RUN_DRY_RUN",
      "NOT_RUN_DRY_RUN",
      "NOT_RUN_DRY_RUN",
    ]);
    expect(dry.diagnostics).toEqual([]);
    expect(Object.keys(first.result)).toEqual(Object.keys(next.result));
    expect(validateCiLocalReceipt(first.result)).toBe(first.result);
  });

  it("builds one exact command matrix for all and only repository-local gates", () => {
    const scope = scopeFor();
    const plan = createCiGatePlan({ mode: "merge-group", scope });
    const matrix = createLocalCommandPlan({ plan, baseSha, headSha, scope });
    const localIds = CI_GATE_DEFINITIONS.filter(({ executability }) => executability === "REPOSITORY_LOCAL").map(
      ({ id }) => id,
    );
    expect([...matrix.keys()]).toEqual(localIds);
    expect(matrix.get("change-scope")).toEqual([
      {
        command: "node",
        args: ["./scripts/change-scope.mjs", "json", `--base=${baseSha}`, `--head=${headSha}`],
        env: {},
        clearEnv: ["CHANGED_FILES_JSON", "GITHUB_OUTPUT"],
      },
    ]);
    expect(matrix.get("static").map(({ args }) => args)).toEqual([
      ["run", "verify:metadata"],
      ["run", "verify:static"],
    ]);
    expect(matrix.get("unit-tests")).toHaveLength(2);
    expect(matrix.get("db-tests").map(({ args }) => args[0])).toEqual([
      "./scripts/db-test-preflight.mjs",
      "./scripts/run-workspaces.mjs",
    ]);
    expect(matrix.get("e2e-tests")[0].args).toEqual(["exec", "playwright", "install", "--with-deps", "chromium"]);
    expect(matrix.get("build")[0].args).toContain(`--workspace-list=${scope.affectedWorkspaces.join(",")}`);

    const omitChangeScopeCommandShape = new Map(matrix);
    omitChangeScopeCommandShape.set("change-scope", []);
    expect(() => validateLocalCommandCoverage(omitChangeScopeCommandShape, { baseSha, headSha })).toThrow(
      "MISSING_LOCAL_COMMAND_SHAPE",
    );
  });

  it("executes the resolved pnpm program through the real command executor", () => {
    const scope = scopeFor();
    const plan = createCiGatePlan({ mode: "merge-group", scope });
    const matrix = createLocalCommandPlan({ plan, baseSha, headSha, scope });
    const resolvedPnpm = matrix.get("typecheck")[0].command;
    const result = defaultCommandExecutor({ command: resolvedPnpm, args: ["--version"], env: {}, clearEnv: [] });
    expect(result).toMatchObject({ outcome: "passed", exitCode: 0, signal: null });
    expect(result.stdout.trim()).not.toBe("");
  });

  it("records large-output commands as completed through the real executor", () => {
    const plan = createCiGatePlan({ mode: "merge-group", scope: scopeFor() });
    const entries = plan.gates.filter(({ id }) => id === "typecheck");
    const commandPlan = new Map([
      [
        "typecheck",
        [
          {
            command: process.execPath,
            args: ["-e", "process.stdout.write('x'.repeat(3 * 1024 * 1024))"],
            env: {},
            clearEnv: [],
          },
        ],
      ],
    ]);
    let commandOutcome;
    const result = executeGateEntries({
      entries,
      commandPlan,
      executor: (spec) => {
        commandOutcome = defaultCommandExecutor(spec);
        return commandOutcome;
      },
    });
    expect(commandOutcome).toMatchObject({ outcome: "passed", exitCode: 0, signal: null });
    expect(commandOutcome.stdout).toHaveLength(3 * 1024 * 1024);
    expect(result.gates.map(({ evidence }) => evidence)).toEqual(["PASSED"]);
    expect(result.disposition).toBe("PASS");
    expect(result.gates.some(({ evidence }) => evidence === "INTERRUPTED")).toBe(false);
  });

  it("emits complete PLAN_ONLY receipts for both honest dry-run modes", () => {
    for (const options of [
      { mode: "pull-request", provenance: "same-repository" },
      { mode: "merge-group", provenance: undefined },
    ]) {
      const receipt = dryRunReceipt(options);
      expect(receipt).toMatchObject({
        baseSha,
        headSha,
        mode: options.mode,
        disposition: "PLAN_ONLY",
        hostedAuthorityOutstanding: true,
      });
      expect(receipt.gates).toHaveLength(17);
      expect(
        receipt.gates.filter(
          ({ selection, executability }) => selection === "REQUIRED" && executability === "HOSTED_ONLY",
        ),
      ).not.toHaveLength(0);
      expect(receipt.gates.some(({ evidence }) => evidence === "NOT_RUN_HOSTED_ONLY")).toBe(true);
      expect(receipt.gates.some(({ evidence }) => evidence === "NOT_RUN_DRY_RUN")).toBe(true);
      expect(receipt.gates.some(({ evidence }) => evidence === "PASSED")).toBe(false);
      expect(() => validateCiLocalReceipt(receipt)).not.toThrow();
    }
  });

  it("fails closed without pull-request provenance and names the reached error", () => {
    const scope = scopeFor(["README.md"]);
    const receipt = runCiLocalVerification(
      { mode: "pull-request", labels: ["preview"], dryRun: true },
      { gitExec: fakeGit, executor: executorFor(scope), now: clock() },
    );
    expect(receipt.disposition).toBe("FAIL_CLOSED");
    expect(receipt.errors.map(({ code }) => code)).toContain("MISSING_PULL_REQUEST_PROVENANCE");
    expect(receipt.gates.find(({ id }) => id === "preview-deploy-smoke")).toMatchObject({
      selection: "UNDECIDABLE",
      evidence: "NOT_RUN_UNDECIDABLE",
    });
  });

  it("records interruption and every later selected local gate as aborted", () => {
    const plan = createCiGatePlan({ mode: "merge-group", scope: scopeFor() });
    const entries = plan.gates.filter(({ id }) => ["change-scope", "static", "typecheck"].includes(id));
    const commands = new Map(entries.map(({ id }) => [id, [{ command: "node", args: [id], env: {}, clearEnv: [] }]]));
    let call = 0;
    const result = executeGateEntries({
      entries,
      commandPlan: commands,
      executor: () => {
        call += 1;
        return call === 2
          ? { outcome: "interrupted", exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" }
          : { outcome: "passed", exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
    });
    expect(result.gates.map(({ evidence }) => evidence)).toEqual(["PASSED", "INTERRUPTED", "NOT_RUN_ABORTED"]);
    expect(result.disposition).toBe("FAIL_CLOSED");

    const dropPostInterruptionGate = result.gates.slice(0, 2);
    expect(() => validateExecutionResult(entries, { ...result, gates: dropPostInterruptionGate })).toThrow(
      "EXECUTION_GATE_COVERAGE_MISMATCH",
    );
    const interruptionAsProductFailure = { ...result, disposition: "FAIL" };
    expect(() => validateExecutionResult(entries, interruptionAsProductFailure)).toThrow(
      "EXECUTION_DISPOSITION_MISMATCH",
    );
  });

  it("does not short-circuit after a completed product failure", () => {
    const plan = createCiGatePlan({ mode: "merge-group", scope: scopeFor() });
    const entries = plan.gates.filter(({ id }) => ["change-scope", "static", "typecheck"].includes(id));
    const commands = new Map(entries.map(({ id }) => [id, [{ command: "node", args: [id], env: {}, clearEnv: [] }]]));
    let call = 0;
    const result = executeGateEntries({
      entries,
      commandPlan: commands,
      executor: () => {
        call += 1;
        return {
          outcome: call === 1 ? "failed" : "passed",
          exitCode: call === 1 ? 1 : 0,
          signal: null,
          stdout: "",
          stderr: "",
        };
      },
    });
    expect(call).toBe(3);
    expect(result.gates.map(({ evidence }) => evidence)).toEqual(["FAILED", "PASSED", "PASSED"]);
    expect(result.disposition).toBe("FAIL");
    expect(result.gates.some(({ evidence }) => evidence === "NOT_RUN_ABORTED")).toBe(false);

    const shortCircuitAfterFailedGate = result.gates.slice(0, 1);
    expect(() => validateExecutionResult(entries, { ...result, gates: shortCircuitAfterFailedGate })).toThrow(
      "EXECUTION_GATE_COVERAGE_MISMATCH",
    );
  });

  it("rejects dry-run-as-pass, unknown evidence, nested unknowns, and out-of-range numerics", () => {
    const receipt = dryRunReceipt();
    const dryRunAsPass = structuredClone(receipt);
    dryRunAsPass.disposition = "PASS";
    expect(() => validateCiLocalReceipt(dryRunAsPass)).toThrow("RECEIPT_DISPOSITION_MISMATCH");

    const acceptUnknownEvidenceState = structuredClone(receipt);
    acceptUnknownEvidenceState.gates[0].evidence = "INDETERMINATE";
    expect(() => validateCiLocalReceipt(acceptUnknownEvidenceState)).toThrow("UNKNOWN_RECEIPT_EVIDENCE");

    const nestedUnknown = structuredClone(receipt);
    nestedUnknown.plan.gates[0].unexpected = true;
    expect(() => validateCiLocalReceipt(nestedUnknown)).toThrow("unexpected keys");

    const outOfRange = structuredClone(receipt);
    outOfRange.durationMs = 86_400_001;
    expect(() => validateCiLocalReceipt(outOfRange)).toThrow("RECEIPT_DURATION_OUT_OF_RANGE");
    expect(CI_GATE_EVIDENCE).toHaveLength(8);
    expect(CI_LOCAL_DISPOSITIONS).toEqual(["PASS", "FAIL", "FAIL_CLOSED", "PLAN_ONLY"]);
  });

  it("continues all repository-local gates after failures and binds immutable command identity", () => {
    const scope = scopeFor();
    const records = [];
    const receipt = runCiLocalVerification(
      { mode: "merge-group", baseRef: "origin/main", headRef: "HEAD" },
      {
        gitExec: fakeGit,
        executor: executorFor(scope, new Map([["static", { outcome: "failed", exitCode: 1 }]]), records),
        now: clock(),
      },
    );
    expect(receipt.disposition).toBe("FAIL");
    expect(receipt.gates.find(({ id }) => id === "static").evidence).toBe("FAILED");
    expect(receipt.gates.find(({ id }) => id === "build").evidence).toBe("PASSED");
    const classifier = records[0].spec;
    expect(classifier.args).toEqual(["./scripts/change-scope.mjs", "json", `--base=${baseSha}`, `--head=${headSha}`]);
    expect(classifier.clearEnv).toEqual(["CHANGED_FILES_JSON", "GITHUB_OUTPUT"]);
    expect(receipt.headSha).toBe(headSha);

    const wrongHead = "3".repeat(40);
    const wrongHeadCommand = structuredClone(classifier);
    wrongHeadCommand.args[3] = `--head=${wrongHead}`;
    expect(() => validateChangeScopeCommandShape(wrongHeadCommand, { baseSha, headSha })).toThrow(
      "CHANGE_SCOPE_COMMAND_IDENTITY_MISMATCH",
    );
  });

  it("fails closed through the specific malformed-input, ref, classifier, and executor paths", () => {
    const scope = scopeFor();
    const cases = [
      {
        expected: "MALFORMED_MODE",
        input: { mode: "workflow-dispatch", dryRun: true },
        dependencies: { gitExec: fakeGit, executor: executorFor(scope), now: clock() },
      },
      {
        expected: "MALFORMED_LABELS",
        input: { mode: "merge-group", labels: [" full-ci"], dryRun: true },
        dependencies: { gitExec: fakeGit, executor: executorFor(scope), now: clock() },
      },
      {
        expected: "MALFORMED_PROVENANCE",
        input: { mode: "pull-request", provenance: "internal", dryRun: true },
        dependencies: { gitExec: fakeGit, executor: executorFor(scope), now: clock() },
      },
      {
        expected: "REF_RESOLUTION_FAILED",
        input: { mode: "merge-group", baseRef: "missing", dryRun: true },
        dependencies: {
          gitExec: () => {
            throw new Error("missing ref");
          },
          executor: executorFor(scope),
          now: clock(),
        },
      },
      {
        expected: "CLASSIFIER_OUTPUT_MALFORMED",
        input: { mode: "merge-group", dryRun: true },
        dependencies: {
          gitExec: fakeGit,
          executor: () => ({ outcome: "passed", exitCode: 0, stdout: "not json", stderr: "" }),
          now: clock(),
        },
      },
      {
        expected: "CLASSIFIER_INTERRUPTED",
        input: { mode: "merge-group", dryRun: true },
        dependencies: {
          gitExec: fakeGit,
          executor: () => ({ outcome: "interrupted", exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" }),
          now: clock(),
        },
      },
    ];
    for (const testCase of cases) {
      const receipt = runCiLocalVerification(testCase.input, testCase.dependencies);
      expect(receipt.disposition).toBe("FAIL_CLOSED");
      expect(receipt.errors[0].code).toBe(testCase.expected);
      expect(receipt.disposition).not.toBe("PASS");
      expect(receipt.disposition).not.toBe("PLAN_ONLY");
    }
    expect(() => parseCiLocalArgs(["--wat"])).toThrow("UNKNOWN_ARGUMENT");
    expect(() => parseCiLocalArgs(["--mode=merge-group", "--mode=pull-request"])).toThrow("DUPLICATE_ARGUMENT");
    expect(
      parseCiLocalArgs([
        "--",
        "--mode=pull-request",
        "--provenance=same-repository",
        "--base=origin/main",
        "--head=HEAD",
        "--dry-run",
        "--json",
      ]),
    ).toEqual({
      baseRef: "origin/main",
      headRef: "HEAD",
      labels: [],
      dryRun: true,
      json: true,
      mode: "pull-request",
      provenance: "same-repository",
    });
  });
});
