import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkoutGit,
  checkpointWidths,
  completeTimeline,
  encodePng,
  identityEnv,
  scanPackageForWitnesses,
  witnessMarker,
  witnesses,
} from "../fixtures/journey-package/support.mjs";
import { journeyPackageStep } from "../prepare-journey-package.mjs";
import {
  checkpointNames,
  journeyPackageTarget,
  packageRoot,
  rawRoot,
  recordDirectory,
  timelineAttachmentName,
} from "./journey-package-contract.mjs";

// Real, browserless @playwright/test runs of the synthetic scenarios in
// scripts/fixtures/journey-package, each in a temporary root that mirrors the
// repository layout. The real reporter records the target; the real packager
// then builds (or refuses) the package from that record.
const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const playwrightCli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const fixtureConfig = path.join(repoRoot, "scripts/fixtures/journey-package/playwright.config.mjs");
const scenarioUrl = pathToFileURL(path.join(repoRoot, "scripts/fixtures/journey-package/scenario.mjs")).href;
const fixtureTimeout = 300_000;
const concurrency = 4;
const title = "synthetic market-following journey @marketplace-account";
const targetSpec = [
  `import { defineJourneyFixtureTest, expect } from ${JSON.stringify(scenarioUrl)};`,
  'defineJourneyFixtureTest({ inlineAssertion: () => expect(1, "inline fixture assertion").toBe(2) });',
  "",
].join("\n");
const otherSpec = `import { defineOtherFixtureTest } from ${JSON.stringify(scenarioUrl)};\ndefineOtherFixtureTest();\n`;
const inlineLocation = /^deployables\/marketplace\/e2e\/market-following-offers\.spec\.ts:2:[1-9][0-9]*$/;
const roots = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Timelines start an hour before the run so every capture entry precedes its attach.
const timelineStart = Date.now() - 3_600_000;
const timeline = completeTimeline(timelineStart);
const captureFiles = Object.fromEntries(
  checkpointNames.map((name) => [`files/${name}.png`, encodePng(checkpointWidths[name])]),
);
const credentialPixels = {
  "files/sign-in.png": encodePng(1440, 2, { text: witnesses.password }),
  "files/session.png": encodePng(390, 2, { text: witnesses.session }),
};
const attachTimeline = (value = timeline) => ({ attach: timelineAttachmentName, json: value });
// Active captures attach by path, so both Playwright attachment forms are exercised.
const attachCapture = (name) => ({
  attach: name,
  file: `files/${name}.png`,
  mode: name.startsWith("journey-active") ? "path" : "body",
});
const allCaptures = checkpointNames.map(attachCapture);
const reviewCaptures = allCaptures.slice(0, 2);

function withoutConfirmation() {
  const value = completeTimeline(timelineStart);
  value.entries = value.entries.filter(
    (entry) => entry.command !== "confirm-checkout" && entry.checkpoint !== "journey-checkout-confirmation-1440",
  );
  return value;
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function runFixture(plan, { args = [], workers = 1, maxFailures = 0, dependsOnOther = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "journey-reporter-"));
  roots.push(root);
  const write = (relative, content) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  };
  write("package.json", '{ "type": "module" }\n');
  write("plan.json", JSON.stringify({ title, ...plan }));
  write(journeyPackageTarget.file, targetSpec);
  write("other/other.spec.ts", otherSpec);
  for (const [relative, bytes] of Object.entries({ ...captureFiles, ...credentialPixels })) write(relative, bytes);
  const runnerTemp = path.join(root, "runner-temp");
  mkdirSync(runnerTemp);
  const run = await runNode([playwrightCli, "test", "--config", fixtureConfig, ...args], {
    ...process.env,
    JOURNEY_PACKAGE_FIXTURE_ROOT: root,
    JOURNEY_PACKAGE_FIXTURE_WORKERS: String(workers),
    JOURNEY_PACKAGE_FIXTURE_MAX_FAILURES: String(maxFailures),
    JOURNEY_PACKAGE_FIXTURE_DEPENDS_ON_OTHER: String(dependsOnOther),
    PWTEST_CACHE_DIR: path.join(root, "playwright-transform-cache"),
    TEMP: runnerTemp,
    TMP: runnerTemp,
    TMPDIR: runnerTemp,
    GITHUB_RUN_ID: "7001",
    GITHUB_RUN_ATTEMPT: "1",
  });
  const recordPath = path.join(root, rawRoot, recordDirectory, "record.json");
  return {
    root,
    status: run.status,
    output: `${run.stdout}${run.stderr}`,
    record: existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null,
    recordText: existsSync(recordPath) ? readFileSync(recordPath, "utf8") : null,
  };
}

async function runAll(scenarios) {
  const entries = Object.entries(scenarios);
  const results = {};
  let next = 0;
  const lane = async () => {
    while (next < entries.length) {
      const [name, { plan, options }] = entries[next++];
      results[name] = await runFixture(plan, options);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, lane));
  return results;
}

// The last lines of each run's output, for an assertion message only.
function outputTails(runs) {
  return Object.entries(runs)
    .map(([name, run]) => `--- ${name} (exit ${run.status})\n${run.output.split("\n").slice(-15).join("\n")}`)
    .join("\n");
}

function packageOf(fixture, overrides = {}) {
  const env = identityEnv({
    JOURNEY_PACKAGE_PRODUCER_OUTCOME: fixture.status === 0 ? "success" : "failure",
    ...overrides,
  });
  const step = journeyPackageStep({
    root: fixture.root,
    env,
    git: checkoutGit(env),
    now: () => new Date("2026-11-03T12:00:00.000Z"),
  });
  const directory = path.join(fixture.root, packageRoot);
  const read = (file) => JSON.parse(readFileSync(path.join(directory, file), "utf8"));
  const published = existsSync(directory);
  return {
    ...step,
    directory,
    manifest: published ? read("manifest.json") : null,
    result: published ? read("result.json") : null,
    files: published ? read("manifest.json").files.map((file) => file.path) : null,
  };
}

describe("journey package reporter over real Playwright runs", () => {
  it("status taxonomy", { timeout: fixtureTimeout }, async () => {
    const overCapTimeline = `${JSON.stringify(timeline)}${" ".repeat(256 * 1024 + 1 - JSON.stringify(timeline).length)}`;
    const unsafe = completeTimeline(timelineStart);
    unsafe.entries[2].viewport.cookie = witnesses.cookie;
    const runs = await runAll({
      success: {
        plan: {
          steps: [attachTimeline(), ...allCaptures],
          other: [{ attach: "journey-review-390", file: "files/journey-review-390.png" }],
        },
      },
      incomplete: { plan: { steps: [attachTimeline(withoutConfirmation()), ...allCaptures.slice(0, 4)] } },
      unsafe: { plan: { steps: [attachTimeline(unsafe), ...allCaptures] } },
      conflicting: { plan: { steps: [attachTimeline(), attachTimeline(), ...allCaptures] } },
      duplicateTarget: { plan: { duplicate: true, steps: [attachTimeline(), ...allCaptures] } },
      overCap: {
        plan: {
          steps: [
            { attach: timelineAttachmentName, text: overCapTimeline, contentType: "application/json" },
            ...allCaptures,
          ],
        },
      },
      absent: {
        plan: { steps: [attachTimeline(), ...allCaptures] },
        options: { args: ["--project", "other-project"] },
      },
      unenrolled: { plan: { steps: allCaptures } },
      skipped: { plan: { steps: [attachTimeline(), ...reviewCaptures, { do: "skip" }] } },
      expectedFailure: {
        plan: { expectFailure: true, steps: [attachTimeline(), ...reviewCaptures, { do: "inline-assert" }] },
      },
      retryRecovered: {
        plan: { steps: [attachTimeline(), ...reviewCaptures, { do: "fail-first-attempt" }] },
        options: { args: ["--retries=1"] },
      },
      failed: { plan: { steps: [attachTimeline(), ...reviewCaptures, { do: "inline-assert" }] } },
      timedOut: { plan: { timeoutMs: 2000, steps: [attachTimeline(), { do: "hang" }] } },
      interrupted: {
        plan: {
          steps: [attachTimeline(), { do: "touch", file: "target-started" }, { do: "hang" }],
          other: [
            { do: "wait-for-file", file: "target-started" },
            { do: "throw", message: "synthetic other failure" },
          ],
        },
        options: { workers: 2, maxFailures: 1 },
      },
      notExecuted: {
        plan: { steps: [attachTimeline()], other: [{ do: "throw", message: "synthetic dependency failure" }] },
        options: { dependsOnOther: true },
      },
      invalidDiagnostics: {
        plan: {
          steps: [
            attachTimeline(),
            { attach: "journey-review-390", file: "files/journey-review-1440.png" },
            { do: "inline-assert" },
          ],
        },
      },
      unexpectedPass: { plan: { expectFailure: true, steps: [attachTimeline()] } },
    });

    const playwrightExit = Object.fromEntries(Object.entries(runs).map(([name, run]) => [name, run.status]));
    expect(playwrightExit, outputTails(runs)).toEqual({
      success: 0,
      incomplete: 0,
      unsafe: 0,
      conflicting: 0,
      duplicateTarget: 0,
      overCap: 0,
      absent: 0,
      unenrolled: 0,
      skipped: 0,
      expectedFailure: 0,
      retryRecovered: 0,
      failed: 1,
      timedOut: 1,
      interrupted: 1,
      notExecuted: 1,
      invalidDiagnostics: 1,
      unexpectedPass: 1,
    });

    // Producer success, target success: the success package.
    const success = packageOf(runs.success);
    expect(success).toMatchObject({
      exitCode: 0,
      outputs: { publish: "true", "artifact-name": "journey-package-7001-1-3", package: "success" },
      manifest: { package: "success", state: "passed", partial: false, identity: { test: { title, retry: 0 } } },
      result: { state: "passed", expectedStatus: "passed", status: "passed", outcome: "expected", retry: 0 },
    });
    expect(success.files).toHaveLength(7);
    expect(runs.success.record.targets).toHaveLength(1);
    expect(runs.success.record.targets[0].attempts[0].candidates.map((candidate) => candidate.name)).toEqual([
      timelineAttachmentName,
      ...checkpointNames,
    ]);

    // Producer success, target passed but incomplete, unsafe, conflicting or over cap: refused.
    for (const [name, code] of [
      ["incomplete", "timeline-incomplete"],
      ["unsafe", "timeline-invalid"],
      ["conflicting", "timeline-conflict"],
      ["duplicateTarget", "target-conflict"],
      ["overCap", "over-cap"],
    ]) {
      const refused = packageOf(runs[name]);
      expect(refused.outcome, name).toMatchObject({ status: "refused", code });
      expect(refused.exitCode, name).toBe(1);
      expect(refused.outputs, name).toEqual({ publish: "false" });
      expect(refused.manifest, name).toBeNull();
    }

    // Producer success, target absent or unenrolled: summary only, exit 0.
    expect(runs.absent.record).toBeNull();
    for (const [name, state] of [
      ["absent", "absent"],
      ["unenrolled", "unenrolled"],
    ]) {
      expect(packageOf(runs[name]), name).toMatchObject({
        exitCode: 0,
        outputs: { publish: "false" },
        outcome: { status: "summary", state },
        manifest: null,
      });
    }

    // Producer success, target skipped, expected failure or retry-recovered: diagnostics.
    for (const [name, state, status, outcome] of [
      ["skipped", "skipped", "skipped", "skipped"],
      ["expectedFailure", "expected-failure", "failed", "expected"],
      ["retryRecovered", "retry-recovered", "failed", "flaky"],
    ]) {
      expect(packageOf(runs[name]), name).toMatchObject({
        exitCode: 0,
        outputs: { publish: "true", "artifact-name": "journey-package-diagnostics-7001-1-3", package: "diagnostics" },
        manifest: { package: "diagnostics", state, partial: true, identity: { producerOutcome: "success" } },
        result: { state, status, outcome, retry: 0 },
      });
    }
    expect(runs.retryRecovered.record.targets[0].attempts.map((attempt) => attempt.status)).toEqual([
      "failed",
      "passed",
    ]);

    // Producer failure, target failed, timed out, interrupted or not executed: partial diagnostics, exit 0.
    for (const [name, state, classification] of [
      ["failed", "failed", "assertion"],
      ["timedOut", "timed-out", "timeout"],
      ["interrupted", "interrupted", null],
      ["notExecuted", "not-executed", null],
      ["unexpectedPass", "failed", "unknown"],
    ]) {
      const diagnostics = packageOf(runs[name]);
      expect(diagnostics, name).toMatchObject({
        exitCode: 0,
        outputs: { publish: "true", "artifact-name": "journey-package-diagnostics-7001-1-3" },
        manifest: { package: "diagnostics", state, partial: true, identity: { producerOutcome: "failure" } },
        result: { state, retry: 0 },
      });
      if (classification !== null) expect(diagnostics.result.classification, name).toBe(classification);
    }
    const failed = packageOf(runs.failed);
    expect(failed.result.location).toMatch(inlineLocation);
    expect(failed.files).toEqual([
      "captures/journey-review-1440.png",
      "captures/journey-review-390.png",
      "result.json",
      "timeline.json",
    ]);
    expect(packageOf(runs.notExecuted).files).toEqual(["result.json"]);
    expect(runs.notExecuted.record.targets[0].attempts).toEqual([]);
    expect(runs.interrupted.record.targets[0].attempts[0].status).toBe("interrupted");

    // Either producer outcome, diagnostics invalid: refused.
    expect(packageOf(runs.invalidDiagnostics).outcome).toMatchObject({
      status: "refused",
      code: "capture-invalid",
      path: "captures/journey-review-390.png",
    });

    // Conflicts: a failed target cannot ride a successful producer, and a stale record never qualifies.
    expect(packageOf(runs.failed, { JOURNEY_PACKAGE_PRODUCER_OUTCOME: "success" })).toMatchObject({
      exitCode: 1,
      outcome: { status: "refused", code: "outcome-conflict" },
    });
    expect(packageOf(runs.success, { GITHUB_RUN_ATTEMPT: "2" })).toMatchObject({
      exitCode: 1,
      outcome: { status: "refused", code: "record-stale" },
    });
  });

  it("secret-bearing inputs never leave", { timeout: fixtureTimeout }, async () => {
    const adversarialMessage = [
      `Error: ${witnesses.session} ${witnesses.password}`,
      `Locator: getByText('${witnesses.cookie}')`,
      `    at deployables/marketplace/e2e/market-following-offers.spec.ts:1:1 ${witnesses.postgres}`,
      `${witnesses.bearer} ${witnesses.url}`,
    ].join("\n");
    const futureCapture = completeTimeline(Date.now() + 3_600_000);
    const authRoute = completeTimeline(timelineStart);
    authRoute.entries[2].route = "/sign-in";
    const nested = completeTimeline(timelineStart);
    nested.entries[1].offerIds = [witnesses.session];
    const runs = await runAll({
      safeFailure: {
        plan: {
          steps: [
            attachTimeline(),
            ...reviewCaptures,
            { attach: "sign-in", file: "files/sign-in.png" },
            { attach: "screenshot", file: "files/session.png" },
            { attach: "storage-state", json: { cookies: [witnesses.cookie], origins: [witnesses.url] } },
            { do: "throw", message: adversarialMessage },
          ],
        },
      },
      setupFailurePng: {
        plan: {
          steps: [attachTimeline(futureCapture), reviewCaptures[0], { do: "throw", message: adversarialMessage }],
        },
      },
      authRoutePng: {
        plan: {
          steps: [
            attachTimeline(authRoute),
            { attach: "journey-review-390", file: "files/session.png" },
            { do: "assert" },
          ],
        },
      },
      nestedTimeline: { plan: { steps: [attachTimeline(nested), { do: "throw", message: adversarialMessage }] } },
      cleanControl: { plan: { steps: [attachTimeline(), ...allCaptures] } },
    });

    // The witnesses really reached Playwright: its own output carries the error text.
    expect(runs.safeFailure.status, outputTails(runs)).toBe(1);
    expect(runs.safeFailure.output).toContain(witnesses.session);

    // Safe failure: diagnostics publish, with error text, error-context and
    // unlisted, automatic and credential-pixel PNGs excluded and counted.
    const safe = packageOf(runs.safeFailure);
    expect(safe.outcome).toMatchObject({ status: "published", package: "diagnostics", state: "failed" });
    expect(safe.result).toMatchObject({ classification: "unknown", knownLocator: "unknown", location: null });
    expect(scanPackageForWitnesses(safe.directory).hits).toEqual([]);
    const excluded = runs.safeFailure.record.targets[0].attempts[0].excluded;
    expect(excluded.unlisted).toBe(2);
    expect(excluded.automatic).toBeGreaterThanOrEqual(2);
    expect(excluded.png).toBe(2);
    expect(safe.summary.join("\n")).toContain("excluded attachments: automatic");
    expect(runs.safeFailure.recordText.toLowerCase()).not.toContain(witnessMarker);

    // Setup-failure, auth-route and nested-field witnesses refuse the whole package.
    for (const [name, code] of [
      ["setupFailurePng", "capture-provenance"],
      ["authRoutePng", "timeline-invalid"],
      ["nestedTimeline", "timeline-invalid"],
    ]) {
      const refused = packageOf(runs[name]);
      expect(refused.outcome, name).toMatchObject({ status: "refused", code });
      expect(refused.manifest, name).toBeNull();
      expect(JSON.stringify(refused).toLowerCase(), name).not.toContain(witnessMarker);
      expect(runs[name].recordText.toLowerCase(), name).not.toContain(witnessMarker);
    }

    // Clean control: a full success package has nothing to find.
    const clean = packageOf(runs.cleanControl);
    expect(clean.outcome).toMatchObject({ status: "published", package: "success" });
    expect(scanPackageForWitnesses(clean.directory).hits).toEqual([]);
  });

  it(
    "stays inert under --list, a command-line reporter, and for every other test",
    { timeout: fixtureTimeout },
    async () => {
      const plan = { plan: { steps: [attachTimeline(), ...allCaptures] } };
      const runs = await runAll({
        list: { ...plan, options: { args: ["--list"] } },
        lineReporter: { ...plan, options: { args: ["--reporter=line"] } },
        otherOnly: { ...plan, options: { args: ["--project", "other-project"] } },
      });
      for (const [name, run] of Object.entries(runs)) {
        expect(run.status, `${name}: ${run.output}`).toBe(0);
        expect(existsSync(path.join(run.root, rawRoot, recordDirectory)), name).toBe(false);
      }
    },
  );
});
