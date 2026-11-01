import process from "node:process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { readEnvFile } from "./lib/env.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { listWorkspacePackages } from "./lib/repo.mjs";
import { ensureWorktreeSandboxEnvironment } from "./lib/sandbox.mjs";
import { syncLocalEnvFiles } from "./local-env.mjs";
import { driftBound, validateDbDurationBaseline } from "./check-structure/db-duration-baseline.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const inheritedEnvKeys = new Set(Object.keys(process.env));
const testEnvFiles = [".env", ".env.local", ".env.test", ".env.test.local"];
const durationHintRegistryUrl = new URL("./workspace-test-duration-hints-v1.json", import.meta.url);
const workspacePattern = /^@chase-sets\/[a-z0-9-]+$/;
const durationHintScripts = new Set(["test", "test:unit", "test:db"]);
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
const ansiEscapePattern = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const vitestFileResultPattern = /(?:✓|×|✗)\s+(.+?\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+\(\d+ tests?\))?\s+(\d+)ms\s*$/;
export const DEFAULT_TEST_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
export const DB_TEST_SCRIPT_SELECTOR = "test:db*";

export function parseVitestFileAttribution(line) {
  if (typeof line !== "string") return undefined;
  const clean = line.replace(ansiEscapePattern, "").trim();
  const match = vitestFileResultPattern.exec(clean);
  if (!match) return undefined;
  return {
    file: match[1],
    actualDurationMs: Number(match[2]),
    outcome: /(?:×|✗)/.test(clean) ? "failed" : "passed",
  };
}

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
    throw new Error(`${label} must be test, test:unit or test:db.`);
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
  const provenanceEntries = registry.entries.filter((entry) => Object.hasOwn(entry, "sources"));

  for (const [index, entry] of registry.entries.entries()) {
    const label = `Duration-hint registry entries[${index}]`;
    const entryKeys = ["workspace", "script", "estimatedDurationSeconds"];
    if (Object.hasOwn(entry, "sources")) entryKeys.push("sources");
    assertExactKeys(entry, entryKeys, label);
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
    if (entry.sources !== undefined) {
      if (entry.script !== "test:db" || entry.sources.length !== 5) {
        throw new Error(`${label}.sources must contain exactly five hosted observations for test:db.`);
      }
      const sourceDurations = [];
      for (const [sourceIndex, source] of entry.sources.entries()) {
        const sourceLabel = `${label}.sources[${sourceIndex}]`;
        assertExactKeys(source, ["runId", "jobId", "headSha", "logPath", "durationMs"], sourceLabel, { ordered: true });
        assertBoundedInteger(source.runId, 1, Number.MAX_SAFE_INTEGER, `${sourceLabel}.runId`);
        assertBoundedInteger(source.jobId, 1, Number.MAX_SAFE_INTEGER, `${sourceLabel}.jobId`);
        if (typeof source.headSha !== "string" || !/^[a-f0-9]{40}$/.test(source.headSha)) {
          throw new Error(`${sourceLabel}.headSha must be a lowercase commit SHA.`);
        }
        if (typeof source.logPath !== "string" || !source.logPath.includes("10766-impl-g1.hosted-")) {
          throw new Error(`${sourceLabel}.logPath must identify a hosted lane capture.`);
        }
        assertBoundedInteger(source.durationMs, 1, 86_400_000, `${sourceLabel}.durationMs`);
        sourceDurations.push(source.durationMs);
      }
      const middle = sourceDurations.toSorted((left, right) => left - right)[2];
      if (entry.estimatedDurationSeconds !== Math.ceil(middle / 1000)) {
        throw new Error(`${label}.estimatedDurationSeconds is not derived from its hosted observations.`);
      }
    }
  }

  if (
    provenanceEntries.length > 0 &&
    provenanceEntries.length !== registry.entries.filter((entry) => entry.script === "test:db").length
  ) {
    throw new Error("Every test:db duration hint must carry hosted provenance.");
  }

  return registry;
}

export function validateWorkspaceDurationReplay(fixture, registry) {
  const fixtureKeys = ["schemaVersion", "observations"];
  if (Object.hasOwn(fixture, "hostedCaptures")) fixtureKeys.push("hostedCaptures");
  assertExactKeys(fixture, fixtureKeys, "Workspace-duration replay fixture");
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
    if (observation.script !== "test" && observation.script !== "test:unit") {
      throw new Error(`${label}.script must be test or test:unit.`);
    }
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

  if (fixture.hostedCaptures !== undefined) {
    if (!Array.isArray(fixture.hostedCaptures) || fixture.hostedCaptures.length !== 5) {
      throw new Error("Workspace-duration replay fixture hostedCaptures must contain exactly five captures.");
    }
    const captureKeys = new Set();
    for (const [index, capture] of fixture.hostedCaptures.entries()) {
      const label = `Workspace-duration replay fixture hostedCaptures[${index}]`;
      assertExactKeys(
        capture,
        ["runId", "runAttempt", "jobId", "event", "headSha", "conclusion", "logPath", "workspaceDurations", "api"],
        label,
        { ordered: true },
      );
      assertBoundedInteger(capture.runId, 1, Number.MAX_SAFE_INTEGER, `${label}.runId`);
      assertBoundedInteger(capture.runAttempt, 1, 100, `${label}.runAttempt`);
      assertBoundedInteger(capture.jobId, 1, Number.MAX_SAFE_INTEGER, `${label}.jobId`);
      if (capture.event !== "merge_group" || capture.conclusion !== "success")
        throw new Error(`${label} is not eligible.`);
      if (!/^[a-f0-9]{40}$/.test(capture.headSha)) throw new Error(`${label}.headSha is invalid.`);
      if (typeof capture.logPath !== "string" || !capture.logPath.includes("10766-impl-g1.hosted-")) {
        throw new Error(`${label}.logPath is not a hosted lane capture.`);
      }
      const identity = `${capture.runId}\0${capture.jobId}`;
      if (captureKeys.has(identity)) throw new Error(`${label} duplicates an earlier capture.`);
      captureKeys.add(identity);
      if (!isPlainObject(capture.workspaceDurations) || Object.keys(capture.workspaceDurations).length !== 24) {
        throw new Error(`${label}.workspaceDurations must contain the full 24-workspace other census.`);
      }
      for (const [workspace, durationMs] of Object.entries(capture.workspaceDurations)) {
        assertWorkspaceIdentity(workspace, `${label}.workspaceDurations.${workspace}`);
        assertBoundedInteger(durationMs, 1, 86_400_000, `${label}.workspaceDurations.${workspace}`);
      }
      assertExactKeys(capture.api, ["jobId", "logPath", "durationMs"], `${label}.api`, { ordered: true });
      assertBoundedInteger(capture.api.jobId, 1, Number.MAX_SAFE_INTEGER, `${label}.api.jobId`);
      if (typeof capture.api.logPath !== "string" || !capture.api.logPath.includes("10766-impl-g1.hosted-")) {
        throw new Error(`${label}.api.logPath is not a hosted lane capture.`);
      }
      assertBoundedInteger(capture.api.durationMs, 1, 86_400_000, `${label}.api.durationMs`);
    }
    if (registry) {
      for (const entry of registry.entries.filter((candidate) => candidate.script === "test:db" && candidate.sources)) {
        for (const source of entry.sources) {
          const capture = fixture.hostedCaptures.find((candidate) => candidate.runId === source.runId);
          const expected =
            entry.workspace === "@chase-sets/app-platform-api"
              ? capture?.api
              : capture && {
                  jobId: capture.jobId,
                  logPath: capture.logPath,
                  durationMs: capture.workspaceDurations[entry.workspace],
                };
          if (
            !capture ||
            !expected ||
            source.jobId !== expected.jobId ||
            source.logPath !== expected.logPath ||
            source.durationMs !== expected.durationMs
          ) {
            throw new Error(`Hosted provenance does not derive ${entry.workspace} from a checked-in capture.`);
          }
        }
      }
    }
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
    const taskKeys = ["workspace", "script", "estimatedDurationSeconds", "usedFallback", "actualDurationMs", "outcome"];
    if (Object.hasOwn(task, "fileAttributions")) taskKeys.push("fileAttributions");
    assertExactKeys(task, taskKeys, label, { ordered: true });
    assertWorkspaceIdentity(task.workspace, `${label}.workspace`);
    assertDurationHintScript(task.script, `${label}.script`);
    if (task.script !== summary.scriptName) {
      throw new Error(`${label}.script must match the summary scriptName.`);
    }
    assertBoundedInteger(task.estimatedDurationSeconds, 1, 3600, `${label}.estimatedDurationSeconds`);
    if (typeof task.usedFallback !== "boolean") {
      throw new Error(`${label}.usedFallback must be a boolean.`);
    }
    assertBoundedInteger(task.actualDurationMs, 0, 3_600_000, `${label}.actualDurationMs`);
    if (task.outcome !== "passed" && task.outcome !== "failed") {
      throw new Error(`${label}.outcome must be passed or failed.`);
    }
    if (task.fileAttributions !== undefined) {
      if (!Array.isArray(task.fileAttributions)) throw new Error(`${label}.fileAttributions must be an array.`);
      const seenFiles = new Set();
      for (const [fileIndex, attribution] of task.fileAttributions.entries()) {
        const fileLabel = `${label}.fileAttributions[${fileIndex}]`;
        assertExactKeys(attribution, ["file", "actualDurationMs", "outcome"], fileLabel, { ordered: true });
        if (typeof attribution.file !== "string" || attribution.file.length < 1 || attribution.file.length > 512) {
          throw new Error(`${fileLabel}.file is invalid.`);
        }
        assertBoundedInteger(attribution.actualDurationMs, 0, 3_600_000, `${fileLabel}.actualDurationMs`);
        if (attribution.outcome !== "passed" && attribution.outcome !== "failed") {
          throw new Error(`${fileLabel}.outcome must be passed or failed.`);
        }
        if (seenFiles.has(attribution.file)) throw new Error(`${fileLabel}.file is duplicated.`);
        seenFiles.add(attribution.file);
      }
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

function parseShardSpec(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new Error("--shard must use the form k/n.");

  const index = parsePositiveInteger(match[1], "--shard index");
  const total = parsePositiveInteger(match[2], "--shard count");
  if (total > 8) throw new Error("--shard count must be at most 8.");
  if (index > total) throw new Error("--shard index must not exceed the shard count.");

  return { index, total };
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
  const shardArgs = runnerArgs.filter((arg) => arg === "--shard" || arg.startsWith("--shard="));
  if (shardArgs.length > 1) throw new Error("--shard may be provided only once.");
  const shard = shardArgs.length === 1 ? parseShardSpec(shardArgs[0].slice("--shard=".length)) : undefined;
  const includeTestProfile = runnerArgs.find((arg) => arg.startsWith("--test-profile="))?.split("=")[1];
  const excludeTestProfile = runnerArgs.find((arg) => arg.startsWith("--exclude-test-profile="))?.split("=")[1];
  const groupArgs = runnerArgs.filter(
    (arg) => arg === "--db-workspace-group" || arg.startsWith("--db-workspace-group="),
  );
  const dbWorkspaceGroup = groupArgs[0]?.slice("--db-workspace-group=".length);
  if (
    groupArgs.length > 1 ||
    (groupArgs.length === 1 && (scriptName !== DB_TEST_SCRIPT_SELECTOR || !["api", "other"].includes(dbWorkspaceGroup)))
  ) {
    throw new Error("--db-workspace-group requires exactly one api|other value with test:db*.");
  }
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
    ...(dbWorkspaceGroup === undefined ? {} : { dbWorkspaceGroup }),
    workspaceNames,
    concurrency,
    commandTimeoutMs,
    ...(shard === undefined ? {} : { shard }),
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
      options.excludeTestProfile === undefined) ||
    (options.scriptName === DB_TEST_SCRIPT_SELECTOR &&
      options.includeTestProfile === undefined &&
      options.excludeTestProfile === undefined)
  );
}

function isShardableDurationScheduledInvocation(options) {
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

    // Intersect the eligible set, never turn an empty group into all workspaces.
    return (
      options.dbWorkspaceGroup === undefined ||
      (workspace.name === "@chase-sets/app-platform-api") === (options.dbWorkspaceGroup === "api")
    );
  });
}

export function workspaceScriptNames(workspace, scriptName) {
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
  const measured = options.dbWorkspaceGroup === "api";
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let outcome = "failed";
  if (measured)
    console.log(
      `RUN_WORKSPACES_COMMAND_START ${JSON.stringify({ workspace: workspace.name, script: scriptName, startedAt })}`,
    );
  try {
    await run(invocation.command, invocation.args, {
      ...(options.collectFileAttributions
        ? {
            prefix: usePrefixedLogs ? workspace.name : undefined,
            stderrToStderr: true,
            onStdoutLine: options.onLine,
            onStderrLine: options.onLine,
          }
        : usePrefixedLogs
          ? { prefix: workspace.name }
          : { stdio: "inherit" }),
      ...(commandTimeoutMs ? { timeoutMs: commandTimeoutMs } : {}),
    });
    outcome = "passed";
  } finally {
    if (measured)
      console.log(
        `RUN_WORKSPACES_COMMAND_END ${JSON.stringify({
          workspace: workspace.name,
          script: scriptName,
          startedAt,
          completedAt: new Date().toISOString(),
          elapsedMs: Math.ceil(performance.now() - started),
          outcome,
        })}`,
      );
  }
}

async function runConcurrent(tasks, options) {
  const failures = [];
  const pending = tasks.slice();
  const waitingWorkers = new Set();
  let seedOrApiDbActive = false;

  function needsSeedApiExclusion(task) {
    return (
      (task.workspace.name === "@chase-sets/marketplace-seed-testing" ||
        task.workspace.name === "@chase-sets/app-platform-api") &&
      (task.scriptNames ?? [options.scriptName]).some((script) => script === "test:db" || script.startsWith("test:db:"))
    );
  }

  async function worker() {
    while (pending.length > 0) {
      // Preserve priority among runnable tasks without letting the contending
      // seed/API pair occupy both DB slots. Unrelated tasks can pass the waiter.
      const nextIndex = pending.findIndex((task) => !seedOrApiDbActive || !needsSeedApiExclusion(task));
      if (nextIndex === -1) {
        await new Promise((resolve) => waitingWorkers.add(resolve));
        continue;
      }
      const [task] = pending.splice(nextIndex, 1);
      const excludesSeedApi = needsSeedApiExclusion(task);
      if (excludesSeedApi) seedOrApiDbActive = true;
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
          await runWorkspace(workspace, {
            ...options,
            onLine: (line) => {
              const attribution = parseVitestFileAttribution(line);
              if (attribution && taskResult) {
                taskResult.fileAttributions ??= [];
                taskResult.fileAttributions.push(attribution);
              }
            },
            scriptName,
          });
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
          taskResult.actualDurationMs = Math.min(3_600_000, Math.max(0, options.now() - startedAt));
        }
        // Hold admission across every partition, releasing it on failure too.
        if (excludesSeedApi) seedOrApiDbActive = false;
        for (const wake of waitingWorkers) wake();
        waitingWorkers.clear();
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

function selectShardTasks(tasks, shard) {
  const loads = Array.from({ length: shard.total }, () => 0);
  const partitions = Array.from({ length: shard.total }, () => []);

  for (const task of tasks) {
    let target = 0;
    for (let index = 1; index < loads.length; index += 1) {
      if (loads[index] < loads[target]) target = index;
    }
    partitions[target].push(task);
    loads[target] += task.estimatedDurationSeconds;
  }

  return partitions[shard.index - 1];
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
      if (task.fileAttributions?.length) {
        lines.push(`| ↳ ${task.workspace} file attribution | — | — | — | — | — |`);
        for (const attribution of task.fileAttributions) {
          lines.push(
            `| ↳ ${attribution.file} | ${task.script} | — | — | ${attribution.actualDurationMs} | ${attribution.outcome} |`,
          );
        }
      }
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
    readDbBaseline = () => JSON.parse(readFileSync(new URL("./db-duration-baseline-v1.json", import.meta.url), "utf8")),
  } = options;
  const parsed = parseRunWorkspacesArgs(argv);

  if (parsed.shard !== undefined && !isShardableDurationScheduledInvocation(parsed)) {
    throw new Error("--shard is supported only for test --exclude-test-profile=db or test:unit --test-profile=db.");
  }

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
  const summaryScriptName = parsed.scriptName === DB_TEST_SCRIPT_SELECTOR ? "test:db" : parsed.scriptName;
  const dbExecution = summaryScriptName === "test:db" || summaryScriptName.startsWith("test:db:");
  const registry = durationScheduled
    ? validateDurationHintRegistry(
        durationHintRegistry ?? JSON.parse(readFileSync(durationHintRegistryUrl, "utf8")),
        allWorkspaces,
      )
    : undefined;
  const workspaces = filterWorkspaces(allWorkspaces, parsed);
  const scheduledTasks = durationScheduled
    ? scheduleEligibleWorkspaces(workspaces, registry, summaryScriptName).map((task) => ({
        ...task,
        scriptNames: workspaceScriptNames(task.workspace, parsed.scriptName),
      }))
    : workspaces.map((workspace) => ({
        workspace,
        scriptNames: workspaceScriptNames(workspace, parsed.scriptName),
      }));
  const tasks = parsed.shard === undefined ? scheduledTasks : selectShardTasks(scheduledTasks, parsed.shard);

  if (durationScheduled && (parsed.concurrency > 64 || tasks.length > 256)) {
    throw new Error("Duration-scheduled invocations require concurrency at most 64 and at most 256 eligible tasks.");
  }

  const unhintedTasks = durationScheduled
    ? tasks
        .filter((task) => task.usedFallback)
        .map((task) => ({ workspace: task.workspace.name, script: summaryScriptName }))
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
      scriptName: durationScheduled ? summaryScriptName : parsed.scriptName,
      buildInvocation,
      commandTimeoutMs: parsed.commandTimeoutMs ?? defaultCommandTimeoutMs(parsed.scriptName),
      now,
      run,
      taskResults: durationScheduled || dbExecution ? taskResults : undefined,
      collectFileAttributions: dbExecution && run === runCommand,
      usePrefixedLogs: parsed.concurrency > 1,
    });
  } finally {
    if (dbExecution) annotateDbDurationDrift({ tasks: taskResults }, readDbBaseline);
    if (durationScheduled) {
      const summary = buildRunWorkspacesSummary({
        concurrency: parsed.concurrency,
        elapsedMs: now() - startedAt,
        scriptName: summaryScriptName,
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

function annotateDbDurationDrift(summary, readBaseline) {
  try {
    const baseline = validateDbDurationBaseline(readBaseline()).recomputes.at(-1);
    const unbaselined = [];
    for (const task of summary.tasks) {
      const ratified = baseline?.workspaces[task.workspace];
      if (ratified === undefined) unbaselined.push(task.workspace);
      else if (task.actualDurationMs > driftBound(ratified)) {
        console.log(
          `::warning title=DB duration drift::${task.workspace} test:db ${task.actualDurationMs} ms > drift bound ${driftBound(ratified)} ms (ratified ${ratified} ms)`,
        );
      }
    }
    if (unbaselined.length) console.log(`DB duration drift: unbaselined: ${unbaselined.join(", ")}`);
  } catch (error) {
    console.error(`DB duration drift: unknown baseline: ${error.message}`);
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
