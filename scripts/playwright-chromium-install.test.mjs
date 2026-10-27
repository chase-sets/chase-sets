import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

describe("Playwright Chromium installer primitive", () => {
  it("AC1/AC2 inventories every scoped caller, budgets its envelope, and leaves E2E separate", () => {
    const workflow = (name) => readFileSync(`.github/workflows/${name}`, "utf8");
    const catalog = workflow("catalog-staging-provider-uat.yml");
    const advisory = workflow("platform-staging-advisory-evidence.yml");
    const route = workflow("platform-staging-route-matrix-evidence.yml");
    const wake = workflow("platform-staging-wake-drills.yml");
    const production = workflow("platform-production.yml");
    const platformPr = workflow("platform-pr.yml");
    for (const source of [catalog, advisory, route, wake, production]) {
      expect(source).toContain("node scripts/playwright-chromium-install.mjs");
      expect(source).not.toMatch(/^ {6}[A-Z_]+: \$\{\{ runner\.temp \}\}/m);
    }
    expect(catalog).toContain("timeout-minutes: 61");
    expect(catalog).toContain('CATALOG_STAGING_PROVIDER_UAT_TEST_TIMEOUT_MS: "3000000"');
    expect(catalog).toContain("timeout-minutes: 50");
    expect(advisory).toContain("timeout-minutes: 90");
    expect(advisory).toContain("timeout-minutes: 11");
    expect(advisory).toContain("timeout-minutes: 79");
    expect(route).toContain("PLAYWRIGHT_INSTALL_SITE: platform-staging-route-matrix-evidence");
    expect(wake).toContain("PLAYWRIGHT_INSTALL_SITE: platform-staging-wake-drills");
    expect(production).toContain("timeout-minutes: 21");
    expect(production).toContain('PLAYWRIGHT_INSTALL_ATTEMPT: "1"');
    expect(production).toContain('PLAYWRIGHT_INSTALL_ATTEMPT=\"2\" node scripts/playwright-chromium-install.mjs');
    expect(production).toContain("staging-browser-install.txt");
    expect(platformPr).toContain("PLAYWRIGHT_INSTALL_SITE: platform-pr-synthetic-capture");
    expect(platformPr).toContain("timeout-minutes: 15");
    expect(platformPr).toContain("pnpm exec playwright install --with-deps chromium");
  });

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
    expect(source).toContain('from "./provider-browser-install-timeout.mjs"');
    expect(source).toContain("runInstaller");
    expect(source).not.toMatch(/signalGroup|superviseInstaller|spawn\s*\(/);
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
      installerArgs: ["exec", "playwright", "install", "chromium"],
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
    mkdirSync(path.join(cache, "chromium-1"), { recursive: true });
    writeFileSync(path.join(cache, "chromium-1", "chrome"), "payload");
    writeFileSync(path.join(cache, "chromium-1", "package.json"), "{}");
    child.emit("message", { installerStatus: 0 });
    expect(child.send).toHaveBeenCalledWith("release");
    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ status: 0, reason: "success" });
    expect(lines).toEqual([]);
    expect(signalGroupImpl).not.toHaveBeenCalled();
  });

  it("AC2 emits one primitive terminal line when the supervisor succeeds without a cache payload", async () => {
    vi.useFakeTimers();
    const cache = makeCache();
    const child = Object.assign(new EventEmitter(), {
      pid: 4567,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      send: vi.fn(),
    });
    const lines = [];
    const resultPromise = installPlaywrightChromium({
      env: envFor(cache),
      runInstallerImpl: (options) => runInstaller({ ...options, spawnImpl: () => child, signalGroupImpl: vi.fn() }),
      write: (line) => lines.push(line),
    });
    child.emit("message", { installerStatus: 0 });
    child.emit("close", 0);
    await expect(resultPromise).resolves.toMatchObject({ status: 1, reason: "incomplete-cache" });
    expect(lines).toEqual([expect.stringContaining('"reason":"incomplete-cache"')]);
    expect(lines[0]).not.toContain("provider-browser-install-timing/v1");
  });

  it("AC2 uses the fake child lifecycle for cancellation, timeout, cleanup refusal and spawn refusal", async () => {
    vi.useFakeTimers();
    const runCase = ({ cancel = false, signalGroupImpl = vi.fn(), emitError = false } = {}) => {
      const cache = makeCache();
      const child = Object.assign(new EventEmitter(), {
        pid: 4567,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        send: vi.fn(),
      });
      const spawnImpl = vi.fn(() => child);
      const controller = new AbortController();
      const lines = [];
      const resultPromise = installPlaywrightChromium({
        env: envFor(cache),
        cancelSignal: cancel ? controller.signal : undefined,
        runInstallerImpl: (options) => runInstaller({ ...options, spawnImpl, signalGroupImpl }),
        write: (line) => lines.push(line),
      });
      if (emitError) child.emit("error", new Error("synthetic spawn failure"));
      else if (cancel) controller.abort();
      else vi.advanceTimersByTime(600_000);
      return { child, controller, lines, resultPromise, signalGroupImpl, spawnImpl };
    };

    const cancelled = runCase({ cancel: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await cancelled.resultPromise).toMatchObject({ status: 1, reason: "cancelled" });
    expect(cancelled.signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);
    expect(cancelled.spawnImpl).toHaveBeenCalledOnce();
    expect(cancelled.lines).toHaveLength(1);
    expect(cancelled.lines[0]).not.toContain("provider-browser-install-timing/v1");

    const timedOut = runCase();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await timedOut.resultPromise).toMatchObject({ status: 1, reason: "timeout" });
    expect(timedOut.signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);

    const cleanup = runCase({
      signalGroupImpl: vi.fn(() => {
        throw new Error("synthetic cleanup refusal");
      }),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await cleanup.resultPromise).toMatchObject({ status: 1, reason: "cleanup-failure" });
    expect(cleanup.signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);

    const refused = runCase({ emitError: true });
    expect(await refused.resultPromise).toMatchObject({ status: 1, reason: "refused" });
    expect(refused.lines).toHaveLength(1);
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
      mkdirSync(path.join(cache, "chromium-1"), { recursive: true });
      writeFileSync(path.join(cache, "chromium-1", "chrome"), "payload");
      writeFileSync(path.join(cache, "chromium-1", "package.json"), "{}");
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
        BOUNDARY_HEAD_SHA: "0".repeat(40),
      },
    ]);
    expect(lines.join("\n")).not.toMatch(/PRIVATE|provider response|<html>/);
  });

  it("AC4 distinguishes cold, incomplete and recursively unowned caches", () => {
    const cache = makeCache();
    expect(inspectCache(cache).state).toBe("incomplete");
    mkdirSync(path.join(cache, "chromium-1"), { recursive: true });
    writeFileSync(path.join(cache, "chromium-1", "chrome"), "payload");
    writeFileSync(path.join(cache, "chromium-1", "package.json"), "{}");
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

  it("AC4 removes the incomplete failed tree before cache publication", async () => {
    const cache = makeCache();
    mkdirSync(path.join(cache, "restored", "deps"), { recursive: true });
    writeFileSync(path.join(cache, "restored", "deps", "package.json"), "{}");
    const result = await installPlaywrightChromium({
      env: envFor(cache),
      runInstallerImpl: async () => ({ status: 1, record: { terminalOutcome: "timeout" } }),
      write: () => {},
    });
    expect(result).toMatchObject({ status: 1, reason: "timeout" });
    expect(() => validateCachePath(cache)).not.toThrow();
    expect(inspectCache(cache).state).toBe("cold");
  });

  it("AC5 emits stable refusal diagnostics for authority and cleanup failures", async () => {
    const cache = makeCache();
    const lines = [];
    const authority = await installPlaywrightChromium({
      env: envFor(cache),
      runInstallerImpl: async () => {
        throw new Error("secret exception must not escape");
      },
      write: (line) => lines.push(line),
    });
    expect(authority).toMatchObject({ status: 1, reason: "authority-refusal", cache: "incomplete" });
    const cleanup = await installPlaywrightChromium({
      env: envFor(cache),
      runInstallerImpl: async () => ({ status: 1, record: { terminalOutcome: "refused" } }),
      removeCacheImpl: () => {
        throw new Error("secret cleanup exception");
      },
      write: (line) => lines.push(line),
    });
    expect(cleanup).toMatchObject({ status: 1, reason: "cleanup-refusal" });
    expect(lines.join("\n")).toMatch(/site/);
    expect(lines.join("\n")).not.toMatch(/secret|PRIVATE/);
  });

  it("does not allow the installer to treat a directory-only cache as authority", async () => {
    const cache = makeCache();
    const runInstallerImpl = vi.fn(async () => ({ status: 0, record: { terminalOutcome: "success" } }));
    const result = await installPlaywrightChromium({ env: envFor(cache), runInstallerImpl, write: () => {} });
    expect(runInstallerImpl).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 1, reason: "incomplete-cache" });
  });
});
