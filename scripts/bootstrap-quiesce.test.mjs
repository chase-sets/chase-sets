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

  it("scales workers down, runs bootstrap, and leaves rollout restoration to Helm on success", async () => {
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
      ["scale", "release-platform-worker", 0],
      ["wait", "release-platform-worker", 0],
      ["spawn", ["pnpm", "bootstrap"]],
      ["log", "Bootstrap completed with workers quiesced; Helm may continue the rollout."],
    ]);
  });

  it("restores old worker replica counts before failing the hook when bootstrap fails", async () => {
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
    expect(calls).toContainEqual(["scale", "release-platform-worker", 3]);
    expect(calls.at(-1)).toEqual(["wait", "release-platform-worker", 3]);
  });

  it("restores old worker replica counts when bootstrap times out", async () => {
    const calls = [];
    const result = await runQuiescedBootstrap({
      deployments: ["release-platform-worker"],
      command: ["pnpm", "bootstrap"],
      timeoutMs: 1000,
      commandTimeoutMs: 600_000,
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
    expect(calls).toContainEqual(["spawn", ["pnpm", "bootstrap"], 600_000]);
    expect(calls).toContainEqual(["log", "Bootstrap failed with exit code 124."]);
    expect(calls).toContainEqual(["scale", "release-platform-worker", 2]);
    expect(calls.at(-1)).toEqual(["wait", "release-platform-worker", 2]);
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
      ["log", "Bootstrap completed with workers quiesced; Helm may continue the rollout."],
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

function fakeKubernetesClient(calls, replicasByDeployment) {
  return {
    async readScale(name) {
      calls.push(["readScale", name]);
      return { specReplicas: replicasByDeployment[name] ?? 0 };
    },
    async scaleDeployment(name, replicas) {
      calls.push(["scale", name, replicas]);
    },
    async waitForReplicas(name, replicas) {
      calls.push(["wait", name, replicas]);
    },
  };
}
