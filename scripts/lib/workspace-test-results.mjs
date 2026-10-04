import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WORKSPACE_TEST_RESULTS_VERSION = "workspace-test-results/v1";
export const WORKSPACE_TEST_RESULTS_FILE = "workspace-test-results.json";
export const MAX_TEST_RESULTS_BYTES = 32 * 1024 * 1024;
const states = new Set(["passed", "failed", "skipped", "pending", "todo", "disabled"]);
const rootDir = fileURLToPath(new URL("../../", import.meta.url));

// CHASE_SETS_TEST_RESULTS_DIR enables runner collection. The runner alone assigns
// CHASE_SETS_VITEST_JSON_FILE, an absolute, invocation/workspace/script-unique path.
// CI=true is not a gate. The scripts factory supports the same child gate, but
// the hosted static/script battery intentionally does not enable collection.
export function resolveVitestResultsProfile(env = process.env) {
  if (!env.CHASE_SETS_TEST_RESULTS_DIR) return {};
  if (!env.CHASE_SETS_VITEST_JSON_FILE || !path.isAbsolute(env.CHASE_SETS_VITEST_JSON_FILE)) {
    throw new Error("Enabled test results require an absolute CHASE_SETS_VITEST_JSON_FILE.");
  }
  return { reporters: ["default", "json"], outputFile: { json: env.CHASE_SETS_VITEST_JSON_FILE } };
}

function exact(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} must contain exactly ${keys.join(", ")}.`);
  }
}

function text(value, label, max = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`${label} must be a bounded nonempty string.`);
  }
}

function integer(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${label} is out of bounds.`);
}

function instant(value) {
  if (typeof value !== "string" || !/(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("Test results require timezone-bearing instants.");
  }
}

function relativeFile(value) {
  text(value, "file");
  if (
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Test file must be repository-relative.");
  }
}

export function validateWorkspaceTestResults(payload) {
  exact(payload, ["schemaVersion", "producer", "invocations"], "Test results");
  if (payload.schemaVersion !== WORKSPACE_TEST_RESULTS_VERSION) throw new Error("Test results version invalid.");
  const producer = payload.producer;
  exact(producer, ["repository", "headSha", "testedSha", "runId", "runAttempt", "job"], "Producer");
  if (typeof producer.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(producer.repository))
    throw new Error("Producer repository invalid.");
  for (const key of ["headSha", "testedSha"]) {
    if (typeof producer[key] !== "string" || !/^[a-f0-9]{40}$/.test(producer[key]))
      throw new Error(`Producer ${key} invalid.`);
  }
  if (typeof producer.runId !== "string" || !/^[1-9]\d{0,19}$/.test(producer.runId))
    throw new Error("Producer runId invalid.");
  integer(producer.runAttempt, "runAttempt", 100);
  if (producer.runAttempt === 0 || !["unit-tests", "db-tests"].includes(producer.job)) {
    throw new Error("Producer attempt/job invalid.");
  }
  if (!Array.isArray(payload.invocations) || payload.invocations.length < 1 || payload.invocations.length > 256) {
    throw new Error("Invocation count invalid.");
  }
  const ids = new Set();
  const testIds = new Set();
  for (const invocation of payload.invocations) {
    exact(invocation, ["id", "script", "startedAt", "completedAt", "tasks"], "Invocation");
    if (!/^[a-f0-9-]{36}$/.test(invocation.id) || ids.has(invocation.id))
      throw new Error("Invocation identity ambiguous.");
    ids.add(invocation.id);
    text(invocation.script, "Invocation script", 128);
    instant(invocation.startedAt);
    instant(invocation.completedAt);
    if (Date.parse(invocation.completedAt) < Date.parse(invocation.startedAt))
      throw new Error("Invocation order invalid.");
    if (!Array.isArray(invocation.tasks) || invocation.tasks.length > 512) throw new Error("Task count invalid.");
    const tasks = new Set();
    for (const task of invocation.tasks) {
      exact(task, ["workspace", "script", "status", "reason", "assertionCount", "fileFailureCount", "rows"], "Task");
      if (!/^@chase-sets\/[a-z0-9-]+$/.test(task.workspace)) throw new Error("Workspace identity invalid.");
      text(task.script, "Task script", 128);
      const taskKey = `${task.workspace}\0${task.script}`;
      if (tasks.has(taskKey)) throw new Error("Task identity ambiguous.");
      tasks.add(taskKey);
      if (!["complete", "unknown", "not-started"].includes(task.status)) throw new Error("Task status invalid.");
      if (
        typeof task.reason !== "string" ||
        task.reason.length > 300 ||
        (task.status === "unknown" ? !task.reason : task.reason !== "")
      )
        throw new Error("Task reason invalid.");
      integer(task.assertionCount, "assertionCount", 100_000);
      integer(task.fileFailureCount, "fileFailureCount", 100_000);
      if (!Array.isArray(task.rows) || task.rows.length !== task.assertionCount)
        throw new Error("Assertion total mismatch.");
      if (task.status !== "complete" && (task.rows.length || task.fileFailureCount))
        throw new Error("Nonexecuted/unknown rows invalid.");
      for (const row of task.rows) {
        exact(row, ["file", "fullName", "state", "durationMs", "retryCount"], "Test row");
        relativeFile(row.file);
        text(row.fullName, "Test name");
        if (!states.has(row.state)) throw new Error("Test state invalid.");
        if (!Number.isFinite(row.durationMs) || row.durationMs < 0 || row.durationMs > 86_400_000) {
          throw new Error("Test duration invalid.");
        }
        // Built-in Vitest JSON has no retry telemetry; this repository enables no retries.
        if (row.retryCount !== 0) throw new Error("Unproven retry telemetry.");
        const key = `${taskKey}\0${row.file}\0${row.fullName}`;
        if (testIds.has(key)) throw new Error("Test identity ambiguous across invocations.");
        testIds.add(key);
      }
    }
  }
  return payload;
}

export function normalizeVitestReport(report, { repoDir = rootDir, workspaceDir = repoDir } = {}) {
  if (!report || !Array.isArray(report.testResults)) throw new Error("Vitest report missing testResults.");
  integer(report.numTotalTests, "Vitest numTotalTests", 100_000);
  const rows = [];
  let fileFailureCount = 0;
  for (const file of report.testResults) {
    if (!Array.isArray(file.assertionResults) || !["passed", "failed"].includes(file.status)) {
      throw new Error("Vitest file report invalid.");
    }
    text(file.name, "Vitest file name");
    const relative = path.relative(repoDir, path.resolve(workspaceDir, file.name)).replaceAll("\\", "/");
    relativeFile(relative);
    if (file.status === "failed" && !file.assertionResults.some((row) => row.status === "failed")) fileFailureCount++;
    for (const assertion of file.assertionResults) {
      if (!states.has(assertion.status)) throw new Error("Vitest assertion state invalid.");
      if (
        !Array.isArray(assertion.ancestorTitles) ||
        assertion.ancestorTitles.some((title) => typeof title !== "string")
      ) {
        throw new Error("Vitest ancestor titles invalid.");
      }
      text(assertion.title, "Vitest title");
      const fullName = [...assertion.ancestorTitles, assertion.title].join(" ");
      if (assertion.fullName !== fullName) throw new Error("Vitest full name mismatch.");
      const durationMs =
        assertion.duration ?? (assertion.status === "passed" || assertion.status === "failed" ? NaN : 0);
      if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 86_400_000)
        throw new Error("Vitest duration invalid.");
      text(fullName, "Vitest full name");
      rows.push({ file: relative, fullName, state: assertion.status, durationMs, retryCount: 0 });
    }
  }
  if (rows.length !== report.numTotalTests) throw new Error("Vitest assertion total mismatch.");
  return { assertionCount: rows.length, fileFailureCount, rows };
}

function readBoundedJson(file) {
  if (statSync(file).size > MAX_TEST_RESULTS_BYTES) throw new Error("Test results exceed payload byte bound.");
  return JSON.parse(readFileSync(file, "utf8"));
}

export function createTestResultsInvocation(env, tasks, script, now = () => new Date().toISOString()) {
  if (!env.CHASE_SETS_TEST_RESULTS_DIR) return undefined;
  const directory = path.resolve(env.CHASE_SETS_TEST_RESULTS_DIR);
  const producer = {
    repository: env.GITHUB_REPOSITORY,
    headSha: env.CHASE_SETS_TEST_RESULTS_HEAD_SHA,
    testedSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    job: env.GITHUB_JOB,
  };
  const invocation = {
    id: randomUUID(),
    script,
    startedAt: now(),
    completedAt: now(),
    tasks: tasks.flatMap((task) =>
      (task.scriptNames ?? [script]).map((name) => ({
        workspace: task.workspace.name,
        script: name,
        status: "not-started",
        reason: "",
        assertionCount: 0,
        fileFailureCount: 0,
        rows: [],
      })),
    ),
  };
  const payload = { schemaVersion: WORKSPACE_TEST_RESULTS_VERSION, producer, invocations: [invocation] };
  validateWorkspaceTestResults(payload);
  const invocationDir = path.join(directory, "invocations", invocation.id);
  mkdirSync(invocationDir, { recursive: true });
  const persist = () => writeFileSync(path.join(invocationDir, WORKSPACE_TEST_RESULTS_FILE), JSON.stringify(payload));
  persist();
  return {
    start(workspace, name) {
      const task = invocation.tasks.find((item) => item.workspace === workspace.name && item.script === name);
      task.status = "unknown";
      task.reason = "started-report-unavailable";
      persist();
      const output = path.join(invocationDir, `${invocation.tasks.indexOf(task)}.json`);
      return { task, output, env: { ...env, CHASE_SETS_VITEST_JSON_FILE: output } };
    },
    complete(workspace, started) {
      try {
        Object.assign(
          started.task,
          normalizeVitestReport(readBoundedJson(started.output), { workspaceDir: workspace.dir }),
        );
        started.task.status = "complete";
        started.task.reason = "";
        validateWorkspaceTestResults(payload);
      } catch (error) {
        Object.assign(started.task, {
          status: "unknown",
          reason: String(error.message).slice(0, 300),
          assertionCount: 0,
          fileFailureCount: 0,
          rows: [],
        });
      }
      persist();
    },
    finish() {
      invocation.completedAt = now();
      validateWorkspaceTestResults(payload);
      persist();
      console.log(
        `WORKSPACE_TEST_RESULTS ${JSON.stringify({
          invocation: invocation.id,
          assertionCount: invocation.tasks.reduce((sum, task) => sum + task.assertionCount, 0),
          unknownCount: invocation.tasks.filter((task) => task.status === "unknown").length,
        })}`,
      );
    },
  };
}

export function finalizeWorkspaceTestResults(directory) {
  const invocationRoot = path.join(directory, "invocations");
  const names = readdirSync(invocationRoot);
  if (names.length < 1 || names.length > 256) throw new Error("No bounded started invocation corpus.");
  const payloads = names.map((name) =>
    validateWorkspaceTestResults(readBoundedJson(path.join(invocationRoot, name, WORKSPACE_TEST_RESULTS_FILE))),
  );
  if (payloads.some((payload) => JSON.stringify(payload.producer) !== JSON.stringify(payloads[0].producer))) {
    throw new Error("Invocation producer mismatch.");
  }
  const payload = { ...payloads[0], invocations: payloads.flatMap((item) => item.invocations) };
  validateWorkspaceTestResults(payload);
  const bytes = JSON.stringify(payload);
  if (Buffer.byteLength(bytes) > MAX_TEST_RESULTS_BYTES) throw new Error("Test results exceed payload byte bound.");
  writeFileSync(path.join(directory, WORKSPACE_TEST_RESULTS_FILE), bytes);
  return payload;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  finalizeWorkspaceTestResults(process.env.CHASE_SETS_TEST_RESULTS_DIR);
}
