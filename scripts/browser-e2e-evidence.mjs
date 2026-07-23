import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const browserE2eLifecyclePathEnv = "CHASE_SETS_BROWSER_E2E_LIFECYCLE_PATH";
export const browserE2eReadinessEvidencePathEnv = "CHASE_SETS_BROWSER_E2E_READINESS_EVIDENCE_PATH";
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
