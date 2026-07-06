import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAILURE_RUNTIME_PROFILE,
  DEFAULT_NAMESPACE,
  DEFAULT_RELEASE,
  buildFailedBootstrapUpgradeArgs,
  buildHeldLockBlocker,
  buildSuccessfulUpgradeArgs,
  parseStagingBootstrapHookDrillArgs,
  redactSupportUnsafeText,
  runStagingBootstrapHookDrill,
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

  it("writes an explicit support-safe blocker for live held-lock injection", () => {
    expect(buildHeldLockBlocker({ environment: "staging", release, namespace }, "2026-07-06T00:00:00.000Z")).toEqual(
      expect.objectContaining({
        result: "blocked",
        liveHeldLockInjection: "not-enabled",
        supportSafe: true,
        bootstrapTouchedRelation: expect.objectContaining({
          table: "bounded_context_schema_migrations",
        }),
        redaction: expect.objectContaining({
          databaseUrls: "not-read",
          rawIdentifiers: "not-written",
        }),
      }),
    );
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
      const blocker = JSON.parse(await readFile(join(outDir, "held-lock-blocker.json"), "utf8"));
      expect(blocker.supportSafe).toBe(true);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("runs the success and failed-bootstrap drill phases and verifies atomic rollback evidence", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bootstrap-hook-drill-"));
    const calls = [];
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
          if (command === "helm" && args[0] === "status" && args.includes("-o")) {
            return { exitCode: 0, stdout: JSON.stringify({ version: 12 }), stderr: "" };
          }
          if (command === "kubectl" && args[1] === "deployments") {
            return { exitCode: 0, stdout: deploymentJson(), stderr: "" };
          }
          if (command === "kubectl" && args[1] === "pods") {
            return { exitCode: 0, stdout: podsJson(), stderr: "" };
          }
          if (command === "kubectl" && args[1] === "events") {
            return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
          }
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        now: () => "2026-07-06T00:00:00.000Z",
      });

      expect(result.record.result).toBe("success");
      expect(result.record.rollbackVerification).toMatchObject({
        status: "success",
        deploymentImagesStable: true,
        readyPodUidFingerprintsStable: true,
      });
      expect(calls.some(([command, args]) => command === "pnpm" && args.includes("smoke:platform"))).toBe(true);
      expect(calls.some(([command, args]) => command === "kubectl" && args[0] === "logs")).toBe(true);
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
