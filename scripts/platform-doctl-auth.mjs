#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { randomUUID } from "node:crypto";
import { access, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PLATFORM_DOCTL_AUTH_SCHEMA = "platform-doctl-auth-validation/v1";
export const CANONICAL_AUTH_EVIDENCE_PATH = "artifacts/release-health/production-doctl-auth-validation.json";
export const VALIDATION_AUTHORITY = "https://cloud.digitalocean.com";
const TOKEN_INFO_PATH = "/v1/oauth/token/info";
const MAX_EVIDENCE_BYTES = 8192;
const ATTEMPT_TIMEOUT_MS = 75_000;
const RETRY_DELAYS_MS = [5_000, 15_000];
const terminalDetails = Object.freeze({
  succeeded: ["SUCCEEDED", "DoctlAuthValidated", "Staged doctl token validation succeeded."],
  "definitive-rejected": [
    "ERROR",
    "DoctlAuthDefinitiveRejected",
    "Staged doctl token validation rejected the configured authority.",
  ],
  "transient-exhausted": [
    "ERROR",
    "DoctlAuthTransientExhausted",
    "Staged doctl token validation exhausted transient provider availability.",
  ],
  "indeterminate-failed": [
    "ERROR",
    "DoctlAuthIndeterminateFailed",
    "Staged doctl token validation failed closed with an unclassified terminal.",
  ],
});

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function utcInstant(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function tokenInfoAuthority(authority) {
  return `${String(authority).replace(/\/+$/u, "")}${TOKEN_INFO_PATH}`;
}

export function classifyDoctlAuthTerminal(stderr, validationAuthority = VALIDATION_AUTHORITY) {
  const normalized = String(stderr ?? "").replace(/\r\n/g, "\n");
  const authority = tokenInfoAuthority(validationAuthority);
  const prefix = `Error: Unable to use supplied token to access API: `;
  const statusPrefix = `${prefix}GET ${authority}: `;
  if (normalized.startsWith(statusPrefix)) {
    const status = /^(\d{3})\b/u.exec(normalized.slice(statusPrefix.length))?.[1];
    if (!status) return { class: "indeterminate", httpStatus: null };
    const httpStatus = Number(status);
    if (httpStatus === 408 || httpStatus === 429 || (httpStatus >= 500 && httpStatus <= 599)) {
      return { class: "transient-http", httpStatus };
    }
    if ([400, 401, 403].includes(httpStatus)) return { class: "definitive", httpStatus };
    return { class: "indeterminate", httpStatus: null };
  }
  const transportPrefix = `${prefix}Get "${authority}": `;
  const suffix = normalized.startsWith(transportPrefix) ? normalized.slice(transportPrefix.length) : "";
  if (
    /^dial tcp .+: connect: connection refused\n?$/u.test(suffix) ||
    /^dial tcp: lookup [^\s]+ on [^\s]+: no such host\n?$/u.test(suffix) ||
    /^tls: first record does not look like a TLS handshake\n?$/u.test(suffix)
  ) {
    return { class: "transient-transport", httpStatus: null };
  }
  return { class: "indeterminate", httpStatus: null };
}

export function buildChildEnvironment(environment = process.env) {
  const allowed = [
    "HOME",
    "XDG_CONFIG_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "LANG",
    "LC_ALL",
  ];
  const child = {};
  for (const key of allowed) if (environment[key]) child[key] = environment[key];
  if (environment.DIGITALOCEAN_ACCESS_TOKEN) child.DIGITALOCEAN_ACCESS_TOKEN = environment.DIGITALOCEAN_ACCESS_TOKEN;
  return child;
}

function recordFor(outcome, telemetry) {
  const [phase, reasonCode, message] = terminalDetails[outcome];
  return {
    schemaVersion: PLATFORM_DOCTL_AUTH_SCHEMA,
    terminal: { outcome, attempts: telemetry.length, completedAt: telemetry.at(-1).completedAt },
    steps: [{ name: "doctl-auth-validation", componentName: "digitalocean-auth", phase, reasonCode, message }],
    telemetry,
  };
}

export function validateCanonicalAuthEvidence(record) {
  const fail = (message) => ({ valid: false, error: message });
  if (
    !exactKeys(record, ["schemaVersion", "terminal", "steps", "telemetry"]) ||
    record.schemaVersion !== PLATFORM_DOCTL_AUTH_SCHEMA
  )
    return fail("root shape");
  if (!exactKeys(record.terminal, ["outcome", "attempts", "completedAt"]) || !terminalDetails[record.terminal.outcome])
    return fail("terminal shape");
  if (
    !Number.isInteger(record.terminal.attempts) ||
    record.terminal.attempts < 1 ||
    record.terminal.attempts > 3 ||
    !utcInstant(record.terminal.completedAt)
  )
    return fail("terminal values");
  if (
    !Array.isArray(record.steps) ||
    record.steps.length !== 1 ||
    !exactKeys(record.steps[0], ["name", "componentName", "phase", "reasonCode", "message"])
  )
    return fail("steps shape");
  const expected = terminalDetails[record.terminal.outcome];
  if (
    record.steps[0].name !== "doctl-auth-validation" ||
    record.steps[0].componentName !== "digitalocean-auth" ||
    [record.steps[0].phase, record.steps[0].reasonCode, record.steps[0].message].some(
      (value, index) => value !== expected[index],
    )
  )
    return fail("step projection");
  if (!Array.isArray(record.telemetry) || record.telemetry.length !== record.terminal.attempts)
    return fail("telemetry count");
  for (const [index, observation] of record.telemetry.entries()) {
    if (!exactKeys(observation, ["attempt", "class", "httpStatus", "startedAt", "completedAt", "durationMs"]))
      return fail("telemetry shape");
    if (
      observation.attempt !== index + 1 ||
      !["success", "transient-http", "transient-transport", "deadline", "definitive", "indeterminate"].includes(
        observation.class,
      ) ||
      !utcInstant(observation.startedAt) ||
      !utcInstant(observation.completedAt) ||
      Date.parse(observation.startedAt) > Date.parse(observation.completedAt) ||
      !Number.isInteger(observation.durationMs) ||
      observation.durationMs < 0 ||
      observation.durationMs > 76_000
    )
      return fail("telemetry values");
    const hasStatus = observation.class === "transient-http" || observation.class === "definitive";
    if (
      (hasStatus &&
        (!Number.isInteger(observation.httpStatus) || observation.httpStatus < 100 || observation.httpStatus > 599)) ||
      (!hasStatus && observation.httpStatus !== null)
    )
      return fail("telemetry status");
    if (
      index < record.telemetry.length - 1 &&
      !["transient-http", "transient-transport", "deadline"].includes(observation.class)
    )
      return fail("non-final class");
  }
  const finalClass = record.telemetry.at(-1).class;
  const matches =
    (record.terminal.outcome === "succeeded" && finalClass === "success") ||
    (record.terminal.outcome === "definitive-rejected" && finalClass === "definitive") ||
    (record.terminal.outcome === "transient-exhausted" &&
      ["transient-http", "transient-transport", "deadline"].includes(finalClass)) ||
    (record.terminal.outcome === "indeterminate-failed" && finalClass === "indeterminate");
  if (!matches || record.terminal.completedAt !== record.telemetry.at(-1).completedAt)
    return fail("terminal agreement");
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.length > MAX_EVIDENCE_BYTES) return fail("encoded size");
  return { valid: true };
}

export async function writeCanonicalAuthEvidence(outPath, record) {
  const validation = validateCanonicalAuthEvidence(record);
  if (!validation.valid) throw new Error("doctl auth evidence invariant failed");
  const absolute = resolve(outPath);
  const text = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX_EVIDENCE_BYTES || bytes[0] === 0xef) throw new Error("doctl auth evidence invariant failed");
  await mkdir(resolve(absolute, ".."), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, absolute);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function defaultChild({ executable, args, env, timeoutMs }) {
  return await new Promise((resolveChild) => {
    let timedOut = false;
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolveChild({ exitCode: null, signal: "error", stdout, stderr, timedOut });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolveChild({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

async function assertExecutable(executable) {
  if (!isAbsolute(executable)) throw new Error("doctl auth requires an absolute staged executable");
  const details = await stat(executable).catch(() => null);
  if (!details?.isFile()) throw new Error("doctl auth staged executable is unavailable");
  await access(executable, fsConstants.X_OK).catch(() => {
    throw new Error("doctl auth staged executable is not executable");
  });
}

export async function runPlatformDoctlAuth({
  executable,
  outPath = CANONICAL_AUTH_EVIDENCE_PATH,
  env = process.env,
  validationAuthority = VALIDATION_AUTHORITY,
  runChild = defaultChild,
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  log = () => {},
} = {}) {
  const safeEnvironment = buildChildEnvironment(env);
  const telemetry = [];
  const failBeforeContact = async () => {
    const timestamp = now().toISOString();
    telemetry.push({
      attempt: 1,
      class: "indeterminate",
      httpStatus: null,
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
    });
    const record = recordFor("indeterminate-failed", telemetry);
    await writeCanonicalAuthEvidence(outPath, record);
    log("doctl auth validation terminal outcome: indeterminate-failed");
    return { outcome: "indeterminate-failed", record };
  };
  try {
    await assertExecutable(executable);
  } catch {
    return await failBeforeContact();
  }
  if (!safeEnvironment.DIGITALOCEAN_ACCESS_TOKEN || !safeEnvironment.HOME) return await failBeforeContact();
  let outcome = "indeterminate-failed";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const started = now();
    const result = await runChild({
      executable,
      args: ["--http-retry-max", "0", "auth", "init"],
      env: safeEnvironment,
      timeoutMs: ATTEMPT_TIMEOUT_MS,
    }).catch(() => ({ exitCode: null, signal: "error", stdout: "", stderr: "", timedOut: false }));
    const completed = now();
    const classified = result.timedOut
      ? { class: "deadline", httpStatus: null }
      : result.exitCode === 0 && !result.signal
        ? { class: "success", httpStatus: null }
        : result.signal
          ? { class: "indeterminate", httpStatus: null }
          : classifyDoctlAuthTerminal(result.stderr, validationAuthority);
    telemetry.push({
      attempt,
      class: classified.class,
      httpStatus: classified.httpStatus,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime()),
    });
    log(
      `doctl auth validation attempt ${attempt}: ${classified.class}${classified.httpStatus ? ` (${classified.httpStatus})` : ""}; duration ${telemetry.at(-1).durationMs}ms`,
    );
    if (classified.class === "success") {
      outcome = "succeeded";
      break;
    }
    if (classified.class === "definitive") {
      outcome = "definitive-rejected";
      break;
    }
    if (classified.class === "indeterminate") {
      outcome = "indeterminate-failed";
      break;
    }
    if (attempt === 3) {
      outcome = "transient-exhausted";
      break;
    }
    await sleep(RETRY_DELAYS_MS[attempt - 1]);
  }
  const record = recordFor(outcome, telemetry);
  await writeCanonicalAuthEvidence(outPath, record);
  log(`doctl auth validation terminal outcome: ${outcome}`);
  return { outcome, record };
}

function cliOptions(argv) {
  const index = argv.indexOf("--doctl");
  return { executable: index >= 0 ? argv[index + 1] : "" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { executable } = cliOptions(process.argv.slice(2));
  try {
    const result = await runPlatformDoctlAuth({ executable, log: (message) => console.log(message) });
    if (result.outcome !== "succeeded") process.exitCode = 1;
  } catch {
    console.error("staged doctl authentication could not be started safely");
    process.exitCode = 1;
  }
}
