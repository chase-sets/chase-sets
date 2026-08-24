import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { cleanupDigitalOceanRegistry } from "./digitalocean-registry-cleanup.mjs";

const registryWorkflowPath = resolve(".github/workflows/platform-registry-cleanup.yml");
const restoreWorkflowPath = resolve(".github/workflows/platform-production-restore-point-cleanup.yml");
const registrySource = readFileSync(registryWorkflowPath, "utf8");
const restoreSource = readFileSync(restoreWorkflowPath, "utf8");
const registryWorkflow = parseYaml(registrySource);
const restoreWorkflow = parseYaml(restoreSource);
const bashLauncher = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\bash.exe" : "bash";
const registryConfirmation = "delete registry cleanup candidates";
const restoreConfirmation = "delete production restore points";
const registryRequestedName = "DIGITALOCEAN_REGISTRY_CLEANUP_REQUESTED_DRY_RUN";
const registryResolvedName = "DIGITALOCEAN_REGISTRY_CLEANUP_RESOLVED_DRY_RUN";
const restoreResolvedName = "PRODUCTION_DB_RESTORE_POINT_CLEANUP_RESOLVED_APPLY";
const temporaryDirectories = [];
const ambientPath = process.env.PATH ?? process.env.Path ?? "";
const shellPath = process.platform === "win32" ? `${dirname(bashLauncher)}${delimiter}${ambientPath}` : ambientPath;

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function temporaryDirectory(label) {
  const directory = mkdtempSync(join(tmpdir(), `${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function scrubbedAmbientEnvironment(extra = {}, omitted = []) {
  const environment = { ...process.env, ...extra };
  for (const name of Object.keys(environment)) {
    if (name.toLowerCase() === "path") delete environment[name];
  }
  environment.PATH = extra.PATH ?? shellPath;
  for (const name of Object.keys(environment)) {
    if (
      /(?:DIGITALOCEAN|GH|GITHUB|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)/i.test(name) &&
      !Object.hasOwn(extra, name)
    ) {
      delete environment[name];
    }
  }
  for (const name of omitted) delete environment[name];
  return environment;
}

function executeBash(block, { env = {}, omitted = [], args = [], cwd = process.cwd(), launcher = bashLauncher } = {}) {
  const result = spawnSync(launcher, ["-c", block, "workflow-test", ...args], {
    cwd,
    env: scrubbedAmbientEnvironment(env, omitted),
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function requireJob(workflow, jobId) {
  const job = workflow.jobs?.[jobId];
  if (!job) throw new Error(`Missing workflow job ${jobId}.`);
  return job;
}

function requireNamedStep(job, stepName) {
  const matches = (job.steps ?? []).filter((step) => step.name === stepName);
  if (matches.length !== 1)
    throw new Error(`Expected exactly one workflow step named ${stepName}; found ${matches.length}.`);
  if (typeof matches[0].run !== "string") throw new Error(`Workflow step ${stepName} has no executable run block.`);
  return matches[0];
}

function workflowContracts(workflow, confirmation) {
  const dispatch = workflow.on?.workflow_dispatch;
  const confirm = dispatch?.inputs?.confirm;
  expect(confirm).toEqual({
    description: `Type "${confirmation}" to apply cleanup.`,
    required: false,
    type: "string",
  });
  expect(Object.hasOwn(confirm, "default")).toBe(false);

  const refusal = requireJob(workflow, "refuse-unconfirmed-apply");
  expect(refusal.if).toBe("github.event_name == 'workflow_dispatch'");
  expect(refusal.env).toEqual({
    MODE: "${{ github.event.inputs.dry_run }}",
    CONFIRM: "${{ github.event.inputs.confirm }}",
  });
  expect(refusal["continue-on-error"]).toBeUndefined();
  expect(refusal.steps).toHaveLength(1);
  for (const step of refusal.steps) {
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
  }

  const cleanup = requireJob(workflow, "cleanup");
  expect(cleanup["continue-on-error"]).toBeUndefined();
  expect(cleanup.needs).toBe("refuse-unconfirmed-apply");
  expect(cleanup.if).toBe(
    "${{ !cancelled() && (needs.refuse-unconfirmed-apply.result == 'skipped' || needs.refuse-unconfirmed-apply.result == 'success') }}",
  );
  expect(cleanup.if).not.toContain("always()");
  return { refusal, cleanup };
}

function cleanupConditionAllows(jobCondition, { cancelled, refusalResult }) {
  expect(jobCondition).toBe(
    "${{ !cancelled() && (needs.refuse-unconfirmed-apply.result == 'skipped' || needs.refuse-unconfirmed-apply.result == 'success') }}",
  );
  return !cancelled && (refusalResult === "skipped" || refusalResult === "success");
}

function refusalRows(confirmation) {
  const modes = ["true", "false", "", undefined, "maybe", "TRUE"];
  const confirmations = [
    confirmation,
    confirmation.replace(/^./, (character) => character.toUpperCase()),
    "",
    "wrong text",
  ];
  return modes.flatMap((mode) =>
    confirmations.map((confirm) => ({
      mode,
      confirm,
      accepted: mode === "true" || (mode === "false" && confirm === confirmation),
    })),
  );
}

function executeRefusalMatrix(block, confirmation) {
  return refusalRows(confirmation).map((row) => {
    const result = executeBash(block, {
      env: {
        ...(row.mode === undefined ? {} : { MODE: row.mode }),
        CONFIRM: row.confirm,
      },
      omitted: row.mode === undefined ? ["MODE"] : [],
    });
    return { ...row, status: result.status };
  });
}

function assertRefusalMatrix(block, confirmation) {
  const rows = executeRefusalMatrix(block, confirmation);
  expect(rows).toHaveLength(24);
  for (const row of rows) {
    if (row.accepted) expect(row.status, JSON.stringify(row)).toBe(0);
    else expect(row.status, JSON.stringify(row)).not.toBe(0);
  }
  return rows;
}

function refusalComparisonMutant(block, confirmation) {
  const comparison = `if [ "$CONFIRM" != "${confirmation}" ]; then`;
  expect(block).toContain(comparison);
  return block.replace(comparison, "if false; then");
}

function parseEnvironmentFile(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    });
}

function runRegistryResolver(block, requested) {
  const directory = temporaryDirectory("registry-resolver");
  const githubEnvironment = join(directory, "github-env");
  const result = executeBash(block, {
    env: {
      ...(requested === undefined ? {} : { [registryRequestedName]: requested }),
      GITHUB_ENV: githubEnvironment,
    },
    omitted: requested === undefined ? [registryRequestedName] : [],
    cwd: directory,
  });
  return { ...result, publications: parseEnvironmentFile(githubEnvironment) };
}

function registryRequestedValue(expression, eventName, dispatchValue) {
  expect(expression).toBe("${{ github.event_name == 'schedule' && 'false' || github.event.inputs.dry_run }}");
  return eventName === "schedule" ? "false" : dispatchValue;
}

function assertRegistryStepTopology(workflow) {
  const cleanup = requireJob(workflow, "cleanup");
  const names = cleanup.steps.map((step) => step.name ?? step.uses);
  const indices = {
    resolver: names.indexOf("Resolve cleanup mode"),
    deployLane: names.indexOf("Check deploy lane"),
    cleanup: names.indexOf("Cleanup registry tags"),
  };
  expect(indices).toEqual({ resolver: 0, deployLane: 5, cleanup: 6 });
  expect(indices.resolver).toBeLessThan(indices.deployLane);
  expect(indices.resolver).toBeLessThan(indices.cleanup);

  const resolvedConsumers = cleanup.steps
    .map((step, index) => ({ index, name: step.name, source: JSON.stringify(step) }))
    .filter(({ index, source }) => index !== indices.resolver && source.includes(registryResolvedName));
  expect(resolvedConsumers.map(({ index, name }) => ({ index, name }))).toEqual([
    { index: 5, name: "Check deploy lane" },
    { index: 6, name: "Cleanup registry tags" },
  ]);
  for (const consumer of resolvedConsumers) expect(indices.resolver).toBeLessThan(consumer.index);
  return indices;
}

function movedRegistryResolverMutant(workflow) {
  const mutant = structuredClone(workflow);
  const steps = requireJob(mutant, "cleanup").steps;
  const resolverIndex = steps.findIndex((step) => step.name === "Resolve cleanup mode");
  const [resolver] = steps.splice(resolverIndex, 1);
  const deployLaneIndex = steps.findIndex((step) => step.name === "Check deploy lane");
  steps.splice(deployLaneIndex + 1, 0, resolver);
  return mutant;
}

function extractNodeHeredoc(block) {
  const match = /(?:^|\n)node <<'NODE'\n([\s\S]*?)\nNODE(?:\n|$)/.exec(block);
  if (!match) throw new Error("The real Check deploy lane Node heredoc is missing.");
  return match[1];
}

function strictDeferredEnvironment(directory, requested, resolved) {
  const emptyPath = join(directory, "empty-path");
  const configRoot = join(directory, "github-config");
  mkdirSync(emptyPath, { recursive: true });
  mkdirSync(configRoot, { recursive: true });
  const environment = {
    PATH: emptyPath,
    GITHUB_REPOSITORY: "chase-sets/chase-sets",
    GITHUB_RUN_ID: "612700",
    GITHUB_OUTPUT: join(directory, "github-output"),
    PLATFORM_IMAGE_REPOSITORY: "chase-sets-platform",
    [registryRequestedName]: requested,
    [registryResolvedName]: resolved,
    GH_CONFIG_DIR: configRoot,
    XDG_CONFIG_HOME: configRoot,
    HOME: configRoot,
    USERPROFILE: configRoot,
    TMP: directory,
    TEMP: directory,
    TEST_PRELOAD_IDENTITY: join(directory, "preload-identity.json"),
    TEST_CHILD_SENTINEL: join(directory, "child-calls.jsonl"),
    TEST_NATIVE_CHILD_SENTINEL: join(directory, "native-child-sentinel"),
    TEST_BARRIER_RESULT: join(directory, "barrier-result.json"),
  };
  for (const name of ["SystemRoot", "WINDIR"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  expect(
    Object.keys(environment).filter((name) => /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|DIGITALOCEAN_ACCESS)/i.test(name)),
  ).toEqual([]);
  return { environment, emptyPath };
}

function writeSpawnPreload(directory) {
  const preloadPath = join(directory, "spawn-preload.cjs");
  writeFileSync(
    preloadPath,
    `const childProcess = require("node:child_process");
const fs = require("node:fs");
fs.writeFileSync(process.env.TEST_PRELOAD_IDENTITY, JSON.stringify({ filename: __filename, resolved: require.resolve(__filename) }));
let callIndex = 0;
childProcess.spawnSync = (command, args) => {
  if (command !== "gh" || args?.length !== 2 || args[0] !== "api" || !/^repos\\/chase-sets\\/chase-sets\\/actions\\/workflows\\/(platform-production\\.yml|platform-staging-reset\\.yml)\\/runs\\?status=(queued|in_progress|waiting|requested|pending)&per_page=100$/.test(args[1])) {
    throw new Error(\`Unexpected child invocation: \${JSON.stringify({ command, args })}\`);
  }
  fs.appendFileSync(process.env.TEST_CHILD_SENTINEL, JSON.stringify({ command, args }) + "\\n");
  const workflowRuns = callIndex++ === 0
    ? [{ id: 612701, status: "queued", event: "push", head_sha: "synthetic-head", html_url: "https://example.invalid/synthetic-blocker" }]
    : [];
  return { status: 0, stdout: JSON.stringify({ workflow_runs: workflowRuns }), stderr: "" };
};
`,
  );
  return preloadPath;
}

function expectedDeferredChildCalls() {
  const workflows = ["platform-production.yml", "platform-staging-reset.yml"];
  const statuses = ["queued", "in_progress", "waiting", "requested", "pending"];
  return workflows.flatMap((workflow) =>
    statuses.map((status) => ({
      command: "gh",
      args: ["api", `repos/chase-sets/chase-sets/actions/workflows/${workflow}/runs?status=${status}&per_page=100`],
    })),
  );
}

function proveNativeChildBarrier(directory, environment) {
  const barrierProgram = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const result = spawnSync("gh", ["api", "synthetic"], { encoding: "utf8" });
fs.writeFileSync(process.env.TEST_BARRIER_RESULT, JSON.stringify({ status: result.status, errorCode: result.error?.code ?? null }));
`;
  const barrier = spawnSync(process.execPath, ["-e", barrierProgram], {
    cwd: directory,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
  });
  expect(barrier.error).toBeUndefined();
  expect(barrier.status, barrier.stderr).toBe(0);
  expect(JSON.parse(readFileSync(environment.TEST_BARRIER_RESULT, "utf8"))).toEqual({
    status: null,
    errorCode: "ENOENT",
  });
  expect(existsSync(environment.TEST_NATIVE_CHILD_SENTINEL)).toBe(false);
}

function executeDeferredRecord(program, { requested, resolved, preload = true, restoreAmbientPath = false } = {}) {
  const directory = temporaryDirectory("registry-deferred-record");
  const artifactDirectory = join(directory, "artifacts", "release-health");
  mkdirSync(artifactDirectory, { recursive: true });
  const { environment, emptyPath } = strictDeferredEnvironment(directory, requested, resolved);
  if (restoreAmbientPath) environment.PATH = ambientPath;
  if (environment.PATH !== emptyPath) throw new Error("Deferred-record execution refused a non-isolated PATH.");

  proveNativeChildBarrier(directory, environment);
  const preloadPath = writeSpawnPreload(directory);
  const args = preload ? ["-r", preloadPath, "-e", program] : ["-e", program];
  const result = spawnSync(process.execPath, args, {
    cwd: directory,
    env: environment,
    encoding: "utf8",
    windowsHide: true,
  });
  const recordPath = join(artifactDirectory, "digitalocean-registry-cleanup.json");
  if (!preload) return { result, recordPath, environment, preloadPath };

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const identity = JSON.parse(readFileSync(environment.TEST_PRELOAD_IDENTITY, "utf8"));
  expect(identity).toEqual({ filename: preloadPath, resolved: preloadPath });
  const childCalls = readFileSync(environment.TEST_CHILD_SENTINEL, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  expect(childCalls).toEqual(expectedDeferredChildCalls());
  expect(existsSync(environment.TEST_NATIVE_CHILD_SENTINEL)).toBe(false);
  return {
    result,
    record: JSON.parse(readFileSync(recordPath, "utf8")),
    childCalls,
    preloadPath,
    environment,
  };
}

function swappedRecordSourceMutant(program) {
  const modeSource = `process.env.${registryResolvedName} === "true" ? "dry-run" : "apply"`;
  const requestedSource = `process.env.${registryRequestedName} === "true" ? "dry-run" : "apply"`;
  expect(program).toContain(modeSource);
  expect(program).toContain(requestedSource);
  return program
    .replace(modeSource, "__MODE_SOURCE__")
    .replace(requestedSource, modeSource)
    .replace("__MODE_SOURCE__", requestedSource);
}

function collapsedRecordSourceMutant(program) {
  const modeSource = `process.env.${registryResolvedName} === "true" ? "dry-run" : "apply"`;
  const requestedSource = `process.env.${registryRequestedName} === "true" ? "dry-run" : "apply"`;
  expect(program).toContain(modeSource);
  return program.replace(modeSource, requestedSource);
}

function runRestoreResolver(block, eventName, mode) {
  const directory = temporaryDirectory("restore-resolver");
  const githubEnvironment = join(directory, "github-env");
  const result = executeBash(block, {
    env: {
      GITHUB_EVENT_NAME: eventName,
      ...(mode === undefined ? {} : { MODE: mode }),
      GITHUB_ENV: githubEnvironment,
    },
    omitted: mode === undefined ? ["MODE"] : [],
    cwd: directory,
  });
  return { ...result, publications: parseEnvironmentFile(githubEnvironment) };
}

function executeRestoreInvocation(block, resolvedApply) {
  const directory = temporaryDirectory("restore-invocation");
  const argvPath = join(directory, "node-argv");
  const recorder = `node() { printf '%s\\n' "$@" > "$ARGV_FILE"; }\n`;
  const result = executeBash(`${recorder}${block}`, {
    env: {
      ...(resolvedApply === undefined ? {} : { [restoreResolvedName]: resolvedApply }),
      MIN_AGE_HOURS: "6",
      ARGV_FILE: argvPath,
    },
    omitted: resolvedApply === undefined ? [restoreResolvedName] : [],
    cwd: directory,
  });
  return {
    ...result,
    invoked: existsSync(argvPath),
    argv: existsSync(argvPath) ? readFileSync(argvPath, "utf8").trim().split(/\r?\n/) : [],
  };
}

function assertRestoreInvocation(block, resolvedApply, expectedApplyCount) {
  const result = executeRestoreInvocation(block, resolvedApply);
  expect(result.status, result.stderr).toBe(0);
  expect(result.invoked).toBe(true);
  expect(result.argv).toEqual([
    "./scripts/production-db-restore-point-cleanup.mjs",
    "--min-age-hours",
    "6",
    "--out",
    "artifacts/release-health/production-db-restore-point-cleanup.json",
    ...Array.from({ length: expectedApplyCount }, () => "--apply"),
  ]);
  return result;
}

function environmentOwners(workflow, name) {
  const owners = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    if (Object.hasOwn(job.env ?? {}, name)) owners.push(`jobs.${jobId}.env`);
    for (const [index, step] of (job.steps ?? []).entries()) {
      if (Object.hasOwn(step.env ?? {}, name)) owners.push(`jobs.${jobId}.steps.${index}.env`);
    }
  }
  return owners;
}

describe("destructive cleanup workflow shell authority", () => {
  it("executes the selected Git Bash or POSIX launcher with exact environment and argv channels", () => {
    const result = executeBash('set -euo pipefail\nprintf "env=%s|argv=%s" "$ROUND_TRIP_ENV" "$1"', {
      env: { ROUND_TRIP_ENV: "env value" },
      args: ["argv value"],
    });
    expect({ launcher: bashLauncher, ...result }).toEqual({
      launcher: bashLauncher,
      status: 0,
      stdout: "env=env value|argv=argv value",
      stderr: "",
    });

    expect(() => executeBash("exit 0", { launcher: join(temporaryDirectory("missing-launcher"), "bash") })).toThrow();
  });

  it("executes the real registry refusal truth table and makes the exact-comparison mutant red", () => {
    const { refusal, cleanup } = workflowContracts(registryWorkflow, registryConfirmation);
    const block = requireNamedStep(refusal, "Validate manual registry cleanup mode").run;
    const rows = assertRefusalMatrix(block, registryConfirmation);
    expect(rows.filter((row) => row.status === 0)).toHaveLength(5);
    const candidateNegative = rows.find((row) => row.mode === "false" && row.confirm === "wrong text");
    const mutantNegative = executeBash(refusalComparisonMutant(block, registryConfirmation), {
      env: { MODE: "false", CONFIRM: "wrong text" },
    });
    expect({ candidate: candidateNegative.status, mutant: mutantNegative.status }).toEqual({ candidate: 1, mutant: 0 });

    expect([
      cleanupConditionAllows(cleanup.if, { cancelled: false, refusalResult: "skipped" }),
      cleanupConditionAllows(cleanup.if, { cancelled: false, refusalResult: "success" }),
      cleanupConditionAllows(cleanup.if, { cancelled: false, refusalResult: "failure" }),
      cleanupConditionAllows(cleanup.if, { cancelled: true, refusalResult: "success" }),
    ]).toEqual([true, true, false, false]);

    const renamed = structuredClone(registryWorkflow);
    renamed.jobs["renamed-refusal"] = renamed.jobs["refuse-unconfirmed-apply"];
    delete renamed.jobs["refuse-unconfirmed-apply"];
    expect(() => workflowContracts(renamed, registryConfirmation)).toThrow();
    expect(() => expect(rows.slice(1)).toHaveLength(24)).toThrow();
  });

  it("executes the real restore refusal truth table and makes the exact-comparison mutant red", () => {
    const { refusal, cleanup } = workflowContracts(restoreWorkflow, restoreConfirmation);
    const block = requireNamedStep(refusal, "Validate manual restore-point cleanup mode").run;
    const rows = assertRefusalMatrix(block, restoreConfirmation);
    expect(rows.filter((row) => row.status === 0)).toHaveLength(5);
    const candidateNegative = rows.find((row) => row.mode === "false" && row.confirm === "wrong text");
    const mutantNegative = executeBash(refusalComparisonMutant(block, restoreConfirmation), {
      env: { MODE: "false", CONFIRM: "wrong text" },
    });
    expect({ candidate: candidateNegative.status, mutant: mutantNegative.status }).toEqual({ candidate: 1, mutant: 0 });
    expect(cleanupConditionAllows(cleanup.if, { cancelled: false, refusalResult: "failure" })).toBe(false);
  });
});

describe("registry cleanup requested and resolved authorities", () => {
  it("publishes the exact event/request matrix from the first step and rejects malformed direct resolver inputs", () => {
    const cleanup = requireJob(registryWorkflow, "cleanup");
    const requestedExpression = cleanup.env[registryRequestedName];
    const resolver = requireNamedStep(cleanup, "Resolve cleanup mode").run;
    expect(registrySource.match(new RegExp(`${registryResolvedName}=`, "g"))).toHaveLength(1);
    expect(environmentOwners(registryWorkflow, registryResolvedName)).toEqual([]);
    assertRegistryStepTopology(registryWorkflow);
    expect(() => assertRegistryStepTopology(movedRegistryResolverMutant(registryWorkflow))).toThrow();

    const rows = [
      { eventName: "schedule", dispatchValue: undefined, requested: "false", resolved: "false" },
      { eventName: "workflow_dispatch", dispatchValue: "true", requested: "true", resolved: "true" },
      { eventName: "workflow_dispatch", dispatchValue: "false", requested: "false", resolved: "false" },
    ];
    for (const row of rows) {
      const requested = registryRequestedValue(requestedExpression, row.eventName, row.dispatchValue);
      expect(requested).toBe(row.requested);
      const result = runRegistryResolver(resolver, requested);
      expect(result.status, JSON.stringify(row)).toBe(0);
      expect(result.publications).toEqual([[registryResolvedName, row.resolved]]);
      expect(requested).toBe(row.requested);
    }

    for (const requested of ["", undefined, "maybe", "TRUE"]) {
      const result = runRegistryResolver(resolver, requested);
      expect(result.status).not.toBe(0);
      expect(result.publications).toEqual([]);
    }
  });

  it("executes the real deferred-record heredoc offline with distinct fields and discriminating mutants", () => {
    const cleanup = requireJob(registryWorkflow, "cleanup");
    const deployLane = requireNamedStep(cleanup, "Check deploy lane");
    const program = extractNodeHeredoc(deployLane.run);
    const rows = [
      { requested: "false", resolved: "false", mode: "apply", requestedMode: "apply" },
      { requested: "true", resolved: "true", mode: "dry-run", requestedMode: "dry-run" },
      { requested: "false", resolved: "false", mode: "apply", requestedMode: "apply" },
      { requested: "true", resolved: "false", mode: "apply", requestedMode: "dry-run" },
    ];
    for (const row of rows) {
      const execution = executeDeferredRecord(program, row);
      expect(execution.record).toMatchObject({
        result: "deferred",
        mode: row.mode,
        requestedMode: row.requestedMode,
        deployLaneBlockers: [
          {
            id: 612701,
            status: "queued",
            headSha: "synthetic-head",
          },
        ],
      });
    }

    const divergence = { requested: "true", resolved: "false" };
    const swapped = executeDeferredRecord(swappedRecordSourceMutant(program), divergence).record;
    expect(swapped).not.toMatchObject({ mode: "apply", requestedMode: "dry-run" });
    const collapsed = executeDeferredRecord(collapsedRecordSourceMutant(program), divergence).record;
    expect(collapsed).not.toMatchObject({ mode: "apply", requestedMode: "dry-run" });

    const noPreload = executeDeferredRecord(program, { ...divergence, preload: false });
    expect(noPreload.result.status).not.toBe(0);
    expect(existsSync(noPreload.recordPath)).toBe(false);
    expect(() => executeDeferredRecord(program, { ...divergence, restoreAmbientPath: true })).toThrow(
      "Deferred-record execution refused a non-isolated PATH.",
    );
  });

  it("feeds split workflow publications through the exported cleanup gate before any provider call", async () => {
    const cleanup = requireJob(registryWorkflow, "cleanup");
    const resolver = requireNamedStep(cleanup, "Resolve cleanup mode").run;
    const requested = registryRequestedValue(cleanup.env[registryRequestedName], "workflow_dispatch", "true");
    const publishedResolved = runRegistryResolver(resolver, requested).publications[0][1];
    expect(publishedResolved).toBe("true");
    const changedResolved = "false";
    let providerCalls = 0;
    const result = await cleanupDigitalOceanRegistry(
      {
        repository: "chase-sets-platform",
        retentionDays: 7,
        retainRecentShaTreeTags: 25,
        dryRun: changedResolved === "true",
        requestedDryRun: requested === "true",
        checkedAt: "2026-08-24T00:00:00.000Z",
      },
      {
        commandOutput: async () => {
          providerCalls += 1;
          throw new Error("Provider sentinel must remain unreachable.");
        },
      },
    );
    expect(providerCalls).toBe(0);
    expect(result.passesCleanupGate).toBe(false);
    expect(result.record.errors).toContain("Resolved cleanup mode apply does not match requested mode dry-run.");
  });
});

describe("restore cleanup resolved authority and closed argv", () => {
  it("executes the real resolver and destructive block across the complete event matrix", () => {
    const cleanup = requireJob(restoreWorkflow, "cleanup");
    const resolverStep = requireNamedStep(cleanup, "Resolve cleanup mode");
    const destructiveStep = requireNamedStep(cleanup, "Cleanup restore-point forks");
    const names = cleanup.steps.map((step) => step.name ?? step.uses);
    expect({
      resolver: names.indexOf("Resolve cleanup mode"),
      destructive: names.indexOf("Cleanup restore-point forks"),
      summary: names.indexOf("Summarize cleanup"),
    }).toEqual({ resolver: 2, destructive: 3, summary: 4 });

    const rows = [
      { eventName: "schedule", mode: undefined, resolvedApply: "true", applyCount: 1 },
      { eventName: "workflow_dispatch", mode: "false", resolvedApply: "true", applyCount: 1 },
      { eventName: "workflow_dispatch", mode: "true", resolvedApply: "false", applyCount: 0 },
    ];
    for (const row of rows) {
      const resolution = runRestoreResolver(resolverStep.run, row.eventName, row.mode);
      expect(resolution.status, JSON.stringify(row)).toBe(0);
      expect(resolution.publications).toEqual([[restoreResolvedName, row.resolvedApply]]);
      assertRestoreInvocation(destructiveStep.run, row.resolvedApply, row.applyCount);
    }

    for (const mode of ["", undefined, "maybe", "TRUE"]) {
      const resolution = runRestoreResolver(resolverStep.run, "workflow_dispatch", mode);
      expect(resolution.status).not.toBe(0);
      expect(resolution.publications).toEqual([]);
    }
    const unknownEvent = runRestoreResolver(resolverStep.run, "push", "false");
    expect(unknownEvent.status).not.toBe(0);
    expect(unknownEvent.publications).toEqual([]);

    for (const resolved of ["", undefined, "maybe", "TRUE"]) {
      const invocation = executeRestoreInvocation(destructiveStep.run, resolved);
      expect(invocation.status).not.toBe(0);
      expect(invocation.invoked).toBe(false);
    }
  });

  it("rejects restore argv and environment-channel mutants while preserving bounded selection semantics", () => {
    const cleanup = requireJob(restoreWorkflow, "cleanup");
    const destructive = requireNamedStep(cleanup, "Cleanup restore-point forks").run;
    expect(environmentOwners(restoreWorkflow, restoreResolvedName)).toEqual([]);
    expect(restoreSource.match(new RegExp(`${restoreResolvedName}=`, "g"))).toHaveLength(1);
    expect(restoreSource).not.toContain("PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY");
    for (const registryOnlySurface of [
      registryRequestedName,
      registryResolvedName,
      "requestedMode",
      "--dry-run",
      "validateCleanupOptions",
    ]) {
      expect(restoreSource).not.toContain(registryOnlySurface);
    }
    expect(restoreWorkflow.on.schedule).toEqual([{ cron: "17 3,9,15,21 * * *" }]);
    expect(Object.keys(restoreWorkflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(restoreWorkflow.on.workflow_dispatch.inputs.min_age_hours.default).toBe("6");
    expect(restoreWorkflow.on.workflow_dispatch.inputs.hold_names.default).toBe("");
    expect(restoreWorkflow.concurrency).toEqual({
      group: "platform-production-restore-point-cleanup",
      "cancel-in-progress": false,
    });
    expect(cleanup.permissions).toEqual({ contents: "read", issues: "write" });
    expect(cleanup.env).toEqual({
      PRODUCTION_DB_RESTORE_POINT_CLEANUP_PREFIX: "cs-prod-rp-",
      PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES:
        "${{ github.event.inputs.hold_names || vars.PRODUCTION_DB_RESTORE_POINT_CLEANUP_HOLD_NAMES || '' }}",
    });
    expect(requireNamedStep(cleanup, "Cleanup restore-point forks").env.MIN_AGE_HOURS).toBe(
      "${{ github.event.inputs.min_age_hours || '6' }}",
    );

    const removedApply = destructive.replace('apply_args=("--apply")', "apply_args=()");
    expect(() => assertRestoreInvocation(removedApply, "true", 1)).toThrow();
    const duplicatedApply = destructive.replace('apply_args=("--apply")', 'apply_args=("--apply" "--apply")');
    expect(() => assertRestoreInvocation(duplicatedApply, "true", 1)).toThrow();
    expect(destructive).toContain('"${apply_args[@]}"');
    const unconditionalApply = destructive.replace('"${apply_args[@]}"', '--apply \\\n  "${apply_args[@]}"');
    expect(() => assertRestoreInvocation(unconditionalApply, "false", 0)).toThrow();

    const environmentChannelMutant = structuredClone(restoreWorkflow);
    environmentChannelMutant.jobs.cleanup.env.PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY = "false";
    expect(environmentOwners(environmentChannelMutant, "PRODUCTION_DB_RESTORE_POINT_CLEANUP_APPLY")).not.toEqual([]);
  });
});

describe("cleanup workflow bounded footprint pins", () => {
  it("preserves registry selection, permissions, concurrency, and exact destructive argv", () => {
    const cleanup = requireJob(registryWorkflow, "cleanup");
    const destructive = requireNamedStep(cleanup, "Cleanup registry tags").run;
    expect(registryWorkflow.on.schedule).toEqual([{ cron: "37 8 * * 1" }]);
    expect(Object.keys(registryWorkflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(registryWorkflow.concurrency).toEqual({
      group: "platform-registry-mutation",
      "cancel-in-progress": false,
    });
    expect(cleanup.permissions).toEqual({ contents: "read", actions: "read", issues: "write" });
    expect(cleanup.env).toEqual({
      [registryRequestedName]: "${{ github.event_name == 'schedule' && 'false' || github.event.inputs.dry_run }}",
      PLATFORM_IMAGE_REPOSITORY: "chase-sets-platform",
    });
    expect(destructive).toContain("--retain-recent-sha-tree-tags=25");
    expect(destructive).toContain(`--dry-run="\${${registryResolvedName}}"`);
    expect(destructive).toContain("--out artifacts/release-health/digitalocean-registry-cleanup.json");
    expect(destructive).not.toContain("--retention-days");
  });

  it("pins exactly the three declared managed-authority step-anchor shifts", () => {
    const manifest = JSON.parse(readFileSync(resolve("scripts/managed-postgres-authority-manifest.json"), "utf8"));
    const anchors = manifest.grants.map(
      (entry) => `${entry.file}|${entry.jobId}|${entry.stepAnchor}|${entry.secretName}`,
    );
    const expected = [
      ".github/workflows/platform-registry-cleanup.yml|cleanup|name:Cleanup registry tags#7|DIGITALOCEAN_REGISTRY_TOKEN",
      ".github/workflows/platform-production-restore-point-cleanup.yml|cleanup|name:Cleanup restore-point forks#4|DIGITALOCEAN_ACCESS_TOKEN",
      ".github/workflows/platform-production-restore-point-cleanup.yml|cleanup|name:Summarize cleanup#5|DIGITALOCEAN_ACCESS_TOKEN",
    ];
    for (const anchor of expected) expect(anchors.filter((candidate) => candidate === anchor)).toHaveLength(1);
    for (const predecessor of [
      expected[0].replace("#7", "#6"),
      expected[1].replace("#4", "#3"),
      expected[2].replace("#5", "#4"),
    ]) {
      expect(anchors).not.toContain(predecessor);
    }
  });
});
