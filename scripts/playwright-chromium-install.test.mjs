import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectCache,
  installPlaywrightChromium,
  removeCache,
  validateCachePath,
} from "./playwright-chromium-install.mjs";

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
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

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

  it("AC4 removes the complete failed tree before cache publication", async () => {
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
