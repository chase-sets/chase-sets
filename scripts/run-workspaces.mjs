// Evidence-only in-scope classifier probe for #6810 candidate b806463; never merge.
import process from "node:process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readEnvFile } from "./lib/env.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { listWorkspacePackages } from "./lib/repo.mjs";
import { ensureWorktreeSandboxEnvironment } from "./lib/sandbox.mjs";
import { syncLocalEnvFiles } from "./local-env.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const inheritedEnvKeys = new Set(Object.keys(process.env));
const testEnvFiles = [".env", ".env.local", ".env.test", ".env.test.local"];
const durationHintRegistryUrl = new URL("./workspace-test-duration-hints-v1.json", import.meta.url);
const workspacePattern = /^@chase-sets\/[a-z0-9-]+$/;
const durationHintScripts = new Set(["test", "test:unit"]);
const durationInvocations = new Map([
  ["test--exclude-test-profile=db", "test"],
  ["test:unit--test-profile=db", "test:unit"],
]);
const summaryRootKeys = [
  "schemaVersion",
  "scriptName",
  "concurrency",
  "eligibleCount",
  "completedCount",
  "passedCount",
  "failedCount",
  "elapsedMs",
  "unhintedTasks",
  "tasks",
];
export const DEFAULT_TEST_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const DB_TEST_SCRIPT_SELECTOR = "test:db*";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value, expectedKeys, label, { ordered = false } = {}) {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object.`);
  }

  const actualKeys = Object.keys(value);
  const matches = ordered
    ? actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index])
    : actualKeys.length === expectedKeys.length && expectedKeys.every((key) => actualKeys.includes(key));

  if (!matches) {
    throw new Error(`${label} must contain exactly: ${expectedKeys.join(", ")}.`);
  }
}

function assertBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
}

function assertWorkspaceIdentity(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || !workspacePattern.test(value)) {
    throw new Error(`${label} must match ${workspacePattern.source} and contain 1 through 128 characters.`);
  }
}

function assertDurationHintScript(value, label) {
  if (typeof value !== "string" || !durationHintScripts.has(value)) {
    throw new Error(`${label} must be test or test:unit.`);
  }
}

function isWorkspaceEligibleForDurationHint(workspace, scriptName) {
  if (typeof workspace.packageJson.scripts?.[scriptName] !== "string") {
    return false;
  }

  const testProfile = workspace.packageJson.chaseSets?.testProfile;
  return scriptName === "test" ? testProfile !== "db" : testProfile === "db";
}

export function validateDurationHintRegistry(registry, workspaces) {
  assertExactKeys(registry, ["schemaVersion", "entries"], "Duration-hint registry");
  if (registry.schemaVersion !== "workspace-test-duration-hints/v1") {
    throw new Error("Duration-hint registry schemaVersion must be workspace-test-duration-hints/v1.");
  }
  if (!Array.isArray(registry.entries) || registry.entries.length < 1 || registry.entries.length > 256) {
    throw new Error("Duration-hint registry entries must contain 1 through 256 items.");
  }

  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const seenKeys = new Set();

  for (const [index, entry] of registry.entries.entries()) {
    const label = `Duration-hint registry entries[${index}]`;
    assertExactKeys(entry, ["workspace", "script", "estimatedDurationSeconds"], label);
    assertWorkspaceIdentity(entry.workspace, `${label}.workspace`);
    assertDurationHintScript(entry.script, `${label}.script`);
    assertBoundedInteger(entry.estimatedDurationSeconds, 1, 3600, `${label}.estimatedDurationSeconds`);

    const key = `${entry.workspace}\0${entry.script}`;
    if (seenKeys.has(key)) {
      throw new Error(`Duration-hint registry contains duplicate key ${entry.workspace} ${entry.script}.`);
    }
    seenKeys.add(key);

    const workspace = workspaceByName.get(entry.workspace);
    if (!workspace) {
      throw new Error(`Duration-hint registry references nonexistent workspace ${entry.workspace}.`);
    }
    if (typeof workspace.packageJson.scripts?.[entry.script] !== "string") {
      throw new Error(`Duration-hint registry references absent script ${entry.script} in ${entry.workspace}.`);
    }
    if (!isWorkspaceEligibleForDurationHint(workspace, entry.script)) {
      throw new Error(`Duration-hint registry entry ${entry.workspace} ${entry.script} is obsolete.`);
    }
  }

  return registry;
}

export function validateWorkspaceDurationReplay(fixture, registry) {
  assertExactKeys(fixture, ["schemaVersion", "observations"], "Workspace-duration replay fixture");
  if (fixture.schemaVersion !== "workspace-unit-duration-replay/v1") {
    throw new Error("Workspace-duration replay fixture schemaVersion must be workspace-unit-duration-replay/v1.");
  }
  if (!Array.isArray(fixture.observations) || fixture.observations.length < 1 || fixture.observations.length > 128) {
    throw new Error("Workspace-duration replay fixture observations must contain 1 through 128 items.");
  }

  const registeredKeys = registry
    ? new Set(registry.entries.map((entry) => `${entry.workspace}\0${entry.script}`))
    : undefined;
  const seenObservations = new Set();

  for (const [index, observation] of fixture.observations.entries()) {
    const label = `Workspace-duration replay fixture observations[${index}]`;
    assertExactKeys(
      observation,
      ["runId", "runAttempt", "jobId", "invocation", "workspace", "script", "observedDurationMs"],
      label,
    );
    assertBoundedInteger(observation.runId, 1, Number.MAX_SAFE_INTEGER, `${label}.runId`);
    assertBoundedInteger(observation.runAttempt, 1, 100, `${label}.runAttempt`);
    assertBoundedInteger(observation.jobId, 1, Number.MAX_SAFE_INTEGER, `${label}.jobId`);
    if (typeof observation.invocation !== "string" || !durationInvocations.has(observation.invocation)) {
      throw new Error(`${label}.invocation is invalid.`);
    }
    assertWorkspaceIdentity(observation.workspace, `${label}.workspace`);
    assertDurationHintScript(observation.script, `${label}.script`);
    assertBoundedInteger(observation.observedDurationMs, 0, 600_000, `${label}.observedDurationMs`);
    if (durationInvocations.get(observation.invocation) !== observation.script) {
      throw new Error(`${label}.invocation does not match its script.`);
    }

    const registeredKey = `${observation.workspace}\0${observation.script}`;
    if (registeredKeys && !registeredKeys.has(registeredKey)) {
      throw new Error(`${label} references an unregistered workspace and script.`);
    }

    const observationKey = [
      observation.runId,
      observation.runAttempt,
      observation.jobId,
      observation.invocation,
      observation.workspace,
      observation.script,
    ].join("\0");
    if (seenObservations.has(observationKey)) {
      throw new Error(`${label} duplicates an earlier observation.`);
    }
    seenObservations.add(observationKey);
  }

  return fixture;
}

export function validateRunWorkspacesSummary(summary) {
  assertExactKeys(summary, summaryRootKeys, "Run-workspaces summary", { ordered: true });
  if (summary.schemaVersion !== "run-workspaces-summary/v1") {
    throw new Error("Run-workspaces summary schemaVersion must be run-workspaces-summary/v1.");
  }
  assertDurationHintScript(summary.scriptName, "Run-workspaces summary scriptName");
  assertBoundedInteger(summary.concurrency, 1, 64, "Run-workspaces summary concurrency");
  for (const field of ["eligibleCount", "completedCount", "passedCount", "failedCount"]) {
    assertBoundedInteger(summary[field], 0, 256, `Run-workspaces summary ${field}`);
  }
  assertBoundedInteger(summary.elapsedMs, 0, 86_400_000, "Run-workspaces summary elapsedMs");
  if (
    summary.completedCount !== summary.passedCount + summary.failedCount ||
    summary.completedCount !== summary.eligibleCount
  ) {
    throw new Error("Run-workspaces summary counts must describe all eligible settled tasks.");
  }
  if (!Array.isArray(summary.unhintedTasks) || summary.unhintedTasks.length > summary.eligibleCount) {
    throw new Error("Run-workspaces summary unhintedTasks is invalid.");
  }
  if (!Array.isArray(summary.tasks) || summary.tasks.length !== summary.completedCount) {
    throw new Error("Run-workspaces summary tasks must contain every completed task.");
  }

  for (const [index, task] of summary.unhintedTasks.entries()) {
    const label = `Run-workspaces summary unhintedTasks[${index}]`;
    assertExactKeys(task, ["workspace", "script"], label, { ordered: true });
    assertWorkspaceIdentity(task.workspace, `${label}.workspace`);
    assertDurationHintScript(task.script, `${label}.script`);
  }

  for (const [index, task] of summary.tasks.entries()) {
    const label = `Run-workspaces summary tasks[${index}]`;
    assertExactKeys(
      task,
      ["workspace", "script", "estimatedDurationSeconds", "usedFallback", "actualDurationMs", "outcome"],
      label,
      { ordered: true },
    );
    assertWorkspaceIdentity(task.workspace, `${label}.workspace`);
    assertDurationHintScript(task.script, `${label}.script`);
    if (task.script !== summary.scriptName) {
      throw new Error(`${label}.script must match the summary scriptName.`);
    }
    assertBoundedInteger(task.estimatedDurationSeconds, 1, 3600, `${label}.estimatedDurationSeconds`);
    if (typeof task.usedFallback !== "boolean") {
      throw new Error(`${label}.usedFallback must be a boolean.`);
    }
    assertBoundedInteger(task.actualDurationMs, 0, 600_000, `${label}.actualDurationMs`);
    if (task.outcome !== "passed" && task.outcome !== "failed") {
      throw new Error(`${label}.outcome must be passed or failed.`);
    }
  }

  const fallbackTasks = summary.tasks
    .filter((task) => task.usedFallback)
    .map((task) => ({ workspace: task.workspace, script: task.script }));
  if (JSON.stringify(fallbackTasks) !== JSON.stringify(summary.unhintedTasks)) {
    throw new Error("Run-workspaces summary unhintedTasks must match fallback tasks in dispatch order.");
  }
  if (summary.passedCount !== summary.tasks.filter((task) => task.outcome === "passed").length) {
    throw new Error("Run-workspaces summary passedCount does not match task outcomes.");
  }
  if (summary.failedCount !== summary.tasks.filter((task) => task.outcome === "failed").length) {
    throw new Error("Run-workspaces summary failedCount does not match task outcomes.");
  }

  return summary;
}

export function loadTestEnvironment({
  env = process.env,
  envRootDir = rootDir,
  includeTestDatabaseUrl = true,
  inheritedKeys = inheritedEnvKeys,
  syncEnvFiles = syncLocalEnvFiles,
  ensureSandboxEnvironment = ensureWorktreeSandboxEnvironment,
} = {}) {
  syncEnvFiles({ command: "sync" });

  for (const fileName of testEnvFiles) {
    const values = readEnvFile(path.join(envRootDir, fileName));

    for (const [key, value] of Object.entries(values)) {
      if (key === "TEST_DATABASE_URL" && !includeTestDatabaseUrl && !inheritedKeys.has(key)) {
        continue;
      }

      if (!inheritedKeys.has(key)) {
        env[key] = value;
      }
    }
  }

  const { env: sandboxEnv } = ensureSandboxEnvironment({ rootDir: envRootDir, env });
  for (const [key, value] of Object.entries(sandboxEnv)) {
    if (key === "TEST_DATABASE_URL" && !includeTestDatabaseUrl && !inheritedKeys.has(key)) {
      continue;
    }

    if (!inheritedKeys.has(key)) {
      env[key] = value;
    }
  }
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

export function parseRunWorkspacesArgs(argv) {
  const [scriptName, ...rawArgs] = argv;

  if (!scriptName) {
    throw new Error(
      "Usage: node ./scripts/run-workspaces.mjs <script-name> [--concurrency=N] [--command-timeout-ms=N] [-- ...args]",
    );
  }

  const passthroughSeparatorIndex = rawArgs.indexOf("--");
  const runnerArgs = passthroughSeparatorIndex === -1 ? rawArgs : rawArgs.slice(0, passthroughSeparatorIndex);
  const passthroughArgs = passthroughSeparatorIndex === -1 ? [] : rawArgs.slice(passthroughSeparatorIndex + 1);

  const concurrencyArg = runnerArgs.find((arg) => arg.startsWith("--concurrency="));
  const concurrency = concurrencyArg ? parsePositiveInteger(concurrencyArg.split("=")[1] ?? "", "--concurrency") : 1;
  const commandTimeoutArg = runnerArgs.find((arg) => arg.startsWith("--command-timeout-ms="));
  const commandTimeoutMs = commandTimeoutArg
    ? parsePositiveInteger(commandTimeoutArg.split("=")[1] ?? "", "--command-timeout-ms")
    : undefined;
  const includeTestProfile = runnerArgs.find((arg) => arg.startsWith("--test-profile="))?.split("=")[1];
  const excludeTestProfile = runnerArgs.find((arg) => arg.startsWith("--exclude-test-profile="))?.split("=")[1];
  const workspaceNames = new Set(
    runnerArgs
      .filter((arg) => arg.startsWith("--workspace="))
      .map((arg) => arg.slice("--workspace=".length))
      .concat(
        runnerArgs
          .find((arg) => arg.startsWith("--workspace-list="))
          ?.slice("--workspace-list=".length)
          .split(",") ?? [],
      )
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return {
    scriptName,
    passthroughArgs,
    includeTestProfile,
    excludeTestProfile,
    workspaceNames,
    concurrency,
    commandTimeoutMs,
  };
}

function defaultCommandTimeoutMs(scriptName) {
  return scriptName.startsWith("test") ? DEFAULT_TEST_COMMAND_TIMEOUT_MS : undefined;
}

function isDurationScheduledInvocation(options) {
  return (
    (options.scriptName === "test" &&
      options.excludeTestProfile === "db" &&
      options.includeTestProfile === undefined) ||
    (options.scriptName === "test:unit" &&
      options.includeTestProfile === "db" &&
      options.excludeTestProfile === undefined)
  );
}

function filterWorkspaces(workspaces, options) {
  const { scriptName, includeTestProfile, excludeTestProfile, workspaceNames } = options;

  return workspaces.filter((workspace) => {
    if (workspaceNames?.size > 0 && !workspaceNames.has(workspace.name)) {
      return false;
    }

    if (workspaceScriptNames(workspace, scriptName).length === 0) {
      return false;
    }

    const testProfile = workspace.packageJson.chaseSets?.testProfile;
    if (includeTestProfile && testProfile !== includeTestProfile) {
      return false;
    }

    if (excludeTestProfile && testProfile === excludeTestProfile) {
      return false;
    }

    return true;
  });
}

function workspaceScriptNames(workspace, scriptName) {
  const scripts = workspace.packageJson.scripts ?? {};
  if (scriptName !== DB_TEST_SCRIPT_SELECTOR) {
    return typeof scripts[scriptName] === "string" ? [scriptName] : [];
  }

  const partitionScripts = Object.keys(scripts)
    .filter((name) => name.startsWith("test:db:") && typeof scripts[name] === "string")
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  if (partitionScripts.length > 0) {
    return partitionScripts;
  }
  return typeof scripts["test:db"] === "string" ? ["test:db"] : [];
}

async function runWorkspace(workspace, options) {
  const { buildInvocation, commandTimeoutMs, passthroughArgs, run, scriptName, usePrefixedLogs } = options;

  console.log(`Running ${scriptName} in ${workspace.name}...`);
  const invocation = buildInvocation(["--filter", workspace.name, "run", scriptName, ...passthroughArgs]);
  await run(invocation.command, invocation.args, {
    ...(usePrefixedLogs ? { prefix: workspace.name } : { stdio: "inherit" }),
    ...(commandTimeoutMs ? { timeoutMs: commandTimeoutMs } : {}),
  });
}

async function runConcurrent(tasks, options) {
  const failures = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex];
      nextIndex += 1;
      const workspace = task.workspace;
      const startedAt = options.now();
      const taskResult = options.taskResults
        ? {
            workspace: workspace.name,
            script: options.scriptName,
            estimatedDurationSeconds: task.estimatedDurationSeconds,
            usedFallback: task.usedFallback,
            actualDurationMs: 0,
            outcome: "passed",
          }
        : undefined;
      if (taskResult) {
        options.taskResults.push(taskResult);
      }

      try {
        for (const scriptName of task.scriptNames ?? [options.scriptName]) {
          await runWorkspace(workspace, { ...options, scriptName });
        }
      } catch (error) {
        if (taskResult) {
          taskResult.outcome = "failed";
        }
        failures.push({
          workspace,
          error,
        });
      } finally {
        if (taskResult) {
          taskResult.actualDurationMs = Math.min(600_000, Math.max(0, options.now() - startedAt));
        }
      }
    }
  }

  const workerCount = Math.min(options.concurrency, tasks.length);
  if (workerCount === 0) {
    console.log(`No workspaces matched ${options.scriptName}.`);
    return;
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (failures.length > 0) {
    const failedNames = failures.map((failure) => failure.workspace.name).join(", ");
    console.error(`Failed workspaces: ${failedNames}`);
    for (const failure of failures) {
      console.error(
        `[${failure.workspace.name}] ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
      );
    }
    throw new Error(`${failures.length} workspace script run(s) failed.`);
  }
}

function scheduleEligibleWorkspaces(workspaces, registry, scriptName) {
  const hints = new Map(
    registry.entries.map((entry) => [`${entry.workspace}\0${entry.script}`, entry.estimatedDurationSeconds]),
  );
  const fallbackDuration = Math.max(...registry.entries.map((entry) => entry.estimatedDurationSeconds));

  return workspaces
    .map((workspace) => {
      const estimatedDurationSeconds = hints.get(`${workspace.name}\0${scriptName}`);
      return {
        workspace,
        estimatedDurationSeconds: estimatedDurationSeconds ?? fallbackDuration,
        usedFallback: estimatedDurationSeconds === undefined,
      };
    })
    .sort(
      (left, right) =>
        Number(right.usedFallback) - Number(left.usedFallback) ||
        right.estimatedDurationSeconds - left.estimatedDurationSeconds ||
        (left.workspace.name < right.workspace.name ? -1 : left.workspace.name > right.workspace.name ? 1 : 0),
    );
}

function buildRunWorkspacesSummary({ concurrency, elapsedMs, scriptName, taskResults, unhintedTasks }) {
  const passedCount = taskResults.filter((task) => task.outcome === "passed").length;
  const failedCount = taskResults.length - passedCount;

  return {
    schemaVersion: "run-workspaces-summary/v1",
    scriptName,
    concurrency,
    eligibleCount: taskResults.length,
    completedCount: taskResults.length,
    passedCount,
    failedCount,
    elapsedMs: Math.min(86_400_000, Math.max(0, elapsedMs)),
    unhintedTasks,
    tasks: taskResults,
  };
}

function renderRunWorkspacesSummaryMarkdown(summary) {
  const lines = [
    `Run workspaces summary (${summary.schemaVersion}): script \`${summary.scriptName}\`, concurrency ${summary.concurrency}, elapsed ${summary.elapsedMs}ms, ${summary.passedCount} passed, ${summary.failedCount} failed.`,
    "",
    "| Workspace | Script | Estimated seconds | Fallback | Actual ms | Outcome |",
    "| --- | --- | ---: | :---: | ---: | --- |",
  ];

  if (summary.tasks.length === 0) {
    lines.push("| _No eligible workspaces_ | — | — | — | — | — |");
  } else {
    for (const task of summary.tasks) {
      lines.push(
        `| ${task.workspace} | ${task.script} | ${task.estimatedDurationSeconds} | ${task.usedFallback ? "yes" : "no"} | ${task.actualDurationMs} | ${task.outcome} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function runWorkspaceScripts(options) {
  const {
    appendSummary = appendFileSync,
    argv,
    buildInvocation = buildPackageManagerInvocation,
    durationHintRegistry,
    env = process.env,
    listWorkspaces = listWorkspacePackages,
    loadEnvironment = loadTestEnvironment,
    now = Date.now,
    run = runCommand,
  } = options;
  const parsed = parseRunWorkspacesArgs(argv);

  if (parsed.scriptName.startsWith("test")) {
    const includeTestDatabaseUrl =
      parsed.scriptName === "test:db" ||
      parsed.scriptName === DB_TEST_SCRIPT_SELECTOR ||
      (parsed.scriptName === "test" && parsed.excludeTestProfile !== "db");
    loadEnvironment({
      includeTestDatabaseUrl,
    });
  }

  const allWorkspaces = listWorkspaces();
  const durationScheduled = isDurationScheduledInvocation(parsed);
  const registry = durationScheduled
    ? validateDurationHintRegistry(
        durationHintRegistry ?? JSON.parse(readFileSync(durationHintRegistryUrl, "utf8")),
        allWorkspaces,
      )
    : undefined;
  const workspaces = filterWorkspaces(allWorkspaces, parsed);
  const tasks = durationScheduled
    ? scheduleEligibleWorkspaces(workspaces, registry, parsed.scriptName)
    : workspaces.map((workspace) => ({
        workspace,
        scriptNames: workspaceScriptNames(workspace, parsed.scriptName),
      }));

  if (durationScheduled && (parsed.concurrency > 64 || tasks.length > 256)) {
    throw new Error("Duration-scheduled invocations require concurrency at most 64 and at most 256 eligible tasks.");
  }

  const unhintedTasks = durationScheduled
    ? tasks
        .filter((task) => task.usedFallback)
        .map((task) => ({ workspace: task.workspace.name, script: parsed.scriptName }))
    : [];
  if (unhintedTasks.length > 0) {
    console.error(
      `Warning: missing duration hints for ${unhintedTasks.map((task) => task.workspace).join(", ")}; using the largest registered duration as fallback.`,
    );
  }

  const taskResults = [];
  const startedAt = now();
  try {
    await runConcurrent(tasks, {
      ...parsed,
      buildInvocation,
      commandTimeoutMs: parsed.commandTimeoutMs ?? defaultCommandTimeoutMs(parsed.scriptName),
      now,
      run,
      taskResults: durationScheduled ? taskResults : undefined,
      usePrefixedLogs: parsed.concurrency > 1,
    });
  } finally {
    if (durationScheduled) {
      const summary = buildRunWorkspacesSummary({
        concurrency: parsed.concurrency,
        elapsedMs: now() - startedAt,
        scriptName: parsed.scriptName,
        taskResults,
        unhintedTasks,
      });
      validateRunWorkspacesSummary(summary);
      console.log(`RUN_WORKSPACES_SUMMARY ${JSON.stringify(summary)}`);
      if (typeof env.GITHUB_STEP_SUMMARY === "string" && env.GITHUB_STEP_SUMMARY.length > 0) {
        appendSummary(env.GITHUB_STEP_SUMMARY, renderRunWorkspacesSummaryMarkdown(summary), "utf8");
      }
    }
  }
}

async function main() {
  const scriptName = process.argv[2];
  if (scriptName === "build") acquireHeavySlot("build");
  else if (scriptName === "test" || scriptName === "test:unit" || scriptName?.startsWith("test:db")) {
    acquireHeavySlot("script-battery");
  }
  await runWorkspaceScripts({ argv: process.argv.slice(2) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
