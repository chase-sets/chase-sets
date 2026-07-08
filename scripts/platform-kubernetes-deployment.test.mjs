import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  buildDeploymentEvidence,
  buildDiagnosticsCommands,
  buildHelmRollbackArgs,
  buildHelmStatusArgs,
  buildHelmUpgradeArgs,
  buildKubernetesRollbackTarget,
  deployPlatformToKubernetes,
  helmReleaseExists,
  parsePlatformImageRef,
  platformValuesPathForEnvironment,
  platformKubernetesWorkloads,
  rollbackPlatformOnKubernetes,
} from "./platform-kubernetes-deployment.mjs";

const sampleValues = {
  components: {
    "public-web": { enabled: true, kind: "service" },
    marketplace: { enabled: true, kind: "service" },
    "platform-worker": { enabled: true, kind: "worker" },
    "platform-bootstrap": { enabled: true, kind: "job" },
    disabled: { enabled: false, kind: "service" },
  },
};

function successfulSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0));
    return child;
  };
}

function completedSpawn(calls, completions) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const completion = completions.shift() ?? { code: 0 };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (completion.stdout) {
        child.stdout.emit("data", completion.stdout);
      }
      if (completion.stderr) {
        child.stderr.emit("data", completion.stderr);
      }
      child.emit("close", completion.code ?? 0);
    });
    return child;
  };
}

describe("platform Kubernetes deployment", () => {
  it("parses DigitalOcean platform image refs with tags or digests", () => {
    expect(parsePlatformImageRef("registry.digitalocean.com/chase-sets/chase-sets-platform:abc123")).toEqual({
      registry: "registry.digitalocean.com",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: "abc123",
      digest: "",
    });
    expect(
      parsePlatformImageRef(`registry.digitalocean.com/chase-sets/chase-sets-platform@sha256:${"a".repeat(64)}`),
    ).toEqual({
      registry: "registry.digitalocean.com",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: "latest",
      digest: `sha256:${"a".repeat(64)}`,
    });
    expect(() => parsePlatformImageRef("chase-sets-platform:abc123")).toThrow("Platform image must look like");
  });

  it("builds Helm upgrade arguments for atomic rollout-based deploys", () => {
    expect(
      buildHelmUpgradeArgs({
        release: "staging-platform",
        namespace: "staging",
        timeout: "12m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
      }),
    ).toEqual([
      "upgrade",
      "--install",
      "staging-platform",
      "infrastructure/helm/platform",
      "--namespace",
      "staging",
      "--create-namespace",
      "--wait",
      "--timeout",
      "12m",
      "--atomic",
      "--set-string",
      "global.image.registry=registry.digitalocean.com",
      "--set-string",
      "global.image.registryName=chase-sets",
      "--set-string",
      "global.image.repository=chase-sets-platform",
      "--set-string",
      "global.image.tag=release-sha",
      "--set-string",
      "global.image.digest=",
    ]);
  });

  it("can pass a Kubernetes image pull secret to Helm", () => {
    expect(
      buildHelmUpgradeArgs({
        release: "production-platform",
        namespace: "production",
        timeout: "12m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
        imagePullSecret: "registry-chase-sets",
      }),
    ).toEqual(expect.arrayContaining(["--set-string", "global.imagePullSecrets[0].name=registry-chase-sets"]));
  });

  it("can pass non-secret runtime environment overrides to Helm", () => {
    expect(
      buildHelmUpgradeArgs({
        release: "production-platform",
        namespace: "production",
        timeout: "12m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
        envOverrides: {
          CATALOG_ASSET_S3_BUCKET: "chase-sets-production-catalog-assets",
          CATALOG_ASSET_PUBLIC_BASE_URL: "https://assets.chasesets.com",
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        "--set-string",
        "global.envOverrides.CATALOG_ASSET_PUBLIC_BASE_URL=https://assets.chasesets.com",
        "--set-string",
        "global.envOverrides.CATALOG_ASSET_S3_BUCKET=chase-sets-production-catalog-assets",
      ]),
    );
  });

  it("loads the staging Helm overlay only for staging deployments", () => {
    expect(platformValuesPathForEnvironment("staging")).toBe("infrastructure/helm/platform/values.staging.yaml");
    expect(platformValuesPathForEnvironment("production")).toBeNull();
    expect(
      buildHelmUpgradeArgs({
        release: "staging-platform",
        namespace: "staging",
        timeout: "12m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
        envOverrides: {
          DEPLOYMENT_ENVIRONMENT: "staging",
        },
      }),
    ).toEqual(expect.arrayContaining(["--values", "infrastructure/helm/platform/values.staging.yaml"]));
    expect(
      buildHelmUpgradeArgs({
        release: "production-platform",
        namespace: "production",
        timeout: "12m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
        envOverrides: {
          DEPLOYMENT_ENVIRONMENT: "production",
        },
      }),
    ).not.toContain("--values");
  });

  it("threads DOKS ingress Helm values only for staging when an ingress target is configured", () => {
    const stagingArgs = buildHelmUpgradeArgs({
      release: "staging-platform",
      namespace: "staging",
      timeout: "12m",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
      envOverrides: {
        DEPLOYMENT_ENVIRONMENT: "staging",
      },
      env: {
        DOKS_INGRESS_TARGET: "203.0.113.10",
        STAGING_APP_SERVING: "app-platform",
      },
    });

    expect(stagingArgs).toEqual(expect.arrayContaining(["--set", "doksIngress.enabled=true"]));
    expect(stagingArgs).toEqual(
      expect.arrayContaining([
        "--set-string",
        "doksIngress.clusterIssuer=letsencrypt-production",
        "--set-string",
        "doksIngress.hosts[0].host=doks.staging.chasesets.com",
        "--set-string",
        "doksIngress.hosts[1].host=www.doks.staging.chasesets.com",
        "--set-string",
        "doksIngress.hosts[2].host=marketplace.doks.staging.chasesets.com",
        "--set-string",
        "doksIngress.hosts[3].host=admin.doks.staging.chasesets.com",
      ]),
    );

    const productionArgs = buildHelmUpgradeArgs({
      release: "production-platform",
      namespace: "production",
      timeout: "12m",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
      envOverrides: {
        DEPLOYMENT_ENVIRONMENT: "production",
      },
      env: {
        DOKS_INGRESS_TARGET: "203.0.113.10",
        STAGING_APP_SERVING: "doks",
      },
    });

    expect(productionArgs).not.toContain("doksIngress.enabled=true");
  });

  it("escapes comma-separated runtime environment override values for Helm", () => {
    expect(
      buildHelmUpgradeArgs({
        release: "production-platform",
        namespace: "production",
        timeout: "12m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
        envOverrides: {
          PLATFORM_DATA_PROFILES: "critical-bootstrap,catalog-integration-bootstrap",
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        "--set-string",
        "global.envOverrides.PLATFORM_DATA_PROFILES=critical-bootstrap\\,catalog-integration-bootstrap",
      ]),
    );
  });

  it("rejects malformed runtime environment override names", () => {
    expect(() =>
      buildHelmUpgradeArgs({
        release: "production-platform",
        namespace: "production",
        timeout: "12m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
        envOverrides: { "catalog.asset": "bad" },
      }),
    ).toThrow("Runtime env override name");
  });

  it("builds Helm rollback arguments with an optional revision", () => {
    expect(buildHelmRollbackArgs({ release: "staging-platform", namespace: "staging", timeout: "5m" })).toEqual([
      "rollback",
      "staging-platform",
      "--namespace",
      "staging",
      "--wait",
      "--timeout",
      "5m",
    ]);
    expect(
      buildHelmRollbackArgs({ release: "staging-platform", namespace: "staging", timeout: "5m", revision: "7" }),
    ).toContain("7");
  });

  it("builds Helm status arguments for release existence checks", () => {
    expect(buildHelmStatusArgs({ release: "staging-platform", namespace: "staging" })).toEqual([
      "status",
      "staging-platform",
      "--namespace",
      "staging",
    ]);
  });

  it("derives rollout workloads from the platform Helm values", () => {
    expect(platformKubernetesWorkloads({ values: sampleValues, release: "proof" })).toEqual({
      deployments: [
        "proof-chase-sets-platform-public-web",
        "proof-chase-sets-platform-marketplace",
        "proof-chase-sets-platform-platform-worker",
      ],
      jobs: ["proof-chase-sets-platform-platform-bootstrap"],
    });
  });

  it("deploys with Helm and waits for every runtime deployment", async () => {
    const calls = [];
    const result = await deployPlatformToKubernetes({
      values: sampleValues,
      release: "proof",
      namespace: "staging",
      timeout: "30s",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
      spawn: successfulSpawn(calls),
    });

    expect(result).toMatchObject({
      schemaVersion: "platform-kubernetes-deployment/v1",
      action: "deploy",
      result: "success",
      release: "proof",
      namespace: "staging",
    });
    expect(calls.map((call) => [call.command, call.args])).toEqual([
      [
        "helm",
        buildHelmUpgradeArgs({
          release: "proof",
          namespace: "staging",
          timeout: "30s",
          image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
        }),
      ],
      [
        "kubectl",
        [
          "rollout",
          "status",
          "deployment/proof-chase-sets-platform-public-web",
          "--namespace",
          "staging",
          "--timeout=30s",
        ],
      ],
      [
        "kubectl",
        [
          "rollout",
          "status",
          "deployment/proof-chase-sets-platform-marketplace",
          "--namespace",
          "staging",
          "--timeout=30s",
        ],
      ],
      [
        "kubectl",
        [
          "rollout",
          "status",
          "deployment/proof-chase-sets-platform-platform-worker",
          "--namespace",
          "staging",
          "--timeout=30s",
        ],
      ],
    ]);
  });

  it("rolls back with Helm and reuses rollout status waits", async () => {
    const calls = [];
    await rollbackPlatformOnKubernetes({
      values: sampleValues,
      release: "proof",
      namespace: "staging",
      timeout: "30s",
      revision: "3",
      spawn: successfulSpawn(calls),
    });

    expect(calls[0]).toMatchObject({
      command: "helm",
      args: ["status", "proof", "--namespace", "staging"],
    });
    expect(calls[1]).toMatchObject({
      command: "helm",
      args: ["rollback", "proof", "3", "--namespace", "staging", "--wait", "--timeout", "30s"],
    });
    expect(calls.slice(2).every((call) => call.args[0] === "rollout")).toBe(true);
  });

  it("detects whether a Helm release exists without logging status output", async () => {
    const calls = [];
    await expect(
      helmReleaseExists({
        release: "proof",
        namespace: "staging",
        spawn: completedSpawn(calls, [{ code: 0, stdout: '{"name":"proof"}' }]),
      }),
    ).resolves.toBe(true);

    expect(calls).toEqual([
      {
        command: "helm",
        args: ["status", "proof", "--namespace", "staging"],
        options: { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      },
    ]);
  });

  it("treats a missing Helm release as a skipped first-install rollback", async () => {
    const calls = [];
    const result = await rollbackPlatformOnKubernetes({
      values: sampleValues,
      release: "proof",
      namespace: "production",
      timeout: "30s",
      spawn: completedSpawn(calls, [{ code: 1, stderr: "Error: release: not found" }]),
    });

    expect(result).toMatchObject({
      action: "rollback",
      result: "skipped",
      reason: "helm-release-not-found",
      release: "proof",
      namespace: "production",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["status", "proof", "--namespace", "production"]);
  });

  it("fails closed when Helm status fails for reasons other than a missing release", async () => {
    await expect(
      helmReleaseExists({
        release: "proof",
        namespace: "production",
        spawn: completedSpawn([], [{ code: 1, stderr: "Error: Kubernetes cluster unreachable" }]),
      }),
    ).rejects.toThrow("helm status proof --namespace production exited with code 1");
  });

  it("builds kubectl diagnostics without requiring App Platform state", () => {
    const commands = buildDiagnosticsCommands({
      values: sampleValues,
      release: "proof",
      namespace: "staging",
      tailLines: 50,
    });

    expect(commands.slice(0, 4)).toEqual([
      [
        "kubectl",
        ["get", "pods", "--namespace", "staging", "--sort-by=.metadata.creationTimestamp", "--output", "wide"],
      ],
      ["kubectl", ["get", "jobs", "--namespace", "staging", "--sort-by=.metadata.creationTimestamp"]],
      ["kubectl", ["get", "deployments", "--namespace", "staging", "--sort-by=.metadata.creationTimestamp"]],
      ["kubectl", ["get", "events", "--namespace", "staging", "--sort-by=.lastTimestamp"]],
    ]);
    expect(commands).toContainEqual([
      "kubectl",
      ["describe", "job", "proof-chase-sets-platform-platform-bootstrap", "--namespace", "staging"],
    ]);
    expect(commands).toContainEqual([
      "kubectl",
      [
        "describe",
        "pods",
        "--namespace",
        "staging",
        "--selector",
        "app.kubernetes.io/instance=proof,app.kubernetes.io/component=platform-bootstrap",
      ],
    ]);
    expect(commands).toContainEqual([
      "kubectl",
      [
        "logs",
        "--namespace",
        "staging",
        "--selector",
        "app.kubernetes.io/instance=proof,app.kubernetes.io/component=platform-bootstrap",
        "--all-containers",
        "--tail",
        "50",
      ],
    ]);
    expect(commands).toContainEqual([
      "kubectl",
      [
        "logs",
        "--namespace",
        "staging",
        "--selector",
        "app.kubernetes.io/instance=proof,app.kubernetes.io/component=platform-bootstrap",
        "--all-containers",
        "--previous",
        "--tail",
        "50",
      ],
    ]);
    expect(commands).not.toContainEqual([
      "kubectl",
      ["get", "pods,jobs,deployments,events", "--namespace", "staging", "--sort-by=.metadata.creationTimestamp"],
    ]);
  });

  it("builds release-health-friendly deployment evidence", () => {
    expect(
      buildDeploymentEvidence({
        action: "rollback",
        release: "proof",
        namespace: "production",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:prior",
        result: "success",
        values: sampleValues,
      }),
    ).toMatchObject({
      schemaVersion: "platform-kubernetes-deployment/v1",
      action: "rollback",
      release: "proof",
      namespace: "production",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:prior",
      result: "success",
      workloads: {
        deployments: expect.arrayContaining(["proof-chase-sets-platform-platform-worker"]),
        jobs: ["proof-chase-sets-platform-platform-bootstrap"],
      },
    });
  });

  it("builds release-health-friendly rollback targets without App Platform state", () => {
    expect(
      buildKubernetesRollbackTarget({
        values: sampleValues,
        release: "proof",
        namespace: "production",
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        releaseTag: "release-20260705120000-abcdef12",
        lastKnownGoodCommit: "a".repeat(40),
        checkedAt: "2026-07-05T12:00:00.000Z",
      }),
    ).toEqual({
      schemaVersion: "platform-kubernetes-rollback-target/v1",
      capturedAt: "2026-07-05T12:00:00.000Z",
      release: "proof",
      namespace: "production",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: "release-20260705120000-abcdef12",
      digest: "",
      imageRef: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-20260705120000-abcdef12",
      componentNames: [
        "proof-chase-sets-platform-marketplace",
        "proof-chase-sets-platform-platform-bootstrap",
        "proof-chase-sets-platform-platform-worker",
        "proof-chase-sets-platform-public-web",
      ],
      lastKnownGoodCommit: "a".repeat(40),
      releaseTag: "release-20260705120000-abcdef12",
    });
  });
});
