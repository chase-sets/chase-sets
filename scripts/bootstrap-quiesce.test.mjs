import { describe, expect, it } from "vitest";
import {
  parseDeploymentList,
  parseQuiesceOptions,
  runQuiescedBootstrap,
} from "../infrastructure/helm/platform/scripts/bootstrap-quiesce.mjs";

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
