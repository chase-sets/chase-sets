import { EventEmitter } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
import { classifyDeploymentRootCause } from "./platform-deploy-incident.mjs";

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
const failedAttempt = (terminalOutcome) => async () => ({ status: 1, record: { terminalOutcome } });

afterEach(() => {
  vi.useRealTimers();
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

// Real supervisor lifecycle with a fake detached child per attempt and fake time.
function supervisedInstall({ signalGroupImpl = vi.fn(), cancelSignal, removeCacheImpl = removeCache, policy } = {}) {
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
    env: { ...envFor(cache), ...(policy === undefined ? {} : { PLAYWRIGHT_INSTALL_POLICY: policy }) },
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

const workflowJob = (file, id) => parse(readFileSync(`.github/workflows/${file}`, "utf8")).jobs[id];
const deployInstallStep = () =>
  workflowJob("platform-production.yml", "deploy-staging").steps.find(
    (step) => step.name === "Install Playwright Chromium for staging critical flows",
  );
const bash =
  process.platform === "win32"
    ? path.resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe")
    : "bash";

// Execute the workflow shell and real helper, replacing only its underlying installer.
function executeDeployInstall(outcomes) {
  const root = makeCache();
  const callsPath = path.join(root, "calls.jsonl");
  const sleeperPath = path.join(root, "sleeps.txt");
  writeFileSync(callsPath, "");
  writeFileSync(sleeperPath, "");
  const bridge = path.join(root, "installer.mjs");
  writeFileSync(
    bridge,
    `
    import { appendFileSync, readFileSync } from 'node:fs';
    import { installPlaywrightChromium } from ${JSON.stringify(pathToFileURL(path.resolve("scripts/playwright-chromium-install.mjs")).href)};
    const outcomes = ${JSON.stringify(outcomes)};
    let lastOutcome;
    const result = await installPlaywrightChromium({
      env: process.env,
      inspectCacheImpl: () => ({state: 'complete', complete: true, owned: true}),
      removeCacheImpl: () => { if (lastOutcome === 'cleanup-refusal') throw new Error('synthetic refusal'); },
      delayImpl: async () => {},
      runInstallerImpl: async ({timeoutSeconds}) => {
        const count = readFileSync(process.env.PROBE_CALLS, 'utf8').trim().split('\\n').filter(Boolean).length;
        lastOutcome = outcomes[Math.min(count, outcomes.length - 1)];
        appendFileSync(process.env.PROBE_CALLS, JSON.stringify({attempt: process.env.PLAYWRIGHT_INSTALL_ATTEMPT, timeoutSeconds}) + '\\n');
        return {status: lastOutcome === 'success' ? 0 : 1, record: {terminalOutcome: lastOutcome}};
      },
    });
    process.exitCode = result.status;
  `,
  );
  const step = deployInstallStep();
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const invocation = `${quote(process.execPath.replaceAll("\\", "/"))} ${quote(bridge.replaceAll("\\", "/"))}`;
  const run = step.run.replaceAll("node scripts/playwright-chromium-install.mjs", invocation);
  const result = spawnSync(
    bash,
    ["-e", "-o", "pipefail", "-c", `sleep() { printf '%s\\n' "$1" >> "$PROBE_SLEEPS"; }\n${run}`],
    {
      cwd: root,
      env: {
        ...process.env,
        ...step.env,
        PLAYWRIGHT_BROWSERS_PATH: path.join(root, "browser"),
        PROBE_CALLS: callsPath,
        PROBE_SLEEPS: sleeperPath.replaceAll("\\", "/"),
      },
      encoding: "utf8",
    },
  );
  expect(result.error).toBeUndefined();
  const calls = readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return {
    ...result,
    calls,
    sleeps: readFileSync(sleeperPath, "utf8").trim(),
    classified: readFileSync(path.join(root, "artifacts/release-health/staging-browser-install.txt"), "utf8"),
    retained: readFileSync(path.join(root, "artifacts/release-health/staging-browser-install-attempts.txt"), "utf8"),
  };
}

describe("Playwright Chromium installer primitive", () => {
  it.each(["", "retry", "e2e-retry", "single-attempt ", "SINGLE-ATTEMPT"])(
    "refuses invalid policy %j before cache access or spawn",
    async (policy) => {
      const inspectCacheImpl = vi.fn();
      const removeCacheImpl = vi.fn();
      const runInstallerImpl = vi.fn();
      const result = await installPlaywrightChromium({
        env: { ...envFor(makeCache()), PLAYWRIGHT_INSTALL_POLICY: policy },
        inspectCacheImpl,
        removeCacheImpl,
        runInstallerImpl,
        write: () => {},
      });
      expect(result).toMatchObject({ status: 1, reason: "invalid-policy" });
      expect(inspectCacheImpl).not.toHaveBeenCalled();
      expect(removeCacheImpl).not.toHaveBeenCalled();
      expect(runInstallerImpl).not.toHaveBeenCalled();
    },
  );

  it.each(["timeout", "partial-download", "incomplete-cache", "cancelled", "cleanup-failure"])(
    "single-attempt runs one underlying 600-second installer on %s",
    async (reason) => {
      const runInstallerImpl = vi.fn(failedAttempt(reason));
      const delayImpl = vi.fn();
      const result = await installPlaywrightChromium({
        env: { ...envFor(makeCache()), PLAYWRIGHT_INSTALL_POLICY: "single-attempt" },
        runInstallerImpl,
        delayImpl,
        write: () => {},
      });
      expect(result).toMatchObject({ status: 1, reason });
      expect(runInstallerImpl).toHaveBeenCalledOnce();
      expect(runInstallerImpl.mock.calls[0][0].timeoutSeconds).toBe(600);
      expect(delayImpl).not.toHaveBeenCalled();
    },
  );

  it("single-attempt supervisor enforces 600 seconds plus five-second grace without a retry", async () => {
    const f = supervisedInstall({ policy: "single-attempt" });
    await vi.advanceTimersByTimeAsync(599_999);
    expect(f.signalGroupImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
    await vi.advanceTimersByTimeAsync(1);
    await expect(f.result).resolves.toMatchObject({ status: 1, reason: "timeout" });
    expect(f.signalGroupImpl.mock.calls).toEqual([
      [4567, "TERM"],
      [4567, "KILL"],
    ]);
    expect(f.spawnImpl).toHaveBeenCalledOnce();
    expect(f.elapsedMs()).toBe(605_000);
    expect(f.delayImpl).not.toHaveBeenCalled();
  });

  it.each(["timeout", "partial-download", "cache-restore-failure", "incomplete-cache"])(
    "deploy recovers %s with at most two underlying installs and no stale classification",
    (reason) => {
      const result = executeDeployInstall([reason, "success"]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toEqual([
        { attempt: "1", timeoutSeconds: 600 },
        { attempt: "2", timeoutSeconds: 600 },
      ]);
      expect(result.sleeps).toBe("5");
      expect(result.retained).toContain(`"reason":"${reason}"`);
      expect(result.classified).toBe("");
      expect(
        classifyDeploymentRootCause({ diagnostics: [result.classified, "projection convergence timed out"] })
          .rootCauseCode,
      ).toBe("blocking-staging-verification");
      expect(
        classifyDeploymentRootCause({ diagnostics: [result.classified, "unrecognized probe failure"] }).rootCauseCode,
      ).toBe("unknown");
    },
  );

  it("deploy terminal retry failure stays red with only attempt-2 diagnostic", () => {
    const result = executeDeployInstall(["timeout", "partial-download"]);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([
      { attempt: "1", timeoutSeconds: 600 },
      { attempt: "2", timeoutSeconds: 600 },
    ]);
    expect(result.classified.trim().split("\n")).toHaveLength(1);
    expect(result.classified).toContain('"attempt":"2","reason":"partial-download"');
    expect(classifyDeploymentRootCause({ diagnostics: [result.classified] }).rootCauseCode).toBe(
      "staging-browser-install",
    );
  });

  it.each([
    "cancelled",
    "cleanup-refusal",
    "cleanup-failure",
    "refused",
    "checksum",
    "authority-refusal",
    "start-refusal",
  ])("deploy does not retry terminal %s or swallow its exit", (reason) => {
    const result = executeDeployInstall([reason, "success"]);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([{ attempt: "1", timeoutSeconds: 600 }]);
    expect(result.sleeps).toBe("");
    expect(result.classified).toContain(`"reason":"${reason}"`);
  });

  it("AC1/AC2 inventories every scoped caller, budgets its envelope, and leaves E2E separate", () => {
    const workflow = (name) => parse(readFileSync(`.github/workflows/${name}`, "utf8"));
    const workflows = {
      catalog: workflow("catalog-staging-provider-uat.yml"),
      advisory: workflow("platform-staging-advisory-evidence.yml"),
      route: workflow("platform-staging-route-matrix-evidence.yml"),
      wake: workflow("platform-staging-wake-drills.yml"),
      production: workflow("platform-production.yml"),
      platformPr: workflow("platform-pr.yml"),
    };
    const rows = [
      [
        "catalog",
        "staging-provider-uat",
        "Install Playwright Chromium",
        "Run staging provider sync UAT",
        "catalog-staging-provider-uat",
        61,
        11,
        50,
        1,
      ],
      [
        "catalog",
        "scope-sync-count-lifecycle",
        "Install isolated Chromium",
        "Capture count lifecycle without confirmation",
        "catalog-scope-sync-count-lifecycle",
        15,
        11,
        4,
        1,
      ],
      [
        "catalog",
        "scrydex-coordinate-preview",
        "Install isolated Chromium",
        "Capture Scrydex coordinate preview",
        "catalog-scrydex-coordinate-preview",
        20,
        11,
        9,
        1,
      ],
      [
        "catalog",
        "scrydex-cache-capture",
        "Install isolated Chromium",
        "Capture Scrydex option cache without refresh",
        "catalog-scrydex-cache-capture",
        20,
        11,
        9,
        1,
      ],
      [
        "catalog",
        "scrydex-force-refresh-bounded",
        "Install isolated Chromium",
        "Run bounded Scrydex force refresh",
        "catalog-scrydex-force-refresh-bounded",
        20,
        11,
        9,
        1,
      ],
      [
        "advisory",
        "staging-advisory-evidence",
        "Install Playwright Chromium for staging critical flows",
        "Staging marketplace critical flows",
        "platform-staging-advisory-evidence",
        90,
        11,
        10,
        1,
      ],
      [
        "route",
        "staging-route-matrix-evidence",
        "Install Playwright Chromium for route-matrix sampler",
        "Drive checkout route-matrix sample",
        "platform-staging-route-matrix-evidence",
        45,
        11,
        34,
        1,
      ],
      [
        "wake",
        "staging-wake-drill",
        "Install Playwright Chromium for canary writes",
        "Run staging wake drill",
        "platform-staging-wake-drills",
        45,
        11,
        34,
        1,
      ],
      [
        "production",
        "deploy-staging",
        "Install Playwright Chromium for staging critical flows",
        "Staging Buy Now freshness probes",
        "platform-production-deploy-staging",
        180,
        21,
        null,
        2,
      ],
      [
        "platformPr",
        "capture-hermetic-chromium",
        "Install Playwright Chromium",
        "Prove three synthetic Chromium capture cases",
        "platform-pr-synthetic-capture",
        15,
        11,
        4,
        1,
      ],
    ];
    const job = (wf, id) => workflows[wf].jobs[id];
    for (const [
      wf,
      id,
      installName,
      consumerName,
      site,
      jobMinutes,
      installMinutes,
      consumerMinutes,
      attempts,
    ] of rows) {
      const candidate = job(wf, id);
      expect(candidate, `${wf}/${id}`).toBeTruthy();
      const install = candidate.steps.find((step) => step.name === installName);
      const consumer = candidate.steps.find((step) => step.name === consumerName);
      expect(install, `${site} install`).toBeTruthy();
      expect(consumer, `${site} consumer`).toBeTruthy();
      expect(install.run).toContain("node scripts/playwright-chromium-install.mjs");
      expect(install.run.match(/node scripts\/playwright-chromium-install\.mjs/g)).toHaveLength(attempts);
      if (attempts === 1 && wf !== "platformPr")
        expect(install.run).toBe("node scripts/playwright-chromium-install.mjs");
      expect(install["timeout-minutes"]).toBe(installMinutes);
      expect(install.env.PLAYWRIGHT_INSTALL_SITE).toBe(site);
      expect(install.env.PLAYWRIGHT_INSTALL_POLICY, `${site} policy`).toBe("single-attempt");
      expect(install.if ?? "").not.toMatch(/cache-hit/);
      expect(install["continue-on-error"]).toBeUndefined();
      expect(install.env.PLAYWRIGHT_BROWSERS_PATH).toBe(
        site === "platform-pr-synthetic-capture"
          ? "${{ runner.temp }}/ac4-playwright"
          : "${{ runner.temp }}/playwright-chromium",
      );
      expect(install.env.PLAYWRIGHT_BROWSERS_PATH).toBe(consumer.env.PLAYWRIGHT_BROWSERS_PATH);
      if (consumerMinutes !== null) expect(consumer["timeout-minutes"]).toBe(consumerMinutes);
      expect(candidate["timeout-minutes"]).toBe(jobMinutes);
      const consumerSeconds = consumerMinutes === null ? 9530 : consumerMinutes * 60;
      expect(605 * attempts + 5 * (attempts - 1) + consumerSeconds + 55).toBeLessThanOrEqual(jobMinutes * 60);
      expect(JSON.stringify(candidate.env ?? {})).not.toContain("runner.temp");
      for (const cache of candidate.steps.filter(
        (step) => step.uses?.startsWith("actions/cache@") && /playwright/i.test(step.name ?? ""),
      )) {
        expect(cache.with.path).toBe(install.env.PLAYWRIGHT_BROWSERS_PATH);
        expect(cache.if ?? "").not.toMatch(/always\(\)|failure\(\)/);
      }
    }
    const production = workflows.production.jobs["deploy-staging"];
    const productionInstall = production.steps.find(
      (step) => step.name === "Install Playwright Chromium for staging critical flows",
    );
    expect(productionInstall.run).toContain("staging-browser-install-attempts.txt");
    expect(productionInstall.run).toContain('exit "$status"');
    expect(productionInstall.env.PLAYWRIGHT_BROWSERS_PATH).toBe("${{ runner.temp }}/playwright-chromium");
    expect(productionInstall["timeout-minutes"]).toBe(21);
    expect(production["timeout-minutes"]).toBe(180);
    const platformPr = workflows.platformPr.jobs["capture-hermetic-chromium"];
    const syntheticInstall = platformPr.steps.find((step) => step.name === "Install Playwright Chromium");
    const syntheticCapture = platformPr.steps.find(
      (step) => step.name === "Prove three synthetic Chromium capture cases",
    );
    expect(syntheticInstall["timeout-minutes"]).toBe(11);
    expect(syntheticCapture["timeout-minutes"]).toBe(4);
    expect(platformPr["timeout-minutes"]).toBe(15);
    const classifier = production.steps.find((step) => (step.run ?? "").includes("classify-root-cause"));
    expect(classifier.run).toContain("--diagnostics artifacts/release-health/staging-browser-install.txt");
    expect(classifier.run).not.toContain("staging-browser-install-attempts.txt");
    for (const wf of Object.values(workflows)) {
      for (const [id, candidate] of Object.entries(wf.jobs)) {
        if (wf === workflows.platformPr && id === "e2e-tests") continue;
        for (const step of candidate.steps ?? []) expect(step.run ?? "").not.toMatch(/playwright install/);
      }
    }
    expect(rows).toHaveLength(10);
    const advisory = workflows.advisory.jobs["staging-advisory-evidence"];
    const preflightAt = advisory.steps.findIndex((step) => step.id === "advisory_preflight");
    const admissionMinutes = Number(
      advisory.steps[preflightAt].run.match(/const deadline = startedAt \+ (\d+) \* 60 \* 1000/)?.[1],
    );
    const later = advisory.steps.slice(preflightAt + 1);
    expect(later.find((step) => step.id === "staging-playwright-chromium")["timeout-minutes"]).toBe(2);
    for (const step of later) expect(step["timeout-minutes"], step.name).toBeGreaterThan(0);
    expect(admissionMinutes).toBe(37);
    expect(admissionMinutes + later.reduce((total, step) => total + step["timeout-minutes"], 0)).toBeLessThanOrEqual(
      90,
    );
  });

  it("restores direct E2E installation while preserving native dependencies and required gates", () => {
    const workflow = parse(readFileSync(".github/workflows/platform-pr.yml", "utf8"));
    const job = workflow.jobs["e2e-tests"];
    expect(job["timeout-minutes"]).toBe(25);
    expect(job["continue-on-error"]).toBeUndefined();
    const at = job.steps.findIndex((step) => step.name === "Cache Playwright Chromium");
    const [cache, install, suites] = job.steps.slice(at, at + 3);
    expect(cache.with).toEqual({
      path: "~/.cache/ms-playwright",
      key: "playwright-chromium-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}",
      "restore-keys": "playwright-chromium-${{ runner.os }}-\n",
    });
    expect(install).toEqual({
      name: "Install Playwright Chromium",
      env: { PLAYWRIGHT_BROWSERS_PATH: "~/.cache/ms-playwright" },
      run: "pnpm exec playwright install --with-deps chromium",
    });
    expect(suites.name).toBe("Run marketplace e2e suites");
    expect(suites.env.PLAYWRIGHT_BROWSERS_PATH).toBe(install.env.PLAYWRIGHT_BROWSERS_PATH);
    expect(suites.if).toBeUndefined();
    expect(suites["continue-on-error"]).toBeUndefined();
    expect(suites.run.startsWith("set -o pipefail\n")).toBe(true);
    expect(job.steps.some((step) => step.name === "Resolve Playwright Chromium cache")).toBe(false);
    expect(workflow.jobs["pr-required"].needs).toContain("e2e-tests");
    expect(workflow.jobs["pr-required"].steps.map((step) => step.run ?? "").join("\n")).toContain(
      `require_job "E2E Tests" "\${{ needs['e2e-tests'].result }}" "\${{ needs['change-scope'].outputs.e2e_tests_required }}"`,
    );
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
