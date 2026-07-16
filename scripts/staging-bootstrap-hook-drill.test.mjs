import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FAILURE_RUNTIME_PROFILE,
  DEFAULT_NAMESPACE,
  DEFAULT_RELEASE,
  buildFailedBootstrapUpgradeArgs,
  HELD_LOCK_READY_MARKER,
  HELD_LOCK_SETUP_FAILED_MARKER,
  buildHeldLockInjectorExecArgs,
  buildHeldLockInjectorShell,
  buildHeldLockNotStarted,
  buildSuccessfulUpgradeArgs,
  parseStagingBootstrapHookDrillArgs,
  redactSupportUnsafeText,
  runCommand,
  runStagingBootstrapHookDrill,
  selectReadyWorkerPodName,
  summarizeDeploymentSnapshot,
  summarizeEvents,
  summarizeReadyPodUidFingerprints,
} from "./staging-bootstrap-hook-drill.mjs";

const release = DEFAULT_RELEASE;
const namespace = DEFAULT_NAMESPACE;
const execFile = promisify(execFileCallback);

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
          context: "catalog",
          schema: null,
          table: "bounded_context_schema_migrations",
          lockMode: "ACCESS EXCLUSIVE",
          schemaDiscovery: "runtime-pg-tables",
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
    expect(args.join(" ")).toContain("FROM pg_tables WHERE tablename = $1");
    expect(args.join(" ")).toContain('schemaMigrationsTable = "bounded_context_schema_migrations"');
    expect(args.join(" ")).toContain("LOCK TABLE ${relationDiscovery.lockTarget}");
    expect(args.join(" ")).not.toContain("public.bounded_context_schema_migrations");
    expect(args.join(" ")).not.toContain("LOCK TABLE catalog.bounded_context_schema_migrations");
    expect(args.join(" ")).not.toMatch(/postgres:\/\/|PASSWORD=|TOKEN=|SECRET=/);
  });

  it("normalizes sslmode=require injector connections to match the runtime pool", async () => {
    const result = await runGeneratedHeldLockInjector({
      databaseUrl: "postgresql://catalog:secret@db.example:25060/catalog?sslmode=require",
    });

    expect(new URL(result.config.connectionString).searchParams.get("uselibpqcompat")).toBe("true");
    expect(result.config.ssl).toEqual({ rejectUnauthorized: false });
    expect(result.config.application_name).toBe("staging-bootstrap-hook-drill-held-lock");
    expect(`${result.stdout}\n${result.stderr}`).toContain(HELD_LOCK_READY_MARKER);
    expect(`${result.stdout}\n${result.stderr}`).toContain('"schema":"catalog"');
    expect(result.queries).toContain(
      'LOCK TABLE "catalog"."bounded_context_schema_migrations" IN ACCESS EXCLUSIVE MODE',
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("secret");
  });

  it("discovers and locks a non-public schema-migrations relation", async () => {
    const result = await runGeneratedHeldLockInjector({
      databaseUrl: "postgresql://catalog:secret@db.example:25060/catalog?sslmode=require",
      tableSchemas: ["catalog_runtime"],
    });

    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      `${HELD_LOCK_READY_MARKER} {"context":"catalog","schema":"catalog_runtime","table":"bounded_context_schema_migrations","relation":"catalog_runtime.bounded_context_schema_migrations","lockMode":"ACCESS EXCLUSIVE"`,
    );
    expect(result.queries).toContain(
      'LOCK TABLE "catalog_runtime"."bounded_context_schema_migrations" IN ACCESS EXCLUSIVE MODE',
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("secret");
  });

  it("reports a support-safe missing-relation setup failure before taking the held lock", async () => {
    const result = await runGeneratedHeldLockInjector({
      databaseUrl: "postgresql://catalog:secret@db.example:25060/catalog?sslmode=require",
      tableSchemas: [],
      schemaNames: ["catalog", "extensions", "public"],
      databaseName: "catalog",
    });

    expect(result.exitCode).toBe(3);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(readMarkerPayload(output, HELD_LOCK_SETUP_FAILED_MARKER)).toEqual({
      ok: false,
      reason: "missing-relation",
      table: "bounded_context_schema_migrations",
      database: "catalog",
      schemasPresent: ["catalog", "extensions", "public"],
    });
    expect(result.queries.some((query) => query.startsWith("LOCK TABLE"))).toBe(false);
    expect(output).not.toMatch(/pg_catalog|information_schema|postgres(?:ql)?:\/\//i);
    expect(output).not.toContain("secret");
  });

  it("reports support-safe duplicate relation candidates before taking the held lock", async () => {
    const result = await runGeneratedHeldLockInjector({
      databaseUrl: "postgresql://catalog:secret@db.example:25060/catalog?sslmode=require",
      tableSchemas: ["catalog", "public"],
    });

    expect(result.exitCode).toBe(3);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(readMarkerPayload(output, HELD_LOCK_SETUP_FAILED_MARKER)).toEqual({
      ok: false,
      reason: "multiple-relations",
      table: "bounded_context_schema_migrations",
      candidates: ["catalog.bounded_context_schema_migrations", "public.bounded_context_schema_migrations"],
    });
    expect(result.queries.some((query) => query.startsWith("LOCK TABLE"))).toBe(false);
    expect(output).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(output).not.toContain("secret");
  });

  it("uses PGSSLROOTCERT for verifying injector sslmodes without writing CA material to output", async () => {
    const ca = await writeCaFile("root ca material");
    try {
      const result = await runGeneratedHeldLockInjector({
        databaseUrl: "postgresql://catalog:secret@db.example:25060/catalog?sslmode=verify-ca",
        pgsslrootcert: ca.caPath,
      });

      expect(new URL(result.config.connectionString).searchParams.get("uselibpqcompat")).toBe("true");
      expect(result.config.ssl).toEqual({ rejectUnauthorized: true, ca: "root ca material" });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("root ca material");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(ca.caPath);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("secret");
    } finally {
      await ca.cleanup();
    }
  });

  it("lets injector sslrootcert override PGSSLROOTCERT like the runtime pool", async () => {
    const envCa = await writeCaFile("env ca");
    const urlCa = await writeCaFile("url ca");
    try {
      const result = await runGeneratedHeldLockInjector({
        databaseUrl: `postgresql://catalog:secret@db.example:25060/catalog?sslmode=verify-full&sslrootcert=${encodeURIComponent(
          urlCa.caPath,
        )}`,
        pgsslrootcert: envCa.caPath,
      });

      expect(result.config.ssl).toEqual({ rejectUnauthorized: true, ca: "url ca" });
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("url ca");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(envCa.caPath);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(urlCa.caPath);
    } finally {
      await envCa.cleanup();
      await urlCa.cleanup();
    }
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

  it("keeps command captures intact for machine-parsed JSON over the evidence cap", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bootstrap-hook-drill-capture-"));
    const largePodsJson = largeWorkerPodJson();
    try {
      const jsonPath = join(outDir, "large-pods.json");
      await writeFile(jsonPath, largePodsJson, "utf8");
      const result = await runCommand(process.execPath, [
        "-e",
        "process.stdout.write(require('fs').readFileSync(process.argv[1], 'utf8'))",
        jsonPath,
      ]);

      expect(result.stdout.length).toBe(largePodsJson.length);
      expect(result.stdout).not.toContain("[output-truncated]");
      expect(selectReadyWorkerPodName(result.stdout)).toBe("ready-worker");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
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
        expectedReplicas: 1,
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
          rolloutSettleAttempts: 1,
          rolloutSettlePollIntervalMs: 0,
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
            if (
              command === "kubectl" &&
              args[0] === "get" &&
              args[1] === "pods" &&
              args.some((arg) => arg.includes("app.kubernetes.io/component=platform-worker"))
            ) {
              return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
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
      marketplaceRootUrl: "https://root.example",
      checkedAt: "2026-07-06T00:00:00.000Z",
      rolloutSettleAttempts: 3,
      rolloutSettlePollIntervalMs: 0,
    };
    const platformPodSnapshots = [
      podsJson({ workerUid: "11111111-1111-4111-8111-111111111111" }),
      podsJson({
        workerUid: "22222222-2222-4222-8222-222222222222",
        adminWebUids: ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"],
      }),
      podsJson({ workerUid: "22222222-2222-4222-8222-222222222222" }),
      podsJson({ workerUid: "55555555-5555-4555-8555-555555555555" }),
    ];
    let platformPodSnapshotIndex = 0;

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
            return {
              exitCode: 0,
              stdout:
                platformPodSnapshots[platformPodSnapshotIndex++] ??
                platformPodSnapshots[platformPodSnapshots.length - 1],
              stderr: "",
            };
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
          queueMicrotask(() =>
            handle.emitStdout(
              `${HELD_LOCK_READY_MARKER} {"context":"catalog","schema":"catalog_runtime","relation":"catalog_runtime.bounded_context_schema_migrations"}\n`,
            ),
          );
          return handle;
        },
        now: () => "2026-07-06T00:00:00.000Z",
      });

      expect(result.record.result).toBe("success");
      expect(result.record.rollbackVerification).toMatchObject({
        status: "success",
        deploymentImagesStable: true,
        readyPodUidFingerprintsStable: true,
        servingReadyPodUidFingerprintsStable: true,
        servingComponents: ["admin-web", "marketplace", "platform-api", "public-web"],
        quiescedWorkerComponent: "platform-worker",
        platformWorkerReturnedReady: true,
        platformWorkerUidChanged: true,
        platformWorkerExpectedReplicas: 1,
        platformWorkerBeforeUidFingerprints: [expect.stringMatching(/^[a-f0-9]{16}$/)],
        platformWorkerAfterUidFingerprints: [expect.stringMatching(/^[a-f0-9]{16}$/)],
      });
      expect(result.record.afterSuccessfulUpgrade.rolloutSettle).toMatchObject({
        status: "settled",
        attempt: 2,
      });
      expect(result.record.heldLock).toMatchObject({
        result: "released",
        release,
        bootstrapTouchedRelation: {
          schema: "catalog_runtime",
        },
        lockRelease: {
          status: "observed",
          releasedDuring: "successful-bootstrap-upgrade",
        },
      });
      expect(JSON.stringify(result.record.heldLock)).not.toContain("ready-worker");
      expect(calls.some(([command, args]) => command === "pnpm" && args.includes("smoke:platform"))).toBe(true);
      expect(calls.some(([command, args]) => command === "kubectl" && args[0] === "logs")).toBe(true);
      expect(execHandles).toHaveLength(1);
      expect(platformPodSnapshotIndex).toBe(4);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("parses large pod JSON while bounding oversized evidence text at artifact boundaries", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "bootstrap-hook-drill-"));
    const execHandles = [];
    const oversizedInjectorOutput = "x".repeat(210_000);
    const options = {
      ...parseStagingBootstrapHookDrillArgs(
        ["--out-dir", outDir, "--marker", "run-large-capture", "--held-lock-release-timeout-ms", "1"],
        {},
      ),
      landingUrl: "https://landing.example",
      adminUrl: "https://admin.example",
      marketplaceUrl: "https://marketplace.example",
      checkedAt: "2026-07-06T00:00:00.000Z",
      rolloutSettleAttempts: 1,
      rolloutSettlePollIntervalMs: 0,
    };
    const platformPodSnapshots = [
      podsJson({ workerUid: "11111111-1111-4111-8111-111111111111" }),
      podsJson({ workerUid: "22222222-2222-4222-8222-222222222222" }),
      podsJson({ workerUid: "55555555-5555-4555-8555-555555555555" }),
    ];
    let platformPodSnapshotIndex = 0;

    try {
      const result = await runStagingBootstrapHookDrill(options, {
        runner: async (command, args) => {
          if (
            command === "helm" &&
            args[0] === "upgrade" &&
            args.includes("global.envOverrides.CHASE_SETS_RUNTIME_PROFILE=bootstrap-hook-drill-invalid-runtime-profile")
          ) {
            return { exitCode: 1, stdout: "", stderr: "bootstrap failed as expected" };
          }
          if (command === "helm" && args[0] === "upgrade") {
            execHandles[0]?.finish({ exitCode: 0 });
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
            return { exitCode: 0, stdout: largeWorkerPodJson(), stderr: "" };
          }
          if (command === "kubectl" && args[1] === "pods") {
            return {
              exitCode: 0,
              stdout:
                platformPodSnapshots[platformPodSnapshotIndex++] ??
                platformPodSnapshots[platformPodSnapshots.length - 1],
              stderr: "",
            };
          }
          if (command === "kubectl" && args[1] === "events") {
            return { exitCode: 0, stdout: JSON.stringify({ items: [] }), stderr: "" };
          }
          return { exitCode: 0, stdout: "ok", stderr: "" };
        },
        processStarter: () => {
          const handle = createFakeProcessHandle();
          execHandles.push(handle);
          queueMicrotask(() => {
            handle.emitStdout(oversizedInjectorOutput);
            handle.emitStdout(
              `\n${HELD_LOCK_READY_MARKER} {"context":"catalog","schema":"catalog_runtime","relation":"catalog_runtime.bounded_context_schema_migrations"}\n`,
            );
          });
          return handle;
        },
        now: () => "2026-07-06T00:00:00.000Z",
      });

      expect(result.record.result).toBe("success");
      expect(result.record.heldLock.bootstrapTouchedRelation.schema).toBe("catalog_runtime");
      expect(JSON.stringify(result.record)).not.toContain("[output-truncated]");

      const injectorOutput = await readFile(join(outDir, "held-lock-injector-output.txt"), "utf8");
      expect(injectorOutput).toContain("[output-truncated]");
      expect(injectorOutput.length).toBeLessThan(201_000);

      const heldLockEvidence = await readFile(join(outDir, "held-lock-evidence.json"), "utf8");
      expect(heldLockEvidence).not.toContain("[output-truncated]");
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
  const components = ["admin-web", "marketplace", "platform-api", "platform-worker", "public-web"];
  return JSON.stringify({
    items: components.map((component) => ({
      metadata: { generation: 3, labels: { "app.kubernetes.io/component": component } },
      status: { observedGeneration: 3, replicas: 1, readyReplicas: 1 },
      spec: {
        replicas: 1,
        template: {
          spec: { containers: [{ image: "registry.digitalocean.com/chase-sets/chase-sets-platform:abc" }] },
        },
      },
    })),
  });
}

function podsJson({
  workerUid = "9cf3ae99-7b02-4db1-a257-9eb48c19e8c3",
  adminWebUids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
} = {}) {
  const pod = (component, uid) => ({
    metadata: {
      uid,
      labels: { "app.kubernetes.io/component": component },
    },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
  });
  return JSON.stringify({
    items: [
      ...adminWebUids.map((uid) => pod("admin-web", uid)),
      pod("marketplace", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      pod("platform-api", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
      pod("platform-worker", workerUid),
      pod("public-web", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
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

function largeWorkerPodJson() {
  return JSON.stringify({
    items: [
      ...Array.from({ length: 2_500 }, (_, index) => ({
        metadata: {
          name: `pending-worker-${index}`,
          labels: { "app.kubernetes.io/component": "platform-worker" },
        },
        status: { phase: "Pending", conditions: [{ type: "Ready", status: "False" }] },
      })),
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

async function runGeneratedHeldLockInjector({
  databaseUrl,
  pgsslrootcert = "",
  tableSchemas = ["catalog"],
  schemaNames = ["catalog", "public"],
  databaseName = "catalog",
}) {
  const directory = await mkdtemp(join(tmpdir(), "bootstrap-hook-drill-injector-"));
  try {
    const pgModuleDirectory = join(directory, "node_modules", "pg");
    const capturePath = join(directory, "client-config.json");
    const scriptPath = join(directory, "injector.mjs");
    await mkdir(pgModuleDirectory, { recursive: true });
    await writeFile(join(pgModuleDirectory, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    await writeFile(
      join(pgModuleDirectory, "index.js"),
      `import { writeFileSync } from "node:fs";

export class Client {
  constructor(config) {
    this.config = config;
    this.queries = [];
    this.writeCapture();
  }

  async connect() {}

  async query(sql, params = []) {
    const query = String(sql);
    this.queries.push(query);
    this.writeCapture();
    if (query.includes("FROM pg_tables")) {
      return {
        rows: JSON.parse(process.env.CHASE_SETS_TEST_TABLE_SCHEMAS).map((schemaname) => ({ schemaname })),
      };
    }
    if (query.includes("FROM pg_namespace")) {
      return {
        rows: JSON.parse(process.env.CHASE_SETS_TEST_SCHEMA_NAMES)
          .filter((schema) => !schema.startsWith("pg_") && schema !== "information_schema")
          .map((schema) => ({ schema })),
      };
    }
    if (query.startsWith("SELECT current_database()")) {
      return { rows: [{ database: process.env.CHASE_SETS_TEST_DATABASE_NAME }] };
    }
    if (JSON.parse(process.env.CHASE_SETS_TEST_TABLE_SCHEMAS).length !== 1 && query.startsWith("LOCK TABLE")) {
      throw new Error("held-lock query ran after relation discovery failed");
    }
    return { rows: [] };
  }

  async end() {}

  writeCapture() {
    writeFileSync(process.env.CHASE_SETS_TEST_CAPTURE_PATH, JSON.stringify({
      application_name: this.config.application_name,
      connectionString: this.config.connectionString,
      ssl: this.config.ssl,
      queries: this.queries,
    }));
  }
}

export default { Client };
`,
    );
    await writeFile(
      scriptPath,
      extractHeldLockInjectorNodeScript(buildHeldLockInjectorShell({ heldLockTimeoutSeconds: 0 })),
    );

    let result;
    try {
      result = await execFile(process.execPath, [scriptPath], {
        cwd: directory,
        env: {
          ...process.env,
          CHASE_SETS_HELD_LOCK_TIMEOUT_SECONDS: "0",
          CHASE_SETS_TEST_TABLE_SCHEMAS: JSON.stringify(tableSchemas),
          CHASE_SETS_TEST_SCHEMA_NAMES: JSON.stringify(schemaNames),
          CHASE_SETS_TEST_DATABASE_NAME: databaseName,
          CHASE_SETS_TEST_CAPTURE_PATH: capturePath,
          DATABASE_URL_CATALOG: databaseUrl,
          PGSSLROOTCERT: pgsslrootcert,
        },
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
        windowsHide: true,
      });
    } catch (error) {
      result = {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        exitCode: typeof error.code === "number" ? error.code : 1,
      };
    }

    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    return {
      config: {
        application_name: capture.application_name,
        connectionString: capture.connectionString,
        ssl: capture.ssl,
      },
      queries: capture.queries ?? [],
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function extractHeldLockInjectorNodeScript(shell) {
  const match = /<<'NODE'\r?\n([\s\S]*)\r?\nNODE$/.exec(shell);
  if (!match) {
    throw new Error("Generated held-lock injector shell did not contain a NODE heredoc.");
  }
  return match[1];
}

function readMarkerPayload(output, marker) {
  const line = output.split(/\r?\n/).find((entry) => entry.includes(marker));
  if (!line) {
    throw new Error(`Output did not contain marker ${marker}.`);
  }
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length).trim());
}

async function writeCaFile(contents) {
  const directory = await mkdtemp(join(tmpdir(), "bootstrap-hook-drill-ca-"));
  const caPath = join(directory, "root.crt");
  await writeFile(caPath, contents, "utf8");
  return {
    caPath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
