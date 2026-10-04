import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseDeploymentList,
  parseQuiesceOptions,
  runQuiescedBootstrap,
  changeSeedOwnership,
  spawnShellCommand,
  createKubernetesClient,
  QUIESCE_PROTOCOL_VERSION,
} from "../infrastructure/helm/platform/scripts/bootstrap-quiesce.mjs";

const ownerKey = "chase-sets.com/quiesce-owner";
const pauseKey = "autoscaling.keda.sh/paused-replicas";
function ownershipHarness(annotations = {}) {
  let version = 1;
  const state = { metadata: { resourceVersion: String(version), annotations } };
  const calls = [];
  const take = (owner) => {
    state.metadata = { resourceVersion: String(++version), annotations: { [ownerKey]: owner, [pauseKey]: "0" } };
  };
  const kubernetes = {
    readScaledObject: vi.fn(async () => structuredClone(state)),
    patchScaledObject: vi.fn(async (_name, patch) => {
      if (patch.metadata.resourceVersion !== state.metadata.resourceVersion) {
        throw Object.assign(new Error("Conflict"), { statusCode: 409 });
      }
      calls.push(patch);
      state.metadata.resourceVersion = String(++version);
      for (const [key, value] of Object.entries(patch.metadata.annotations)) {
        if (value === null) delete state.metadata.annotations[key];
        else state.metadata.annotations[key] = value;
      }
    }),
    readScale: async () => ({ specReplicas: 3 }),
    scaleDeployment: vi.fn(async () => {}),
    waitForReplicas: async () => {},
    pauseScaledObject: async (_name, owner) => {
      take(owner);
      return true;
    },
    resumeScaledObject: async () => {
      state.metadata.annotations = {};
      state.metadata.resourceVersion = String(++version);
    },
  };
  const log = vi.fn();
  const options = {
    mode: "scenario-seed",
    owner: "scenario-seed:synthetic-job",
    deployments: ["worker"],
    command: ["true"],
    timeoutMs: 1000,
    pollIntervalMs: 2000,
    kubernetes,
    log,
    spawnCommand: vi.fn(async () => 0),
  };
  return { state, calls, take, kubernetes, options, log };
}

describe("owner-fenced seed yield", () => {
  it("exports the capability marker and parses owner mode", () => {
    expect(QUIESCE_PROTOCOL_VERSION).toBe("owner-fenced-seed-yield/v1");
    expect(
      parseQuiesceOptions(["--", "true"], {
        CHASE_SETS_QUIESCE_MODE: "scenario-seed",
        CHASE_SETS_QUIESCE_OWNER: "scenario-seed:job",
      }),
    ).toMatchObject({ mode: "scenario-seed", owner: "scenario-seed:job" });
  });
  it.each([{ [pauseKey]: "0" }, { [ownerKey]: "helm-hook:pod" }, { [ownerKey]: "scenario-seed:stale" }])(
    "refuses any existing pause or owner before spawn: %j",
    async (annotations) => {
      const h = ownershipHarness(annotations);
      expect(await runQuiescedBootstrap(h.options)).toBe(75);
      expect(h.options.spawnCommand).not.toHaveBeenCalled();
      expect(h.calls).toEqual([]);
      expect(h.log).toHaveBeenCalledWith("scenario-seed result=refused");
    },
  );
  it.each([404, 403, 500])("refuses missing/unreadable carrier (%s)", async (statusCode) => {
    const h = ownershipHarness();
    h.kubernetes.readScaledObject.mockRejectedValue(Object.assign(new Error("unreadable"), { statusCode }));
    expect(await runQuiescedBootstrap(h.options)).toBe(75);
    expect(h.options.spawnCommand).not.toHaveBeenCalled();
  });
  it.each([0, 17, 124])("CAS-resumes normal seed completion with exit %s, never restoring replicas", async (code) => {
    const h = ownershipHarness();
    h.options.spawnCommand.mockResolvedValue(code);
    expect(await runQuiescedBootstrap(h.options)).toBe(code);
    expect(h.state.metadata.annotations).toEqual({});
    expect(h.calls).toHaveLength(2);
    expect(h.kubernetes.scaleDeployment).not.toHaveBeenCalled();
  });
  it("re-reads an acquisition conflict and never overwrites the arriving hook", async () => {
    const h = ownershipHarness();
    h.kubernetes.patchScaledObject.mockImplementationOnce(async () => {
      h.take("helm-hook:arrived");
      throw Object.assign(new Error("Conflict"), { statusCode: 409 });
    });
    expect(await runQuiescedBootstrap(h.options)).toBe(75);
    expect(h.options.spawnCommand).not.toHaveBeenCalled();
    expect(h.state.metadata.annotations[ownerKey]).toBe("helm-hook:arrived");
  });
  it("seed finally observes 409 then foreign owner and never resumes the hook", async () => {
    const h = ownershipHarness();
    h.options.spawnCommand.mockImplementation(async () => {
      h.kubernetes.patchScaledObject.mockImplementationOnce(async () => {
        h.take("helm-hook:arrived");
        throw Object.assign(new Error("Conflict"), { statusCode: 409 });
      });
      return 0;
    });
    expect(await runQuiescedBootstrap(h.options)).toBe(76);
    expect(h.state.metadata.annotations).toEqual({ [ownerKey]: "helm-hook:arrived", [pauseKey]: "0" });
    expect(h.calls).toHaveLength(1);
  });
  it("the CAS double rejects an unconditional resume mutant", async () => {
    const h = ownershipHarness({ [ownerKey]: "helm-hook:pod", [pauseKey]: "0" });
    await expect(
      h.kubernetes.patchScaledObject("worker", {
        metadata: { annotations: { [pauseKey]: null, [ownerKey]: null } },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await changeSeedOwnership(h.kubernetes, "worker", "scenario-seed:job", "release")).toBe(false);
  });
  it("hook takes stale seed ownership unconditionally and clears both on exit", async () => {
    const h = ownershipHarness({ [ownerKey]: "scenario-seed:stale", [pauseKey]: "0" });
    await runQuiescedBootstrap({
      ...h.options,
      mode: "helm-hook",
      owner: "helm-hook:pod",
      spawnCommand: async () => {
        expect(h.state.metadata.annotations[ownerKey]).toBe("helm-hook:pod");
        return 0;
      },
    });
    expect(h.state.metadata.annotations).toEqual({});
    expect(h.kubernetes.readScaledObject).not.toHaveBeenCalled();
  });
  it.each(["hook", "unreadable", "stalled-request"])(
    "kills during %s within the bounded ownership window",
    async (loss) => {
      vi.useFakeTimers();
      const h = ownershipHarness();
      let started;
      let commandSignal;
      const ready = new Promise((resolve) => {
        started = resolve;
      });
      h.options.spawnCommand.mockImplementation(async (_command, { signal }) => {
        commandSignal = signal;
        started();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return 76;
      });
      try {
        const running = runQuiescedBootstrap(h.options);
        await ready;
        if (loss === "hook") h.take("helm-hook:pod");
        else
          h.kubernetes.readScaledObject.mockImplementation(async () => {
            if (loss === "stalled-request") await new Promise((resolve) => setTimeout(resolve, 2000));
            throw new Error("unreadable");
          });
        await vi.advanceTimersByTimeAsync(loss === "hook" ? 4000 : 6000);
        expect(commandSignal.aborted).toBe(true);
        // Killing meets the deadline even if the final bounded GET has not settled.
        await vi.advanceTimersByTimeAsync(2000);
        expect(await running).toBe(76);
        expect(h.calls).toHaveLength(1);
        expect(h.log).toHaveBeenCalledWith("scenario-seed result=preempted");
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("bounds real Kubernetes requests, including an unresponsive server, to two seconds", async () => {
    const https = await import("node:https");
    const { EventEmitter } = await import("node:events");
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = (error) => {
      request.emit("error", error);
      request.emit("close");
    };
    const spy = vi.spyOn(https.default, "request").mockReturnValue(request);
    vi.useFakeTimers();
    try {
      const client = createKubernetesClient({
        host: "synthetic.invalid",
        namespace: "test",
        token: "synthetic",
        ca: "synthetic",
      });
      const result = expect(client.readScaledObject("worker")).rejects.toThrow("2000ms");
      await vi.advanceTimersByTimeAsync(2000);
      await result;
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

// The deployed wrapper is POSIX-only. Linux hosted CI executes this real process-tree
// control; Windows still executes every synthetic protocol/request control above.
if (process.platform !== "win32") {
  describe("real command process group", () => {
    it.each(["yield", "timeout"])("kills a real grandchild heartbeat on %s", async (cause) => {
      const directory = mkdtempSync(join(tmpdir(), "seed-group-"));
      const heartbeat = join(directory, "heartbeat");
      const childScript = join(directory, "child.cjs");
      const grandchildScript = join(directory, "grandchild.cjs");
      const pidFile = join(directory, "grandchild.pid");
      writeFileSync(
        grandchildScript,
        `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'x'), 20);`,
      );
      writeFileSync(
        childScript,
        `require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchildScript)}], {stdio: 'ignore'}); setInterval(() => {}, 1000);`,
      );
      const controller = new AbortController();
      try {
        const running = spawnShellCommand([`'${process.execPath}'`, `'${childScript}'`], {
          signal: controller.signal,
          timeoutMs: cause === "timeout" ? 1500 : 5000,
        });
        await vi.waitFor(() => expect(readFileSync(heartbeat, "utf8").length).toBeGreaterThan(1));
        if (cause === "yield") controller.abort();
        expect(await running).toBe(cause === "yield" ? 76 : 124);
        const stopped = readFileSync(heartbeat, "utf8");
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(readFileSync(heartbeat, "utf8")).toBe(stopped);
      } finally {
        controller.abort();
        // Also clean the deliberately surviving descendant in a shell-only-kill mutation run.
        if (existsSync(pidFile)) {
          try {
            process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
}

describe("bootstrap quiesce wrapper", () => {
  it("parses target deployments and bootstrap command from env and argv", () => {
    expect(parseDeploymentList(" worker-a,worker-b ,, ")).toEqual(["worker-a", "worker-b"]);

    expect(
      parseQuiesceOptions(["--", "pnpm", "run", "bootstrap"], {
        CHASE_SETS_QUIESCE_DEPLOYMENTS: "platform-worker",
        CHASE_SETS_QUIESCE_TIMEOUT_SECONDS: "45",
        CHASE_SETS_BOOTSTRAP_COMMAND_TIMEOUT_SECONDS: "120",
        CHASE_SETS_QUIESCE_POLL_INTERVAL_MS: "250",
      }),
    ).toMatchObject({
      deployments: ["platform-worker"],
      command: ["pnpm", "run", "bootstrap"],
      timeoutMs: 45_000,
      commandTimeoutMs: 120_000,
      pollIntervalMs: 250,
      restoreOnFailure: true,
      restoreOnSuccess: false,
      ignoreMissingDeployments: true,
    });
  });

  it("pauses KEDA before scaling workers down and resumes it after successful bootstrap", async () => {
    const calls = [];
    const result = await runQuiescedBootstrap({
      deployments: ["release-platform-worker"],
      command: ["pnpm", "bootstrap"],
      timeoutMs: 1000,
      pollIntervalMs: 1,
      restoreOnFailure: true,
      log: async (message) => calls.push(["log", message]),
      kubernetes: fakeKubernetesClient(calls, { "release-platform-worker": 2 }),
      spawnCommand: async (command) => {
        calls.push(["spawn", command]);
        return 0;
      },
    });

    expect(result).toBe(0);
    expect(calls).toEqual([
      ["readScale", "release-platform-worker"],
      ["log", "Quiescing release-platform-worker before bootstrap."],
      ["pauseScaledObject", "release-platform-worker"],
      ["scale", "release-platform-worker", 0],
      ["wait", "release-platform-worker", 0],
      ["spawn", ["pnpm", "bootstrap"]],
      ["log", "Bootstrap completed; Helm may continue the rollout."],
      ["log", "Resuming KEDA autoscaling for release-platform-worker."],
      ["resumeScaledObject", "release-platform-worker"],
    ]);
  });

  it("resumes KEDA before failing the hook when bootstrap fails", async () => {
    const calls = [];
    const result = await runQuiescedBootstrap({
      deployments: ["release-platform-worker"],
      command: ["pnpm", "bootstrap"],
      timeoutMs: 1000,
      pollIntervalMs: 1,
      restoreOnFailure: true,
      log: async (message) => calls.push(["log", message]),
      kubernetes: fakeKubernetesClient(calls, { "release-platform-worker": 3 }),
      spawnCommand: async () => 17,
    });

    expect(result).toBe(17);
    expect(calls).toContainEqual(["scale", "release-platform-worker", 0]);
    expect(calls).not.toContainEqual(["scale", "release-platform-worker", 3]);
    expect(calls.at(-1)).toEqual(["resumeScaledObject", "release-platform-worker"]);
  });

  it("resumes KEDA when bootstrap times out", async () => {
    const calls = [];
    const result = await runQuiescedBootstrap({
      deployments: ["release-platform-worker"],
      command: ["pnpm", "bootstrap"],
      timeoutMs: 1000,
      commandTimeoutMs: 780_000,
      pollIntervalMs: 1,
      restoreOnFailure: true,
      log: async (message) => calls.push(["log", message]),
      kubernetes: fakeKubernetesClient(calls, { "release-platform-worker": 2 }),
      spawnCommand: async (command, options) => {
        calls.push(["spawn", command, options.timeoutMs]);
        return 124;
      },
    });

    expect(result).toBe(124);
    expect(calls).toContainEqual(["spawn", ["pnpm", "bootstrap"], 780_000]);
    expect(calls).toContainEqual(["log", "Bootstrap failed with exit code 124."]);
    expect(calls.at(-1)).toEqual(["resumeScaledObject", "release-platform-worker"]);
  });

  it("falls back to direct Deployment scaling and restoration without a ScaledObject", async () => {
    const calls = [];
    const result = await runQuiescedBootstrap({
      deployments: ["release-platform-worker"],
      command: ["pnpm", "bootstrap"],
      timeoutMs: 1000,
      pollIntervalMs: 1,
      restoreOnFailure: true,
      log: async (message) => calls.push(["log", message]),
      kubernetes: fakeKubernetesClient(calls, { "release-platform-worker": 2 }, { kedaManaged: false }),
      spawnCommand: async () => 17,
    });

    expect(result).toBe(17);
    expect(calls).toContainEqual(["pauseScaledObject", "release-platform-worker"]);
    expect(calls).toContainEqual([
      "log",
      "No ScaledObject found for release-platform-worker; scaling the Deployment directly.",
    ]);
    expect(calls).toContainEqual(["scale", "release-platform-worker", 0]);
    expect(calls).toContainEqual(["scale", "release-platform-worker", 2]);
    expect(calls.at(-1)).toEqual(["wait", "release-platform-worker", 2]);
    expect(calls).not.toContainEqual(["resumeScaledObject", "release-platform-worker"]);
  });

  it("restores a directly managed worker after a successful advisory Job", async () => {
    const calls = [];
    const result = await runQuiescedBootstrap({
      deployments: ["release-platform-worker"],
      command: ["pnpm", "bootstrap"],
      timeoutMs: 1000,
      pollIntervalMs: 1,
      restoreOnSuccess: true,
      log: async (message) => calls.push(["log", message]),
      kubernetes: fakeKubernetesClient(calls, { "release-platform-worker": 2 }, { kedaManaged: false }),
      spawnCommand: async () => 0,
    });

    expect(result).toBe(0);
    expect(calls).toContainEqual(["scale", "release-platform-worker", 0]);
    expect(calls).toContainEqual(["scale", "release-platform-worker", 2]);
    expect(calls).toContainEqual(["wait", "release-platform-worker", 2]);
  });

  it("skips missing deployments during first install", async () => {
    const calls = [];
    const result = await runQuiescedBootstrap({
      deployments: ["release-platform-worker"],
      command: ["pnpm", "bootstrap"],
      timeoutMs: 1000,
      pollIntervalMs: 1,
      restoreOnFailure: true,
      ignoreMissingDeployments: true,
      log: async (message) => calls.push(["log", message]),
      kubernetes: {
        async readScale(name) {
          calls.push(["readScale", name]);
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        },
        async scaleDeployment(name, replicas) {
          calls.push(["scale", name, replicas]);
        },
        async waitForReplicas(name, replicas) {
          calls.push(["wait", name, replicas]);
        },
      },
      spawnCommand: async (command) => {
        calls.push(["spawn", command]);
        return 0;
      },
    });

    expect(result).toBe(0);
    expect(calls).toEqual([
      ["readScale", "release-platform-worker"],
      ["log", "Skipping missing deployment release-platform-worker; first install has no workers to quiesce."],
      ["spawn", ["pnpm", "bootstrap"]],
      ["log", "Bootstrap completed; Helm may continue the rollout."],
    ]);
  });

  it("requires at least one deployment and a bootstrap command", async () => {
    await expect(
      runQuiescedBootstrap({
        deployments: [],
        command: ["pnpm"],
      }),
    ).rejects.toThrow("CHASE_SETS_QUIESCE_DEPLOYMENTS");

    await expect(
      runQuiescedBootstrap({
        deployments: ["worker"],
        command: [],
      }),
    ).rejects.toThrow("Bootstrap command is required");
  });
});

function fakeKubernetesClient(calls, replicasByDeployment, options = {}) {
  const kedaManaged = options.kedaManaged ?? true;

  return {
    async readScale(name) {
      calls.push(["readScale", name]);
      return { specReplicas: replicasByDeployment[name] ?? 0 };
    },
    async scaleDeployment(name, replicas) {
      calls.push(["scale", name, replicas]);
    },
    async pauseScaledObject(name) {
      calls.push(["pauseScaledObject", name]);
      return kedaManaged;
    },
    async resumeScaledObject(name) {
      calls.push(["resumeScaledObject", name]);
      return kedaManaged;
    },
    async waitForReplicas(name, replicas) {
      calls.push(["wait", name, replicas]);
    },
  };
}
