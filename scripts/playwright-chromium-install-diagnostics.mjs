import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  accessSync,
  constants,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPackageManagerInvocation } from "./lib/process.mjs";
import { inspectCache, installPlaywrightChromium, validateCachePath } from "./playwright-chromium-install.mjs";
import { runInstaller } from "./provider-browser-install-timeout.mjs";

const self = fileURLToPath(import.meta.url);
const monotonic = () => Number(process.hrtime.bigint()) / 1e6;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const nativePrefix = "chromium-diagnostic-native:";
const browserPrefix = "chromium-diagnostic-browser:";
export const DIAGNOSTIC_DEBUG = "pw:install,extract-zip";
export const TRACE_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, line: 8192, events: 256 });
const payloadNames = ["chromium", "headless-shell", "ffmpeg"];

function payloadFromTitle(title) {
  if (/^Chrome Headless Shell /.test(title)) return "headless-shell";
  if (/^Chrome for Testing /.test(title)) return "chromium";
  if (/^FFmpeg /.test(title)) return "ffmpeg";
  return undefined;
}

// Vocabulary inspected in pinned 1.60.0 coreBundle: browserFetcher,
// oopDownloadBrowserMain, and extractZip. Permission work is NOT extraction.
export function createPhaseTrace({ now = monotonic, limits = TRACE_LIMITS, onEvent = () => {} } = {}) {
  const events = [];
  const problems = new Set();
  const payloads = [];
  const pending = { stdout: "", stderr: "" };
  let bytes = 0;
  let active;
  let native;
  let browser;
  let previous = -Infinity;
  const emit = (kind, payload, status) => {
    const atMs = now();
    if (!Number.isFinite(atMs) || atMs < previous) problems.add("nonmonotonic-event");
    previous = atMs;
    if (events.length >= limits.events) {
      problems.add("event-limit");
      return;
    }
    const event = { atMs, kind, ...(payload ? { payload } : {}), ...(status !== undefined ? { status } : {}) };
    events.push(event);
    onEvent(event);
    return atMs;
  };
  const line = (text) => {
    if (events.length >= limits.events) {
      problems.add("event-limit");
      return;
    }
    if (text.startsWith(browserPrefix)) {
      if (text === `${browserPrefix}start` && !browser) browser = { startMs: emit("browser-command-start") };
      else if (/^chromium-diagnostic-browser:end:\d{1,3}$/.test(text) && browser && browser.endMs === undefined) {
        browser.status = Number(text.split(":").at(-1));
        browser.endMs = emit("browser-command-end", undefined, browser.status);
      } else problems.add("browser-command-order");
      return;
    }
    if (text.startsWith(nativePrefix)) {
      if (text === `${nativePrefix}start` && !native) native = { startMs: emit("native-start") };
      else if (/^chromium-diagnostic-native:end:\d{1,3}$/.test(text) && native && native.endMs === undefined) {
        native.status = Number(text.split(":").at(-1));
        native.endMs = emit("native-end", undefined, native.status);
      } else problems.add("native-order");
      return;
    }
    const pw = /(?:^|\s)pw:install (.*?)(?:\s+\+\d+(?:ms|s|m))?$/.exec(text)?.[1];
    const extractionEnd = /(?:^|\s)extract-zip zip extraction complete(?:\s+\+\d+(?:ms|s|m))?$/.test(text);
    if (extractionEnd) {
      if (!active || active.extractStartMs === undefined || active.extractEndMs !== undefined)
        problems.add("extraction-order");
      else active.extractEndMs = emit("extract-end", active.payload, 0);
      return;
    }
    if (!pw) return;
    const start = /^downloading (.+) - attempt #(\d+)$/.exec(pw);
    const cached = /^(.+) is already downloaded\.$/.exec(pw);
    if (start) {
      const payload = payloadFromTitle(start[1]);
      if (!payload) {
        problems.add("unsupported-payload");
        return;
      }
      if (active && active.installEndMs === undefined && active.failureMs === undefined)
        problems.add("overlapping-payload");
      active = { payload, downloadAttempt: Number(start[2]), fetchStartMs: emit("fetch-start", payload) };
      payloads.push(active);
    } else if (cached) {
      const payload = payloadFromTitle(cached[1]);
      if (!payload) problems.add("unsupported-payload");
      else {
        payloads.push({ payload, cached: true });
        emit("cache-skip", payload);
      }
    } else if (/^-- download complete, size: \d+$/.test(pw)) {
      if (!active || active.fetchEndMs !== undefined) problems.add("download-order");
      else active.fetchEndMs = emit("fetch-end", active.payload, 0);
    } else if (pw === "extracting archive") {
      if (!active || active.fetchEndMs === undefined || active.extractStartMs !== undefined)
        problems.add("extraction-order");
      else active.extractStartMs = emit("extract-start", active.payload);
    } else if (/^SUCCESS installing /.test(pw)) {
      if (
        !active ||
        payloadFromTitle(pw.slice("SUCCESS installing ".length)) !== active.payload ||
        active.extractEndMs === undefined
      )
        problems.add("install-order");
      else active.installEndMs = emit("payload-complete", active.payload, 0);
    } else if (/^attempt #\d+ - ERROR:/.test(pw)) {
      if (!active) problems.add("failure-order");
      else active.failureMs = emit("payload-failure", active.payload, 1);
    }
  };
  return {
    consume(stream, chunk) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limits.bytes) {
        problems.add("trace-limit");
        return;
      }
      const pieces = (pending[stream] + String(chunk)).split(/\r?\n/);
      pending[stream] = pieces.pop();
      if (pending[stream].length > limits.line) {
        problems.add("line-limit");
        pending[stream] = "";
      }
      for (const piece of pieces) {
        if (piece.length > limits.line) problems.add("line-limit");
        else line(piece);
      }
    },
    finish(terminalOutcome) {
      if (Object.values(pending).some(Boolean)) problems.add("truncated-line");
      const phases = payloads.map((entry) => ({
        ...entry,
        fetchStatus: entry.cached ? "NOT_EXECUTED" : entry.fetchEndMs !== undefined ? "PASS" : "UNKNOWN",
        extractionStatus: entry.cached ? "NOT_EXECUTED" : entry.extractEndMs !== undefined ? "PASS" : "UNKNOWN",
      }));
      for (const entry of phases)
        if (!entry.cached && entry.installEndMs === undefined) problems.add("incomplete-payload");
      for (const name of payloadNames)
        if (!phases.some((entry) => entry.payload === name)) problems.add(`missing-${name}`);
      const residualIntervals = [];
      const residual = (startMs, endMs, kind) => {
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs)
          residualIntervals.push({ startMs, endMs, kind, status: "PASS" });
      };
      for (const entry of phases) {
        residual(entry.fetchEndMs, entry.extractStartMs, "pre-extraction-overhead");
        residual(entry.extractEndMs, entry.installEndMs, "permission-marker-and-child-close-overhead");
      }
      const lastPayloadEnd = phases.filter((entry) => entry.installEndMs !== undefined).at(-1)?.installEndMs;
      if (browser)
        residual(
          lastPayloadEnd ?? (phases.every((entry) => entry.cached) ? browser.startMs : undefined),
          browser.endMs,
          "native-validation-and-other-overhead",
        );
      return {
        status: problems.size ? "UNKNOWN" : "PASS",
        terminalOutcome,
        problems: [...problems],
        native: native
          ? { ...native, outcome: native.endMs === undefined ? "UNKNOWN" : native.status === 0 ? "PASS" : "FAIL" }
          : { outcome: "UNKNOWN", reason: "no-explicit-native-boundaries" },
        browserCommand: browser ?? { outcome: "UNKNOWN", reason: "combined-command-has-no-separate-browser-command" },
        residual:
          "Native validation, permission/marker work and other overhead are not extraction; only explicit fetch/extraction intervals are attributed",
        residualIntervals,
        payloads: phases,
        events,
        observedBytes: bytes,
      };
    },
  };
}

export function classifyControl({ mode, restored, empty, complete, owned, readable }) {
  if (mode === "cold")
    return empty && owned && readable
      ? { status: "PASS", eligible: true }
      : { status: "FAIL", eligible: false, reason: "cold-not-empty-owned-tree" };
  if (mode === "hit")
    return restored === true && !empty && complete && owned && readable
      ? { status: "PASS", eligible: true }
      : { status: "NOT_OBSERVED", eligible: false, reason: "missing-complete-pre-attempt-hit" };
  return { status: "FAIL", eligible: false, reason: "invalid-cache-control" };
}

export function composeAttempt(options, route) {
  if (
    !["combined", "decomposed"].includes(route) ||
    options.timeoutSeconds !== 180 ||
    options.env.PLAYWRIGHT_INSTALL_POLICY !== "e2e-retry"
  )
    throw new Error("diagnostic-composition-refused");
  return {
    ...options,
    ...(route === "decomposed" ? { installerCommand: process.execPath, installerArgs: [self, "install-phases"] } : {}),
    installerEnv: { ...options.installerEnv, DEBUG: DIAGNOSTIC_DEBUG, FORCE_COLOR: "0" },
  };
}

export async function measureDiagnostic({
  env,
  route,
  supervise = runInstaller,
  install = installPlaywrightChromium,
  spawnImpl = spawn,
  now = monotonic,
  persist = () => {},
  helperOptions = {},
}) {
  const attempts = [];
  const helperEvents = [];
  const startedMs = now();
  const checkpoint = (result) =>
    persist({
      startedMs,
      endedMs: now(),
      elapsedMs: now() - startedMs,
      attempts,
      helperEvents,
      ...(result ? { result } : {}),
    });
  checkpoint();
  const result = await install({
    ...helperOptions,
    env: { ...env, PLAYWRIGHT_INSTALL_POLICY: "e2e-retry" },
    write: (text) => {
      helperEvents.push(text);
      checkpoint();
    },
    runInstallerImpl: async (options) => {
      const attempt = { index: attempts.length + 1, startedMs: now(), status: "UNKNOWN" };
      attempts.push(attempt);
      const trace = createPhaseTrace({
        now,
        onEvent: (event) => {
          (attempt.events ??= []).push(event);
          checkpoint();
        },
      });
      checkpoint();
      try {
        const outcome = await supervise({
          ...composeAttempt(options, route),
          spawnImpl(command, args, spawnOptions) {
            const child = spawnImpl(command, args, spawnOptions);
            for (const stream of ["stdout", "stderr"])
              child[stream]?.on("data", (chunk) => trace.consume(stream, chunk));
            return child;
          },
          write: (text) => {
            (attempt.supervisorEvents ??= []).push(text);
            options.write(text);
          },
        });
        Object.assign(attempt, {
          status: outcome.status === 0 ? "PASS" : "FAIL",
          result: outcome,
          trace: trace.finish(outcome.record?.terminalOutcome ?? "refused"),
        });
        return outcome;
      } catch {
        attempt.reason = "authority-refusal";
        attempt.trace = trace.finish("refused");
        throw new Error("diagnostic-supervisor-refused");
      } finally {
        attempt.endedMs = now();
        attempt.elapsedMs = attempt.endedMs - attempt.startedMs;
        checkpoint();
      }
    },
  });
  checkpoint(result);
  return { result, attempts, helperEvents };
}

export async function runDecomposed({
  env = process.env,
  spawnImpl = spawn,
  write = (text) => process.stdout.write(text),
} = {}) {
  for (const command of [
    ["exec", "playwright", "install-deps", "chromium"],
    ["exec", "playwright", "install", "chromium"],
  ]) {
    const native = command[2] === "install-deps";
    const prefix = native ? nativePrefix : browserPrefix;
    write(`${prefix}start\n`);
    const invocation = buildPackageManagerInvocation(command, { env });
    const status = await new Promise((resolve) => {
      let settled = false;
      const finish = (code) => {
        if (!settled) {
          settled = true;
          resolve(Number.isInteger(code) ? code : 1);
        }
      };
      try {
        const child = spawnImpl(invocation.command, invocation.args, {
          env,
          stdio: ["ignore", "inherit", "inherit"],
          windowsHide: true,
        });
        child.once("error", () => finish(1));
        child.once("close", finish);
      } catch {
        finish(1);
      }
    });
    write(`${prefix}end:${status}\n`);
    if (status !== 0) return status;
  }
  return 0;
}

export function pinnedSource() {
  const require = createRequire(import.meta.url);
  const testRequire = createRequire(require.resolve("@playwright/test/package.json"));
  const playwrightRequire = createRequire(testRequire.resolve("playwright/package.json"));
  const root = path.dirname(playwrightRequire.resolve("playwright-core/package.json"));
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const source = readFileSync(path.join(root, "lib/coreBundle.js"), "utf8");
  const supported =
    version === "1.60.0" &&
    source.includes("log(`-- download complete, size: ${downloadedBytes}`)") &&
    source.includes("log(`extracting archive`)") &&
    source.includes('debug2("zip extraction complete")');
  const browsers = JSON.parse(readFileSync(path.join(root, "browsers.json"), "utf8")).browsers;
  return {
    version,
    supported,
    sourceSha256: digest(source),
    browsersSha256: digest(readFileSync(path.join(root, "browsers.json"))),
    revisions: Object.fromEntries(
      ["chromium", "chromium-headless-shell", "ffmpeg"].map((name) => [
        name,
        browsers.find((browser) => browser.name === name)?.revision,
      ]),
    ),
  };
}

function inventory() {
  const capture = (command, args) =>
    execFileSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
      .split("\n")
      .filter(Boolean)
      .sort();
  return {
    packages: capture("dpkg-query", ["-W", "-f=${binary:Package}\t${Version}\n"]),
    fonts: capture("fc-list", ["--format=%{family}\t%{style}\t%{file}\n"]),
  };
}

function cacheSnapshot(cachePath, pinned) {
  mkdirSync(cachePath, { recursive: true });
  const base = inspectCache(cachePath);
  const exact = [
    [`chromium-${pinned.revisions.chromium}`, "chrome-linux64/chrome"],
    [
      `chromium_headless_shell-${pinned.revisions["chromium-headless-shell"]}`,
      "chrome-headless-shell-linux64/chrome-headless-shell",
    ],
    [`ffmpeg-${pinned.revisions.ffmpeg}`, "ffmpeg-linux"],
  ];
  const payloads = exact.map(([directory, executable]) => {
    const file = path.join(cachePath, directory, executable);
    const marker = path.join(cachePath, directory, "INSTALLATION_COMPLETE");
    try {
      const stat = lstatSync(file);
      accessSync(file, constants.R_OK | constants.X_OK);
      return { directory, complete: stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && existsSync(marker) };
    } catch {
      return { directory, complete: false };
    }
  });
  return {
    ...base,
    empty: readdirSync(cachePath).length === 0,
    readable: base.owned && base.state !== "mismatched",
    complete: base.complete && payloads.every((entry) => entry.complete),
    payloads,
  };
}

function runtimePaths(env) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.platform !== "linux" ||
    process.arch !== "x64"
  )
    throw new Error("hosted-linux-x64-only");
  const owned = validateCachePath(env.RUNNER_TEMP);
  const pinned = pinnedSource();
  const expected = path.join(owned, "playwright-chromium", "Linux", "X64", pinned.version);
  const directory = path.join(owned, "chromium-install-diagnostics");
  if (
    env.PLAYWRIGHT_BROWSERS_PATH !== expected ||
    env.DIAGNOSTIC_DIRECTORY !== directory ||
    !["combined", "decomposed"].includes(env.DIAGNOSTIC_ROUTE) ||
    !["cold", "hit"].includes(env.DIAGNOSTIC_CACHE)
  )
    throw new Error("diagnostic-owned-path-or-cell-refused");
  for (const target of [
    owned,
    path.dirname(path.dirname(path.dirname(expected))),
    path.dirname(path.dirname(expected)),
    path.dirname(expected),
    expected,
    directory,
  ])
    if (existsSync(target) && (lstatSync(target).isSymbolicLink() || lstatSync(target).uid !== process.getuid()))
      throw new Error("diagnostic-path-ownership-refused");
  mkdirSync(directory, { recursive: true });
  return { cachePath: expected, directory, pinned };
}

function save(directory, name, value) {
  writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function main(command, env) {
  if (command === "install-phases") {
    if (env.GITHUB_ACTIONS !== "true" || env.RUNNER_ENVIRONMENT !== "github-hosted" || process.platform !== "linux")
      throw new Error("hosted-child-only");
    return runDecomposed({ env });
  }
  const { cachePath, directory, pinned } = runtimePaths(env);
  if (command === "prepare") {
    const cache = cacheSnapshot(cachePath, pinned);
    const control = classifyControl({
      mode: env.DIAGNOSTIC_CACHE,
      restored: env.DIAGNOSTIC_RESTORED === "true",
      ...cache,
    });
    const sourceFiles = [
      "scripts/playwright-chromium-install-diagnostics.mjs",
      "scripts/playwright-chromium-install.mjs",
      "scripts/provider-browser-install-timeout.mjs",
      "pnpm-lock.yaml",
      ".github/workflows/playwright-chromium-install-diagnostics.yml",
    ];
    const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
    save(directory, "before.json", {
      schema: "chromium-install-diagnostics/v1",
      capturedAt: new Date().toISOString(),
      route: env.DIAGNOSTIC_ROUTE,
      cacheMode: env.DIAGNOSTIC_CACHE,
      cacheKey: env.DIAGNOSTIC_CACHE_KEY,
      cache,
      control,
      pinned,
      identity: {
        source: env.GITHUB_SHA,
        checkout: git("rev-parse", "HEAD"),
        tree: git("rev-parse", "HEAD^{tree}"),
        workflowTree: git("rev-parse", "HEAD:.github/workflows"),
        run: env.GITHUB_RUN_ID,
        attempt: env.GITHUB_RUN_ATTEMPT,
        checkRun: env.DIAGNOSTIC_CHECK_RUN_ID,
        helperTimingJobIdKind: "check-run-id; not authoritative owning-job identity",
        jobName: env.GITHUB_JOB,
        owningJob: "UNKNOWN: host live API capture required",
      },
      hashes: Object.fromEntries(sourceFiles.map((file) => [file, digest(readFileSync(file))])),
      runner: {
        imageOS: env.ImageOS,
        imageVersion: env.ImageVersion,
        os: os.release(),
        architecture: process.arch,
        region: "UNKNOWN: host provisioner log capture required",
        osRelease: readFileSync("/etc/os-release", "utf8"),
      },
      native: inventory(),
    });
    appendFileSync(env.GITHUB_OUTPUT, `eligible=${control.eligible && pinned.supported}\n`);
    return control.status === "FAIL" || !pinned.supported ? 1 : 0;
  }
  if (command === "measure") {
    const before = JSON.parse(readFileSync(path.join(directory, "before.json"), "utf8"));
    if (!before.control.eligible || !before.pinned.supported) throw new Error("pre-attempt-control-refused");
    const cancel = new AbortController();
    const abort = () => cancel.abort();
    process.once("SIGTERM", abort);
    process.once("SIGINT", abort);
    try {
      const measured = await measureDiagnostic({
        env: { ...env, GITHUB_JOB_ID: env.DIAGNOSTIC_CHECK_RUN_ID },
        route: env.DIAGNOSTIC_ROUTE,
        helperOptions: { cancelSignal: cancel.signal },
        persist: (record) => save(directory, "measurement.json", record),
      });
      return measured.result.status;
    } finally {
      process.removeListener("SIGTERM", abort);
      process.removeListener("SIGINT", abort);
    }
  }
  if (command === "finalize") {
    const read = (name) =>
      existsSync(path.join(directory, name)) ? JSON.parse(readFileSync(path.join(directory, name), "utf8")) : undefined;
    const before = read("before.json");
    const measurement = read("measurement.json");
    const status =
      env.DIAGNOSTIC_INSTALL_OUTCOME === "cancelled"
        ? "UNKNOWN"
        : before?.control.status === "NOT_OBSERVED"
          ? "NOT_OBSERVED"
          : !measurement
            ? "NOT_EXECUTED"
            : !measurement.result
              ? "UNKNOWN"
              : measurement.result.status !== 0
                ? "FAIL"
                : measurement.attempts.some((attempt) => attempt.trace?.status !== "PASS")
                  ? "UNKNOWN"
                  : "PASS";
    save(directory, "after.json", {
      capturedAt: new Date().toISOString(),
      native: inventory(),
      cache: cacheSnapshot(cachePath, pinned),
    });
    save(directory, "result.json", {
      status: status === "PASS" ? "UNKNOWN" : status,
      installationStatus: status,
      workflowInstallOutcome: env.DIAGNOSTIC_INSTALL_OUTCOME,
      prepareOutcome: env.DIAGNOSTIC_PREPARE_OUTCOME,
      externalEvidence:
        "UNKNOWN until host reconciles live/completed owning jobs, steps, all API pages/logs, runner region and artifact hashes",
      limitations: [
        "Split command and debug tracing can perturb behavior; not production equivalence",
        "No affected-region failing combined control means regional reproduction NOT_OBSERVED",
        "Lost runner/forced cancellation can prevent finalization; host must retain and reconcile partial cells",
        "Combined native boundary lacks explicit end; native timing UNKNOWN, not subtraction-derived",
        "No natural reliability, Bug fix, or product landing credit",
      ],
    });
    const files = ["before.json", "measurement.json", "after.json", "result.json"].filter((name) =>
      existsSync(path.join(directory, name)),
    );
    save(
      directory,
      "hashes.json",
      Object.fromEntries(files.map((name) => [name, digest(readFileSync(path.join(directory, name)))])),
    );
    return 0;
  }
  throw new Error("diagnostic-command-refused");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv[2], process.env);
  } catch {
    console.error("chromium-install-diagnostics: refused; missing evidence remains UNKNOWN");
    process.exitCode = 1;
  }
}
