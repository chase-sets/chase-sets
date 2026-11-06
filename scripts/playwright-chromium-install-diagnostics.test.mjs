import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyControl,
  cacheSnapshot,
  composeAttempt,
  createPhaseTrace,
  DIAGNOSTIC_DEBUG,
  measureDiagnostic,
  pinnedSource,
  runDecomposed,
} from "./playwright-chromium-install-diagnostics.mjs";
import { runInstaller } from "./provider-browser-install-timeout.mjs";

// Synthetic timestamps/paths; actual message vocabulary from Playwright 1.60.0
// coreBundle browserFetcher/oopDownloadBrowserMain and extractZip.
const titles = [
  "Chrome for Testing 148.0.7778.96 (playwright chromium v1223)",
  "Chrome Headless Shell 148.0.7778.96 (playwright chromium-headless-shell v1223)",
  "FFmpeg (playwright ffmpeg v1011)",
];
const pw = (text) => `2026-11-06T00:00:00.000Z pw:install ${text}\n`;
const extractionEnd = "2026-11-06T00:00:00.000Z extract-zip zip extraction complete\n";
const payloadFixture = (title) => [
  pw(`downloading ${title} - attempt #1`),
  pw("-- download complete, size: 1234"),
  pw(`SUCCESS downloading ${title}`),
  pw("removing existing browser directory if any"),
  pw("extracting archive"),
  extractionEnd,
  pw("fixing permissions at /synthetic/payload"),
  pw(`SUCCESS installing ${title}`),
];
function traceFor(chunks = titles.flatMap(payloadFixture), terminal = "success", options = {}) {
  let clock = 0;
  const trace = createPhaseTrace({ now: () => ++clock, ...options });
  for (const chunk of chunks) trace.consume("stderr", chunk);
  return trace.finish(terminal);
}

afterEach(() => vi.useRealTimers());

describe("pinned phase evidence", () => {
  it("checks the fixture vocabulary against the installed frozen-lockfile implementation", () => {
    expect(pinnedSource()).toMatchObject({
      version: "1.60.0",
      supported: true,
      revisions: { chromium: "1223", "chromium-headless-shell": "1223", ffmpeg: "1011" },
    });
  });
  it("separates fetch/extraction for every actual processed payload and keeps native/residual separate", () => {
    const report = traceFor([
      "chromium-diagnostic-native:start\n",
      "chromium-diagnostic-native:end:0\n",
      "chromium-diagnostic-browser:start\n",
      ...titles.flatMap(payloadFixture),
      "chromium-diagnostic-browser:end:0\n",
    ]);
    expect(report.status).toBe("PASS");
    expect(report.native).toMatchObject({ outcome: "PASS", status: 0 });
    expect(report.payloads.map((entry) => entry.payload)).toEqual(["chromium", "headless-shell", "ffmpeg"]);
    for (const payload of report.payloads) {
      expect(payload.fetchStartMs).toBeLessThan(payload.fetchEndMs);
      expect(payload.fetchEndMs).toBeLessThan(payload.extractStartMs);
      expect(payload.extractStartMs).toBeLessThan(payload.extractEndMs);
      expect(payload.extractEndMs).toBeLessThan(payload.installEndMs);
      expect(payload.extractionStatus).toBe("PASS");
    }
    expect(report.residual).toContain("not extraction");
    expect(report.residualIntervals.some((interval) => interval.kind === "native-validation-and-other-overhead")).toBe(
      true,
    );
    expect(report.residualIntervals.every((interval) => interval.endMs >= interval.startMs)).toBe(true);
  });

  it.each([
    ["missing markers", []],
    ["download complete/extraction hung", payloadFixture(titles[0]).slice(0, 5)],
    [
      "permission work substituted for extraction end",
      titles.flatMap(payloadFixture).filter((text) => text !== extractionEnd),
    ],
    ["reordered extraction event", [extractionEnd, ...titles.flatMap(payloadFixture)]],
    ["unknown payload", [pw("downloading Unknown browser - attempt #1")]],
    ["truncated trace", [pw(`downloading ${titles[0]} - attempt #1`).trim()]],
    ["repeated extraction end", [...titles.flatMap(payloadFixture), extractionEnd]],
  ])("returns UNKNOWN, not invented timing, for %s", (_name, chunks) => {
    expect(traceFor(chunks, "timeout").status).toBe("UNKNOWN");
  });

  it("never calls time until permission/native overhead extraction", () => {
    const report = traceFor(payloadFixture(titles[0]).slice(0, 5), "timeout");
    expect(report.payloads[0]).toMatchObject({ fetchStatus: "PASS", extractionStatus: "UNKNOWN" });
    expect(report.payloads[0].extractEndMs).toBeUndefined();
    expect(report.terminalOutcome).toBe("timeout");
  });

  it("retains provider retries and failures rather than deduplicating executions", () => {
    const chunks = [
      pw(`downloading ${titles[0]} - attempt #1`),
      pw("attempt #1 - ERROR: synthetic"),
      ...titles.flatMap(payloadFixture),
    ];
    const report = traceFor(chunks);
    expect(report.payloads).toHaveLength(4);
    expect(report.payloads[0].failureMs).toBeTypeOf("number");
    expect(report.status).toBe("UNKNOWN");
  });

  it("records cached payloads as NOT_EXECUTED, never zero-duration extraction", () => {
    const report = traceFor(titles.map((title) => pw(`${title} is already downloaded.`)));
    expect(report.status).toBe("PASS");
    expect(
      report.payloads.every((entry) => entry.extractionStatus === "NOT_EXECUTED" && entry.extractEndMs === undefined),
    ).toBe(true);
  });

  it("bounds byte/line/event input and never retains raw URLs, paths or unknown diagnostic text", () => {
    const report = traceFor([
      pw("-- from url: https://synthetic.invalid/file?private=do-not-retain"),
      ...titles.flatMap(payloadFixture),
    ]);
    expect(JSON.stringify(report)).not.toContain("private=");
    expect(JSON.stringify(report)).not.toContain("/synthetic/");
    expect(traceFor(["x".repeat(100)], "timeout", { limits: { bytes: 32, line: 16, events: 2 } }).problems).toContain(
      "trace-limit",
    );
    expect(traceFor(["x".repeat(100)], "timeout", { limits: { bytes: 1000, line: 16, events: 2 } }).problems).toContain(
      "line-limit",
    );
    expect(
      traceFor(titles.flatMap(payloadFixture), "success", { limits: { bytes: 10000, line: 8192, events: 2 } }).problems,
    ).toContain("event-limit");
    let decreasing = 0;
    expect(traceFor(undefined, "success", { now: () => --decreasing }).problems).toContain("nonmonotonic-event");
  });
});

describe("fresh cold/hit admission", () => {
  const pinned = { revisions: { chromium: "1223", "chromium-headless-shell": "1223", ffmpeg: "1011" } };
  function cacheFixture({ omit, unreadable, unowned, symlink, emptyPayload, markerDirectory, revision } = {}) {
    const root = path.resolve("synthetic-owned-cache");
    const entries = new Map();
    const add = (relative, directory = false) => {
      if (relative === omit) return;
      entries.set(path.join(root, relative), {
        uid: relative === unowned ? 8 : 7,
        size: relative === emptyPayload ? 0 : 1,
        isDirectory: () => directory || relative === markerDirectory,
        isFile: () => !directory && relative !== markerDirectory,
        isSymbolicLink: () => relative === symlink,
      });
    };
    add("", true);
    for (const [directory, executable] of [
      [`chromium-${revision ?? "1223"}`, "chrome-linux64/chrome"],
      ["chromium_headless_shell-1223", "chrome-headless-shell-linux64/chrome-headless-shell"],
      ["ffmpeg-1011", "ffmpeg-linux"],
    ]) {
      add(directory, true);
      if (path.dirname(executable) !== ".") add(path.join(directory, path.dirname(executable)), true);
      add(path.join(directory, executable));
      add(path.join(directory, "INSTALLATION_COMPLETE"));
    }
    add(".links", true);
    add(path.join(".links", "synthetic-link"));
    const snapshot = cacheSnapshot(root, pinned, {
      exists: (target) => entries.has(target),
      lstat: (target) => {
        if (!entries.has(target)) throw new Error("synthetic missing");
        return entries.get(target);
      },
      readdir: (target) =>
        [...entries.keys()]
          .filter((item) => item !== target && path.dirname(item) === target)
          .map((item) => path.basename(item)),
      access: (target) => {
        if (target === path.join(root, unreadable ?? "not-present")) throw new Error("synthetic unreadable");
      },
      ownerUid: 7,
    });
    return snapshot;
  }

  it("validates exact Chromium, headless-shell and FFmpeg only inside the diagnostic inspector", () => {
    expect(cacheFixture()).toMatchObject({
      state: "complete",
      complete: true,
      owned: true,
      readable: true,
      empty: false,
    });
  });

  it.each([
    { omit: path.join("chromium-1223", "INSTALLATION_COMPLETE") },
    { omit: path.join("chromium_headless_shell-1223", "chrome-headless-shell-linux64", "chrome-headless-shell") },
    { omit: path.join("ffmpeg-1011", "ffmpeg-linux") },
    { markerDirectory: path.join("ffmpeg-1011", "INSTALLATION_COMPLETE") },
    { emptyPayload: path.join("chromium-1223", "chrome-linux64", "chrome") },
    { revision: "1222" },
    { unreadable: path.join(".links", "synthetic-link") },
    { unreadable: path.join("chromium-1223", "INSTALLATION_COMPLETE") },
    { unowned: path.join("ffmpeg-1011", "ffmpeg-linux") },
    { symlink: "chromium-1223" },
  ])("rejects one-variable payload/ownership/readability defect %j", (change) => {
    const cache = cacheFixture(change);
    expect(cache.complete).toBe(false);
    expect(classifyControl({ mode: "hit", restored: true, ...cache }).status).toBe("NOT_OBSERVED");
  });

  const hit = { mode: "hit", restored: true, empty: false, complete: true, owned: true, readable: true };
  it("requires restore AND complete owned readable payload BEFORE the attempt", () => {
    expect(classifyControl(hit)).toEqual({ status: "PASS", eligible: true });
    for (const change of [
      { restored: false },
      { empty: true },
      { complete: false },
      { owned: false },
      { readable: false },
    ]) {
      expect(classifyControl({ ...hit, ...change })).toMatchObject({ status: "NOT_OBSERVED", eligible: false });
    }
  });
  it("rejects cold-as-hit, warmed cold and invalid control modes", () => {
    expect(classifyControl({ ...hit, restored: false, complete: false, empty: true }).eligible).toBe(false);
    expect(classifyControl({ ...hit, mode: "cold" })).toMatchObject({ status: "FAIL", eligible: false });
    expect(classifyControl({ ...hit, mode: "cold", empty: true })).toMatchObject({ status: "PASS", eligible: true });
    expect(classifyControl({ ...hit, mode: "warm" }).status).toBe("FAIL");
  });
});

const env = {
  PLAYWRIGHT_BROWSERS_PATH: path.resolve("synthetic-diagnostic-cache"),
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
};
function fakeOwnedInstall({
  results = ["timeout", "success"],
  route = "decomposed",
  cleanupRefusal = false,
  signal,
} = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
  let complete = false;
  const calls = [];
  const persisted = [];
  const remove = vi.fn(() => {
    if (cleanupRefusal) throw new Error("synthetic cleanup refusal");
  });
  const supervise = vi.fn(async (options) => {
    calls.push(options);
    const outcome = results[calls.length - 1];
    complete = outcome === "success";
    options.write(`provider-browser-install-timing/v1 synthetic-attempt-${calls.length}`);
    return {
      status: complete ? 0 : 1,
      ...(outcome === "start-refusal" ? { startRefused: true } : {}),
      record: { terminalOutcome: outcome === "start-refusal" ? "refused" : outcome },
    };
  });
  const result = measureDiagnostic({
    env,
    route,
    supervise,
    now: () => Date.now(),
    persist: (record) => persisted.push(structuredClone(record)),
    helperOptions: {
      inspectCacheImpl: () => ({ state: complete ? "complete" : "cold", complete, owned: true }),
      removeCacheImpl: remove,
      delayImpl: vi.fn(async (ms) => {
        vi.advanceTimersByTime(ms);
      }),
      cancelSignal: signal,
    },
  });
  return { result, supervise, calls, remove, persisted };
}

describe("one shipped lifecycle, no phase timeout reset", () => {
  it("retains both attempts, retry/cleanup events, whole-step and final status", async () => {
    const run = fakeOwnedInstall();
    const report = await run.result;
    expect(report.result.status).toBe(0);
    expect(report.attempts.map((attempt) => attempt.status)).toEqual(["FAIL", "PASS"]);
    expect(report.helperEvents.some((line) => line.startsWith("Playwright Chromium install retry "))).toBe(true);
    expect(run.remove).toHaveBeenCalledTimes(1);
    expect(run.calls.every((call) => call.timeoutSeconds === 180 && call.requireComplete === false)).toBe(true);
    expect(
      run.calls.every(
        (call) => call.installerCommand === process.execPath && call.installerArgs.at(-1) === "install-phases",
      ),
    ).toBe(true);
    expect(run.persisted.at(-1).elapsedMs).toBe(5000);
    expect(run.persisted.at(-1).attempts).toHaveLength(2);
    expect(report.attempts.map((attempt) => attempt.supervisorEvents)).toEqual([
      ["provider-browser-install-timing/v1 synthetic-attempt-1"],
      ["provider-browser-install-timing/v1 synthetic-attempt-2"],
    ]);
  });

  it.each(["start-refusal", "cancelled", "cleanup-failure"])("never retries terminal %s", async (outcome) => {
    const run = fakeOwnedInstall({ results: [outcome, "success"] });
    expect((await run.result).result.status).toBe(1);
    expect(run.supervise).toHaveBeenCalledTimes(1);
  });

  it("never retries cleanup refusal or a third timed-out attempt", async () => {
    const refused = fakeOwnedInstall({ cleanupRefusal: true });
    expect((await refused.result).result.reason).toBe("cleanup-refusal");
    expect(refused.supervise).toHaveBeenCalledTimes(1);
    const timeout = fakeOwnedInstall({ results: ["timeout", "timeout", "success"] });
    expect((await timeout.result).result.status).toBe(1);
    expect(timeout.supervise).toHaveBeenCalledTimes(2);
  });

  it("leaves the unchanged combined pnpm command intact and adds only trace environment", async () => {
    const run = fakeOwnedInstall({ route: "combined", results: ["success"] });
    await run.result;
    expect(run.calls[0].installerArgs.slice(-5)).toEqual(["exec", "playwright", "install", "--with-deps", "chromium"]);
    expect(run.calls[0].installerEnv.DEBUG).toBe(DIAGNOSTIC_DEBUG);
  });

  it("refuses changed bounds, route and retry policy", () => {
    const options = {
      timeoutSeconds: 180,
      env: { PLAYWRIGHT_INSTALL_POLICY: "diagnostic-retry" },
      installerArgs: ["unchanged"],
    };
    expect(composeAttempt(options, "combined").installerArgs).toEqual(["unchanged"]);
    for (const mutant of [
      { ...options, timeoutSeconds: 181 },
      { ...options, env: { PLAYWRIGHT_INSTALL_POLICY: "single-attempt" } },
      { ...options, env: { PLAYWRIGHT_INSTALL_POLICY: "e2e-retry" } },
    ])
      expect(() => composeAttempt(mutant, "combined")).toThrow("diagnostic-composition-refused");
    expect(() => composeAttempt(options, "arbitrary")).toThrow();
  });

  it("taps output before the real supervisor consumes it without replacing spawn options", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    const spawnImpl = vi.fn(() => child);
    const result = await measureDiagnostic({
      env,
      route: "combined",
      spawnImpl,
      install: async (options) =>
        options.runInstallerImpl({
          timeoutSeconds: 180,
          env: { PLAYWRIGHT_INSTALL_POLICY: "diagnostic-retry" },
          write: () => {},
        }),
      supervise: async (options) => {
        const actual = options.spawnImpl("synthetic", [], { detached: true });
        for (const chunk of titles.flatMap(payloadFixture)) actual.stderr.write(chunk);
        return { status: 0, record: { terminalOutcome: "success" } };
      },
    });
    expect(spawnImpl).toHaveBeenCalledWith("synthetic", [], { detached: true });
    expect(result.attempts[0].trace.status).toBe("PASS");
  });
});

describe("fixed decomposition child", () => {
  it.each([0, 7])("preserves native status %s and never starts browser work after failure", async (nativeStatus) => {
    const calls = [];
    const lines = [];
    const status = await runDecomposed({
      env: {},
      write: (line) => lines.push(line),
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        queueMicrotask(() => child.emit("close", calls.length === 1 ? nativeStatus : 0));
        return child;
      },
    });
    expect(status).toBe(nativeStatus);
    expect(calls[0].args.slice(-4)).toEqual(["exec", "playwright", "install-deps", "chromium"]);
    expect(calls).toHaveLength(nativeStatus === 0 ? 2 : 1);
    if (nativeStatus === 0) expect(calls[1].args.slice(-4)).toEqual(["exec", "playwright", "install", "chromium"]);
    expect(lines).toContain(`chromium-diagnostic-native:end:${nativeStatus}\n`);
    expect(calls.every((call) => call.options.stdio.join() === "ignore,inherit,inherit")).toBe(true);
  });
});

describe("real supervisor with fake owned children and fake time only", () => {
  function ownedRun({ signalRefusal = false, cancelSignal } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
    const children = [];
    const signals = vi.fn(() => {
      if (signalRefusal) throw new Error("synthetic signal refusal");
    });
    const snapshots = [];
    const result = measureDiagnostic({
      env,
      route: "decomposed",
      now: () => Date.now(),
      persist: (record) => snapshots.push(structuredClone(record)),
      spawnImpl: () => {
        const child = Object.assign(new EventEmitter(), {
          pid: 1234 + children.length,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          send: vi.fn(),
        });
        children.push(child);
        return child;
      },
      supervise: (options) => runInstaller({ ...options, signalGroupImpl: signals }),
      helperOptions: {
        cancelSignal,
        delayImpl: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        inspectCacheImpl: () => ({ state: "cold", complete: false, owned: true }),
        removeCacheImpl: vi.fn(),
      },
    });
    return { result, children, signals, snapshots };
  }

  it("keeps 180s attempts, 5s cleanup and retry delay within the 390s envelope", async () => {
    const run = ownedRun();
    await vi.advanceTimersByTimeAsync(180000);
    expect(run.signals.mock.calls).toEqual([[1234, "TERM"]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run.signals.mock.calls).toEqual([
      [1234, "TERM"],
      [1234, "KILL"],
    ]);
    expect(run.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run.children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(185000);
    const report = await run.result;
    expect(report.result.status).toBe(1);
    expect(report.attempts.map((attempt) => attempt.elapsedMs)).toEqual([185000, 185000]);
    expect(run.snapshots.at(-1).elapsedMs).toBe(375000);
    expect(run.children).toHaveLength(2);
    expect(run.signals.mock.calls.at(-1)).toEqual([1235, "KILL"]);
  });

  it.each(["cancellation", "cleanup refusal"])("does not retry real-supervisor %s", async (reason) => {
    const cancel = new AbortController();
    const run = ownedRun({ signalRefusal: reason === "cleanup refusal", cancelSignal: cancel.signal });
    if (reason === "cancellation") cancel.abort();
    else await vi.advanceTimersByTimeAsync(180000);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await run.result).result.reason).toBe(reason === "cancellation" ? "cancelled" : "cleanup-failure");
    expect(run.children).toHaveLength(1);
  });

  it("waits for the started-child error cleanup barrier before removal or another attempt", async () => {
    const run = ownedRun();
    run.children[0].emit("spawn");
    run.children[0].emit("error", new Error("synthetic started error"));
    run.children[0].emit("error", new Error("synthetic late error"));
    await vi.advanceTimersByTimeAsync(4999);
    expect(run.children).toHaveLength(1);
    expect(run.snapshots.at(-1).attempts[0].status).toBe("UNKNOWN");
    await vi.advanceTimersByTimeAsync(1);
    expect(run.signals.mock.calls).toEqual([
      [1234, "TERM"],
      [1234, "KILL"],
    ]);
    expect(run.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run.children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(185000);
    const report = await run.result;
    expect(report.attempts.map((attempt) => attempt.result.record.terminalOutcome)).toEqual(["refused", "timeout"]);
    expect(report.attempts.every((attempt) => attempt.supervisorEvents.length === 1)).toBe(true);
  });
});
