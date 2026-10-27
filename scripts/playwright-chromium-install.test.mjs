import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { resolveBrowserPath, runPlaywrightChromiumInstall } from "./playwright-chromium-install.mjs";

const baseEnv = {
  PLAYWRIGHT_BROWSERS_PATH: "/tmp/chase-playwright",
  PLAYWRIGHT_INSTALL_SITE: "synthetic",
  PLAYWRIGHT_INSTALL_MAX_ATTEMPTS: "1",
};

function child() {
  return Object.assign(new EventEmitter(), { pid: 42, stdout: new PassThrough(), stderr: new PassThrough() });
}

describe("bounded Playwright Chromium installer", () => {
  it("rejects tilde and relative cache paths", () => {
    expect(() => resolveBrowserPath({ PLAYWRIGHT_BROWSERS_PATH: "~/.cache/ms-playwright" })).toThrow(/absolute/);
    expect(() => resolveBrowserPath({ PLAYWRIGHT_BROWSERS_PATH: "cache/ms-playwright" })).toThrow(/absolute/);
  });

  it("runs a successful install once without cache-hit bypass", async () => {
    const spawned = [];
    const result = await runPlaywrightChromiumInstall({
      env: baseEnv,
      spawnImpl: vi.fn((...args) => {
        spawned.push(args);
        const value = child();
        queueMicrotask(() => value.emit("close", 0));
        return value;
      }),
      signalGroupImpl: vi.fn(),
      write: vi.fn(),
    });
    expect(result.status).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].slice(0, 2)).toEqual(["pnpm", ["exec", "playwright", "install", "--with-deps", "chromium"]]);
  });

  it("retries only the authorized two-attempt budget and reports failure", async () => {
    let calls = 0;
    const write = vi.fn();
    const result = await runPlaywrightChromiumInstall({
      env: { ...baseEnv, PLAYWRIGHT_INSTALL_MAX_ATTEMPTS: "2" },
      spawnImpl: vi.fn(() => {
        calls += 1;
        const value = child();
        queueMicrotask(() => value.emit("close", 42));
        return value;
      }),
      signalGroupImpl: vi.fn(),
      write,
    });
    expect(calls).toBe(2);
    expect(result.status).not.toBe(0);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("attempt=2"));
  });

  it("covers every listed non-E2E workflow caller", () => {
    for (const file of [
      ".github/workflows/platform-production.yml",
      ".github/workflows/platform-staging-advisory-evidence.yml",
      ".github/workflows/platform-staging-route-matrix-evidence.yml",
      ".github/workflows/platform-staging-wake-drills.yml",
      ".github/workflows/catalog-staging-provider-uat.yml",
      ".github/workflows/platform-pr.yml",
    ]) {
      const source = readFileSync(file, "utf8");
      const direct = source.match(/pnpm exec playwright install --with-deps chromium/g) ?? [];
      expect(file.endsWith("platform-pr.yml") ? direct.length : direct.length).toBe(
        file.endsWith("platform-pr.yml") ? 1 : 0,
      );
      expect(source).toContain("node scripts/playwright-chromium-install.mjs");
    }
    const platformPr = parse(readFileSync(".github/workflows/platform-pr.yml", "utf8"));
    expect(JSON.stringify(platformPr.jobs["e2e-tests"])).toContain("pnpm exec playwright install --with-deps chromium");
  });
});
