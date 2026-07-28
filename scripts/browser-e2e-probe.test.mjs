import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBrowserE2eProbe } from "./browser-e2e-probe.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTemporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chase-sets-browser-e2e-probe-"));
  temporaryDirectories.push(directory);
  return directory;
}

class FakeChild extends EventEmitter {
  constructor(pid, { connected = false, exitCode = null } = {}) {
    super();
    this.pid = pid;
    this.exitCode = exitCode;
    this.signalCode = null;
    this.connected = connected;
  }

  send(message) {
    expect(message).toEqual({ type: "browser-e2e-probe-shutdown" });
    setImmediate(() => {
      this.connected = false;
      this.exitCode = 0;
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    });
  }
}

describe("standalone browser e2e probe", () => {
  it("uses the package contract, launches no Playwright command, and emits a hashed machine-readable bundle", async () => {
    vi.stubEnv("CHASE_SETS_HEAVY_SLOT_ID", "0123456789abcdef0123456789abcdef");
    const outputDirectory = await createTemporaryDirectory();
    const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
    expect(packageJson.scripts["dev:e2e:probe"]).toBe("node ./scripts/browser-e2e-probe.mjs");
    await writeFile(
      path.join(outputDirectory, "lifecycle.json"),
      JSON.stringify({
        services: ["marketplace", "platform-api", "platform-worker"].map((name, index) => ({
          name,
          spawnedAt: "2023-11-14T22:13:20.000Z",
          pid: 6200 + index,
          status: "running",
        })),
      }),
    );
    await writeFile(
      path.join(outputDirectory, "readiness.json"),
      JSON.stringify({
        outcome: "ready",
        playwrightSpecsRun: 0,
        readinessTimeline: [
          ...["marketplace", "platform-api", "platform-worker"].map((component) => ({
            phase: "service-readiness",
            component,
            ready: true,
          })),
          { phase: "projection-readiness", component: "platform-worker", ready: true },
        ],
      }),
    );

    const children = [new FakeChild(6101, { connected: true }), new FakeChild(6102)];
    const spawnCalls = [];
    const runCalls = [];
    const result = await runBrowserE2eProbe({
      outputDirectory,
      sandbox: {
        id: "probe-test",
        urls: { portal: "http://127.0.0.1:6100" },
      },
      target: "browser-e2e",
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return children.shift();
      },
      run: async (command, args, options) => {
        runCalls.push({ command, args, options });
      },
      terminate: (child, signal) => {
        child.signalCode = signal;
        child.emit("exit", null, signal);
        child.emit("close", null, signal);
        return true;
      },
      fetchImpl: async () => ({ status: 200 }),
      now: () => 1_700_000_000_000,
    });

    const bundleBytes = await readFile(result.bundlePath);
    const bundle = JSON.parse(bundleBytes.toString("utf8"));
    const hash = createHash("sha256").update(bundleBytes).digest("hex");
    expect(bundle).toMatchObject({
      schemaVersion: 1,
      kind: "browser-e2e-standalone-probe",
      sandboxId: "probe-test",
      target: "browser-e2e",
      outcome: "ready",
      playwrightSpecsRun: 0,
      webServers: {
        services: [
          expect.objectContaining({ name: "dev-system", pid: 6101, status: "exited", exitCode: 0 }),
          expect.objectContaining({ name: "readiness", pid: 6102, status: "exited", signal: "SIGTERM" }),
        ],
      },
      teardown: {
        devSystem: { pid: 6101, exitCode: 0, signal: null },
        readiness: { pid: 6102, exitCode: null, signal: "SIGTERM" },
        devDown: { attempted: true, succeeded: true, error: null },
      },
    });
    expect(bundle.commands).toEqual([
      {
        name: "dev-system",
        command: "node",
        args: ["./scripts/dev-system.mjs", "dev", "browser-e2e"],
      },
      {
        name: "readiness",
        command: "node",
        args: ["./scripts/browser-e2e-readiness.mjs"],
      },
    ]);
    expect(JSON.stringify(bundle.commands).toLowerCase()).not.toContain("playwright");
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0].options.stdio).toEqual(["ignore", "pipe", "pipe", "ipc"]);
    expect(spawnCalls[0].options).toMatchObject({
      inheritEnv: false,
      env: {
        CHASE_SETS_BROWSER_E2E_PROBE: "true",
        CHASE_SETS_HEAVY_SLOT_ID: "0123456789abcdef0123456789abcdef",
        NOTIFICATION_EMAIL_PROVIDER: "noop",
        STRIPE_PUBLISHABLE_KEY: "",
        STRIPE_SECRET_KEY: "",
      },
    });
    expect(runCalls.map(({ command, args }) => [command, args])).toEqual([
      ["node", ["./scripts/dev-system.mjs", "down"]],
    ]);
    expect(result.hash).toBe(hash);
    expect(await readFile(result.hashPath, "utf8")).toBe(`${hash}  probe.json\n`);
  });

  it("preserves component-specific evidence when the dev-system exits before readiness", async () => {
    const outputDirectory = await createTemporaryDirectory();
    await writeFile(
      path.join(outputDirectory, "lifecycle.json"),
      JSON.stringify({
        services: [
          {
            name: "platform-worker",
            spawnedAt: "2023-11-14T22:13:20.000Z",
            pid: 6034,
            status: "exited",
            exitCode: 37,
            signal: null,
            stdoutTail: "worker partial output",
            stderrTail: "injected worker failure",
          },
        ],
      }),
    );

    const children = [new FakeChild(6101, { exitCode: 1 }), new FakeChild(6102)];
    let caught;
    try {
      await runBrowserE2eProbe({
        outputDirectory,
        sandbox: {
          id: "probe-test",
          urls: { portal: "http://127.0.0.1:6100" },
        },
        target: "browser-e2e",
        spawn: () => children.shift(),
        run: async () => undefined,
        terminate: (child, signal) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            return false;
          }
          child.signalCode = signal;
          child.emit("exit", null, signal);
          child.emit("close", null, signal);
          return true;
        },
        fetchImpl: async () => ({ status: 503 }),
        now: () => 1_700_000_000_000,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught?.message).toMatch(
      /dev-system exited before readiness.*platform-worker: status=exited.*PID=6034, exitCode=37, signal=none.*worker partial output.*injected worker failure/s,
    );
    const bundle = JSON.parse(await readFile(caught.evidence.bundlePath, "utf8"));
    expect(bundle).toMatchObject({
      outcome: "failed",
      playwrightSpecsRun: 0,
      lifecycle: {
        services: [
          expect.objectContaining({
            name: "platform-worker",
            pid: 6034,
            exitCode: 37,
          }),
        ],
      },
    });
  });
});
