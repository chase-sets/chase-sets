import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserE2eLifecyclePathEnv,
  browserE2eReadinessEvidencePathEnv,
  browserE2eTestTimelinePathEnv,
  BrowserE2eTestTimelineReporter,
  createBrowserE2eLifecycleRecorder,
  createBrowserE2eRunEvidenceEnvironment,
  createReadinessTimeline,
  joinBrowserE2eTestTimelineWithLifecycle,
  readJsonIfPresent,
} from "./browser-e2e-evidence.mjs";
import { waitForBrowserE2eReadiness } from "./browser-e2e-readiness.mjs";

const temporaryDirectories = [];
const spawnedChildren = [];

afterEach(async () => {
  await Promise.all(
    spawnedChildren.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const closed = once(child, "close");
      child.kill();
      await closed;
    }),
  );
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chase-sets-browser-e2e-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("browser e2e lifecycle evidence", () => {
  it("gives each Playwright web-server run isolated evidence paths", () => {
    const rootDir = path.resolve("test-repo");
    const environment = createBrowserE2eRunEvidenceEnvironment(
      { rootDir, id: "lane-09" },
      { now: 1_700_000_000_000, pid: 6034 },
    );

    expect(environment).toEqual({
      [browserE2eLifecyclePathEnv]: path.join(
        rootDir,
        "artifacts",
        "browser-e2e",
        "runs",
        "lane-09",
        "2023-11-14T221320-000Z-6034",
        "lifecycle.json",
      ),
      [browserE2eReadinessEvidencePathEnv]: path.join(
        rootDir,
        "artifacts",
        "browser-e2e",
        "runs",
        "lane-09",
        "2023-11-14T221320-000Z-6034",
        "readiness.json",
      ),
      [browserE2eTestTimelinePathEnv]: path.join(
        rootDir,
        "artifacts",
        "browser-e2e",
        "runs",
        "lane-09",
        "2023-11-14T221320-000Z-6034",
        "test-timeline.json",
      ),
    });
  });

  it("reports an injected early service exit with PID, exit identity, and bounded partial output tails", async () => {
    const directory = await createTemporaryDirectory();
    const lifecyclePath = path.join(directory, "lifecycle.json");
    const recorder = createBrowserE2eLifecycleRecorder({
      filePath: lifecyclePath,
      sandboxId: "test-sandbox",
      target: "browser-e2e",
      maxTailCharacters: 24,
      now: () => 1_700_000_000_000,
    });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          "process.stdout.write('discarded-prefix::stdout-partial');",
          "process.stderr.write('discarded-prefix::stderr-partial');",
          "process.exitCode = 37;",
        ].join(""),
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    spawnedChildren.push(child);
    recorder.observe("platform-worker", child);
    await once(child, "close");

    let now = 0;
    await expect(
      waitForBrowserE2eReadiness({
        components: [{ name: "platform-worker", url: "http://platform-worker/health/ready" }],
        fetchImpl: async () => ({ status: 503 }),
        timeoutMs: 100,
        pollMs: 25,
        now: () => now,
        sleepImpl: async (ms) => {
          now += ms;
        },
        readLifecycleEvidence: () => readJsonIfPresent(lifecyclePath),
      }),
    ).rejects.toThrow(
      new RegExp(
        `platform-worker exited before reporting ready.*PID=${child.pid}, exitCode=37, signal=none.*stdoutTail.*=.*stdout-partial.*stderrTail.*=.*stderr-partial`,
      ),
    );

    const evidence = JSON.parse(await readFile(lifecyclePath, "utf8"));
    const worker = evidence.services[0];
    expect(worker).toMatchObject({
      name: "platform-worker",
      pid: child.pid,
      status: "exited",
      exitCode: 37,
      signal: null,
    });
    expect(worker.stdoutTail.length).toBeLessThanOrEqual(24);
    expect(worker.stderrTail.length).toBeLessThanOrEqual(24);
    expect(worker.stdoutOmittedCharacters).toBeGreaterThan(0);
    expect(worker.stderrOmittedCharacters).toBeGreaterThan(0);
    expect(worker.stdoutTail).toMatch(/stdout-partial$/);
    expect(worker.stderrTail).toMatch(/stderr-partial$/);
  });

  it("describes a service that remains alive but never becomes ready", async () => {
    const directory = await createTemporaryDirectory();
    const lifecyclePath = path.join(directory, "lifecycle.json");
    const recorder = createBrowserE2eLifecycleRecorder({
      filePath: lifecyclePath,
      sandboxId: "test-sandbox",
      target: "browser-e2e",
    });
    const child = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(() => {}, 1000);"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    spawnedChildren.push(child);
    recorder.observe("platform-worker", child);

    let now = 0;
    await expect(
      waitForBrowserE2eReadiness({
        components: [{ name: "platform-worker", url: "http://platform-worker/health/ready" }],
        fetchImpl: async () => ({ status: 503 }),
        timeoutMs: 100,
        pollMs: 25,
        now: () => now,
        sleepImpl: async (ms) => {
          now += ms;
        },
        readLifecycleEvidence: () => readJsonIfPresent(lifecyclePath),
      }),
    ).rejects.toThrow(
      new RegExp(
        `platform-worker \\(HTTP 503\\)[\\s\\S]*status=running.*PID=${child.pid}, exitCode=pending, signal=pending`,
      ),
    );

    child.kill();
    await once(child, "close");
  });
});

describe("browser e2e test timeline evidence", () => {
  it("writes every Playwright onTestEnd row durably", async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, "test-timeline.json");
    let now = 1_700_000_000_000;
    const reporter = new BrowserE2eTestTimelineReporter({
      filePath,
      sandboxId: "test-sandbox",
      now: () => now,
    });
    reporter.onBegin();

    for (let index = 1; index <= 2; index += 1) {
      now += 1_000;
      reporter.onTestEnd(
        {
          id: `test-${index}`,
          titlePath: () => ["buy funnel", `test ${index}`],
          parent: { project: () => ({ name: "marketplace-chromium" }) },
        },
        { retry: 0, status: "passed", duration: 100 + index },
      );
      const durableTimeline = JSON.parse(await readFile(filePath, "utf8"));
      expect(durableTimeline.tests).toHaveLength(index);
      expect(durableTimeline.tests[index - 1]).toMatchObject({
        sequence: index,
        testId: `test-${index}`,
        projectName: "marketplace-chromium",
        retry: 0,
        status: "passed",
      });
    }
  });

  it("orders test-nine completion before Marketplace exit", async () => {
    const directory = await createTemporaryDirectory();
    const timelinePath = path.join(directory, "test-timeline.json");
    const tests = Array.from({ length: 9 }, (_, index) => ({
      sequence: index + 1,
      testId: `test-${index + 1}`,
      completedAt: `2026-08-30T02:31:${String(40 + index).padStart(2, "0")}.000Z`,
    }));
    await writeFile(timelinePath, JSON.stringify({ tests }));

    const order = joinBrowserE2eTestTimelineWithLifecycle({
      lifecycle: {
        services: [
          {
            name: "marketplace",
            pid: 43444,
            status: "exited",
            exitedAt: "2026-08-30T02:31:49.000Z",
          },
        ],
      },
      testTimeline: readJsonIfPresent(timelinePath),
    });

    expect(order).toEqual({
      marketplacePid: 43444,
      testCount: 9,
      test9CompletedAt: "2026-08-30T02:31:48.000Z",
      marketplaceExitedAt: "2026-08-30T02:31:49.000Z",
      ordering: "marketplace-exited-after-test-nine",
    });

    expect(
      joinBrowserE2eTestTimelineWithLifecycle({
        lifecycle: { services: [{ name: "marketplace", pid: 43444, status: "running", exitedAt: null }] },
        testTimeline: readJsonIfPresent(timelinePath),
      }),
    ).toMatchObject({
      marketplacePid: 43444,
      test9CompletedAt: "2026-08-30T02:31:48.000Z",
      marketplaceExitedAt: null,
      ordering: "marketplace-alive-through-test-nine",
    });
  });

  it("rejects an exit after the last response but before test completion", () => {
    const lastResponseAt = "2026-08-30T02:31:47.000Z";
    const tests = Array.from({ length: 9 }, (_, index) => ({
      sequence: index + 1,
      testId: `test-${index + 1}`,
      completedAt: index === 8 ? "2026-08-30T02:31:49.000Z" : `2026-08-30T02:31:${40 + index}.000Z`,
    }));
    const marketplaceExitedAt = "2026-08-30T02:31:48.000Z";

    expect(Date.parse(marketplaceExitedAt)).toBeGreaterThan(Date.parse(lastResponseAt));
    expect(() =>
      joinBrowserE2eTestTimelineWithLifecycle({
        lifecycle: {
          services: [{ name: "marketplace", pid: 43444, status: "exited", exitedAt: marketplaceExitedAt }],
        },
        testTimeline: { tests },
      }),
    ).toThrow("marketplace exited at 2026-08-30T02:31:48.000Z before test 9 completed at 2026-08-30T02:31:49.000Z");
  });

  it("rejects a duplicate completion row that hides a missing test", () => {
    const tests = Array.from({ length: 9 }, (_, index) => ({
      sequence: index + 1,
      testId: `test-${index + 1}`,
      retry: 0,
      completedAt: `2026-08-30T02:31:${40 + index}.000Z`,
    }));
    tests[8].testId = tests[7].testId;

    expect(() =>
      joinBrowserE2eTestTimelineWithLifecycle({
        lifecycle: { services: [{ name: "marketplace", pid: 43444, status: "running", exitedAt: null }] },
        testTimeline: { tests },
      }),
    ).toThrow("Browser e2e test timeline completion row 9 is missing or duplicated.");
  });
});

describe("browser e2e readiness timeline", () => {
  it("records ordered state changes and drops duplicate polls", () => {
    let now = 1_700_000_000_000;
    const timeline = createReadinessTimeline({ startedAtMs: now, now: () => now });

    timeline.record("service-readiness", [{ name: "platform-worker", ready: false, observation: "fetch failed" }]);
    now += 250;
    timeline.record("service-readiness", [{ name: "platform-worker", ready: false, observation: "fetch failed" }]);
    now += 250;
    timeline.record("service-readiness", [{ name: "platform-worker", ready: true, observation: "HTTP 200" }]);

    expect(timeline.snapshot()).toEqual([
      expect.objectContaining({
        sequence: 1,
        elapsedMs: 0,
        phase: "service-readiness",
        component: "platform-worker",
        ready: false,
        observation: "fetch failed",
      }),
      expect.objectContaining({
        sequence: 2,
        elapsedMs: 500,
        phase: "service-readiness",
        component: "platform-worker",
        ready: true,
        observation: "HTTP 200",
      }),
    ]);
  });
});
