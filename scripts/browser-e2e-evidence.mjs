import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const browserE2eLifecyclePathEnv = "CHASE_SETS_BROWSER_E2E_LIFECYCLE_PATH";
export const browserE2eReadinessEvidencePathEnv = "CHASE_SETS_BROWSER_E2E_READINESS_EVIDENCE_PATH";
export const browserE2eTestTimelinePathEnv = "CHASE_SETS_BROWSER_E2E_TEST_TIMELINE_PATH";
export const browserE2eOutputTailCharacters = 16_384;

function isoTimestamp(now) {
  return new Date(now()).toISOString();
}

export function resolveBrowserE2eEvidencePaths(sandbox, env = process.env) {
  const runtimeDirectory = path.join(sandbox.rootDir, "artifacts", "browser-e2e", "runtime", sandbox.id);
  return {
    lifecyclePath: path.resolve(env[browserE2eLifecyclePathEnv] ?? path.join(runtimeDirectory, "lifecycle.json")),
    readinessPath: path.resolve(
      env[browserE2eReadinessEvidencePathEnv] ?? path.join(runtimeDirectory, "readiness.json"),
    ),
    testTimelinePath: path.resolve(
      env[browserE2eTestTimelinePathEnv] ?? path.join(runtimeDirectory, "test-timeline.json"),
    ),
  };
}

export function createBrowserE2eRunEvidenceEnvironment(sandbox, { now = Date.now(), pid = process.pid } = {}) {
  const timestamp = new Date(now).toISOString().replaceAll(":", "").replaceAll(".", "-");
  const runDirectory = path.join(
    sandbox.rootDir,
    "artifacts",
    "browser-e2e",
    "runs",
    sandbox.id,
    `${timestamp}-${pid}`,
  );
  return {
    [browserE2eLifecyclePathEnv]: path.join(runDirectory, "lifecycle.json"),
    [browserE2eReadinessEvidencePathEnv]: path.join(runDirectory, "readiness.json"),
    [browserE2eTestTimelinePathEnv]: path.join(runDirectory, "test-timeline.json"),
  };
}

export function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

  try {
    renameSync(temporaryPath, filePath);
  } catch (error) {
    if (!["EEXIST", "EPERM"].includes(error?.code)) {
      throw error;
    }
    rmSync(filePath, { force: true });
    renameSync(temporaryPath, filePath);
  }
}

export function readJsonIfPresent(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function createBoundedTextTail(maxCharacters) {
  let text = "";
  let omittedCharacters = 0;

  return {
    append(chunk) {
      text += chunk.toString();
      if (text.length > maxCharacters) {
        const overflow = text.length - maxCharacters;
        text = text.slice(overflow);
        omittedCharacters += overflow;
      }
    },
    snapshot() {
      return { text, omittedCharacters };
    },
  };
}

export function createBrowserE2eLifecycleRecorder({
  filePath,
  sandboxId,
  target,
  maxTailCharacters = browserE2eOutputTailCharacters,
  now = Date.now,
} = {}) {
  if (!filePath) {
    throw new Error("Browser e2e lifecycle evidence requires a file path.");
  }

  const startedAt = isoTimestamp(now);
  const services = new Map();

  function snapshot() {
    return {
      schemaVersion: 1,
      kind: "browser-e2e-service-lifecycle",
      sandboxId,
      target,
      startedAt,
      updatedAt: isoTimestamp(now),
      services: [...services.values()]
        .sort((left, right) => left.name.localeCompare(right.name, "en"))
        .map(({ stdout, stderr, ...service }) => {
          const stdoutTail = stdout.snapshot();
          const stderrTail = stderr.snapshot();
          return {
            ...service,
            stdoutTail: stdoutTail.text,
            stdoutOmittedCharacters: stdoutTail.omittedCharacters,
            stderrTail: stderrTail.text,
            stderrOmittedCharacters: stderrTail.omittedCharacters,
          };
        }),
    };
  }

  function persist() {
    const evidence = snapshot();
    writeJsonAtomic(filePath, evidence);
    return evidence;
  }

  persist();

  return {
    observe(name, child) {
      const service = {
        name,
        spawnedAt: isoTimestamp(now),
        pid: child.pid ?? null,
        status: "running",
        exitedAt: null,
        exitCode: null,
        signal: null,
        spawnError: null,
        stdout: createBoundedTextTail(maxTailCharacters),
        stderr: createBoundedTextTail(maxTailCharacters),
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        service.status = "exited";
        service.exitedAt = isoTimestamp(now);
        service.exitCode = child.exitCode ?? null;
        service.signal = child.signalCode ?? null;
      }
      services.set(name, service);

      child.stdout?.on("data", (chunk) => {
        service.stdout.append(chunk);
        persist();
      });
      child.stderr?.on("data", (chunk) => {
        service.stderr.append(chunk);
        persist();
      });
      child.once("error", (error) => {
        service.status = "spawn-error";
        service.spawnError = error instanceof Error ? error.message : String(error);
        service.exitedAt = isoTimestamp(now);
        persist();
      });
      child.once("exit", (code, signal) => {
        service.status = "exited";
        service.exitedAt = isoTimestamp(now);
        service.exitCode = code;
        service.signal = signal;
        persist();
      });

      persist();
      return child;
    },
    persist,
    snapshot,
  };
}

function formatTail(label, text, omittedCharacters) {
  const omission = omittedCharacters > 0 ? ` (${omittedCharacters} earlier characters omitted)` : "";
  return `${label}${omission}=${JSON.stringify(text)}`;
}

export function formatServiceLifecycleEvidence(lifecycleEvidence, componentName) {
  const service = lifecycleEvidence?.services?.find((candidate) => candidate.name === componentName);
  if (!service) {
    return `${componentName}: lifecycle evidence unavailable`;
  }

  const exitCode = service.exitCode === null ? (service.status === "running" ? "pending" : "none") : service.exitCode;
  const signal = service.signal ?? (service.status === "running" ? "pending" : "none");
  const details = [
    `${componentName}: status=${service.status}`,
    `spawnedAt=${service.spawnedAt}`,
    `PID=${service.pid ?? "unavailable"}`,
    `exitCode=${exitCode}`,
    `signal=${signal}`,
    formatTail("stdoutTail", service.stdoutTail ?? "", service.stdoutOmittedCharacters ?? 0),
    formatTail("stderrTail", service.stderrTail ?? "", service.stderrOmittedCharacters ?? 0),
  ];
  if (service.spawnError) {
    details.push(`spawnError=${JSON.stringify(service.spawnError)}`);
  }
  return details.join(", ");
}

export function createReadinessTimeline({ startedAtMs = Date.now(), now = Date.now } = {}) {
  const entries = [];
  const latestByKey = new Map();

  return {
    record(phase, observations) {
      for (const observation of observations) {
        const component = observation.name ?? observation.component ?? phase;
        const value = {
          ready: Boolean(observation.ready),
          observation: observation.observation ?? null,
        };
        const key = `${phase}\0${component}`;
        if (JSON.stringify(latestByKey.get(key)) === JSON.stringify(value)) {
          continue;
        }
        latestByKey.set(key, value);
        const observedAtMs = now();
        entries.push({
          sequence: entries.length + 1,
          observedAt: new Date(observedAtMs).toISOString(),
          elapsedMs: Math.max(0, observedAtMs - startedAtMs),
          phase,
          component,
          ...value,
        });
      }
      return entries;
    },
    snapshot() {
      return entries.map((entry) => ({ ...entry }));
    },
  };
}

export function createBrowserE2eTestTimelineRecorder({ filePath, sandboxId, now = Date.now } = {}) {
  if (!filePath) {
    throw new Error("Browser e2e test timeline evidence requires a file path.");
  }

  const startedAt = isoTimestamp(now);
  const tests = [];

  function snapshot() {
    return {
      schemaVersion: 1,
      kind: "browser-e2e-test-timeline",
      sandboxId,
      startedAt,
      updatedAt: isoTimestamp(now),
      tests: tests.map((test) => ({ ...test, titlePath: [...test.titlePath] })),
    };
  }

  function persist() {
    const evidence = snapshot();
    writeJsonAtomic(filePath, evidence);
    return evidence;
  }

  persist();

  return {
    record({ testId, titlePath, projectName, retry, status, durationMs }) {
      tests.push({
        sequence: tests.length + 1,
        testId,
        titlePath: [...titlePath],
        projectName,
        retry,
        status,
        durationMs,
        completedAt: isoTimestamp(now),
      });
      return persist();
    },
    persist,
    snapshot,
  };
}

function parseEvidenceTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Browser e2e evidence is missing a valid ${label}.`);
  }
  return timestamp;
}

export function joinBrowserE2eTestTimelineWithLifecycle({
  lifecycle,
  testTimeline,
  expectedTestCount = 9,
  marketplaceServiceName = "marketplace",
} = {}) {
  const tests = testTimeline?.tests;
  if (!Array.isArray(tests) || tests.length !== expectedTestCount) {
    throw new Error(
      `Browser e2e test timeline requires exactly ${expectedTestCount} completion rows; received ${tests?.length ?? 0}.`,
    );
  }
  const completedAttempts = new Set();
  for (const [index, test] of tests.entries()) {
    if (test.sequence !== index + 1) {
      throw new Error(`Browser e2e test timeline sequence ${index + 1} is missing or duplicated.`);
    }
    const completedAttempt = `${test.testId}\0${test.retry ?? 0}`;
    if (!test.testId || completedAttempts.has(completedAttempt)) {
      throw new Error(`Browser e2e test timeline completion row ${index + 1} is missing or duplicated.`);
    }
    completedAttempts.add(completedAttempt);
    parseEvidenceTimestamp(test.completedAt, `test ${index + 1} completion timestamp`);
  }

  const marketplaceServices = lifecycle?.services?.filter((service) => service.name === marketplaceServiceName) ?? [];
  if (marketplaceServices.length !== 1) {
    throw new Error(
      `Browser e2e lifecycle requires exactly one ${marketplaceServiceName} service; received ${marketplaceServices.length}.`,
    );
  }

  const marketplace = marketplaceServices[0];
  if (!Number.isInteger(marketplace.pid)) {
    throw new Error(`Browser e2e lifecycle is missing the ${marketplaceServiceName} direct-child PID.`);
  }

  const test9CompletedAt = tests[expectedTestCount - 1].completedAt;
  const test9CompletedAtMs = parseEvidenceTimestamp(test9CompletedAt, `test ${expectedTestCount} completion timestamp`);
  if (marketplace.exitedAt === null && marketplace.status === "running") {
    return {
      marketplacePid: marketplace.pid,
      testCount: tests.length,
      test9CompletedAt,
      marketplaceExitedAt: null,
      ordering: "marketplace-alive-through-test-nine",
    };
  }

  const marketplaceExitedAtMs = parseEvidenceTimestamp(
    marketplace.exitedAt,
    `${marketplaceServiceName} exit timestamp`,
  );
  if (marketplaceExitedAtMs <= test9CompletedAtMs) {
    throw new Error(
      `${marketplaceServiceName} exited at ${marketplace.exitedAt} before test ${expectedTestCount} completed at ${test9CompletedAt}.`,
    );
  }

  return {
    marketplacePid: marketplace.pid,
    testCount: tests.length,
    test9CompletedAt,
    marketplaceExitedAt: marketplace.exitedAt,
    ordering: "marketplace-exited-after-test-nine",
  };
}

export class BrowserE2eTestTimelineReporter {
  constructor({ filePath, sandboxId, now = Date.now } = {}) {
    this.filePath = filePath;
    this.sandboxId = sandboxId;
    this.now = now;
    this.recorder = null;
  }

  onBegin() {
    this.recorder = createBrowserE2eTestTimelineRecorder({
      filePath: this.filePath,
      sandboxId: this.sandboxId,
      now: this.now,
    });
  }

  onTestEnd(test, result) {
    if (!this.recorder) {
      throw new Error("Browser e2e test timeline reporter did not receive onBegin before onTestEnd.");
    }
    this.recorder.record({
      testId: test.id,
      titlePath: test.titlePath(),
      projectName: test.parent?.project?.()?.name ?? null,
      retry: result.retry,
      status: result.status,
      durationMs: result.duration,
    });
  }
}

export default BrowserE2eTestTimelineReporter;

export function writeBrowserE2eReadinessEvidence({
  filePath,
  sandboxId,
  target,
  startedAt,
  outcome,
  error = null,
  timeline,
  lifecyclePath,
  now = Date.now,
}) {
  const lifecycle = readJsonIfPresent(lifecyclePath);
  const evidence = {
    schemaVersion: 1,
    kind: "browser-e2e-readiness",
    sandboxId,
    target,
    startedAt,
    updatedAt: isoTimestamp(now),
    completedAt: outcome === "starting" ? null : isoTimestamp(now),
    outcome,
    error,
    playwrightSpecsRun: 0,
    readinessTimeline: timeline,
    lifecycle,
  };
  writeJsonAtomic(filePath, evidence);
  return evidence;
}
