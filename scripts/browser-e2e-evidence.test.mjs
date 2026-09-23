import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserE2eLifecyclePathEnv,
  browserE2eReadinessEvidencePathEnv,
  createBrowserE2eLifecycleRecorder,
  createBrowserE2eRunEvidenceEnvironment,
  createReadinessTimeline,
  readJsonIfPresent,
} from "./browser-e2e-evidence.mjs";
import { runObservedBrowserE2eBootstrap, sampleWindowsProcessTree } from "./browser-e2e-bootstrap-observation.mjs";
import { waitForBrowserE2eReadiness } from "./browser-e2e-readiness.mjs";

const temporaryDirectories = [];
const spawnedChildren = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
  it.each([
    ["app-platform-api", true],
    ["app-platform-api", false],
    ["app-platform-worker", true],
    ["app-platform-worker", false],
  ])(
    "persists a failing %s bootstrap child's stderr, wrapper and inner Node PID in the run directory (stderrToStderr=%s)",
    async (workspace, stderrToStderr) => {
      const directory = await createTemporaryDirectory();
      const lifecyclePath = path.join(directory, "lifecycle.json");
      const recorder = createBrowserE2eLifecycleRecorder({
        filePath: lifecyclePath,
        sandboxId: "synthetic-sandbox",
        target: "browser-e2e",
      });
      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
      const script = "process.stderr.write('synthetic bootstrap fatal\\n'); process.exit(37)";
      await expect(
        runObservedBrowserE2eBootstrap(process.execPath, ["-e", script], {
          name: `bootstrap-${workspace}`,
          prefix: workspace,
          recorder,
          environment: { PATH: process.env.PATH },
          stderrToStderr,
          sampleProcessTree: async (wrapperPid) => [
            { pid: wrapperPid, parentPid: process.pid, name: "node.exe", createdAt: "2026-09-23T00:00:00Z" },
            { pid: 81002, parentPid: wrapperPid, name: "node.exe", createdAt: "2026-09-23T00:00:01Z" },
          ],
        }),
      ).rejects.toThrow(/exited with code 37/);
      const destination = stderrToStderr ? stderr : stdout;
      const other = stderrToStderr ? stdout : stderr;
      expect(destination).toHaveBeenCalledWith(`[${workspace}] synthetic bootstrap fatal`);
      expect(other).not.toHaveBeenCalledWith(`[${workspace}] synthetic bootstrap fatal`);

      const evidence = JSON.parse(await readFile(lifecyclePath, "utf8"));
      expect(evidence.services).toEqual([
        expect.objectContaining({
          name: `bootstrap-${workspace}`,
          command: process.execPath,
          args: ["-e", script],
          parentPid: process.pid,
          pid: expect.any(Number),
          innerNodePid: 81002,
          processTree: [
            expect.objectContaining({ pid: expect.any(Number), parentPid: process.pid }),
            expect.objectContaining({ pid: 81002, parentPid: expect.any(Number) }),
          ],
          status: "exited",
          exitCode: 37,
          exitedAt: expect.any(String),
          stderrTail: expect.stringContaining("synthetic bootstrap fatal"),
        }),
      ]);
    },
  );

  it.each(["linux", "darwin"])("does not invoke the Windows process sampler on %s", async (platform) => {
    expect(await sampleWindowsProcessTree(81002, { platform })).toEqual([]);
  });

  it("does not queue slow process samples or start samples after bootstrap exit", async () => {
    const child = { pid: 81002, exitCode: null, signalCode: null };
    let outstanding = 0;
    let maximumOutstanding = 0;
    let sampleCalls = 0;
    let samplesAfterExit = 0;
    let exitedAt;
    const recorder = { observe: vi.fn(), recordProcessTree: vi.fn(), recordProcessTreeError: vi.fn() };
    const run = async (_command, _args, { onSpawn }) => {
      onSpawn(child);
      await delay(90);
      child.exitCode = 0;
      exitedAt = Date.now();
    };

    await runObservedBrowserE2eBootstrap("synthetic", [], {
      name: "bootstrap-slow",
      recorder,
      run,
      pollMs: 10,
      sampleProcessTree: async () => {
        sampleCalls += 1;
        if (child.exitCode !== null) samplesAfterExit += 1;
        outstanding += 1;
        maximumOutstanding = Math.max(maximumOutstanding, outstanding);
        await delay(120);
        outstanding -= 1;
        return [];
      },
    });

    expect(maximumOutstanding).toBe(1);
    expect(sampleCalls).toBe(1);
    expect(samplesAfterExit).toBe(0);
    expect(Date.now() - exitedAt).toBeLessThan(240);
  });

  it("preserves a bootstrap exit 37 when the process sampler never settles", async () => {
    const directory = await createTemporaryDirectory();
    const recorder = createBrowserE2eLifecycleRecorder({
      filePath: path.join(directory, "lifecycle.json"),
      sandboxId: "synthetic-sandbox",
      target: "browser-e2e",
    });

    await expect(
      runObservedBrowserE2eBootstrap(process.execPath, ["-e", "process.exit(37)"], {
        name: "bootstrap-hung-sampler",
        recorder,
        environment: { PATH: process.env.PATH },
        pollMs: 10,
        sampleProcessTree: () => new Promise(() => {}),
      }),
    ).rejects.toThrow(/exited with code 37/);
  });

  it("persists sampler error codes without changing a failing bootstrap outcome", async () => {
    const directory = await createTemporaryDirectory();
    const lifecyclePath = path.join(directory, "lifecycle.json");
    const recorder = createBrowserE2eLifecycleRecorder({
      filePath: lifecyclePath,
      sandboxId: "synthetic-sandbox",
      target: "browser-e2e",
    });
    const script = "process.stderr.write('synthetic bootstrap fatal\\n'); process.exit(37)";
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runObservedBrowserE2eBootstrap(process.execPath, ["-e", script], {
        name: "bootstrap-sampler-error",
        recorder,
        environment: { PATH: process.env.PATH },
        stderrToStderr: false,
        sampleProcessTree: async () => {
          throw Object.assign(new Error("synthetic"), { code: "ENOENT" });
        },
      }),
    ).rejects.toThrow(/exited with code 37/);

    const evidence = JSON.parse(await readFile(lifecyclePath, "utf8"));
    expect(evidence.services).toEqual([
      expect.objectContaining({
        name: "bootstrap-sampler-error",
        processTreeError: "ENOENT",
        exitCode: 37,
        stderrTail: expect.stringContaining("synthetic bootstrap fatal"),
        status: "exited",
      }),
    ]);
  });

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
