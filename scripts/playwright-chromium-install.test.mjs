import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  inspectCache,
  installPlaywrightChromium,
  removeCache,
  validateCachePath,
} from "./playwright-chromium-install.mjs";
import { runInstaller } from "./provider-browser-install-timeout.mjs";

const directories = [];
const makeCache = () => {
  const root = mkdtempSync(path.join(tmpdir(), "playwright-chromium-install-"));
  directories.push(root);
  return root;
};
const envFor = (cachePath) => ({
  PLAYWRIGHT_BROWSERS_PATH: cachePath,
  PLAYWRIGHT_INSTALL_SITE: "staging-uat",
  PLAYWRIGHT_INSTALL_ATTEMPT: "2",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  GH_TOKEN: "PRIVATE_TOKEN",
  PROVIDER_SECRET: "PRIVATE_PROVIDER",
});
const writeBrowser = (cache, directory, payload, { marker = true } = {}) => {
  mkdirSync(path.join(cache, directory, path.dirname(payload)), { recursive: true });
  writeFileSync(path.join(cache, directory, payload), "payload");
  if (marker) writeFileSync(path.join(cache, directory, "INSTALLATION_COMPLETE"), "");
};
// The Linux x64 layout Playwright 1.60 writes for `playwright install chromium`.
const writeInstalledChromium = (cache) => {
  writeBrowser(cache, "chromium-1223", "chrome-linux64/chrome");
  writeBrowser(cache, "chromium_headless_shell-1223", "chrome-headless-shell-linux64/chrome-headless-shell");
};
const isRetryLine = (line) => line.startsWith("Playwright Chromium install retry ");
const isTimingLine = (line) => line.startsWith("provider-browser-install-timing/v1 ");
const failedAttempt = (terminalOutcome) => async () => ({ status: 1, record: { terminalOutcome } });

afterEach(() => {
  vi.useRealTimers();
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

// Real supervisor lifecycle with a fake detached child per attempt and fake time.
function supervisedInstall({ signalGroupImpl = vi.fn(), cancelSignal, removeCacheImpl = removeCache } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  const cache = makeCache();
  const children = [];
  const signalsAtSpawn = [];
  const spawnImpl = vi.fn(() => {
    signalsAtSpawn.push(signalGroupImpl.mock.calls.length);
    const child = Object.assign(new EventEmitter(), {
      pid: 4567 + children.length,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      send: vi.fn(),
    });
    children.push(child);
    return child;
  });
  const delayImpl = vi.fn((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const lines = [];
  const startedAt = Date.now();
  const result = installPlaywrightChromium({
    env: envFor(cache),
    cancelSignal,
    delayImpl,
    removeCacheImpl,
    runInstallerImpl: (options) => runInstaller({ ...options, spawnImpl, signalGroupImpl }),
    write: (line) => lines.push(line),
  });
  return {
    cache,
    children,
    delayImpl,
    elapsedMs: () => Date.now() - startedAt,
    lines,
    result,
    signalGroupImpl,
    signalsAtSpawn,
    spawnImpl,
  };
}

describe("Playwright Chromium installer primitive", () => {
  it.each(["relative/cache", "~/cache", path.parse(process.cwd()).root])(
    "refuses unsafe cache path: %s",
    async (cachePath) => {
      expect(() => validateCachePath(cachePath)).toThrow("invalid-cache-path");
      const lines = [];
      const result = await installPlaywrightChromium({ env: envFor(cachePath), write: (line) => lines.push(line) });
      expect(result).toMatchObject({ status: 1, reason: "invalid-path", cache: "invalid" });
      expect(lines[0]).toContain("Playwright Chromium install failed");
      expect(lines[0]).not.toMatch(/PRIVATE/);
    },
  );

  it("AC1 delegates lifecycle to the shipped supervisor module, not a copied process loop", () => {
    const source = readFileSync("scripts/playwright-chromium-install.mjs", "utf8");
    // The retry wait is the only timer the helper may own: one exact promise import.
    const waitImport = /^import \{ setTimeout as delay \} from "node:timers\/promises";\r?\n/gm;
    expect(source.match(waitImport)).toHaveLength(1);
    const guarded = source.replace(waitImport, "");
    expect(guarded).toContain(
      'import { INSTALLER_TIMEOUT_GRACE_MS, runInstaller } from "./provider-browser-install-timeout.mjs";',
    );
    expect(guarded).toContain("runInstallerImpl = runInstaller,");
    expect(guarded).toContain("timeoutSeconds: PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS,");
    expect(guarded).toContain("delayImpl = delay,");
    expect(guarded).not.toMatch(/\bdelay\s*\(/);
    expect(guarded.match(/\bdelayImpl\s*\(/g)).toHaveLength(1);
    expect(guarded).not.toMatch(/signalGroup|superviseInstaller|child_process|spawn\s*\(/);
    expect(guarded).not.toMatch(
      /setTimeout|setInterval|process\.kill|\.kill\s*\(|AbortController|AbortSignal|Promise\.race/,
    );
  });

  it("AC4 composes only the E2E caller with a bounded, loudly failing install step", () => {
    const workflow = parse(readFileSync(".github/workflows/platform-pr.yml", "utf8"));
    const job = workflow.jobs["e2e-tests"];
    expect(job["timeout-minutes"]).toBe(25);
    expect(job["continue-on-error"]).toBeUndefined();
    const at = (name) => job.steps.findIndex((step) => step.name === name);
    const resolveAt = at("Resolve Playwright Chromium cache");
    expect([
      at("Cache Playwright Chromium"),
      at("Install Playwright Chromium"),
      at("Run marketplace e2e suites"),
    ]).toEqual([resolveAt + 1, resolveAt + 2, resolveAt + 3]);
    const [resolveStep, cache, install, suites] = job.steps.slice(resolveAt, resolveAt + 4);
    expect(resolveStep.run).toContain("set -euo pipefail");
    expect(resolveStep.run).toContain(
      'browser_path="${RUNNER_TEMP}/playwright-chromium/${RUNNER_OS}/${RUNNER_ARCH}/${version}"',
    );
    expect(cache.with).toEqual({
      path: "${{ steps.playwright-chromium.outputs.browser-path }}",
      key: "e2e-playwright-chromium-${{ runner.os }}-${{ runner.arch }}-${{ steps.playwright-chromium.outputs.version }}",
    });
    // Exact step: no continue-on-error, if:, shell wrapper, pipe or fallback can mask a nonzero exit.
    expect(install).toEqual({
      name: "Install Playwright Chromium",
      "timeout-minutes": 7,
      env: {
        GITHUB_JOB_ID: "${{ job.check_run_id }}",
        BOUNDARY_HEAD_SHA: "${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha || '' }}",
      },
      run: "node scripts/playwright-chromium-install.mjs",
    });
    expect(suites.if).toBeUndefined();
    expect(suites["continue-on-error"]).toBeUndefined();
    expect(suites.run.startsWith("set -o pipefail\n")).toBe(true);
    expect(suites.env.PLAYWRIGHT_BROWSERS_PATH).toBe("${{ steps.playwright-chromium.outputs.browser-path }}");
    expect(job.steps.filter((step) => /playwright install/.test(step.run ?? ""))).toEqual([]);
    const required = workflow.jobs["pr-required"];
    expect(required.needs).toContain("e2e-tests");
    expect(required.steps.map((step) => step.run ?? "").join("\n")).toContain(
      `require_job "E2E Tests" "\${{ needs['e2e-tests'].result }}" "\${{ needs['change-scope'].outputs.e2e_tests_required }}"`,
    );
  });

  it("AC1 passes the native 180-second bound and retries one failed attempt sequentially", async () => {
    const cache = makeCache();
    const calls = [];
    const runInstallerImpl = vi.fn(async (options) => {
      calls.push(options);
      if (calls.length === 2) {
        writeInstalledChromium(cache);
        return { status: 0, record: { terminalOutcome: "success" } };
      }
      return { status: 1, record: { terminalOutcome: "timeout" } };
    });
    const result = await installPlaywrightChromium({
      env: envFor(cache),
      runInstallerImpl,
      delayImpl: vi.fn(async () => {}),
      write: () => {},
    });
    expect(result).toMatchObject({ status: 0, reason: "success" });
    expect(runInstallerImpl).toHaveBeenCalledTimes(2);
    expect(calls.map(({ timeoutSeconds }) => timeoutSeconds)).toEqual([180, 180]);
    expect(calls.map(({ installerArgs }) => installerArgs)).toEqual([
      ["exec", "playwright", "install", "--with-deps", "chromium"],
      ["exec", "playwright", "install", "--with-deps", "chromium"],
    ]);
  });

  it("AC1 waits five seconds between retryable attempts and emits one retry diagnostic", async () => {
    const cache = makeCache();
    let nowMs = 0;
    const delayImpl = vi.fn(async (milliseconds) => {
      nowMs += milliseconds;
    });
    let calls = 0;
    const lines = [];
    const result = await installPlaywrightChromium({
      env: envFor(cache),
      now: () => nowMs,
      delayImpl,
      runInstallerImpl: async (options) => {
        calls += 1;
        options.write(`provider-browser-install-timing/v1 ${calls}`);
        if (calls === 2) {
          writeInstalledChromium(cache);
          return { status: 0, record: { terminalOutcome: "success" } };
        }
        return { status: 1, record: { terminalOutcome: "timeout" } };
      },
      write: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ status: 0, reason: "success" });
    expect(delayImpl.mock.calls).toEqual([[5_000]]);
    expect(lines).toEqual([
      'Playwright Chromium install retry {"site":"staging-uat","attempt":"2","installerAttempt":1,"reason":"timeout","cache":"incomplete"}',
      "provider-browser-install-timing/v1 2",
    ]);
  });

  it("AC1 never waits or retries after a first-attempt success", async () => {
    const cache = makeCache();
    const delayImpl = vi.fn(async () => {});
    const runInstallerImpl = vi.fn(async () => {
      writeInstalledChromium(cache);
      return { status: 0, record: { terminalOutcome: "success" } };
    });
    const lines = [];
    const result = await installPlaywrightChromium({
      env: envFor(cache),
      delayImpl,
      runInstallerImpl,
      write: (line) => lines.push(line),
    });
    expect(result).toMatchObject({ status: 0, reason: "success", cache: "complete" });
    expect(runInstallerImpl).toHaveBeenCalledOnce();
    expect(delayImpl).not.toHaveBeenCalled();
    expect(lines.filter(isRetryLine)).toEqual([]);
  });

  it.each(["timeout", "refused", "partial-download", "checksum-failure", "cache-restore-failure"])(
    "AC1 retries a completed %s attempt exactly once",
    async (outcome) => {
      const cache = makeCache();
      const runInstallerImpl = vi.fn(failedAttempt(outcome));
      const lines = [];
      const result = await installPlaywrightChromium({
        env: envFor(cache),
        runInstallerImpl,
        delayImpl: vi.fn(async () => {}),
        write: (line) => lines.push(line),
      });
      expect(result).toMatchObject({ status: 1, reason: outcome });
      expect(runInstallerImpl).toHaveBeenCalledTimes(2);
      expect(lines.filter(isRetryLine)).toEqual([expect.stringContaining(`"reason":"${outcome}"`)]);
    },
  );

  it.each([
    ["cancelled", failedAttempt("cancelled"), 1],
    ["cleanup-failure", failedAttempt("cleanup-failure"), 0],
    [
      "authority-refusal",
      async () => {
        throw new Error("provider-browser-install authority or 600-second bound refused");
      },
      1,
    ],
  ])(
    "AC1 treats a %s attempt as terminal: no wait, retry line or second attempt",
    async (reason, attemptImpl, removals) => {
      const cache = makeCache();
      const runInstallerImpl = vi.fn(attemptImpl);
      const removeCacheImpl = vi.fn();
      const delayImpl = vi.fn(async () => {});
      const lines = [];
      const result = await installPlaywrightChromium({
        env: envFor(cache),
        runInstallerImpl,
        removeCacheImpl,
        delayImpl,
        write: (line) => lines.push(line),
      });
      expect(result).toMatchObject({ status: 1, reason });
      expect(runInstallerImpl).toHaveBeenCalledOnce();
      expect(delayImpl).not.toHaveBeenCalled();
      expect(lines.filter(isRetryLine)).toEqual([]);
      expect(removeCacheImpl).toHaveBeenCalledTimes(removals);
    },
  );

  it("AC1 does not start a retry that cannot finish inside the 390-second envelope", async () => {
    // 200 s elapsed + 5 s wait + 180 s bound + 5 s grace = 390 s still fits; one more millisecond does not.
    for (const [elapsedMs, attempts] of [
      [200_000, 2],
      [200_001, 1],
    ]) {
      const cache = makeCache();
      let nowMs = 0;
      const delayImpl = vi.fn(async (milliseconds) => {
        nowMs += milliseconds;
      });
      const runInstallerImpl = vi.fn(async () => {
        nowMs += elapsedMs;
        return { status: 1, record: { terminalOutcome: "timeout" } };
      });
      const lines = [];
      const result = await installPlaywrightChromium({
        env: envFor(cache),
        now: () => nowMs,
        delayImpl,
        runInstallerImpl,
        write: (line) => lines.push(line),
      });
      expect(result).toMatchObject({ status: 1, reason: "timeout" });
      expect(runInstallerImpl).toHaveBeenCalledTimes(attempts);
      expect(delayImpl).toHaveBeenCalledTimes(attempts - 1);
      expect(lines.filter(isRetryLine)).toHaveLength(attempts - 1);
    }
  });

  it("AC1 rechecks the 390-second envelope after the five-second wait", async () => {
    const cache = makeCache();
    let nowMs = 0;
    const runInstallerImpl = vi.fn(async () => {
      nowMs += 190_000;
      return { status: 1, record: { terminalOutcome: "timeout" } };
    });
    const result = await installPlaywrightChromium({
      env: envFor(cache),
      now: () => nowMs,
      // The wait overruns: 190 s + 15.001 s leaves less than the 185 s a retry needs.
      delayImpl: vi.fn(async () => {
        nowMs += 15_001;
      }),
      runInstallerImpl,
      write: () => {},
    });
    expect(result).toMatchObject({ status: 1, reason: "timeout" });
    expect(runInstallerImpl).toHaveBeenCalledOnce();
  });

  it("AC1 does not retry when cancellation arrives during the five-second wait", async () => {
    const cache = makeCache();
    const controller = new AbortController();
    const runInstallerImpl = vi.fn(failedAttempt("timeout"));
    const result = await installPlaywrightChromium({
      env: envFor(cache),
      cancelSignal: controller.signal,
      runInstallerImpl,
      delayImpl: vi.fn(async () => controller.abort()),
      write: () => {},
    });
    expect(result).toMatchObject({ status: 1, reason: "cancelled" });
    expect(runInstallerImpl).toHaveBeenCalledOnce();
  });

  it("AC2 executes one bounded installer attempt and preserves terminal cancellation", async () => {
    const cache = makeCache();
    const controller = new AbortController();
    let options;
    const runInstallerImpl = vi.fn(async (value) => {
      options = value;
      controller.abort();
      return { status: 1, record: { terminalOutcome: "cancelled" } };
    });
    const result = await installPlaywrightChromium({
      env: envFor(cache),
      cancelSignal: controller.signal,
      runInstallerImpl,
      write: () => {},
    });
    expect(runInstallerImpl).toHaveBeenCalledOnce();
    expect(options).toMatchObject({
      installerArgs: ["exec", "playwright", "install", "--with-deps", "chromium"],
      requireComplete: false,
      cancelSignal: controller.signal,
    });
    expect(result).toMatchObject({ status: 1, reason: "cancelled" });
  });

  it("AC2 composes the real supervisor with the primitive command, env boundary and release", async () => {
    vi.useFakeTimers();
    const cache = makeCache();
    const child = Object.assign(new EventEmitter(), {
      pid: 4567,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      send: vi.fn(),
    });
    const spawnImpl = vi.fn(() => child);
    const signalGroupImpl = vi.fn();
    const buildInvocationImpl = vi.fn(() => ({ command: process.execPath, args: ["-e", "process.exit(0)"] }));
    const lines = [];
    const resultPromise = installPlaywrightChromium({
      env: envFor(cache),
      buildInvocationImpl,
      runInstallerImpl: (options) => runInstaller({ ...options, spawnImpl, signalGroupImpl }),
      write: (line) => lines.push(line),
    });
    const spawnArgs = spawnImpl.mock.calls[0][1];
    expect(JSON.parse(Buffer.from(spawnArgs[2], "base64url").toString("utf8"))).toEqual({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    });
    expect(spawnImpl.mock.calls[0][2].env).toMatchObject({
      PLAYWRIGHT_BROWSERS_PATH: path.resolve(cache),
      PLAYWRIGHT_INSTALL_SITE: "staging-uat",
      PLAYWRIGHT_INSTALL_ATTEMPT: "2",
    });
    expect(spawnImpl.mock.calls[0][2].env).not.toHaveProperty("GH_TOKEN");
    expect(spawnImpl.mock.calls[0][2].env).not.toHaveProperty("PROVIDER_SECRET");
    writeInstalledChromium(cache);
    child.emit("message", { installerStatus: 0 });
    expect(child.send).toHaveBeenCalledWith("release");
    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ status: 0, reason: "success" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("provider-browser-install-timing/v1");
    expect(signalGroupImpl).not.toHaveBeenCalled();
  });

  it("AC2 times out both real supervised attempts with TERM, five-second grace and KILL, never overlapping", async () => {
    const f = supervisedInstall();
    expect(f.spawnImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(179_999);
    expect(f.signalGroupImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    // The leader exits; a TERM-resistant descendant still owns the group until KILL.
    f.children[0].emit("close", 0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.spawnImpl).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.spawnImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(185_000);
    await expect(f.result).resolves.toMatchObject({ status: 1, reason: "timeout" });
    expect(f.signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
      [4568, "TERM"],
      [4568, "KILL"],
    ]);
    expect(f.signalsAtSpawn).toEqual([0, 2]);
    expect(f.elapsedMs()).toBe(375_000);
    expect(f.delayImpl.mock.calls).toEqual([[5_000]]);
    expect(f.lines.filter(isRetryLine)).toHaveLength(1);
    expect(f.lines.filter(isTimingLine)).toHaveLength(1);
    expect(f.lines.at(-1)).toContain('"reason":"timeout"');
  });

  it("AC2 relays the first real supervisor timeout as one retry line before a successful attempt", async () => {
    const f = supervisedInstall();
    await vi.advanceTimersByTimeAsync(190_000);
    expect(f.spawnImpl).toHaveBeenCalledTimes(2);
    writeInstalledChromium(f.cache);
    f.children[1].emit("message", { installerStatus: 0 });
    expect(f.children[1].send).toHaveBeenCalledWith("release");
    f.children[1].emit("close", 0);
    await expect(f.result).resolves.toMatchObject({ status: 0, reason: "success", cache: "complete" });
    expect(f.lines).toHaveLength(2);
    expect(f.lines[0]).toBe(
      'Playwright Chromium install retry {"site":"staging-uat","attempt":"2","installerAttempt":1,"reason":"timeout","cache":"incomplete"}',
    );
    expect(JSON.parse(f.lines[1].slice("provider-browser-install-timing/v1 ".length))).toMatchObject({
      terminalOutcome: "success",
    });
  });

  it("AC2 ends a cancelled real supervised attempt after TERM and grace without a retry", async () => {
    const controller = new AbortController();
    const f = supervisedInstall({ cancelSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort();
    expect(f.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    await vi.advanceTimersByTimeAsync(400_001);
    expect(f.spawnImpl).toHaveBeenCalledOnce();
    expect(f.delayImpl).not.toHaveBeenCalled();
    expect(f.signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);
    await expect(f.result).resolves.toMatchObject({ status: 1, reason: "cancelled" });
    expect(f.lines.filter(isRetryLine)).toEqual([]);
    expect(f.lines.filter(isTimingLine)).toHaveLength(1);
  });

  it("AC2 stops on a real supervisor cleanup failure without retrying or touching the tree", async () => {
    const signalGroupImpl = vi.fn(() => {
      throw new Error("synthetic cleanup refusal");
    });
    const removeCacheImpl = vi.fn();
    const f = supervisedInstall({ signalGroupImpl, removeCacheImpl });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(f.spawnImpl).toHaveBeenCalledOnce();
    expect(signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);
    expect(removeCacheImpl).not.toHaveBeenCalled();
    expect(f.delayImpl).not.toHaveBeenCalled();
    await expect(f.result).resolves.toMatchObject({ status: 1, reason: "cleanup-failure" });
    expect(f.lines.filter(isTimingLine)).toHaveLength(1);
  });

  it("AC2 emits one primitive terminal line when the supervisor succeeds without a cache payload", async () => {
    const cache = makeCache();
    const lines = [];
    const runInstallerImpl = vi.fn(async () => ({ status: 0, record: { terminalOutcome: "success" } }));
    const resultPromise = installPlaywrightChromium({
      env: envFor(cache),
      runInstallerImpl,
      delayImpl: vi.fn(async () => {}),
      write: (line) => lines.push(line),
    });
    await expect(resultPromise).resolves.toMatchObject({ status: 1, reason: "incomplete-cache" });
    expect(runInstallerImpl).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Playwright Chromium install retry");
    expect(lines[1]).toContain('"reason":"incomplete-cache"');
  });

  it("AC5 refuses invalid environment fields before composition", async () => {
    for (const [key, value] of [
      ["PLAYWRIGHT_INSTALL_SITE", "bad site;x"],
      ["PLAYWRIGHT_INSTALL_ATTEMPT", "bad attempt"],
    ]) {
      const cache = makeCache();
      const runInstallerImpl = vi.fn();
      const lines = [];
      const result = await installPlaywrightChromium({
        env: { ...envFor(cache), [key]: value },
        runInstallerImpl,
        write: (line) => lines.push(line),
      });
      expect(result).toMatchObject({ status: 1, reason: "invalid-environment", cache: "invalid" });
      expect(runInstallerImpl).not.toHaveBeenCalled();
      expect(lines).toEqual([expect.stringContaining('"reason":"invalid-environment"')]);
    }
  });

  it("AC5 propagates the CLI refusal exit and never prints the caller secret", () => {
    const result = spawnSync(process.execPath, ["scripts/playwright-chromium-install.mjs"], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        PLAYWRIGHT_BROWSERS_PATH: "relative/cache",
        GH_TOKEN: "PRIVATE_TOKEN",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain('"reason":"invalid-path"');
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("PRIVATE_TOKEN");
  });

  it("AC3 passes only explicit non-secret child metadata and never relays raw provider output", async () => {
    const cache = makeCache();
    const captured = [];
    const runInstallerImpl = vi.fn(async ({ installerEnv }) => {
      captured.push(installerEnv);
      writeInstalledChromium(cache);
      return { status: 0, record: { terminalOutcome: "success" } };
    });
    const lines = [];
    const result = await installPlaywrightChromium({
      env: envFor(cache),
      runInstallerImpl,
      write: (line) => lines.push(line),
    });
    expect(result.status).toBe(0);
    expect(captured).toEqual([
      {
        PLAYWRIGHT_BROWSERS_PATH: path.resolve(cache),
        PLAYWRIGHT_INSTALL_SITE: "staging-uat",
        PLAYWRIGHT_INSTALL_ATTEMPT: "2",
      },
    ]);
    expect(lines.join("\n")).not.toMatch(/PRIVATE|provider response|<html>/);
  });

  it("AC4 distinguishes cold, incomplete and recursively unowned caches", () => {
    const cache = makeCache();
    expect(inspectCache(path.join(cache, "absent")).state).toBe("cold");
    expect(inspectCache(cache).state).toBe("incomplete");
    writeInstalledChromium(cache);
    expect(inspectCache(cache).state).toBe("complete");
    const stats = new Map([
      [cache, { isDirectory: () => true, isSymbolicLink: () => false, uid: 7 }],
      [path.join(cache, "chromium-1"), { isDirectory: () => true, isSymbolicLink: () => false, uid: 7 }],
      [path.join(cache, "chromium-1", "chrome"), { isDirectory: () => false, isSymbolicLink: () => false, uid: 8 }],
    ]);
    const mismatched = inspectCache(cache, {
      ownerUid: 7,
      lstat: (entry) => stats.get(entry),
      readdir: (entry) => (entry === cache ? ["chromium-1"] : ["chrome"]),
    });
    expect(mismatched).toMatchObject({ state: "mismatched", owned: false });
  });

  it("AC4 accepts Playwright registry extras that carry no installation marker", () => {
    const cache = makeCache();
    writeInstalledChromium(cache);
    mkdirSync(path.join(cache, ".links"), { recursive: true });
    writeFileSync(path.join(cache, ".links", "0123456789abcdef"), "/workspace/node_modules/playwright-core");
    mkdirSync(path.join(cache, "ffmpeg-1011"), { recursive: true });
    writeFileSync(path.join(cache, "ffmpeg-1011", "ffmpeg-linux"), "payload");
    expect(inspectCache(cache)).toMatchObject({ state: "complete", complete: true });
  });

  it.each([
    ["Chromium without its installation marker", { chromium: { marker: false } }],
    ["headless shell without its installation marker", { headlessShell: { marker: false } }],
    ["no headless shell browser", { headlessShell: null }],
    ["no Chromium browser", { chromium: null }],
    ["a marked Chromium directory without its payload", { chromiumPayload: "chrome-linux64/resources.pak" }],
    ["a marked headless shell directory without its payload", { headlessPayload: "chrome-headless-shell-linux64/x" }],
  ])("AC4 treats a cache with %s as incomplete", (_name, layout) => {
    const cache = makeCache();
    if (layout.chromium !== null) {
      writeBrowser(cache, "chromium-1223", layout.chromiumPayload ?? "chrome-linux64/chrome", layout.chromium);
    }
    if (layout.headlessShell !== null) {
      writeBrowser(
        cache,
        "chromium_headless_shell-1223",
        layout.headlessPayload ?? "chrome-headless-shell-linux64/chrome-headless-shell",
        layout.headlessShell,
      );
    }
    expect(inspectCache(cache)).toMatchObject({ state: "incomplete", complete: false });
  });

  it.each([
    ["the Chromium payload", ["chromium-1223", "chrome-linux64", "chrome"]],
    ["the headless shell marker", ["chromium_headless_shell-1223", "INSTALLATION_COMPLETE"]],
    ["a registry extra", [".links", "0123456789abcdef"]],
  ])("AC4 rejects a cache whose %s is unreadable", (_name, segments) => {
    const cache = makeCache();
    writeInstalledChromium(cache);
    mkdirSync(path.join(cache, ".links"), { recursive: true });
    writeFileSync(path.join(cache, ".links", "0123456789abcdef"), "link");
    const unreadable = path.join(cache, ...segments);
    expect(
      inspectCache(cache, {
        access: (entryPath) => {
          if (entryPath === unreadable) throw new Error("EACCES");
        },
      }),
    ).toMatchObject({ state: "mismatched", complete: false });
  });

  it("AC4 removes the incomplete failed tree before cache publication", async () => {
    const cache = makeCache();
    mkdirSync(path.join(cache, "restored", "deps"), { recursive: true });
    writeFileSync(path.join(cache, "restored", "deps", "package.json"), "{}");
    const result = await installPlaywrightChromium({
      env: envFor(cache),
      runInstallerImpl: failedAttempt("timeout"),
      delayImpl: vi.fn(async () => {}),
      write: () => {},
    });
    expect(result).toMatchObject({ status: 1, reason: "timeout" });
    expect(() => validateCachePath(cache)).not.toThrow();
    expect(inspectCache(cache).state).toBe("cold");
  });

  it("AC5 emits stable refusal diagnostics for authority and cleanup failures", async () => {
    const cache = makeCache();
    const lines = [];
    const authorityRun = vi.fn(async () => {
      throw new Error("secret exception must not escape");
    });
    const authority = await installPlaywrightChromium({
      env: envFor(cache),
      runInstallerImpl: authorityRun,
      write: (line) => lines.push(line),
    });
    expect(authority).toMatchObject({ status: 1, reason: "authority-refusal", cache: "incomplete" });
    expect(authorityRun).toHaveBeenCalledOnce();
    const cleanupRun = vi.fn(failedAttempt("refused"));
    const cleanup = await installPlaywrightChromium({
      env: envFor(cache),
      runInstallerImpl: cleanupRun,
      removeCacheImpl: () => {
        throw new Error("secret cleanup exception");
      },
      write: (line) => lines.push(line),
    });
    expect(cleanup).toMatchObject({ status: 1, reason: "cleanup-refusal" });
    expect(cleanupRun).toHaveBeenCalledOnce();
    expect(lines.join("\n")).toMatch(/site/);
    expect(lines.join("\n")).not.toMatch(/secret|PRIVATE/);
  });

  it("does not allow the installer to treat a directory-only cache as authority", async () => {
    const cache = makeCache();
    const runInstallerImpl = vi.fn(async () => ({ status: 0, record: { terminalOutcome: "success" } }));
    const result = await installPlaywrightChromium({
      env: envFor(cache),
      runInstallerImpl,
      delayImpl: vi.fn(async () => {}),
      write: () => {},
    });
    expect(runInstallerImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 1, reason: "incomplete-cache" });
  });
});
