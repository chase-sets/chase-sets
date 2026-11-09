import { EventEmitter } from "node:events";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { gitListingOptions } from "./lib/git-listing.mjs";
import {
  inspectCache,
  installPlaywrightChromium as realInstallPlaywrightChromium,
  removeCache,
  validateCachePath,
  PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS,
  PLAYWRIGHT_INSTALL_ENVELOPE_SECONDS,
  projectUbuntuSources,
  validateUbuntuProjection,
  prepareE2eApt,
  classifyAptBoolean,
  resolveE2eCache,
} from "./playwright-chromium-install.mjs";
import { runInstaller } from "./provider-browser-install-timeout.mjs";
import { classifyDeploymentRootCause } from "./platform-deploy-incident.mjs";
import { checkGithubActionsRuntime } from "./check-github-actions-runtime.mjs";
import {
  releaseQualificationScopeRegistry,
  validateReleaseQualificationScopeRegistry,
} from "./release-qualification-scope.mjs";

const directories = [];
const installPlaywrightChromium = (options) =>
  realInstallPlaywrightChromium({
    ...(options.env?.PLAYWRIGHT_INSTALL_POLICY === "e2e-acquisition"
      ? {
          identity: { runId: "123", jobId: "456", runAttempt: 2, headSha: "a".repeat(40) },
          inspectCacheImpl: inspectCache,
          prepareAptImpl: () => ({ projected: false, restore: vi.fn() }),
        }
      : {}),
    ...options,
  });

it("AC1/AC2 pre-fix regression: E2E acquisition reserves suites inside the unchanged 25-minute job", () => {
  expect(PLAYWRIGHT_INSTALL_TIMEOUT_SECONDS).toBe(540);
  expect(PLAYWRIGHT_INSTALL_ENVELOPE_SECONDS).toBe(570);
  const job = parse(readFileSync(".github/workflows/platform-pr.yml", "utf8")).jobs["e2e-tests"];
  const install = job.steps.find((step) => step.name === "Install Playwright Chromium");
  expect(install["timeout-minutes"]).toBe(10);
  expect(install.run).toBe("node scripts/playwright-chromium-install.mjs");
  expect(install.env.PLAYWRIGHT_INSTALL_POLICY).toBe("e2e-acquisition");
  expect(install["timeout-minutes"] * 60 + 60 + 780 + 60).toBeLessThanOrEqual(job["timeout-minutes"] * 60);
});
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
    now: () => new Date(),
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
  it.each([undefined, "single-attempt"])("omitted/explicit policy %s stays one 600-second attempt", async (policy) => {
    const runInstallerImpl = vi.fn(failedAttempt("timeout"));
    const delayImpl = vi.fn();
    const result = await installPlaywrightChromium({
      env: { ...envFor(makeCache()), PLAYWRIGHT_INSTALL_POLICY: policy },
      runInstallerImpl,
      delayImpl,
      write: () => {},
    });
    expect(result).toMatchObject({ status: 1, reason: "timeout" });
    expect(runInstallerImpl).toHaveBeenCalledOnce();
    expect(runInstallerImpl.mock.calls[0][0].timeoutSeconds).toBe(600);
    expect(delayImpl).not.toHaveBeenCalled();
  });
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

  it("uses bounded E2E acquisition while preserving native dependencies and required gates", () => {
    const workflow = parse(readFileSync(".github/workflows/platform-pr.yml", "utf8"));
    const job = workflow.jobs["e2e-tests"];
    expect(job["timeout-minutes"]).toBe(25);
    expect(job["continue-on-error"]).toBeUndefined();
    const at = job.steps.findIndex((step) => step.name === "Cache Playwright Chromium");
    const [cache, install, suites] = job.steps.slice(at, at + 3);
    expect(cache.with).toEqual({
      path: "${{ steps.e2e-browser-cache.outputs.path }}",
      key: "${{ steps.e2e-browser-cache.outputs.key }}",
    });
    expect(install).toEqual({
      name: "Install Playwright Chromium",
      "timeout-minutes": 10,
      env: {
        PLAYWRIGHT_BROWSERS_PATH: "${{ steps.e2e-browser-cache.outputs.path }}",
        PLAYWRIGHT_INSTALL_POLICY: "e2e-acquisition",
        PLAYWRIGHT_INSTALL_JOB_NAME: "E2E Tests (${{ matrix.suite_batch }})",
        GH_TOKEN: "${{ github.token }}",
        BOUNDARY_HEAD_SHA: "${{ github.event.pull_request.head.sha || github.sha }}",
      },
      run: "node scripts/playwright-chromium-install.mjs",
    });
    expect(suites.name).toBe("Run marketplace e2e suites");
    expect(suites.env.PLAYWRIGHT_BROWSERS_PATH).toBe(install.env.PLAYWRIGHT_BROWSERS_PATH);
    expect(suites.if).toBeUndefined();
    expect(suites["continue-on-error"]).toBeUndefined();
    expect(suites.run.startsWith("set -o pipefail\n")).toBe(true);
    expect(job.steps.some((step) => step.name === "Resolve Playwright Chromium cache")).toBe(true);
    expect(workflow.jobs["pr-required"].needs).toContain("e2e-tests");
    expect(workflow.jobs["pr-required"].steps.map((step) => step.run ?? "").join("\n")).toContain(
      `require_job "E2E Tests" "\${{ needs['e2e-tests'].result }}" "\${{ needs['change-scope'].outputs.e2e_tests_required }}"`,
    );
  });

  it.each(["success", "failure", "cancelled", "skipped", "unknown"])(
    "AC3 forced E2E result %s preserves the real Required shell polarity",
    (outcome) => {
      const run = workflowJob("platform-pr.yml", "pr-required").steps.find(
        (step) => step.name === "Verify required jobs",
      ).run;
      const boundary = run.indexOf('require_job "Known Failure Guard"');
      expect(boundary).toBeGreaterThan(0);
      const shell = `${run.slice(0, boundary)}\nrequire_job "E2E Tests" "${outcome}" "true"\n`;
      const result = spawnSync(bash, ["-e", "-o", "pipefail", "-c", shell], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
      });
      expect(result.error).toBeUndefined();
      expect(result.status === 0).toBe(outcome === "success");
      if (outcome !== "success")
        expect(result.stderr).toContain(`E2E Tests was required but finished with result '${outcome}'`);
    },
  );

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
    expect(await refused.resultPromise).toMatchObject({ status: 1, reason: "start-refusal" });
    expect(refused.signalGroupImpl).not.toHaveBeenCalled();
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

describe("Ubuntu acquisition projection", () => {
  const ubuntuPath = "/etc/apt/sources.list.d/ubuntu.sources";
  const thirdPartyPath = "/etc/apt/sources.list.d/microsoft.sources";
  const mirrorUri = "mirror+file:/etc/apt/apt-mirrors.txt";
  const ubuntu = `Types: deb\nURIs: ${mirrorUri}\nSuites: noble noble-updates noble-backports noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n`;
  const thirdParty =
    "Types: deb\nURIs: https://packages.microsoft.com/ubuntu/24.04/prod\nSuites: noble\nComponents: main\nSigned-By: /usr/share/keyrings/microsoft.gpg\n";
  const mirrors = {
    [mirrorUri]:
      "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttps://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://security.ubuntu.com/ubuntu/\tpriority:3\n",
  };
  const fixture = () => ({
    distribution: "ubuntu",
    release: "24.04",
    codename: "noble",
    architecture: "X64",
    sources: { [ubuntuPath]: ubuntu, [thirdPartyPath]: thirdParty },
    mirrors,
  });
  // Runner state logged by the owning head-2 E2E job, before acquisition.
  const loggedRunner = {
    releaseText:
      'PRETTY_NAME="Ubuntu 24.04.5 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.5 LTS (Noble Numbat)"\nVERSION_CODENAME=noble\nID=ubuntu\nID_LIKE=debian\nHOME_URL="https://www.ubuntu.com/"\nSUPPORT_URL="https://help.ubuntu.com/"\nBUG_REPORT_URL="https://bugs.launchpad.net/ubuntu/"\nPRIVACY_POLICY_URL="https://www.ubuntu.com/legal/terms-and-policies/privacy-policy"\nUBUNTU_CODENAME=noble\nLOGO=ubuntu-logo\n',
    sources: {
      "/etc/apt/sources.list":
        "# Ubuntu sources have moved to the /etc/apt/sources.list.d/ubuntu.sources\n# file, which uses the deb822 format. Use deb822-formatted .sources files\n# to manage package sources in the /etc/apt/sources.list.d/ directory.\n# See the sources.list(5) manual page for details.\n",
      "/etc/apt/sources.list.d/microsoft-prod.list":
        "deb [arch=amd64,arm64,armhf signed-by=/usr/share/keyrings/microsoft-prod.gpg] https://packages.microsoft.com/ubuntu/24.04/prod noble main\n",
      [ubuntuPath]: `## Note, this file is written by cloud-init on first boot of an instance
## modifications made here will not survive a re-bundle.
##
## If you wish to make changes you can:
## a.) add 'apt_preserve_sources_list: true' to /etc/cloud/cloud.cfg
##     or do the same in user-data
## b.) add supplemental sources in /etc/apt/sources.list.d
## c.) make changes to template file
##      /etc/cloud/templates/sources.list.ubuntu.deb822.tmpl
##

# See http://help.ubuntu.com/community/UpgradeNotes for how to upgrade to
# newer versions of the distribution.

## Ubuntu distribution repository
##
## The following settings can be adjusted to configure which packages to use from Ubuntu.
## Mirror your choices (except for URIs and Suites) in the security section below to
## ensure timely security updates.
##
## Types: Append deb-src to enable the fetching of source package.
## URIs: A URL to the repository (you may add multiple URLs)
## Suites: The following additional suites can be configured
##   <name>-updates   - Major bug fix updates produced after the final release of the
##                      distribution.
##   <name>-backports - software from this repository may not have been tested as
##                      extensively as that contained in the main release, although it includes
##                      newer versions of some applications which may provide useful features.
##                      Also, please note that software in backports WILL NOT receive any review
##                      or updates from the Ubuntu security team.
## Components: Aside from main, the following components can be added to the list
##   restricted  - Software that may not be under a free license, or protected by patents.
##   universe    - Community maintained packages. Software in this repository receives maintenance
##                 from volunteers in the Ubuntu community, or a 10 year security maintenance
##                 commitment from Canonical when an Ubuntu Pro subscription is attached.
##   multiverse  - Community maintained of restricted. Software from this repository is
##                 ENTIRELY UNSUPPORTED by the Ubuntu team, and may not be under a free
##                 licence. Please satisfy yourself as to your rights to use the software.
##                 Also, please note that software in multiverse WILL NOT receive any
##                 review or updates from the Ubuntu security team.
##
## See the sources.list(5) manual page for further settings.
Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble noble-updates noble-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

## Ubuntu security updates. Aside from URIs and Suites,
## this should mirror your choices in the previous section.
Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`,
    },
    env: { RUNNER_ARCH: "X64", ImageOS: "ubuntu24", ImageVersion: "20261101.360.1" },
  };

  function aptConfigDump(files) {
    const values = new Map([
      ["Dir", "/"],
      ["Dir::Etc", "etc/apt"],
      ["Dir::Etc::sourcelist", "sources.list"],
      ["Dir::Etc::sourceparts", "sources.list.d"],
      ["Acquire::AllowInsecureRepositories", "0"],
      ["Acquire::AllowWeakRepositories", "0"],
      ["Acquire::AllowDowngradeToInsecureRepositories", "0"],
    ]);
    const parts = [...files.keys()].filter((file) => file.startsWith("/etc/apt/apt.conf.d/")).sort();
    for (const file of parts)
      for (const match of files.get(file).matchAll(/^(\S+) "([^"\n]*)";$/gm)) values.set(match[1], match[2]);
    return [...values].map(([key, value]) => `${key} "${value}";\n`).join("");
  }

  function machine({
    effective,
    failWrite,
    failRestore,
    version = "20261101.360.1",
    thirdPartyKey = "original-key",
    runnerState = false,
  } = {}) {
    const input = fixture();
    const files = new Map(
      Object.entries({
        ...input.sources,
        "/etc/os-release": 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\n',
        "/etc/apt/apt-mirrors.txt": mirrors[mirrorUri],
        "/usr/share/keyrings/ubuntu-archive-keyring.gpg": "ubuntu-key",
        "/usr/share/keyrings/microsoft.gpg": thirdPartyKey,
        ...(runnerState
          ? {
              ...loggedRunner.sources,
              "/etc/os-release": loggedRunner.releaseText,
              "/usr/share/keyrings/microsoft-prod.gpg": thirdPartyKey,
              "/etc/apt/apt.conf.d/zz-retries":
                'Acquire::Retries "1";\nAcquire::http::Timeout "15";\nAcquire::https::Timeout "15";\n',
            }
          : {}),
      }),
    );
    if (runnerState) files.delete(thirdPartyPath);
    const original = new Map(files);
    const command = vi.fn((_command, args, text) => {
      expect(_command).toBe("sudo");
      expect(args[0]).toBe("-n");
      if (args[1] === "tee") {
        if (failRestore && text?.toString() === ubuntu) throw new Error("restore denied");
        files.set(args[2], Buffer.isBuffer(text) ? text.toString() : text);
        if (failWrite && args[2].endsWith("-chase-sets-e2e")) throw new Error("partial write");
        return "";
      }
      if (args[1] === "rm") {
        files.delete(args[3]);
        return "";
      }
      expect(args).toEqual(["-n", "apt-config", "dump"]);
      return effective ?? aptConfigDump(files);
    });
    const lines = [];
    const options = {
      env: runnerState ? loggedRunner.env : { RUNNER_ARCH: "X64", ImageOS: "ubuntu24", ImageVersion: version },
      read: (file, encoding) => {
        if (!files.has(file)) throw new Error("missing fixture");
        const bytes = Buffer.from(files.get(file));
        return encoding ? bytes.toString(encoding) : bytes;
      },
      list: (directory) =>
        [...files.keys()]
          .filter((file) => path.posix.dirname(file) === directory)
          .map((file) => path.posix.basename(file)),
      exists: (file) => files.has(file),
      command,
      write: (line) => lines.push(line),
    };
    return { files, original, options, lines, command };
  }

  it("logged runner state projects with effective 30/30/1 bounds despite image zz-retries", () => {
    const m = machine({ runnerState: true });
    let apt;
    try {
      apt = prepareE2eApt(m.options);
    } catch (error) {
      for (const line of m.lines.filter((line) => line.startsWith("playwright-e2e-apt-refusal "))) console.error(line);
      throw error;
    }
    expect(apt.projected).toBe(true);
    const effective = JSON.parse(
      m.lines
        .find((line) => line.startsWith("playwright-e2e-apt-effective "))
        .split(" ")
        .slice(1)
        .join(" "),
    );
    expect(effective.effective).toContain('Acquire::http::Timeout "30";');
    expect(effective.effective).toContain('Acquire::https::Timeout "30";');
    expect(effective.effective).toContain('Acquire::Retries "1";');
    expect(effective.configEntries).toEqual(["zz-retries", "zzz-chase-sets-e2e"]);
    apt.restore();
    expect(m.files).toEqual(m.original);
  });

  const allowKeys = [
    "Acquire::AllowInsecureRepositories",
    "Acquire::AllowWeakRepositories",
    "Acquire::AllowDowngradeToInsecureRepositories",
    "APT::Get::AllowUnauthenticated",
  ];
  const verifyKeys = ["Acquire::https::Verify-Peer", "Acquire::https::archive.ubuntu.com::Verify-Host"];
  const trueSpellings = ["1", "true", "TRUE", "True", "yes", "on", "with", "enable"];
  const falseSpellings = ["0", "false", "FALSE", "False", "no", "off", "without", "disable"];
  const unknownSpellings = ["", "2", "-1", "00", "0x0", "+0", " 0", "0 ", "maybe"];

  it("apt 2.7.14 strutl.cc:824-851 truth table classifies only the admitted whole-string spellings", () => {
    for (const value of trueSpellings) expect(classifyAptBoolean(value), JSON.stringify(value)).toBe(true);
    for (const value of falseSpellings) expect(classifyAptBoolean(value), JSON.stringify(value)).toBe(false);
    for (const value of unknownSpellings) expect(classifyAptBoolean(value), JSON.stringify(value)).toBeNull();
    for (const value of ["YES", "WITH", "ON", "ENABLE"]) expect(classifyAptBoolean(value)).toBe(true);
    for (const value of ["NO", "WITHOUT", "OFF", "DISABLE"]) expect(classifyAptBoolean(value)).toBe(false);
  });

  it("apt-default control admits all three repository-security zero defaults", () => {
    const m = machine({ runnerState: true });
    const apt = prepareE2eApt(m.options);
    expect(apt.projected).toBe(true);
    const effective = JSON.parse(
      m.lines
        .find((line) => line.startsWith("playwright-e2e-apt-effective "))
        .slice("playwright-e2e-apt-effective ".length),
    );
    for (const key of allowKeys.slice(0, 3)) expect(effective.effective).toContain(`${key} "0";`);
    expect(m.lines.some((line) => line.startsWith("playwright-e2e-apt-refusal "))).toBe(false);
    apt.restore();
    expect(m.files).toEqual(m.original);
  });

  function expectTrustRefusal(key, value) {
    const m = machine({ runnerState: true });
    m.files.set("/etc/apt/apt.conf.d/zzzz-trust", `${key} "${value}";\n`);
    m.original = new Map(m.files);
    expect(() => prepareE2eApt(m.options)).toThrow("trust-bypass");
    expect(m.files).toEqual(m.original);
    const refusals = m.lines.filter((line) => line.startsWith("playwright-e2e-apt-refusal "));
    expect(refusals).toHaveLength(1);
    expect(JSON.parse(refusals[0].slice("playwright-e2e-apt-refusal ".length))).toEqual({
      guard: "trust-option",
      key,
      value,
      configEntries: ["zz-retries", "zzz-chase-sets-e2e", "zzzz-trust"],
    });
  }

  it.each([
    ...allowKeys.flatMap((key) => trueSpellings.map((value) => [key, value])),
    ...verifyKeys.flatMap((key) => falseSpellings.map((value) => [key, value])),
  ])("weakening spellings: %s %s refuses and restores every byte", expectTrustRefusal);

  it.each([allowKeys[0], verifyKeys[0]].flatMap((key) => unknownSpellings.map((value) => [key, value])))(
    "unclassifiable spellings: %s %s refuses and restores every byte",
    expectTrustRefusal,
  );

  it.each([
    ...allowKeys.flatMap((key) => falseSpellings.map((value) => [key, value])),
    ...verifyKeys.flatMap((key) => trueSpellings.map((value) => [key, value])),
  ])("secure spellings: %s %s is admitted", (key, value) => {
    const m = machine({ runnerState: true });
    m.files.set("/etc/apt/apt.conf.d/zzzz-trust", `${key} "${value}";\n`);
    m.original = new Map(m.files);
    const apt = prepareE2eApt(m.options);
    expect(apt.projected).toBe(true);
    expect(m.lines.some((line) => line.startsWith("playwright-e2e-apt-effective "))).toBe(true);
    expect(m.lines.some((line) => line.startsWith("playwright-e2e-apt-refusal "))).toBe(false);
    apt.restore();
    expect(m.files).toEqual(m.original);
  });

  it("refusal dump retains the full redacted dump between refusal and restoration", () => {
    const m = machine({ runnerState: true });
    m.files.set("/etc/apt/apt.conf.d/zzzz-trust", `${allowKeys[0]} "1";\n`);
    m.files.set(
      "/etc/apt/apt.conf.d/10-proxy",
      'Acquire::http::Proxy "https://fixture-user:fixture-password@example.invalid/proxy";\n',
    );
    m.original = new Map(m.files);
    let effective;
    const command = m.options.command;
    m.options.command = (name, args, input) => {
      const result = command(name, args, input);
      if (args[1] === "apt-config") effective = result;
      return result;
    };
    expect(() => prepareE2eApt(m.options)).toThrow("trust-bypass");
    expect(m.files).toEqual(m.original);
    const dumps = m.lines.filter((line) => line.startsWith("playwright-e2e-apt-refusal-dump "));
    expect(dumps).toHaveLength(1);
    expect(JSON.parse(dumps[0].slice("playwright-e2e-apt-refusal-dump ".length))).toEqual({
      guard: "trust-option",
      key: allowKeys[0],
      effective: effective.replace("fixture-user:fixture-password", "[redacted]"),
    });
    expect(m.lines.indexOf(dumps[0])).toBeGreaterThan(
      m.lines.findIndex((line) => line.startsWith("playwright-e2e-apt-refusal ")),
    );
    expect(m.lines.indexOf(dumps[0])).toBeLessThan(
      m.lines.findIndex((line) => line.startsWith("playwright-e2e-apt-restore ")),
    );
    expect(m.lines.join("\n")).not.toMatch(/fixture-user|fixture-password/);
  });

  it("M-later-override: later 15-second timeout refuses with bounds-value and restores all bytes", () => {
    const m = machine({ runnerState: true });
    const later = "/etc/apt/apt.conf.d/zzzz-later-override";
    const text = 'Acquire::http::Timeout "15";\n';
    m.files.set(later, text);
    m.original.set(later, text);
    expect(() => prepareE2eApt(m.options)).toThrow("ineffective-elevated-config");
    expect(m.files).toEqual(m.original);
    const refusals = m.lines.filter((line) => line.startsWith("playwright-e2e-apt-refusal "));
    expect(refusals).toHaveLength(1);
    expect(JSON.parse(refusals[0].slice("playwright-e2e-apt-refusal ".length))).toEqual({
      guard: "bounds-value",
      key: "Acquire::http::Timeout",
      value: "15",
      configEntries: ["zz-retries", "zzz-chase-sets-e2e", "zzzz-later-override"],
    });
    expect(m.lines.indexOf(refusals[0])).toBeLessThan(
      m.lines.findIndex((line) => line.startsWith("playwright-e2e-apt-restore ")),
    );
    console.log("MUTANT_RED M-later-override");
  });

  it.each([
    [
      'Dir::Etc "https://fixture-user:fixture-password@example.invalid/apt";',
      "dir-root",
      "Dir::Etc",
      "ineffective-elevated-config",
    ],
    [
      'Acquire::http::Timeout "https://fixture-user:fixture-password@example.invalid/apt";',
      "bounds-value",
      "Acquire::http::Timeout",
      "ineffective-elevated-config",
    ],
    [
      'Acquire::https::example.invalid::Timeout "https://fixture-user:fixture-password@example.invalid/apt";',
      "option-bound",
      "Acquire::https::example.invalid::Timeout",
      "ineffective-elevated-config",
    ],
    [
      'Acquire::https::example.invalid::Verify-Peer "https://fixture-user:fixture-password@example.invalid/apt";',
      "trust-option",
      "Acquire::https::example.invalid::Verify-Peer",
      "trust-bypass",
    ],
  ])("refusal record redacts URL userinfo for %s", (override, guard, key, reason) => {
    const m = machine();
    m.files.set("/etc/apt/apt.conf.d/zzzz-refusal", `${override}\n`);
    m.original = new Map(m.files);
    expect(() => prepareE2eApt(m.options)).toThrow(reason);
    expect(m.files).toEqual(m.original);
    const refusals = m.lines.filter((line) => line.startsWith("playwright-e2e-apt-refusal "));
    expect(refusals).toHaveLength(1);
    expect(JSON.parse(refusals[0].slice("playwright-e2e-apt-refusal ".length))).toEqual({
      guard,
      key,
      value: "https://[redacted]@example.invalid/apt",
      configEntries: ["zzz-chase-sets-e2e", "zzzz-refusal"],
    });
    expect(m.lines.join("\n")).not.toMatch(/fixture-user|fixture-password/);
    console.log(`MUTANT_RED M-refusal-redaction-${guard}`);
  });

  it("success record redacts URL userinfo in effective apt-config values", () => {
    const m = machine();
    m.files.set(
      "/etc/apt/apt.conf.d/10-proxy",
      'Acquire::http::Proxy "https://fixture-user:fixture-password@example.invalid/proxy";\n',
    );
    m.original = new Map(m.files);
    const apt = prepareE2eApt(m.options);
    expect(m.lines.join("\n")).toContain("https://[redacted]@example.invalid/proxy");
    expect(m.lines.join("\n")).not.toMatch(/fixture-user|fixture-password/);
    apt.restore();
    expect(m.files).toEqual(m.original);
  });

  it("absent effective bounds produce a named refusal before restore", () => {
    const m = machine({ effective: "" });
    expect(() => prepareE2eApt(m.options)).toThrow("ineffective-elevated-config");
    expect(m.files).toEqual(m.original);
    expect(
      JSON.parse(
        m.lines
          .find((line) => line.startsWith("playwright-e2e-apt-refusal "))
          .slice("playwright-e2e-apt-refusal ".length),
      ),
    ).toEqual({
      guard: "bounds-value",
      key: "Acquire::http::Timeout",
      value: "absent",
      configEntries: ["zzz-chase-sets-e2e"],
    });
  });

  it("projects every Ubuntu metadata/package URI, preserving suites/components/source-relative keys and untouched third-party bytes", () => {
    const input = fixture();
    const result = projectUbuntuSources(input);
    expect(result.projected).toBe(true);
    expect(result.sources[ubuntuPath]).not.toMatch(/azure|mirror\+/);
    expect(result.sources[ubuntuPath]).toContain("URIs: https://archive.ubuntu.com/ubuntu");
    expect(result.sources[ubuntuPath]).toContain("URIs: https://security.ubuntu.com/ubuntu");
    expect(result.sources[thirdPartyPath]).toBe(thirdParty);
    expect(() => validateUbuntuProjection(input.sources, result.sources, mirrors)).not.toThrow();
    const azure = fixture();
    azure.sources[ubuntuPath] = ubuntu.replace(mirrorUri, "http://azure.archive.ubuntu.com/ubuntu/");
    expect(projectUbuntuSources(azure).sources[ubuntuPath]).not.toContain("azure");
    const legacy = fixture();
    legacy.sources = {
      "/etc/apt/sources.list":
        "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://azure.archive.ubuntu.com/ubuntu/ noble-security main\n",
    };
    expect(projectUbuntuSources(legacy).sources["/etc/apt/sources.list"]).toContain(
      "https://security.ubuntu.com/ubuntu noble-security main",
    );
  });

  it.each([
    [
      "M-azure-source",
      (text) => text.replace("https://archive.ubuntu.com/ubuntu", "http://azure.archive.ubuntu.com/ubuntu"),
      "mixed-sources",
    ],
    [
      "M-projected-key-swap",
      (text) => text.replaceAll("ubuntu-archive-keyring.gpg", "replacement.gpg"),
      "projected-key-swap",
    ],
    ["M-trust-bypass", (text) => text.replace("Types: deb", "Types: deb\nTrusted: yes"), "trust-bypass"],
  ])("rejects governing projected-file mutant %s with other inputs frozen", (name, mutate, reason) => {
    const input = fixture();
    const plan = projectUbuntuSources(input);
    const projected = { ...plan.sources, [ubuntuPath]: mutate(plan.sources[ubuntuPath]) };
    expect(() => validateUbuntuProjection(input.sources, projected, mirrors)).toThrow(reason);
    console.log(`MUTANT_RED ${name}`);
  });

  it("M-image-drift: Ubuntu 26 or missing official entry stays unmitigated and untouched, never refused", () => {
    for (const delta of [{ release: "26.04", codename: "resolute" }, { architecture: "ARM64" }, { mirrors: {} }]) {
      const input = { ...fixture(), ...delta };
      const result = projectUbuntuSources(input);
      expect(result).toEqual({ projected: false, sources: input.sources });
    }
    const m = machine();
    m.files.set("/etc/os-release", 'VERSION_ID="26.04"\nVERSION_CODENAME=resolute\n');
    expect(prepareE2eApt(m.options).projected).toBe(false);
    expect(m.command).not.toHaveBeenCalled();
    expect(m.lines.join("\n")).toContain("image-drift-unmitigated");
    console.log("MUTANT_RED M-image-drift");
  });

  it("M-pinned-image-profile: changed ImageVersion and rotated third-party keys still project without drift/refusal", () => {
    for (const delta of [{ version: "20261108.999.1" }, { thirdPartyKey: "rotated-key" }]) {
      const m = machine(delta);
      const apt = prepareE2eApt(m.options);
      expect(apt.projected).toBe(true);
      expect(m.files.get(thirdPartyPath)).toBe(thirdParty);
      expect(m.lines.join("\n")).not.toContain("image-drift-unmitigated");
      apt.restore();
      expect(m.files).toEqual(m.original);
    }
    console.log("MUTANT_RED M-pinned-image-profile");
  });

  it("M-root-config-lost: ineffective elevated bounds refuse and restore all original bytes", () => {
    const m = machine({ effective: 'Acquire::http::Timeout "120";\n' });
    expect(() => prepareE2eApt(m.options)).toThrow("ineffective-elevated-config");
    expect(m.files).toEqual(m.original);
    console.log("MUTANT_RED M-root-config-lost");
  });

  it.each([
    ['Binary::apt-get::Acquire::Retries "20";', "ineffective-elevated-config"],
    ['Binary::apt-get::Dir::Etc::sourcelist "elsewhere";', "ineffective-elevated-config"],
    ['Acquire::https::archive.ubuntu.com::Verify-Peer "false";', "trust-bypass"],
  ])("effective elevated config includes nested override %s", (override, reason) => {
    const m = machine();
    const command = m.options.command;
    m.options.command = (name, args, input) => {
      const result = command(name, args, input);
      return args[1] === "apt-config" ? `${result}\n${override}\n` : result;
    };
    expect(() => prepareE2eApt(m.options)).toThrow(reason);
    expect(m.files).toEqual(m.original);
  });

  it("rolls partial projection back and makes failed restore red without retry", async () => {
    const partial = machine({ failWrite: true });
    expect(() => prepareE2eApt(partial.options)).toThrow("partial write");
    expect(partial.files).toEqual(partial.original);
    const broken = machine({ failWrite: true, failRestore: true });
    expect(() => prepareE2eApt(broken.options)).toThrow("restore-failure");
    expect(broken.lines.join("\n")).toContain('"state":"restore-failure"');
    const run = vi.fn();
    const result = await installPlaywrightChromium({
      env: { ...envFor(makeCache()), PLAYWRIGHT_INSTALL_POLICY: "e2e-acquisition" },
      prepareAptImpl: () => prepareE2eApt(machine({ failWrite: true, failRestore: true }).options),
      runInstallerImpl: run,
      write: () => {},
    });
    expect(result.reason).toBe("restore-failure");
    expect(run).not.toHaveBeenCalled();
    const malformed = fixture();
    malformed.sources[ubuntuPath] = ubuntu.replace("Types: deb", "Types deb");
    expect(() => projectUbuntuSources(malformed)).toThrow("malformed-sources");
  });

  it("M-projection-leaks-single-attempt: ordinary callers neither project nor change their 600-second bound", async () => {
    const prepareAptImpl = vi.fn();
    const run = vi.fn(async () => ({ status: 0, record: { terminalOutcome: "success" } }));
    const result = await installPlaywrightChromium({
      env: envFor(makeCache()),
      prepareAptImpl,
      runInstallerImpl: run,
      inspectCacheImpl: () => ({ complete: true, state: "complete" }),
      write: () => {},
    });
    expect(result.status).toBe(0);
    expect(prepareAptImpl).not.toHaveBeenCalled();
    expect(run.mock.calls[0][0].timeoutSeconds).toBe(600);
    console.log("MUTANT_RED M-projection-leaks-single-attempt");
  });
});

describe("E2E payload authority and retirement", () => {
  const payloads = [
    { name: "chromium", revision: "1" },
    { name: "chromium_headless_shell", revision: "2" },
    { name: "ffmpeg", revision: "3" },
  ];
  const completeCache = () => {
    const cache = makeCache();
    for (const [index, item] of payloads.entries()) {
      const root = path.join(cache, `${item.name}-${item.revision}`);
      mkdirSync(root);
      writeFileSync(path.join(root, ["chrome", "chrome-headless-shell", "ffmpeg-linux"][index]), "payload");
      writeFileSync(path.join(root, "INSTALLATION_COMPLETE"), "");
    }
    return cache;
  };
  it("M-incomplete-payload: cold/hit/incomplete/wrong-version/readability and ownership are distinct", () => {
    expect(inspectCache(path.join(makeCache(), "absent"), { payloads }).state).toBe("cold");
    const cache = completeCache();
    expect(inspectCache(cache, { payloads })).toMatchObject({ state: "complete", complete: true, manifestCount: 3 });
    expect(inspectCache(cache, { payloads: [{ ...payloads[0], revision: "99" }, ...payloads.slice(1)] }).complete).toBe(
      false,
    );
    expect(
      inspectCache(cache, {
        payloads,
        access: () => {
          throw new Error("denied");
        },
      }).state,
    ).toBe("unreadable");
    expect(inspectCache(cache, { payloads, ownerUid: -1 }).owned).toBe(false);
    rmSync(path.join(cache, "chromium_headless_shell-2", "INSTALLATION_COMPLETE"));
    expect(inspectCache(cache, { payloads }).complete).toBe(false);
    console.log("MUTANT_RED M-incomplete-payload");
  });

  it("M-broad-restore: installed-version/OS/arch identity is exact and HOME-derived, without fallback", () => {
    const cache = resolveE2eCache({ HOME: makeCache(), RUNNER_OS: "Linux", RUNNER_ARCH: "X64" });
    expect(cache.payloads).toHaveLength(3);
    expect(cache.nativePackages).toHaveLength(9);
    expect(path.isAbsolute(cache.cachePath)).toBe(true);
    expect(cache.key).toMatch(/^e2e-playwright-Linux-X64-\d+\.\d+\.\d+-\d+-\d+-\d+$/);
    const job = workflowJob("platform-pr.yml", "e2e-tests");
    const step = job.steps.find((step) => step.name === "Cache Playwright Chromium");
    expect(step.with["restore-keys"]).toBeUndefined();
    expect(step.if).toBeUndefined();
    console.log("MUTANT_RED M-broad-restore");
  });

  it("AC4 tracked-inventory/registry/runtime preflight rejects stale diagnostic paths and policy", () => {
    const tracked = execFileSync(
      "git",
      ["ls-files", "--", ".github/workflows"],
      gitListingOptions({ encoding: "utf8" }),
    )
      .trim()
      .split(/\r?\n/)
      .filter((file) => existsSync(file));
    for (const file of tracked)
      expect(releaseQualificationScopeRegistry.workflows[path.basename(file)], file).toBeTruthy();
    expect(validateReleaseQualificationScopeRegistry(releaseQualificationScopeRegistry)).toEqual([]);
    expect(checkGithubActionsRuntime()).toEqual({ passed: true, violations: [] });
    const retired = "playwright-chromium-install-" + "diagnostics";
    expect(Object.keys(releaseQualificationScopeRegistry.workflows).some((name) => name.includes(retired))).toBe(false);
    const retiredPolicy = "diagnostic" + "-retry";
    const references = spawnSync(
      "git",
      [
        "grep",
        "-n",
        "-E",
        `${retired}|${retiredPolicy}`,
        "--",
        ".github/workflows",
        "scripts/playwright-chromium-install.mjs",
        "scripts/playwright-chromium-install.test.mjs",
        "scripts/release-qualification-scope.mjs",
      ],
      { encoding: "utf8" },
    );
    expect(references.stdout.trim()).toBe("");
    expect(references.status).toBe(1);
  });
});

describe("E2E bounded acquisition", () => {
  it("M-180-cutoff/M-default-600-changed: E2E succeeds after 300s through the same supervisor", async () => {
    const f = supervisedInstall({ policy: "e2e-acquisition" });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.signalGroupImpl).not.toHaveBeenCalled();
    mkdirSync(path.join(f.cache, "chromium-1"), { recursive: true });
    writeFileSync(path.join(f.cache, "chromium-1", "chrome"), "payload");
    f.children[0].emit("message", { installerStatus: 0 });
    f.children[0].emit("close", 0);
    expect(await f.result).toMatchObject({ status: 0, reason: "success" });
    expect(f.lines.filter((line) => line.startsWith("provider-browser-install-timing/v1"))).toHaveLength(1);
  });

  it.each(["stall", "trickle", "resistant-child"])(
    "F bounds %s with synchronous cleanup, no overlap or second timeout",
    async (mode) => {
      const f = supervisedInstall({ policy: "e2e-acquisition" });
      for (let elapsed = 0; elapsed < 540_000; elapsed += 30_000) {
        if (mode === "trickle") f.children[0].stdout.write("one more byte\n");
        await vi.advanceTimersByTimeAsync(30_000);
      }
      if (mode === "resistant-child") f.children[0].emit("close", 0);
      expect(f.signalGroupImpl.mock.calls).toEqual([[4567, "TERM"]]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await f.result).toMatchObject({ status: 1, reason: "timeout" });
      expect(f.signalGroupImpl.mock.calls).toEqual([
        [4567, "TERM"],
        [4567, "KILL"],
      ]);
      expect(f.elapsedMs()).toBe(545_000);
      expect(f.children).toHaveLength(1);
      expect(f.delayImpl).not.toHaveBeenCalled();
    },
  );

  it("retains both attempt records and restores once, before success publication", async () => {
    const events = [];
    let attempt = 0;
    const result = await installPlaywrightChromium({
      env: { ...envFor(makeCache()), PLAYWRIGHT_INSTALL_POLICY: "e2e-acquisition" },
      now: () => 0,
      prepareAptImpl: () => ({ projected: false, restore: () => events.push("restore") }),
      inspectCacheImpl: () => ({ state: "complete", complete: true, owned: true }),
      removeCacheImpl: () => events.push("remove"),
      delayImpl: async () => events.push("delay"),
      runInstallerImpl: async ({ write }) => {
        const outcome = ++attempt === 1 ? "partial-download" : "success";
        write(`provider-browser-install-timing/v1 ${outcome}`);
        return { status: attempt === 1 ? 1 : 0, record: { terminalOutcome: outcome } };
      },
      write: (line) => events.push(line),
    });
    expect(result.status).toBe(0);
    expect(events.filter((line) => line.startsWith("provider-browser-install-timing/v1"))).toEqual([
      "provider-browser-install-timing/v1 partial-download",
      "provider-browser-install-timing/v1 success",
    ]);
    expect(events.indexOf("remove")).toBeLessThan(events.indexOf("delay"));
    expect(events.filter((line) => line === "restore")).toHaveLength(1);
    expect(events.indexOf("restore")).toBeLessThan(events.findIndex((line) => line.startsWith("playwright-e2e-whole")));
  });

  it("native/font superset gates only projected runs; restore failure prevents publication", async () => {
    for (const [projected, restoreFails, expected] of [
      [true, false, "native-validation-failure"],
      [false, false, "success"],
      [false, true, "restore-failure"],
    ]) {
      const result = await installPlaywrightChromium({
        env: { ...envFor(makeCache()), PLAYWRIGHT_INSTALL_POLICY: "e2e-acquisition" },
        prepareAptImpl: () => ({
          projected,
          restore() {
            if (restoreFails) throw new Error("denied");
          },
        }),
        nativeInventoryImpl: () => ({ packages: "", fonts: "" }),
        nativePackages: ["fonts-unifont"],
        inspectCacheImpl: () => ({ state: "complete", complete: true }),
        removeCacheImpl: vi.fn(),
        runInstallerImpl: async () => ({ status: 0, record: { terminalOutcome: "success" } }),
        write: () => {},
      });
      expect(result.reason).toBe(expected);
      expect(result.status).toBe(expected === "success" ? 0 : 1);
    }
  });

  it("M-suite-budget-overrun/M-second-supervisor: one governing-input mutation breaks each composition assertion", () => {
    const job = workflowJob("platform-pr.yml", "e2e-tests");
    const step = job.steps.find((step) => step.name === "Install Playwright Chromium");
    const assertBudget = (minutes) =>
      expect(minutes * 60 + 60 + 780 + 60).toBeLessThanOrEqual(job["timeout-minutes"] * 60);
    assertBudget(step["timeout-minutes"]);
    expect(() => assertBudget(11)).toThrow();
    const source = readFileSync("scripts/playwright-chromium-install.mjs", "utf8");
    const assertOneSupervisor = (text) => expect(text).not.toMatch(/signalGroup|superviseInstaller|spawn\s*\(/);
    assertOneSupervisor(source);
    expect(() => assertOneSupervisor(`${source}\nsignalGroup(pid, 'TERM')`)).toThrow();
  });

  function acquisition({
    outcomes = ["partial-download", "success"],
    inspect,
    remove,
    delay,
    build,
    cancelSignal,
  } = {}) {
    let ms = 0;
    let complete = false;
    const runInstallerImpl = vi.fn(async (options) => {
      const outcome = outcomes[runInstallerImpl.mock.calls.length - 1] ?? "partial-download";
      complete = outcome === "success";
      options.write(`provider-browser-install-timing/v1 ${outcome}`);
      return {
        status: complete ? 0 : 1,
        record: { terminalOutcome: outcome },
        ...(outcome === "start-refusal" ? { startRefused: true } : {}),
      };
    });
    const removeCacheImpl = vi.fn(remove ?? (() => {}));
    const delayImpl = vi.fn(
      delay ??
        (async (elapsed) => {
          ms += elapsed;
        }),
    );
    const inspectCacheImpl = vi.fn(inspect ?? (() => ({ state: complete ? "complete" : "cold", complete })));
    const lines = [];
    const result = installPlaywrightChromium({
      env: { ...envFor(path.resolve("synthetic-e2e-cache")), PLAYWRIGHT_INSTALL_POLICY: "e2e-acquisition" },
      now: () => ms,
      runInstallerImpl,
      inspectCacheImpl,
      removeCacheImpl,
      delayImpl,
      cancelSignal,
      ...(build ? { buildInvocationImpl: build } : {}),
      write: (line) => lines.push(line),
    });
    return {
      result,
      runInstallerImpl,
      removeCacheImpl,
      delayImpl,
      inspectCacheImpl,
      lines,
      advance: (elapsed) => {
        ms += elapsed;
      },
    };
  }

  it("passes 540 only for explicit E2E policy, retrying once after cleanup and 5s delay", async () => {
    const f = acquisition();
    await expect(f.result).resolves.toMatchObject({ status: 0, reason: "success" });
    expect(f.runInstallerImpl.mock.calls.map(([call]) => call.timeoutSeconds)).toEqual([540, 540]);
    expect(f.runInstallerImpl.mock.calls.every(([call]) => call.env.INSTALLER_TIMEOUT_SECONDS === "600")).toBe(true);
    expect(f.removeCacheImpl).toHaveBeenCalledOnce();
    expect(f.delayImpl.mock.calls).toEqual([[5000]]);
    expect(f.lines.filter((line) => line.startsWith("Playwright Chromium install retry"))).toHaveLength(1);
  });

  it.each(["start-refusal", "cancelled", "cleanup-failure", "cleanup-refusal"])(
    "never retries terminal %s",
    async (outcome) => {
      const f = acquisition({ outcomes: [outcome, "success"] });
      await expect(f.result).resolves.toMatchObject({ status: 1, reason: outcome });
      expect(f.runInstallerImpl).toHaveBeenCalledOnce();
      expect(f.delayImpl).not.toHaveBeenCalled();
      if (outcome === "cleanup-failure") expect(f.removeCacheImpl).not.toHaveBeenCalled();
    },
  );

  it("never retries authority or cache removal refusal", async () => {
    for (const options of [
      {
        build: () => {
          throw new Error("synthetic authority refusal");
        },
      },
      {
        remove: () => {
          throw new Error("synthetic removal refusal");
        },
      },
    ]) {
      const f = acquisition(options);
      expect((await f.result).status).toBe(1);
      expect(f.runInstallerImpl.mock.calls.length).toBeLessThanOrEqual(1);
      expect(f.delayImpl).not.toHaveBeenCalled();
    }
  });

  it("reserves the whole attempt plus grace after inspection and invocation construction", async () => {
    for (const stage of ["inspect", "build"]) {
      for (const elapsed of [25000, 25001]) {
        let clock = 0;
        const runInstallerImpl = vi.fn(failedAttempt("timeout"));
        const consume = () => {
          clock = elapsed;
        };
        const result = await installPlaywrightChromium({
          env: { ...envFor(path.resolve("synthetic-e2e-cache")), PLAYWRIGHT_INSTALL_POLICY: "e2e-acquisition" },
          now: () => clock,
          runInstallerImpl,
          removeCacheImpl: vi.fn(),
          delayImpl: vi.fn(),
          inspectCacheImpl: () => {
            if (stage === "inspect") consume();
            return { state: "cold", complete: false };
          },
          buildInvocationImpl: () => {
            if (stage === "build") consume();
            return { command: "synthetic", args: [] };
          },
          write: () => {},
        });
        expect(result.status).toBe(1);
        expect(runInstallerImpl).toHaveBeenCalledTimes(elapsed === 25000 ? 1 : 0);
      }
    }
  });

  it.each([20000, 20001])("reserves delay plus full retry at the %s ms boundary", async (elapsed) => {
    let clock = 0;
    const runInstallerImpl = vi.fn(async () => {
      clock += elapsed;
      return { status: 1, record: { terminalOutcome: "partial-download" } };
    });
    const result = await installPlaywrightChromium({
      env: { ...envFor(path.resolve("synthetic-e2e-cache")), PLAYWRIGHT_INSTALL_POLICY: "e2e-acquisition" },
      now: () => clock,
      runInstallerImpl,
      removeCacheImpl: vi.fn(),
      delayImpl: async (ms) => {
        clock += ms;
      },
      inspectCacheImpl: () => ({ state: "cold", complete: false }),
      write: () => {},
    });
    expect(result.status).toBe(1);
    expect(runInstallerImpl).toHaveBeenCalledTimes(elapsed === 20000 ? 2 : 1);
  });

  it("rechecks after delay, cleanup overhead and next inspection without overlapping", async () => {
    for (const stage of ["delay", "cleanup", "inspection"]) {
      let clock = 0;
      let inspections = 0;
      const runInstallerImpl = vi.fn(async () => {
        clock += 19000;
        return { status: 1, record: { terminalOutcome: "partial-download" } };
      });
      const result = await installPlaywrightChromium({
        env: { ...envFor(path.resolve("synthetic-e2e-cache")), PLAYWRIGHT_INSTALL_POLICY: "e2e-acquisition" },
        now: () => clock,
        runInstallerImpl,
        removeCacheImpl: () => {
          if (stage === "cleanup") clock += 1001;
        },
        delayImpl: async () => {
          clock += stage === "delay" ? 6001 : 5000;
        },
        inspectCacheImpl: () => {
          if (++inspections === 2 && stage === "inspection") clock += 1001;
          return { state: "cold", complete: false };
        },
        write: () => {},
      });
      expect(result).toMatchObject({ status: 1, reason: "budget-exhausted" });
      expect(runInstallerImpl).toHaveBeenCalledOnce();
    }
  });

  it("rejects late success after post-attempt inspection exhausts the envelope", async () => {
    let clock = 0;
    let inspections = 0;
    const result = await installPlaywrightChromium({
      env: { ...envFor(path.resolve("synthetic-e2e-cache")), PLAYWRIGHT_INSTALL_POLICY: "e2e-acquisition" },
      now: () => clock,
      runInstallerImpl: async () => ({ status: 0, record: { terminalOutcome: "success" } }),
      inspectCacheImpl: () => {
        if (++inspections === 2) clock = 570001;
        return { state: "complete", complete: true };
      },
      removeCacheImpl: vi.fn(),
      delayImpl: vi.fn(),
      write: () => {},
    });
    expect(result).toMatchObject({ status: 1, reason: "timeout" });
  });

  it("cancellation during retry delay is terminal", async () => {
    const controller = new AbortController();
    const f = acquisition({ cancelSignal: controller.signal, delay: async () => controller.abort() });
    await expect(f.result).resolves.toMatchObject({ status: 1, reason: "cancelled" });
    expect(f.runInstallerImpl).toHaveBeenCalledOnce();
  });

  it("cancellation before any attempt refuses without spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    const f = acquisition({ cancelSignal: controller.signal });
    await expect(f.result).resolves.toMatchObject({ status: 1, reason: "cancelled" });
    expect(f.runInstallerImpl).not.toHaveBeenCalled();
    expect(f.removeCacheImpl).not.toHaveBeenCalled();
  });

  it("does not label success within-bound when terminal evidence writing exceeds the envelope", async () => {
    let clock = 0;
    const result = await installPlaywrightChromium({
      env: { ...envFor(path.resolve("synthetic-e2e-cache")), PLAYWRIGHT_INSTALL_POLICY: "e2e-acquisition" },
      now: () => clock,
      inspectCacheImpl: () => ({ state: "complete", complete: true }),
      runInstallerImpl: async ({ write }) => {
        write("provider-browser-install-timing/v1 synthetic-success");
        return { status: 0, record: { terminalOutcome: "success" } };
      },
      removeCacheImpl: vi.fn(),
      delayImpl: vi.fn(),
      write: (line) => {
        if (line.startsWith("provider-browser-install-timing/v1")) clock = 570001;
      },
    });
    expect(result).toMatchObject({ status: 1, reason: "timeout" });
  });
});
