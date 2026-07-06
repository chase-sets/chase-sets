import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAILURE_RUNTIME_PROFILE,
  DEFAULT_NAMESPACE,
  DEFAULT_RELEASE,
  buildFailedBootstrapUpgradeArgs,
  HELD_LOCK_READY_MARKER,
  buildHeldLockInjectorExecArgs,
  buildHeldLockNotStarted,
  buildSuccessfulUpgradeArgs,
  parseStagingBootstrapHookDrillArgs,
  redactSupportUnsafeText,
  runStagingBootstrapHookDrill,
  selectReadyWorkerPodName,
  summarizeDeploymentSnapshot,
  summarizeEvents,
  summarizeReadyPodUidFingerprints,
} from "./staging-bootstrap-hook-drill.mjs";

const release = DEFAULT_RELEASE;
const namespace = DEFAULT_NAMESPACE;

describe("staging bootstrap hook drill", () => {
  it("defaults to the current staging DOKS release and namespace", () => {
    expect(parseStagingBootstrapHookDrillArgs([], {})).toMatchObject({
      environment: "staging",
      release,
      namespace,
      chartPath: "infrastructure/helm/platform",
      failureRuntimeProfile: DEFAULT_FAILURE_RUNTIME_PROFILE,
    });
  });

  it("builds a successful Helm upgrade that rolls runtime pods through a harmless marker annotation", () => {
    expect(
      buildSuccessfulUpgradeArgs({
        release,
        namespace,
        chartPath: "infrastructure/helm/platform",
        timeout: "15m",
        marker: "run-1",
      }),
    ).toEqual([
      "upgrade",
      "--install",
      release,
      "infrastructure/helm/platform",
      "--namespace",
      namespace,
      "--wait",
      "--timeout",
      "15m",
      "--atomic",
      "--reuse-values",
      "--set-string",
      "global.podAnnotations.bootstrap-hook-drill=run-1",
    ]);
  });

  it("builds a controlled failed-bootstrap upgrade using only non-secret values", () => {
    const args = buildFailedBootstrapUpgradeArgs({
      release,
      namespace,
      chartPath: "infrastructure/helm/platform",
      timeout: "15m",
      marker: "run-2",
      failureRuntimeProfile: "invalid-profile",
    });

    expect(args).toEqual(
      expect.arrayContaining([
        "--atomic",
        "--reuse-values",
        "--set-string",
        "global.envOverrides.CHASE_SETS_RUNTIME_PROFILE=invalid-profile",
      ]),
    );
    expect(args.join(" ")).not.toMatch(/DATABASE_URL|PASSWORD|SECRET|TOKEN/);
  });

  it("describes support-safe live held-lock evidence before the injector starts", () => {
    expect(buildHeldLockNotStarted({ environment: "staging", release, namespace }, "2026-07-06T00:00:00.000Z")).toEqual(
      expect.objectContaining({
        result: "not-started",
        liveHeldLockInjection: "worker-pod-kubectl-exec",
        supportSafe: true,
        bootstrapTouchedRelation: expect.objectContaining({
          table: "bounded_context_schema_migrations",
          lockMode: "ACCESS EXCLUSIVE",
        }),
        redaction: expect.objectContaining({
          databaseUrls: "not-read-by-workflow",
          rawPodNames: "fingerprinted",
        }),
      }),
    );
  });

  it("builds a worker-pod exec command that does not carry database values", () => {
    const args = buildHeldLockInjectorExecArgs(
      { namespace, heldLockTimeoutSeconds: 1200 },
      "chase-sets-platform-worker-private-pod-name",
    );

    expect(args.slice(0, 8)).toEqual([
      "exec",
      "--namespace",
      namespace,
      "chase-sets-platform-worker-private-pod-name",
      "--container",
      "platform-worker",
      "--",
      "sh",
    ]);
    expect(args.join(" ")).toContain("LOCK TABLE catalog.bounded_context_schema_migrations");
    expect(args.join(" ")).not.toMatch(/postgres:\/\/|PASSWORD=|TOKEN=|SECRET=/);
  });

  it("selects only ready running worker pods for live held-lock injection", () => {
    expect(
      selectReadyWorkerPodName(
        JSON.stringify({
          items: [
            {
              metadata: { name: "terminating", deletionTimestamp: "2026-07-06T00:00:00Z" },
              status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
            },
            {
              metadata: { name: "pending" },
              status: { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] },
            },
            {
              metadata: { name: "ready-worker" },
              status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
            },
          ],
        }),
      ),
    ).toBe("ready-worker");
  });

  it("summarizes deployment images and ready pod UIDs without raw pod identifiers", () => {
    const deployments = summarizeDeploymentSnapshot(
      JSON.stringify({
        items: [
          {
            metadata: { generation: 8, labels: { "app.kubernetes.io/component": "platform-api" } },
            status: { observedGeneration: 8, replicas: 1, readyReplicas: 1 },
            spec: {
              template: {
                spec: {
                  containers: [{ image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha" }],
                },
              },
            },
          },
        ],
      }),
    );
    const pods = summarizeReadyPodUidFingerprints(
      JSON.stringify({
        items: [
          {
            metadata: {
              uid: "9cf3ae99-7b02-4db1-a257-9eb48c19e8c3",
              labels: { "app.kubernetes.io/component": "platform-api" },
            },
            status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
          },
        ],
      }),
    );

    expect(deployments).toEqual([
      {
        component: "platform-api",
        generation: 8,
        observedGeneration: 8,
        replicas: 1,
        readyReplicas: 1,
        images: ["registry.digitalocean.com/[registry]/chase-sets-platform:release-sha"],
      },
    ]);
    expect(pods).toEqual([
      {
        component: "platform-api",
        uidFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
        phase: "Running",
      },
    ]);
    expect(JSON.stringify(pods)).not.toContain("9cf3ae99");
  });

  it("redacts database URLs, secrets, and event UUIDs from artifacts", () => {
    expect(
      redactSupportUnsafeText(
        "DATABASE_URL_CATALOG=postgres://user:pass@db.example/chase token=abc password=hunter2 smoke@example.com 9cf3ae99-7b02-4db1-a257-9eb48c19e8c3",
      ),
    ).toBe("DATABASE_URL_CATALOG=[redacted] token=[redacted] password=[redacted] [redacted-email] [redacted-uuid]");

    expect(
      summarizeEvents(
        JSON.stringify({
          items: [
            {
              lastTimestamp: "2026-07-06T00:00:00Z",
              type: "Warning",
              reason: "Failed",
              involvedObject: { kind: "Pod", name: "pod-name" },
              message: "failed for uid 9cf3ae99-7b02-4db1-a257-9eb48c19e8c3 with postgres://secret",
            },
          ],
        }),
      )[0].message,
    ).not.toContain("postgres://");
  });

  it("refuses stale runbook release names before touching Helm", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bootstrap-hook-drill-"));
    const calls = [];
    try {
      const result = await runStagingBootstrapHookDrill(
        {
          ...parseStagingBootstrapHookDrillArgs(["--release", "chase-sets-staging", "--out-dir", outDir], {}),
          landingUrl: "https://landing.example",
          adminUrl: "https://admin.example",
          marketplaceUrl: "https://marketplace.example",
          legacyRedirectUrl: "https://legacy.example",
        },
        {
          runner: async (command, args) => {
            calls.push([command, args]);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          now: () => "2026-07-06T00:00:00.000Z",
        },
      );

      expect(result.record.result).toBe("failure");
      expect(result.record.errors).toContain(
        "Refusing stale or non-staging Helm release 'chase-sets-staging'; expected 'chase-sets-platform'.",
      );
      expect(calls).toEqual([]);
      const evidence = JSON.parse(await readFile(join(outDir, "held-lock-evidence.json"), "utf8"));
      expect(evidence.supportSafe).toBe(true);
      expect(evidence.result).toBe("not-started");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("stops before Helm when the held-lock injector cannot find a ready worker", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bootstrap-hook-drill-"));
    const calls = [];
    try {
      const result = await runStagingBootstrapHookDrill(
        {
          ...parseStagingBootstrapHookDrillArgs(["--out-dir", outDir], {}),
          landingUrl: "https://landing.example",
          adminUrl: "https://admin.example",
          marketplaceUrl: "https://marketplace.example",
          legacyRedirectUrl: "https://legacy.example",
        },
        {
          runner: async (command, args) => {
            calls.push([command, args]);
            if (command === "helm" && args[0] === "status" && args.includes("-o")) {
              return { exitCode: 0, stdout: JSON.stringify({ version: 12 }), stderr: "" };
            }
            if (command === "kubectl" && args[1] === "deployments") {
              return { exitCode: 0, stdout: deploymentJson(), stderr: "" };
            }
            if (command === "kubectl" && args[1] === "pods") {
              return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
            }
            if (command === "kubectl" && args[1] === "events") {
              return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
            }
            return { exitCode: 0, stdout: "ok", stderr: "" };
          },
          now: () => "2026-07-06T00:00:00.000Z",
        },
      );

      expect(result.record.result).toBe("failure");
      expect(result.record.heldLock).toMatchObject({
        result: "setup-failed",
        setup: { releaseTouched: false },
      });
      expect(calls.some(([command, args]) => command === "helm" && args[0] === "upgrade")).toBe(false);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("runs the success and failed-bootstrap drill phases and verifies atomic rollback evidence", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bootstrap-hook-drill-"));
    const calls = [];
    const execHandles = [];
    const options = {
      ...parseStagingBootstrapHookDrillArgs(["--out-dir", outDir, "--marker", "run-3"], {}),
      landingUrl: "https://landing.example",
      adminUrl: "https://admin.example",
      marketplaceUrl: "https://marketplace.example",
      legacyRedirectUrl: "https://legacy.example",
      marketplaceRootUrl: "https://root.example",
      checkedAt: "2026-07-06T00:00:00.000Z",
    };

    try {
      const result = await runStagingBootstrapHookDrill(options, {
        runner: async (command, args) => {
          calls.push([command, args]);
          if (
            command === "helm" &&
            args[0] === "upgrade" &&
            args.includes("global.envOverrides.CHASE_SETS_RUNTIME_PROFILE=bootstrap-hook-drill-invalid-runtime-profile")
          ) {
            return { exitCode: 1, stdout: "", stderr: "bootstrap failed as expected" };
          }
          if (command === "helm" && args[0] === "upgrade") {
            execHandles[0]?.finish({ exitCode: 137 });
            return { exitCode: 0, stdout: "successful bootstrap", stderr: "" };
          }
          if (command === "helm" && args[0] === "status" && args.includes("-o")) {
            return { exitCode: 0, stdout: JSON.stringify({ version: 12 }), stderr: "" };
          }
          if (command === "kubectl" && args[1] === "deployments") {
            return { exitCode: 0, stdout: deploymentJson(), stderr: "" };
          }
          if (
            command === "kubectl" &&
            args[0] === "get" &&
            args[1] === "pods" &&
            args.some((arg) => arg.includes("app.kubernetes.io/component=platform-worker"))
          ) {
            return { exitCode: 0, stdout: workerPodJson(), stderr: "" };
          }
          if (command === "kubectl" && args[1] === "pods") {
            return { exitCode: 0, stdout: podsJson(), stderr: "" };
          }
          if (command === "kubectl" && args[1] === "events") {
            return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
          }
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        processStarter: (command, args) => {
          calls.push([command, args]);
          const handle = createFakeProcessHandle();
          execHandles.push(handle);
          queueMicrotask(() => handle.emitStdout(`${HELD_LOCK_READY_MARKER} {"context":"catalog"}\n`));
          return handle;
        },
        now: () => "2026-07-06T00:00:00.000Z",
      });

      expect(result.record.result).toBe("success");
      expect(result.record.rollbackVerification).toMatchObject({
        status: "success",
        deploymentImagesStable: true,
        readyPodUidFingerprintsStable: true,
      });
      expect(result.record.heldLock).toMatchObject({
        result: "released",
        release,
        lockRelease: {
          status: "observed",
          releasedDuring: "successful-bootstrap-upgrade",
        },
      });
      expect(JSON.stringify(result.record.heldLock)).not.toContain("ready-worker");
      expect(calls.some(([command, args]) => command === "pnpm" && args.includes("smoke:platform"))).toBe(true);
      expect(calls.some(([command, args]) => command === "kubectl" && args[0] === "logs")).toBe(true);
      expect(execHandles).toHaveLength(1);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("cleans up and fails when worker quiesce does not release the held-lock injector", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bootstrap-hook-drill-"));
    const execHandles = [];
    try {
      const result = await runStagingBootstrapHookDrill(
        {
          ...parseStagingBootstrapHookDrillArgs(["--out-dir", outDir, "--held-lock-release-timeout-ms", "1"], {}),
          landingUrl: "https://landing.example",
          adminUrl: "https://admin.example",
          marketplaceUrl: "https://marketplace.example",
          legacyRedirectUrl: "https://legacy.example",
        },
        {
          runner: async (command, args) => {
            if (command === "helm" && args[0] === "upgrade") {
              return { exitCode: 0, stdout: "successful bootstrap", stderr: "" };
            }
            if (command === "helm" && args[0] === "status" && args.includes("-o")) {
              return { exitCode: 0, stdout: JSON.stringify({ version: 12 }), stderr: "" };
            }
            if (command === "kubectl" && args[1] === "deployments") {
              return { exitCode: 0, stdout: deploymentJson(), stderr: "" };
            }
            if (
              command === "kubectl" &&
              args[0] === "get" &&
              args[1] === "pods" &&
              args.some((arg) => arg.includes("app.kubernetes.io/component=platform-worker"))
            ) {
              return { exitCode: 0, stdout: workerPodJson(), stderr: "" };
            }
            if (command === "kubectl" && args[1] === "pods") {
              return { exitCode: 0, stdout: podsJson(), stderr: "" };
            }
            if (command === "kubectl" && args[1] === "events") {
              return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
            }
            return { exitCode: 0, stdout: "ok", stderr: "" };
          },
          processStarter: () => {
            const handle = createFakeProcessHandle();
            execHandles.push(handle);
            queueMicrotask(() => handle.emitStdout(`${HELD_LOCK_READY_MARKER} {"context":"catalog"}\n`));
            return handle;
          },
          now: () => "2026-07-06T00:00:00.000Z",
        },
      );

      expect(result.record.result).toBe("failure");
      expect(result.record.errors).toContain(
        "Held-lock injector did not exit during the successful bootstrap upgrade.",
      );
      expect(result.record.heldLock).toMatchObject({
        result: "cleanup-after-failure",
        cleanup: {
          status: "observed",
          execExitCode: 143,
        },
      });
      expect(execHandles[0]?.killed).toBe(true);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

function deploymentJson() {
  return JSON.stringify({
    items: [
      {
        metadata: { generation: 3, labels: { "app.kubernetes.io/component": "platform-worker" } },
        status: { observedGeneration: 3, replicas: 1, readyReplicas: 1 },
        spec: {
          template: {
            spec: { containers: [{ image: "registry.digitalocean.com/chase-sets/chase-sets-platform:abc" }] },
          },
        },
      },
    ],
  });
}

function podsJson() {
  return JSON.stringify({
    items: [
      {
        metadata: {
          uid: "9cf3ae99-7b02-4db1-a257-9eb48c19e8c3",
          labels: { "app.kubernetes.io/component": "platform-worker" },
        },
        status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
      },
    ],
  });
}

function workerPodJson() {
  return JSON.stringify({
    items: [
      {
        metadata: {
          name: "ready-worker",
          labels: { "app.kubernetes.io/component": "platform-worker" },
        },
        status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
      },
    ],
  });
}

function createFakeProcessHandle() {
  const stdoutListeners = [];
  const stderrListeners = [];
  let resolveWait;
  const handle = {
    wait: new Promise((resolve) => {
      resolveWait = resolve;
    }),
    onStdout(listener) {
      stdoutListeners.push(listener);
    },
    onStderr(listener) {
      stderrListeners.push(listener);
    },
    emitStdout(text) {
      for (const listener of stdoutListeners) {
        listener(text);
      }
    },
    emitStderr(text) {
      for (const listener of stderrListeners) {
        listener(text);
      }
    },
    kill() {
      handle.killed = true;
      resolveWait({ exitCode: 143 });
    },
    finish(result) {
      resolveWait(result);
    },
    killed: false,
  };
  return handle;
}
