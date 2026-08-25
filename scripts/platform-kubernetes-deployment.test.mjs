import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  abortPlatformRollouts,
  assertOciIndexPlatformManifestMembership,
  buildDeploymentEvidence,
  buildDiagnosticsCommands,
  buildApplicationWorkloadIdentityArgs,
  buildHelmHistoryArgs,
  buildHelmRollbackArgs,
  buildHelmStatusArgs,
  buildHelmUninstallArgs,
  buildHelmUpgradeArgs,
  buildHelmValuesArgs,
  buildWaveExposureHelmSetArgs,
  buildKubernetesRollbackTarget,
  buildNamespaceDeleteArgs,
  buildNamespaceGetArgs,
  buildPreviewWildcardSecretApplyArgs,
  buildPreviewWildcardSecretGetArgs,
  buildScenarioSeedAccessManifest,
  buildScenarioSeedJobManifest,
  copyPreviewWildcardTlsSecret,
  captureKubernetesRollbackTarget,
  deployPlatformToKubernetes,
  helmReleaseExists,
  parsePlatformImageRef,
  parseArgs,
  platformValuesPathForEnvironment,
  platformKubernetesWorkloads,
  promotePlatformRollouts,
  rollbackPlatformOnKubernetes,
  runScenarioSeedOnKubernetes,
  sanitizeCopiedSecretManifest,
  scenarioSeedMaxActiveDeadlineSeconds,
  selectStableDeployedHelmSource,
  teardownPlatformKubernetesNamespace,
  verifyKubernetesDeploymentTransition,
} from "./platform-kubernetes-deployment.mjs";

const sampleValues = {
  components: {
    "public-web": { enabled: true, kind: "service", rollout: { enabled: false } },
    marketplace: { enabled: true, kind: "service", rollout: { enabled: false } },
    "platform-worker": { enabled: true, kind: "worker" },
    "platform-bootstrap": { enabled: true, kind: "job" },
    disabled: { enabled: false, kind: "service" },
  },
};

const rollbackDigest = "sha256:635b93388d32b865330e1ccb068a5effcd7a492326e597c9f72c48886f1f9680";
const rollbackIndexDigest = "sha256:261f0b60e1b373d0aa423f04b651c3ab9f9e3d0f6e799624a920b58e4b1aefb2";
const rollbackTag = "c0bd688d64bd5140fcbd2790489717a042e5432b";
const failedCandidateDigest = "sha256:389894cef6b5ebc5dd63d1b3b5aada76264a8d353d8fa4852018bafe9496292d";
const rollbackImageRef = `registry.digitalocean.com/chase-sets/chase-sets-platform@${rollbackDigest}`;
const productionIndex = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: rollbackDigest,
      platform: { os: "linux", architecture: "amd64" },
    },
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: failedCandidateDigest,
      platform: { os: "unknown", architecture: "unknown" },
    },
  ],
};
const rollbackValues = {
  global: {
    image: {
      registry: "registry.digitalocean.com",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: rollbackDigest,
    },
  },
  components: {
    "platform-worker": { enabled: true, kind: "worker" },
    "platform-bootstrap": { enabled: true, kind: "job", job: { hook: { enabled: true } } },
  },
};

function helmHistory(entries) {
  return JSON.stringify(entries);
}

function rollbackWorkloadList(image = rollbackImageRef) {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
          name: "proof-chase-sets-platform-platform-worker",
          labels: {
            "app.kubernetes.io/instance": "proof",
            "app.kubernetes.io/component": "platform-worker",
          },
        },
        spec: {
          template: {
            spec: {
              containers: [{ name: "platform-worker", image }],
            },
          },
        },
      },
      {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {
          name: "proof-chase-sets-platform-platform-bootstrap",
          annotations: {
            "helm.sh/hook": "pre-install,pre-upgrade",
          },
          labels: {
            "app.kubernetes.io/instance": "proof",
            "app.kubernetes.io/component": "platform-bootstrap",
          },
        },
        spec: {
          template: {
            spec: {
              containers: [
                {
                  name: "platform-bootstrap",
                  image: `registry.digitalocean.com/chase-sets/chase-sets-platform@${failedCandidateDigest}`,
                },
              ],
            },
          },
        },
        status: {
          failed: 1,
          conditions: [{ type: "Failed", status: "True" }],
        },
      },
    ],
  });
}

function successfulSpawn(calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdin = { end: () => {} };
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
    child.stdin = { end: (input) => calls[calls.length - 1] && (calls[calls.length - 1].stdin = input) };
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

  it("builds a staging-only post-deploy scenario seed Job that quiesces workers", () => {
    const manifest = buildScenarioSeedJobManifest({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      image: `registry.digitalocean.com/chase-sets/chase-sets-platform@sha256:${"a".repeat(64)}`,
      imagePullSecret: "chase-sets",
      timeout: "60m",
      jobName: "staging-scenario-seed-proof",
      envOverrides: {
        DEPLOYMENT_ENVIRONMENT: "staging",
        CHASE_SETS_RUNTIME_PROFILE: "public",
        CATALOG_ASSET_PUBLIC_BASE_URL: "https://assets.staging.chasesets.com",
        CATALOG_ASSET_S3_BUCKET: "staging-assets",
      },
    });
    const container = manifest.spec.template.spec.containers[0];
    const env = new Map(container.env.map((entry) => [entry.name, entry]));

    expect(manifest.spec.activeDeadlineSeconds).toBe(scenarioSeedMaxActiveDeadlineSeconds);
    expect(manifest.spec.backoffLimit).toBe(0);
    expect(manifest.spec.template.spec.imagePullSecrets).toEqual([{ name: "chase-sets" }]);
    expect(manifest.spec.template.spec.serviceAccountName).toBe(
      "chase-sets-platform-chase-sets-platform-scenario-seed-quiesce",
    );
    expect(container.args).toEqual([
      "node ./infrastructure/helm/platform/scripts/bootstrap-quiesce.mjs -- pnpm --filter @chase-sets/app-platform-api run bootstrap:production",
    ]);
    expect(env.get("PLATFORM_DATA_PROFILES")).toEqual({ name: "PLATFORM_DATA_PROFILES", value: "scenario-seed" });
    expect(env.get("DEPLOYMENT_ENVIRONMENT")).toEqual({ name: "DEPLOYMENT_ENVIRONMENT", value: "staging" });
    expect(env.get("CHASE_SETS_QUIESCE_DEPLOYMENTS")).toEqual({
      name: "CHASE_SETS_QUIESCE_DEPLOYMENTS",
      value: "chase-sets-platform-chase-sets-platform-platform-worker",
    });
    expect(env.get("CHASE_SETS_BOOTSTRAP_COMMAND_TIMEOUT_SECONDS")).toEqual({
      name: "CHASE_SETS_BOOTSTRAP_COMMAND_TIMEOUT_SECONDS",
      value: "3000",
    });
    expect(env.get("CHASE_SETS_QUIESCE_RESTORE_ON_FAILURE")).toEqual({
      name: "CHASE_SETS_QUIESCE_RESTORE_ON_FAILURE",
      value: "true",
    });
    expect(env.get("DATABASE_URL_IDENTITY")).toEqual({
      name: "DATABASE_URL_IDENTITY",
      valueFrom: {
        secretKeyRef: {
          name: "chase-sets-platform-runtime",
          key: "BOOTSTRAP_DATABASE_URL_IDENTITY",
        },
      },
    });

    expect(() =>
      buildScenarioSeedJobManifest({
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:proof",
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "production" },
      }),
    ).toThrow("staging-only");
  });

  it("limits scenario seed quiesce access to worker scaling and KEDA pause", () => {
    const manifest = buildScenarioSeedAccessManifest({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
    });
    const [serviceAccount, role, roleBinding] = manifest.items;

    expect(serviceAccount).toMatchObject({
      kind: "ServiceAccount",
      imagePullSecrets: [{ name: "chase-sets" }],
    });
    expect(role.rules).toEqual([
      {
        apiGroups: ["apps"],
        resources: ["deployments", "deployments/scale"],
        resourceNames: ["chase-sets-platform-chase-sets-platform-platform-worker"],
        verbs: ["get", "patch"],
      },
      {
        apiGroups: ["keda.sh"],
        resources: ["scaledobjects"],
        resourceNames: ["chase-sets-platform-chase-sets-platform-platform-worker"],
        verbs: ["patch"],
      },
    ]);
    expect(roleBinding.roleRef.name).toBe(role.metadata.name);
    expect(roleBinding.subjects).toEqual([
      { kind: "ServiceAccount", name: serviceAccount.metadata.name, namespace: "chase-sets-platform" },
    ]);
  });

  it("builds advisory scenario seed Jobs without pausing projection workers", () => {
    const manifest = buildScenarioSeedJobManifest({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      image: `registry.digitalocean.com/chase-sets/chase-sets-platform@sha256:${"a".repeat(64)}`,
      imagePullSecret: "chase-sets",
      timeout: "60m",
      jobName: "staging-advisory-scenario-seed",
      quiesceWorkers: false,
      envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
    });
    const container = manifest.spec.template.spec.containers[0];
    const env = new Map(container.env.map((entry) => [entry.name, entry]));

    expect(manifest.spec.template.spec.serviceAccountName).toBeUndefined();
    expect(manifest.spec.template.spec.imagePullSecrets).toEqual([{ name: "chase-sets" }]);
    expect(container.args).toEqual(["pnpm --filter @chase-sets/app-platform-api run bootstrap:production"]);
    expect(env.has("CHASE_SETS_QUIESCE_DEPLOYMENTS")).toBe(false);
    expect(env.has("CHASE_SETS_QUIESCE_RESTORE_ON_FAILURE")).toBe(false);
  });

  it("applies, streams, and verifies the post-deploy scenario seed Job", async () => {
    const calls = [];
    const result = await runScenarioSeedOnKubernetes({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:proof",
      timeout: "60m",
      jobName: "staging-scenario-seed-proof",
      envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
      spawn: completedSpawn(calls, [
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 0, stdout: JSON.stringify({ status: { succeeded: 1 } }) },
        { code: 0 },
      ]),
    });

    expect(result).toMatchObject({
      action: "scenario-seed",
      result: "success",
      jobName: "staging-scenario-seed-proof",
    });
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["kubectl", "apply"],
      ["kubectl", "apply"],
      ["kubectl", "logs"],
      ["kubectl", "get"],
      ["kubectl", "delete"],
    ]);
    const accessManifest = JSON.parse(calls[0].stdin);
    const appliedManifest = JSON.parse(calls[1].stdin);
    expect(accessManifest.kind).toBe("List");
    expect(appliedManifest.metadata.labels["app.kubernetes.io/component"]).toBe("scenario-seed");
    expect(calls.at(-1).args).toContain("serviceaccount/chase-sets-platform-chase-sets-platform-scenario-seed-quiesce");
  });

  it("removes scenario seed quiesce access when the Job fails", async () => {
    const calls = [];
    await expect(
      runScenarioSeedOnKubernetes({
        release: "chase-sets-platform",
        namespace: "chase-sets-platform",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:proof",
        timeout: "60m",
        jobName: "staging-scenario-seed-proof",
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
        spawn: completedSpawn(calls, [
          { code: 0 },
          { code: 0 },
          { code: 0 },
          { code: 0, stdout: JSON.stringify({ status: { failed: 1 } }) },
          { code: 0 },
        ]),
      }),
    ).rejects.toThrow("Post-deploy scenario seed Job staging-scenario-seed-proof failed");

    expect(calls.at(-1).args[0]).toBe("delete");
  });

  it("runs advisory scenario seed without creating worker-scaling access", async () => {
    const calls = [];
    const result = await runScenarioSeedOnKubernetes({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:proof",
      timeout: "60m",
      jobName: "staging-advisory-scenario-seed",
      quiesceWorkers: false,
      envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
      spawn: completedSpawn(calls, [
        { code: 0 },
        { code: 0 },
        { code: 0, stdout: JSON.stringify({ status: { succeeded: 1 } }) },
      ]),
    });

    expect(result).toMatchObject({ result: "success", jobName: "staging-advisory-scenario-seed" });
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["kubectl", "apply"],
      ["kubectl", "logs"],
      ["kubectl", "get"],
    ]);
    expect(JSON.parse(calls[0].stdin).kind).toBe("Job");
  });

  it("parses the advisory worker-quiesce override", () => {
    const parsed = parseArgs(["scenario-seed", "--quiesce-workers", "false"], {});

    expect(parsed.quiesceWorkers).toBe(false);
    expect(() => parseArgs(["scenario-seed", "--quiesce-workers", "sometimes"], {})).toThrow(
      "--quiesce-workers must be true or false.",
    );
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
      "--set-string",
      "global.imagePullSecrets[0].name=chase-sets",
    ]);
  });

  it("pins Helm to the provider-managed Kubernetes image pull authority", () => {
    expect(
      buildHelmUpgradeArgs({
        release: "production-platform",
        namespace: "production",
        timeout: "12m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
        imagePullSecret: "chase-sets",
      }),
    ).toEqual(expect.arrayContaining(["--set-string", "global.imagePullSecrets[0].name=chase-sets"]));
    expect(() =>
      buildHelmUpgradeArgs({
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
        imagePullSecret: "generated-registry-secret",
      }),
    ).toThrow("provider-managed 'chase-sets' authority");
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

  it("loads the environment-specific Helm overlays for staging and production", () => {
    expect(platformValuesPathForEnvironment("staging")).toBe("infrastructure/helm/platform/values.staging.yaml");
    expect(platformValuesPathForEnvironment("production")).toBe("infrastructure/helm/platform/values.production.yaml");
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
    ).toEqual(expect.arrayContaining(["--values", "infrastructure/helm/platform/values.production.yaml"]));
  });

  it("enables in-cluster collection with environment-safe export only for long-lived environments", () => {
    const stagingArgs = buildHelmUpgradeArgs({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
      envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging", OBSERVABILITY_ENABLED: "true" },
    });
    expect(stagingArgs).toEqual(
      expect.arrayContaining([
        "--set",
        "observability.enabled=true",
        "--set-string",
        "observability.environment=staging",
        "--set-string",
        "observability.clusterName=chase-sets-staging-doks",
        "--set-string",
        "observability.exporter.endpoint=https://otel.staging.chasesets.com",
      ]),
    );
    expect(stagingArgs.join(" ")).toContain(
      "global.envOverrides.OTEL_EXPORTER_OTLP_ENDPOINT=http://chase-sets-platform-chase-sets-platform-observability-collector:4318",
    );
    expect(stagingArgs.join(" ")).toContain("global.envOverrides.OBSERVABILITY_ENABLED=true");
    expect(stagingArgs.join(" ")).toContain("chase_sets.environment_slug=staging");

    const productionArgs = buildHelmUpgradeArgs({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
      observabilityExporterEndpoint: "https://otel.chasesets.com",
      envOverrides: {
        DEPLOYMENT_ENVIRONMENT: "production",
        OBSERVABILITY_ENABLED: "true",
        // These hostile values prove an observability-enabled production path
        // cannot inherit the base chart's empty/preview telemetry posture.
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.preview.chasesets.com",
        OTEL_RESOURCE_ATTRIBUTES:
          "cloud.provider=digitalocean,cloud.platform=kubernetes,chase_sets.environment_slug=preview",
      },
    });
    expect(productionArgs).toEqual(
      expect.arrayContaining([
        "--values",
        "infrastructure/helm/platform/values.production.yaml",
        "--set-string",
        "observability.environment=production",
        "--set-string",
        "observability.clusterName=chase-sets-production-doks",
        "--set-string",
        "observability.exporter.endpoint=https://otel.chasesets.com",
      ]),
    );
    expect(productionArgs.join(" ")).toContain(
      "global.envOverrides.OTEL_EXPORTER_OTLP_ENDPOINT=http://chase-sets-platform-chase-sets-platform-observability-collector:4318",
    );
    expect(productionArgs.join(" ")).toContain("chase_sets.environment_slug=production");
    expect(productionArgs.join(" ")).not.toContain("chase_sets.environment_slug=preview");
    expect(productionArgs.join(" ")).not.toContain(
      "global.envOverrides.OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.preview.chasesets.com",
    );
    expect(
      productionArgs.some((arg) =>
        arg.startsWith(
          "global.envOverrides.OTEL_EXPORTER_OTLP_ENDPOINT=http://chase-sets-platform-chase-sets-platform-observability-collector:4318",
        ),
      ),
    ).toBe(true);

    const previewArgs = buildHelmUpgradeArgs({
      release: "chase-sets-pr-4051",
      namespace: "chase-sets-pr-4051",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:pr-4051",
      envOverrides: { DEPLOYMENT_ENVIRONMENT: "preview", PREVIEW_IDENTIFIER: "pr-4051" },
    });
    expect(previewArgs).not.toContain("observability.enabled=true");
  });

  it("drives the exact workflow staging argv end-to-end and executes helm with the staging overlay", async () => {
    // End-to-end guard for issue #4743: this is the verbatim argv the
    // platform-production.yml "Deploy staging Kubernetes release" step passes
    // to `pnpm run platform:kubernetes-deployment -- deploy` (captured from
    // the live run log of 29016902701). The full path - CLI parse ->
    // buildHelmUpgradeArgs -> the spawned helm command - must include the
    // staging overlay `--values`; superseded or atomically rolled-back
    // deploys are the only sanctioned reasons the overlay does not reach the
    // cluster.
    const workflowArgv = [
      "--",
      "deploy",
      "--image",
      "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha@sha256:4db059aed0e208b2ab1ebe0e8cbb562070d3962fc21d0f088af85a9942e76d86",
      "--image-pull-secret",
      "chase-sets",
      "--runtime-env",
      "DEPLOYMENT_ENVIRONMENT=staging",
      "--runtime-env",
      "CHASE_SETS_RUNTIME_PROFILE=public",
      "--runtime-env",
      "PLATFORM_DATA_PROFILES=critical-bootstrap,catalog-integration-bootstrap",
      "--runtime-env",
      "CATALOG_ASSET_PUBLIC_BASE_URL=https://assets.staging.chasesets.com",
      "--namespace",
      "chase-sets-platform",
      "--release",
      "chase-sets-platform",
      "--rollouts-enabled",
      "true",
      "--timeout",
      "15m",
    ];
    const parsed = parseArgs(workflowArgv, {});
    expect(parsed.command).toBe("deploy");
    expect(parsed.envOverrides.DEPLOYMENT_ENVIRONMENT).toBe("staging");

    const calls = [];
    await deployPlatformToKubernetes({
      ...parsed,
      values: sampleValues,
      spawn: successfulSpawn(calls),
    });

    const helmCall = calls.find((call) => call.command === "helm");
    expect(helmCall).toBeDefined();
    const valuesFlagIndex = helmCall.args.indexOf("--values");
    expect(valuesFlagIndex).toBeGreaterThan(-1);
    expect(helmCall.args[valuesFlagIndex + 1]).toBe("infrastructure/helm/platform/values.staging.yaml");
    // The runtime env rides global.envOverrides set-strings and must never
    // smuggle a conflicting relay value past the overlay.
    expect(helmCall.args.filter((arg) => String(arg).includes("WORKER_PROJECTION_WAKE_RELAY_ENABLED"))).toEqual([]);
    expect(helmCall.args.join(" ")).toContain("global.envOverrides.DEPLOYMENT_ENVIRONMENT=staging");
    expect(helmCall.args.join(" ")).toContain("components.public-web.rollout.enabled=true");
    expect(helmCall.args.join(" ")).toContain("components.marketplace.rollout.enabled=true");
    expect(helmCall.args.join(" ")).toContain("components.platform-api.rollout.enabled=true");
  });

  it("guards the deploy-applied staging artifacts so the DOKS worker relay flag can never render false", () => {
    // Deploy-artifact guard for issue #4743: the staging helm upgrade applies
    // exactly (chart values.yaml) + (--values values.staging.yaml) + the
    // --set-string args below, resolved by _helpers.tpl's env precedence
    // (secret > component envOverrides > global envOverrides > base value).
    // A render-level assertion on the generator constant is NOT enough — the
    // regression this pins was invisible at render level: the merged fix sat
    // in the repo while the applied estate kept relay=false (superseded
    // deploys skipped the helm step; bootstrap-hook failures atomically
    // rolled back to the pre-fix revision). This test pins every artifact the
    // deploy actually reads.
    const chartValues = readFileSync("infrastructure/helm/platform/values.yaml", "utf8");
    const stagingValues = readFileSync("infrastructure/helm/platform/values.staging.yaml", "utf8");
    const envHelper = readFileSync("infrastructure/helm/platform/templates/_helpers.tpl", "utf8");

    // 1. The staging overlay — the artifact helm merges last — must carry the
    //    relay flag as a platform-worker component override set to "true".
    const overlaySection = stagingValues.slice(stagingValues.indexOf("platform-worker:"));
    expect(overlaySection).toContain('WORKER_PROJECTION_WAKE_RELAY_ENABLED: "true"');

    // 2. The chart base must still declare the env entry as a plain value
    //    (previews stay relay-off; a secret-backed entry would bypass the
    //    override branch in the env helper entirely).
    expect(chartValues).toContain('- name: "WORKER_PROJECTION_WAKE_RELAY_ENABLED"');
    const baseEntryIndex = chartValues.indexOf('- name: "WORKER_PROJECTION_WAKE_RELAY_ENABLED"');
    const baseEntry = chartValues.slice(baseEntryIndex, chartValues.indexOf("- name:", baseEntryIndex + 1));
    expect(baseEntry).toContain('value: "false"');
    expect(baseEntry).not.toContain("secret");

    // 3. The env helper's precedence must keep component envOverrides ahead of
    //    global envOverrides ahead of the base value, so the staging overlay
    //    wins over both the chart default and any --set-string global
    //    override.
    const componentBranch = envHelper.indexOf("hasKey $componentEnvOverrides .name");
    const globalBranch = envHelper.indexOf("hasKey $envOverrides .name");
    const baseBranch = envHelper.indexOf('value: {{ default "" .value | quote }}');
    expect(componentBranch).toBeGreaterThan(-1);
    expect(globalBranch).toBeGreaterThan(componentBranch);
    expect(baseBranch).toBeGreaterThan(globalBranch);

    // 4. The staging helm invocation must include the overlay and must not
    //    smuggle a conflicting relay value through --set-string overrides.
    const args = buildHelmUpgradeArgs({
      release: "staging-platform",
      namespace: "staging",
      timeout: "12m",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
      envOverrides: {
        DEPLOYMENT_ENVIRONMENT: "staging",
        CHASE_SETS_RUNTIME_PROFILE: "public",
      },
    });
    expect(args).toEqual(expect.arrayContaining(["--values", "infrastructure/helm/platform/values.staging.yaml"]));
    expect(args.filter((arg) => String(arg).includes("WORKER_PROJECTION_WAKE_RELAY_ENABLED"))).toEqual([]);
  });

  it("derives CHASE_SETS_INTERNAL_API_ORIGIN from the release fullname so previews reach their own API", () => {
    // The webs (admin-web, marketplace, public-web) resolve the current actor
    // through the in-cluster platform-api Service. That Service name is derived
    // from the release fullname (`<release>-<chart>-platform-api`), so an origin
    // baked into values.yaml only resolves for the release it was rendered
    // against (`chase-sets-platform`, i.e. staging/production). Previews deploy
    // under release `chase-sets-pr-<n>`, so the baked host does not exist and the
    // webs 500 with getaddrinfo ENOTFOUND / 503 on actor resolution. The chart
    // must compute the origin from its own fullname helper instead.
    const envHelper = readFileSync("infrastructure/helm/platform/templates/_helpers.tpl", "utf8");
    const chartValues = readFileSync("infrastructure/helm/platform/values.yaml", "utf8");

    // The env helper computes the origin from the platform-api component name
    // (which is release-fullname-derived), not from the baked base value.
    expect(envHelper).toContain('{{- else if eq .name "CHASE_SETS_INTERNAL_API_ORIGIN" }}');
    expect(envHelper).toContain(
      'value: {{ printf "http://%s:8080" (include "chase-sets-platform.componentName" (dict "root" $root "name" "platform-api")) | quote }}',
    );

    // Precedence: an explicit envOverride still wins (it is checked first), and
    // the computed origin sits ahead of the plain base-value fallback so the
    // baked staging default can never leak into a preview release.
    const globalOverrideBranch = envHelper.indexOf("hasKey $envOverrides .name");
    const originBranch = envHelper.indexOf('{{- else if eq .name "CHASE_SETS_INTERNAL_API_ORIGIN" }}');
    const baseValueBranch = envHelper.indexOf('value: {{ default "" .value | quote }}');
    expect(globalOverrideBranch).toBeGreaterThan(-1);
    expect(originBranch).toBeGreaterThan(globalOverrideBranch);
    expect(baseValueBranch).toBeGreaterThan(originBranch);

    // The chart base still declares the origin as a plain value (not a secret),
    // otherwise the env helper's value branch would be bypassed entirely.
    const baseOriginIndex = chartValues.indexOf('- name: "CHASE_SETS_INTERNAL_API_ORIGIN"');
    expect(baseOriginIndex).toBeGreaterThan(-1);
    const baseOriginEntry = chartValues.slice(baseOriginIndex, chartValues.indexOf("- name:", baseOriginIndex + 1));
    expect(baseOriginEntry).not.toContain("secret");
  });

  it("threads environment-scoped DOKS ingress Helm values for staging and production", () => {
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
      },
    });

    expect(stagingArgs).toEqual(expect.arrayContaining(["--set", "doksIngress.enabled=true"]));
    expect(stagingArgs).toEqual(
      expect.arrayContaining([
        "--set-string",
        "doksIngress.clusterIssuer=letsencrypt-production",
        "--set-string",
        "doksIngress.hosts[0].host=staging.chasesets.com",
        "--set-string",
        "doksIngress.hosts[1].host=www.staging.chasesets.com",
        "--set-string",
        "doksIngress.hosts[2].host=marketplace.staging.chasesets.com",
        "--set-string",
        "doksIngress.hosts[3].host=admin.staging.chasesets.com",
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
        PRODUCTION_DOKS_INGRESS_TARGET: "203.0.113.20",
      },
    });

    expect(productionArgs).toEqual(
      expect.arrayContaining([
        "--set",
        "doksIngress.enabled=true",
        "--set-string",
        "doksIngress.clusterIssuer=",
        "--set",
        "doksIngress.tls.certificate.enabled=true",
        "--set-string",
        "doksIngress.tls.certificate.clusterIssuer=letsencrypt-production",
        "--set-string",
        "doksIngress.hosts[0].host=chasesets.com",
        "--set-string",
        "doksIngress.hosts[2].host=admin.chasesets.com",
      ]),
    );
    expect(productionArgs).not.toContain("marketplace.chasesets.com");
  });

  it("enables preview Postgres and PR-specific ingress only for preview deployments", () => {
    const previewArgs = buildHelmUpgradeArgs({
      release: "chase-sets-pr-123",
      namespace: "chase-sets-pr-123",
      timeout: "15m",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:pr-123",
      envOverrides: {
        DEPLOYMENT_ENVIRONMENT: "preview",
        PREVIEW_IDENTIFIER: "pr-123",
      },
    });

    expect(previewArgs).toEqual(expect.arrayContaining(["--set", "previewPostgres.enabled=true"]));
    expect(previewArgs).toEqual(
      expect.arrayContaining([
        "--set",
        "doksIngress.enabled=true",
        "--set-string",
        "doksIngress.hosts[0].host=pr-123.preview.chasesets.com",
        "--set-string",
        "doksIngress.hosts[1].host=pr-123-marketplace.preview.chasesets.com",
        "--set-string",
        "doksIngress.hosts[2].host=pr-123-admin.preview.chasesets.com",
        "--set-string",
        "doksIngress.clusterIssuer=",
        "--set-string",
        "doksIngress.tls.secretName=preview-wildcard-tls",
      ]),
    );
  });

  // #4857: previews copy the ONE shared *.preview.chasesets.com wildcard TLS
  // secret from the cert-manager namespace into their own namespace instead
  // of asking cert-manager to issue their own certificate. A per-preview
  // issuance design exhausted Let's Encrypt's 50-certificates-per-168h quota
  // and blocked every PR behind "PR Required" for three hours.
  describe("preview wildcard TLS secret copy", () => {
    it("reads the shared secret from cert-manager and applies it into the target namespace", () => {
      expect(buildPreviewWildcardSecretGetArgs({})).toEqual([
        "get",
        "secret",
        "preview-wildcard-tls",
        "--namespace",
        "cert-manager",
        "--output",
        "json",
      ]);
      expect(buildPreviewWildcardSecretApplyArgs({ namespace: "chase-sets-pr-123" })).toEqual([
        "apply",
        "--namespace",
        "chase-sets-pr-123",
        "-f",
        "-",
      ]);
    });

    it("strips cluster/revision identity so the copy applies cleanly into a new namespace", () => {
      const sourceSecret = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: "preview-wildcard-tls",
          namespace: "cert-manager",
          resourceVersion: "999",
          uid: "abc-123",
          creationTimestamp: "2026-07-01T00:00:00Z",
          generation: 3,
          ownerReferences: [{ kind: "Certificate", name: "preview-wildcard" }],
          managedFields: [{ manager: "cert-manager" }],
          annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{}", "cert-manager.io/foo": "bar" },
        },
        type: "kubernetes.io/tls",
        data: { "tls.crt": "ZmFrZQ==", "tls.key": "ZmFrZQ==" },
      };

      const sanitized = sanitizeCopiedSecretManifest(JSON.stringify(sourceSecret));

      expect(sanitized).toEqual({
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: "preview-wildcard-tls",
          annotations: { "cert-manager.io/foo": "bar" },
        },
        type: "kubernetes.io/tls",
        data: { "tls.crt": "ZmFrZQ==", "tls.key": "ZmFrZQ==" },
      });
    });

    it("rejects a manifest that is not a Secret", () => {
      expect(() => sanitizeCopiedSecretManifest({ kind: "ConfigMap" })).toThrow(
        "Expected a Kubernetes Secret manifest to copy.",
      );
    });

    it("copies the secret with a get then an apply, piping the manifest over stdin (never a command argument)", async () => {
      const calls = [];
      const sourceSecret = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "preview-wildcard-tls", namespace: "cert-manager", resourceVersion: "1" },
        type: "kubernetes.io/tls",
        data: { "tls.crt": "ZmFrZQ==", "tls.key": "ZmFrZQ==" },
      };

      const result = await copyPreviewWildcardTlsSecret({
        namespace: "chase-sets-pr-123",
        spawn: completedSpawn(calls, [{ code: 0, stdout: JSON.stringify(sourceSecret) }, { code: 0 }]),
      });

      expect(result).toEqual({ name: "preview-wildcard-tls", namespace: "chase-sets-pr-123" });
      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({
        command: "kubectl",
        args: ["get", "secret", "preview-wildcard-tls", "--namespace", "cert-manager", "--output", "json"],
      });
      expect(calls[1]).toMatchObject({
        command: "kubectl",
        args: ["apply", "--namespace", "chase-sets-pr-123", "-f", "-"],
      });
      // The manifest travels over stdin, never as a command-line argument
      // (which would be visible in process listings and CI logs).
      const appliedManifest = JSON.parse(calls[1].stdin);
      expect(appliedManifest.metadata.namespace).toBeUndefined();
      expect(appliedManifest.metadata.resourceVersion).toBeUndefined();
      expect(appliedManifest.data).toEqual({ "tls.crt": "ZmFrZQ==", "tls.key": "ZmFrZQ==" });
      expect(calls[1].args.join(" ")).not.toContain("tls.crt");
    });

    it("fails with a message pointing at the bootstrap runbook when the shared secret has not been bootstrapped yet", async () => {
      await expect(
        copyPreviewWildcardTlsSecret({
          namespace: "chase-sets-pr-123",
          spawn: completedSpawn(
            [],
            [{ code: 1, stderr: 'Error from server (NotFound): secrets "preview-wildcard-tls" not found' }],
          ),
        }),
      ).rejects.toThrow(/doks-cluster-addons\.mjs --environment staging/);
    });

    it("runs the secret copy before the Helm upgrade for a preview deploy, and never for staging/production", async () => {
      const previewCalls = [];
      const previewSecret = {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "preview-wildcard-tls", namespace: "cert-manager" },
        type: "kubernetes.io/tls",
        data: { "tls.crt": "ZmFrZQ==" },
      };
      await deployPlatformToKubernetes({
        values: sampleValues,
        release: "chase-sets-pr-123",
        namespace: "chase-sets-pr-123",
        timeout: "15m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:pr-123",
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "preview", PREVIEW_IDENTIFIER: "pr-123" },
        spawn: completedSpawn(previewCalls, [{ code: 0, stdout: JSON.stringify(previewSecret) }]),
      });

      const commandSequence = previewCalls.map((call) => call.command);
      expect(commandSequence.slice(0, 3)).toEqual(["kubectl", "kubectl", "helm"]);
      expect(previewCalls[0].args).toEqual([
        "get",
        "secret",
        "preview-wildcard-tls",
        "--namespace",
        "cert-manager",
        "--output",
        "json",
      ]);
      expect(previewCalls[1].args).toEqual(["apply", "--namespace", "chase-sets-pr-123", "-f", "-"]);

      const stagingCalls = [];
      await deployPlatformToKubernetes({
        values: sampleValues,
        release: "staging-platform",
        namespace: "staging",
        timeout: "12m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
        spawn: successfulSpawn(stagingCalls),
      });
      // Staging/production never copy the preview wildcard secret; their
      // existing per-environment cert-manager-issued certificate is untouched.
      expect(stagingCalls.some((call) => call.args.includes("preview-wildcard-tls"))).toBe(false);
    });
  });

  it("pins preview workloads to the dedicated preview node pool and keeps other environments off it", () => {
    const previewArgs = buildHelmUpgradeArgs({
      release: "chase-sets-pr-123",
      namespace: "chase-sets-pr-123",
      timeout: "15m",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:pr-123",
      envOverrides: {
        DEPLOYMENT_ENVIRONMENT: "preview",
        PREVIEW_IDENTIFIER: "pr-123",
      },
    });

    // The nodeSelector targets the staging cluster's preview pool label and
    // the toleration matches its preview-only NoSchedule taint (#4745).
    expect(previewArgs).toEqual(
      expect.arrayContaining([
        "--set-string",
        "global.nodeSelector.chase-sets\\.com/pool=preview",
        "--set-string",
        "global.tolerations[0].key=chase-sets.com/preview-only",
        "--set-string",
        "global.tolerations[0].operator=Equal",
        "--set-string",
        "global.tolerations[0].value=true",
        "--set-string",
        "global.tolerations[0].effect=NoSchedule",
      ]),
    );

    for (const environment of ["staging", "production"]) {
      const args = buildHelmUpgradeArgs({
        release: `${environment}-platform`,
        namespace: environment,
        timeout: "12m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
        envOverrides: {
          DEPLOYMENT_ENVIRONMENT: environment,
        },
      });

      expect(args.join("\n")).not.toContain("global.nodeSelector.chase-sets");
      expect(args.join("\n")).not.toContain("preview-only");
    }
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

  it("wires a beta wave size to its analyzed proportional rollout hold", () => {
    const args = buildWaveExposureHelmSetArgs({ betaWaveSize: "250", betaWaveRolloutExposure: "25" });
    expect(args).toEqual(
      expect.arrayContaining([
        "global.betaWave.inviteCount=250",
        "global.betaWave.rolloutExposurePercent=25",
        "components.public-web.rollout.canary.pauseAfterWeight=25",
        "components.marketplace.rollout.canary.pauseAfterWeight=25",
        "components.platform-api.rollout.canary.pauseAfterWeight=25",
      ]),
    );
    expect(() => buildWaveExposureHelmSetArgs({ betaWaveSize: "250" })).toThrow("supplied together");
    expect(() => buildWaveExposureHelmSetArgs({ betaWaveSize: "250", betaWaveRolloutExposure: "15" })).toThrow(
      "analyzed Argo weight",
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

  it("requires an exact positive Helm rollback revision", () => {
    expect(() => buildHelmRollbackArgs({ release: "staging-platform", namespace: "staging", timeout: "5m" })).toThrow(
      "revision must be a positive Helm revision",
    );
    expect(
      buildHelmRollbackArgs({ release: "staging-platform", namespace: "staging", timeout: "5m", revision: "7" }),
    ).toEqual(["rollback", "staging-platform", "7", "--namespace", "staging", "--wait", "--timeout", "5m"]);
  });

  it("builds the exact history, values, and workload identity reads used by rollback", () => {
    expect(buildHelmHistoryArgs({ release: "proof", namespace: "production" })).toEqual([
      "history",
      "proof",
      "--namespace",
      "production",
      "--output",
      "json",
    ]);
    expect(buildHelmValuesArgs({ release: "proof", namespace: "production", revision: 228 })).toContain("228");
    expect(buildApplicationWorkloadIdentityArgs({ release: "proof", namespace: "production" })).toEqual([
      "get",
      "deployments.apps,jobs.batch,rollouts.argoproj.io",
      "--namespace",
      "production",
      "--selector",
      "app.kubernetes.io/instance=proof",
      "--output",
      "json",
    ]);
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
      rollouts: [],
      jobs: ["proof-chase-sets-platform-platform-bootstrap"],
    });
    expect(platformKubernetesWorkloads({ values: sampleValues, release: "proof", rolloutsEnabled: true })).toEqual({
      deployments: ["proof-chase-sets-platform-platform-worker"],
      rollouts: ["proof-chase-sets-platform-public-web", "proof-chase-sets-platform-marketplace"],
      jobs: ["proof-chase-sets-platform-platform-bootstrap"],
    });
  });

  it("pins KEDA to the worker deployment and keeps the scaler opt-in to staging", () => {
    const chartValues = readFileSync("infrastructure/helm/platform/values.yaml", "utf8");
    const stagingValues = readFileSync("infrastructure/helm/platform/values.staging.yaml", "utf8");
    const scaledObjectTemplate = readFileSync("infrastructure/helm/platform/templates/scaledobject.yaml", "utf8");

    const baseWorker = chartValues.slice(chartValues.indexOf("  platform-worker:"));
    expect(baseWorker).toContain("autoscaling:");
    expect(baseWorker).toContain("enabled: false");
    expect(stagingValues).toContain("  platform-worker:");
    expect(stagingValues).toContain("    autoscaling:");
    expect(stagingValues).toContain("      enabled: true");
    expect(stagingValues).toContain('connectionFromEnv: "PLATFORM_WORK_SIGNAL_DATABASE_URL"');
    expect(stagingValues).toContain("platform_projection_wake_intents");
    expect(stagingValues).toContain("state IN ('queued', 'failed')");

    expect(scaledObjectTemplate).toContain("apiVersion: keda.sh/v1alpha1");
    expect(scaledObjectTemplate).toContain("kind: ScaledObject");
    expect(scaledObjectTemplate).toContain("scaleTargetRef:");
    expect(scaledObjectTemplate).toContain('name: {{ include "chase-sets-platform.componentName"');
    expect(scaledObjectTemplate).toContain("minReplicaCount:");
    expect(scaledObjectTemplate).toContain("maxReplicaCount:");
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

  it("holds enabled Argo Rollouts after analysis, then promotes or aborts through the official plugin", async () => {
    const rolloutValues = { ...sampleValues };
    const deployCalls = [];
    await deployPlatformToKubernetes({
      values: rolloutValues,
      rolloutsEnabled: true,
      release: "proof",
      namespace: "staging",
      timeout: "30s",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
      spawn: completedSpawn(deployCalls, [
        { code: 0 },
        { code: 0 },
        { code: 0, stdout: '{"status":{"phase":"Paused"}}' },
        { code: 0, stdout: '{"status":{"phase":"Paused"}}' },
      ]),
    });
    expect(deployCalls.map((call) => call.args.slice(0, 2))).toEqual([
      ["upgrade", "--install"],
      ["rollout", "status"],
      ["get", "rollout/proof-chase-sets-platform-public-web"],
      ["get", "rollout/proof-chase-sets-platform-marketplace"],
    ]);

    const promoteCalls = [];
    await promotePlatformRollouts({
      values: rolloutValues,
      rolloutsEnabled: true,
      release: "proof",
      namespace: "staging",
      timeout: "30s",
      spawn: completedSpawn(promoteCalls, [
        { code: 0 },
        { code: 0 },
        { code: 0, stdout: '{"status":{"phase":"Healthy"}}' },
        { code: 0, stdout: '{"status":{"phase":"Healthy"}}' },
      ]),
    });
    expect(promoteCalls.filter((call) => call.args[0] === "argo").map((call) => call.args[2])).toEqual([
      "promote",
      "promote",
    ]);

    const abortCalls = [];
    await abortPlatformRollouts({
      values: rolloutValues,
      rolloutsEnabled: true,
      release: "proof",
      namespace: "staging",
      spawn: successfulSpawn(abortCalls),
    });
    expect(abortCalls.map((call) => call.args[2])).toEqual(["abort", "abort"]);
  });

  it("rolls back with Helm and reuses rollout status waits", async () => {
    const calls = [];
    const before = [
      { revision: 3, status: "superseded", description: "Upgrade complete" },
      { revision: 4, status: "failed", description: "Upgrade failed" },
    ];
    const after = [...before, { revision: 5, status: "deployed", description: "Rollback to 3" }];
    const result = await rollbackPlatformOnKubernetes({
      values: rollbackValues,
      release: "proof",
      namespace: "staging",
      timeout: "30s",
      revision: "3",
      spawn: completedSpawn(calls, [
        { code: 0, stdout: '{"name":"proof"}' },
        { code: 0, stdout: helmHistory(before) },
        { code: 0, stdout: JSON.stringify(rollbackValues) },
        { code: 0, stdout: helmHistory(before) },
        { code: 0 },
        { code: 0 },
        { code: 0, stdout: helmHistory(after) },
        { code: 0, stdout: JSON.stringify(rollbackValues) },
        { code: 0, stdout: rollbackWorkloadList() },
        { code: 0, stdout: helmHistory(after) },
      ]),
    });

    expect(result).toMatchObject({
      result: "success",
      rollbackIdentity: {
        sourceRevision: 3,
        resultingRevision: 5,
        observedTag: rollbackTag,
        observedDigest: rollbackDigest,
      },
    });
    expect(calls[0]).toMatchObject({
      command: "helm",
      args: ["status", "proof", "--namespace", "staging"],
    });
    expect(calls.find((call) => call.args[0] === "rollback")).toMatchObject({
      command: "helm",
      args: ["rollback", "proof", "3", "--namespace", "staging", "--wait", "--timeout", "30s"],
    });
  });

  it("ignores a retained failed Helm hook Job while binding recovery to the captured successful LKG revision", async () => {
    const captureCalls = [];
    const capturedHistory = [{ revision: 228, status: "deployed", description: "Upgrade complete" }];
    const target = await captureKubernetesRollbackTarget({
      values: rollbackValues,
      release: "proof",
      namespace: "production",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: rollbackDigest,
      lastKnownGoodCommit: rollbackTag,
      releaseTag: "release-20260727120000-c0bd688d",
      checkedAt: "2026-07-27T12:00:00.000Z",
      spawn: completedSpawn(captureCalls, [
        { code: 0, stdout: helmHistory(capturedHistory) },
        { code: 0, stdout: JSON.stringify(rollbackValues) },
        { code: 0, stdout: rollbackWorkloadList() },
        { code: 0, stdout: helmHistory(capturedHistory) },
      ]),
    });
    expect(target).toMatchObject({
      schemaVersion: "platform-kubernetes-rollback-target/v2",
      sourceRevision: 228,
      sourceStatus: "deployed",
      observedTag: rollbackTag,
      observedDigest: rollbackDigest,
      imageIdentityProof: {
        kind: "exact-digest",
        digest: rollbackDigest,
      },
      workloadIdentities: [{ kind: "Deployment", component: "platform-worker" }],
    });

    const beforeExternalRollback = [
      { revision: 228, status: "superseded", description: "Upgrade complete" },
      { revision: 229, status: "failed", description: "Upgrade failed" },
      { revision: 230, status: "failed", description: "Rollback to 228" },
    ];
    const afterExternalRollback = [
      ...beforeExternalRollback,
      { revision: 231, status: "deployed", description: "Rollback to 228" },
    ];
    const rollbackCalls = [];
    const result = await rollbackPlatformOnKubernetes({
      values: rollbackValues,
      release: "proof",
      namespace: "production",
      timeout: "30s",
      revision: "228",
      rollbackTarget: target,
      spawn: completedSpawn(rollbackCalls, [
        { code: 0, stdout: '{"name":"proof"}' },
        { code: 0, stdout: helmHistory(beforeExternalRollback) },
        { code: 0, stdout: JSON.stringify(rollbackValues) },
        { code: 0, stdout: helmHistory(beforeExternalRollback) },
        { code: 0 },
        { code: 0 },
        { code: 0, stdout: helmHistory(afterExternalRollback) },
        { code: 0, stdout: JSON.stringify(rollbackValues) },
        { code: 0, stdout: rollbackWorkloadList() },
        { code: 0, stdout: helmHistory(afterExternalRollback) },
      ]),
    });

    expect(result).toMatchObject({
      result: "success",
      rollbackIdentity: {
        sourceRevision: 228,
        resultingRevision: 231,
        observedTag: rollbackTag,
        observedDigest: rollbackDigest,
        workloadIdentities: [{ kind: "Deployment", component: "platform-worker" }],
      },
    });
    const helmRollback = rollbackCalls.find((call) => call.command === "helm" && call.args[0] === "rollback");
    expect(helmRollback.args).toEqual([
      "rollback",
      "proof",
      "228",
      "--namespace",
      "production",
      "--wait",
      "--timeout",
      "30s",
    ]);
    expect(helmRollback.args).not.toContain("229");
  });

  it("captures an ordinary deployed head unchanged", async () => {
    const history = [{ revision: 700, status: "deployed", description: "Synthetic upgrade complete" }];
    const target = await captureKubernetesRollbackTarget({
      values: rollbackValues,
      release: "proof",
      namespace: "production",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: rollbackDigest,
      lastKnownGoodCommit: rollbackTag,
      releaseTag: "release-synthetic-proof",
      spawn: completedSpawn(
        [],
        [
          { code: 0, stdout: helmHistory(history) },
          { code: 0, stdout: JSON.stringify(rollbackValues) },
          { code: 0, stdout: rollbackWorkloadList() },
          { code: 0, stdout: helmHistory(history) },
        ],
      ),
    });

    expect(target).toMatchObject({
      sourceRevision: 700,
      sourceStatus: "deployed",
      sourceDescription: "Synthetic upgrade complete",
      historyHeadRevision: 700,
      terminalFailedSuffix: [],
      preDeployHistory: history,
    });
  });

  it("captures a deployed source behind only failed history", async () => {
    const history = [
      { revision: 700, status: "deployed", description: "Synthetic upgrade complete" },
      { revision: 701, status: "failed", description: "Synthetic hook failure" },
    ];
    const target = await captureKubernetesRollbackTarget({
      values: rollbackValues,
      release: "proof",
      namespace: "production",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: rollbackDigest,
      lastKnownGoodCommit: rollbackTag,
      releaseTag: "release-synthetic-proof",
      spawn: completedSpawn(
        [],
        [
          { code: 0, stdout: helmHistory(history) },
          { code: 0, stdout: JSON.stringify(rollbackValues) },
          { code: 0, stdout: rollbackWorkloadList() },
          { code: 0, stdout: helmHistory(history) },
        ],
      ),
    });

    expect(target).toMatchObject({
      sourceRevision: 700,
      sourceStatus: "deployed",
      sourceDescription: "Synthetic upgrade complete",
      historyHeadRevision: 701,
      terminalFailedSuffix: [history[1]],
      preDeployHistory: history,
    });
  });

  it.each([
    ["superseded"],
    ["uninstalled"],
    ["uninstalling"],
    ["pending-install"],
    ["pending-upgrade"],
    ["pending-rollback"],
    ["unknown"],
    ["failed-hook"],
  ])("refuses every non-terminal or ambiguous Helm history status: %s", (status) => {
    expect(() =>
      selectStableDeployedHelmSource([
        { revision: 700, status: "deployed", description: "Synthetic source" },
        { revision: 701, status, description: "Synthetic refusal" },
      ]),
    ).toThrow(`status "${status}"`);
  });

  it("refuses zero or multiple deployed revisions and admits unknown history strictly before the source", () => {
    expect(() =>
      selectStableDeployedHelmSource([{ revision: 700, status: "failed", description: "Synthetic failure" }]),
    ).toThrow("observed 0");
    expect(() =>
      selectStableDeployedHelmSource([
        { revision: 700, status: "deployed", description: "Synthetic first source" },
        { revision: 701, status: "deployed", description: "Synthetic later source" },
      ]),
    ).toThrow("observed 2");
    expect(
      selectStableDeployedHelmSource([
        { revision: 698, status: "unknown-old-status", description: "Synthetic retained history" },
        { revision: 700, status: "deployed", description: "Synthetic source" },
        { revision: 701, status: "failed", description: "Synthetic failure" },
      ]).source.revision,
    ).toBe(700);
  });

  it("admits a failed suffix from raw Helm history output", async () => {
    const rawHistory = [
      { revision: "705", status: " FAILED ", description: " Synthetic failure " },
      { revision: "700", status: " DEPLOYED ", description: " Synthetic source " },
      { revision: "690", status: " UNRECOGNIZED-OLD ", description: " Synthetic old history " },
    ];
    const normalizedHistory = [
      { revision: 690, status: "unrecognized-old", description: "Synthetic old history" },
      { revision: 700, status: "deployed", description: "Synthetic source" },
      { revision: 705, status: "failed", description: "Synthetic failure" },
    ];
    const target = await captureKubernetesRollbackTarget({
      values: rollbackValues,
      release: "proof",
      namespace: "production",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: rollbackDigest,
      lastKnownGoodCommit: rollbackTag,
      releaseTag: "release-synthetic-proof",
      spawn: completedSpawn(
        [],
        [
          { code: 0, stdout: helmHistory(rawHistory) },
          { code: 0, stdout: JSON.stringify(rollbackValues) },
          { code: 0, stdout: rollbackWorkloadList() },
          { code: 0, stdout: helmHistory(rawHistory) },
        ],
      ),
    });
    expect(target.preDeployHistory).toEqual(normalizedHistory);

    for (const invalidHistory of [
      [{ revision: 700, status: " ", description: "Synthetic blank" }],
      [
        { revision: 700, status: "deployed", description: "Synthetic source" },
        { revision: 700, status: "failed", description: "Synthetic duplicate" },
      ],
    ]) {
      await expect(
        captureKubernetesRollbackTarget({
          registryName: "chase-sets",
          repository: "chase-sets-platform",
          tag: rollbackTag,
          digest: rollbackDigest,
          lastKnownGoodCommit: rollbackTag,
          releaseTag: "release-synthetic-proof",
          spawn: completedSpawn([], [{ code: 0, stdout: helmHistory(invalidHistory) }]),
        }),
      ).rejects.toThrow(/required|duplicate revisions/);
    }
  });

  it("keeps every identity and stability proof on a failed-suffix capture", async () => {
    const history = [
      { revision: 700, status: "deployed", description: "Synthetic source" },
      { revision: 701, status: "failed", description: "Synthetic failure" },
    ];
    const baseOptions = {
      values: rollbackValues,
      release: "proof",
      namespace: "production",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: rollbackDigest,
      lastKnownGoodCommit: rollbackTag,
      releaseTag: "release-synthetic-proof",
    };
    const calls = [];
    await captureKubernetesRollbackTarget({
      ...baseOptions,
      spawn: completedSpawn(calls, [
        { code: 0, stdout: helmHistory(history) },
        { code: 0, stdout: JSON.stringify(rollbackValues) },
        { code: 0, stdout: rollbackWorkloadList() },
        { code: 0, stdout: helmHistory(history) },
      ]),
    });
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["helm", "history"],
      ["helm", "get"],
      ["kubectl", "get"],
      ["helm", "history"],
    ]);
    expect(calls[1].args).toContain("700");

    await expect(
      captureKubernetesRollbackTarget({ ...baseOptions, tag: "f".repeat(40), spawn: completedSpawn([], []) }),
    ).rejects.toThrow("must equal lastKnownGoodCommit");

    const wrongValues = structuredClone(rollbackValues);
    wrongValues.global.image.digest = `sha256:${"4".repeat(64)}`;
    await expect(
      captureKubernetesRollbackTarget({
        ...baseOptions,
        spawn: completedSpawn(
          [],
          [
            { code: 0, stdout: helmHistory(history) },
            { code: 0, stdout: JSON.stringify(wrongValues) },
          ],
        ),
      }),
    ).rejects.toThrow("platform is required");

    await expect(
      captureKubernetesRollbackTarget({
        ...baseOptions,
        spawn: completedSpawn(
          [],
          [
            { code: 0, stdout: helmHistory(history) },
            { code: 0, stdout: JSON.stringify(rollbackValues) },
            { code: 0, stdout: '{"items":[]}' },
          ],
        ),
      }),
    ).rejects.toThrow("does not match the Helm revision");

    await expect(
      captureKubernetesRollbackTarget({
        ...baseOptions,
        spawn: completedSpawn(
          [],
          [
            { code: 0, stdout: helmHistory(history) },
            { code: 0, stdout: JSON.stringify(rollbackValues) },
            { code: 0, stdout: rollbackWorkloadList() },
            {
              code: 0,
              stdout: helmHistory([...history, { revision: 702, status: "failed", description: "Synthetic drift" }]),
            },
          ],
        ),
      }),
    ).rejects.toThrow("Helm history moved during rollback target capture");
  });

  it("records the observed head, failed suffix, and pre-deploy history without changing the rollback target contract", async () => {
    const history = [
      { revision: 700, status: "deployed", description: "Synthetic source" },
      { revision: 701, status: "failed", description: "Synthetic failure" },
    ];
    const target = await captureKubernetesRollbackTarget({
      values: rollbackValues,
      release: "proof",
      namespace: "production",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: rollbackDigest,
      lastKnownGoodCommit: rollbackTag,
      releaseTag: "release-synthetic-proof",
      checkedAt: "2026-08-25T20:00:00.000Z",
      spawn: completedSpawn(
        [],
        [
          { code: 0, stdout: helmHistory(history) },
          { code: 0, stdout: JSON.stringify(rollbackValues) },
          { code: 0, stdout: rollbackWorkloadList() },
          { code: 0, stdout: helmHistory(history) },
        ],
      ),
    });

    expect(target).toEqual({
      schemaVersion: "platform-kubernetes-rollback-target/v2",
      capturedAt: "2026-08-25T20:00:00.000Z",
      release: "proof",
      namespace: "production",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: rollbackDigest,
      imageRef: rollbackImageRef,
      componentNames: ["proof-chase-sets-platform-platform-bootstrap", "proof-chase-sets-platform-platform-worker"],
      lastKnownGoodCommit: rollbackTag,
      releaseTag: "release-synthetic-proof",
      sourceRevision: 700,
      sourceStatus: "deployed",
      sourceDescription: "Synthetic source",
      observedTag: rollbackTag,
      observedDigest: rollbackDigest,
      imageIdentityProof: { kind: "exact-digest", digest: rollbackDigest },
      workloadIdentities: [
        {
          kind: "Deployment",
          name: "proof-chase-sets-platform-platform-worker",
          component: "platform-worker",
          images: [
            {
              container: "platform-worker",
              containerType: "application",
              image: rollbackImageRef,
            },
          ],
        },
      ],
      historyHeadRevision: 701,
      terminalFailedSuffix: [history[1]],
      preDeployHistory: history,
    });
  });

  it("verifies one exact deployed Helm transition", async () => {
    const capturedHistory = [
      { revision: 700, status: "deployed", description: "Synthetic source" },
      { revision: 701, status: "failed", description: "Synthetic failure" },
    ];
    const observedHistory = [
      ...capturedHistory,
      { revision: 702, status: "deployed", description: "Synthetic upgrade complete" },
    ];
    const transition = await verifyKubernetesDeploymentTransition({
      release: "proof",
      namespace: "production",
      checkedAt: "2026-08-25T20:10:00.000Z",
      rollbackTarget: {
        schemaVersion: "platform-kubernetes-rollback-target/v2",
        sourceRevision: 700,
        sourceStatus: "deployed",
        historyHeadRevision: 701,
        terminalFailedSuffix: [capturedHistory[1]],
        preDeployHistory: capturedHistory,
      },
      spawn: completedSpawn([], [{ code: 0, stdout: helmHistory(observedHistory) }]),
    });

    expect(transition).toEqual({
      schemaVersion: "platform-kubernetes-deployment-transition/v1",
      checkedAt: "2026-08-25T20:10:00.000Z",
      release: "proof",
      namespace: "production",
      capturedHeadRevision: 701,
      resultingHeadRevision: 702,
      capturedHistory,
      observedHistory,
    });
  });

  it.each([
    {
      name: "missing revision",
      observed: [
        { revision: 700, status: "deployed", description: "Synthetic source" },
        { revision: 701, status: "failed", description: "Synthetic failure" },
      ],
      message: "exactly one new Helm revision; observed 0",
    },
    {
      name: "extra revisions",
      observed: [
        { revision: 700, status: "deployed", description: "Synthetic source" },
        { revision: 701, status: "failed", description: "Synthetic failure" },
        { revision: 702, status: "superseded", description: "Synthetic first result" },
        { revision: 703, status: "deployed", description: "Synthetic second result" },
      ],
      message: "exactly one new Helm revision; observed 2",
    },
    {
      name: "nonconsecutive revision",
      observed: [
        { revision: 700, status: "deployed", description: "Synthetic source" },
        { revision: 701, status: "failed", description: "Synthetic failure" },
        { revision: 703, status: "deployed", description: "Synthetic gap" },
      ],
      message: "requires resulting Helm revision 702; observed 703",
    },
    {
      name: "non-deployed result",
      observed: [
        { revision: 700, status: "deployed", description: "Synthetic source" },
        { revision: 701, status: "failed", description: "Synthetic failure" },
        { revision: 702, status: "failed", description: "Synthetic result failure" },
      ],
      message: 'status "deployed"; observed "failed"',
    },
  ])("refuses a $name deployment transition", async ({ observed, message }) => {
    await expect(
      verifyKubernetesDeploymentTransition({
        rollbackTarget: {
          schemaVersion: "platform-kubernetes-rollback-target/v2",
          sourceRevision: 700,
          sourceStatus: "deployed",
          historyHeadRevision: 701,
          terminalFailedSuffix: [{ revision: 701, status: "failed", description: "Synthetic failure" }],
          preDeployHistory: [
            { revision: 700, status: "deployed", description: "Synthetic source" },
            { revision: 701, status: "failed", description: "Synthetic failure" },
          ],
        },
        spawn: completedSpawn([], [{ code: 0, stdout: helmHistory(observed) }]),
      }),
    ).rejects.toThrow(message);
  });

  it("parses the read-only deployment transition verifier command", () => {
    expect(
      parseArgs(
        [
          "verify-deployment-transition",
          "--rollback-target=artifacts/release-health/production-rollback-target.json",
          "--out=artifacts/release-health/production-kubernetes-deployment-transition.json",
        ],
        {},
      ),
    ).toMatchObject({
      command: "verify-deployment-transition",
      rollbackTargetPath: "artifacts/release-health/production-rollback-target.json",
      outPath: "artifacts/release-health/production-kubernetes-deployment-transition.json",
    });
  });

  it("accepts the production index digest and amd64 manifest digest only when the manifest is a platform member", () => {
    expect(
      assertOciIndexPlatformManifestMembership({
        index: productionIndex,
        indexDigest: rollbackIndexDigest,
        manifestDigest: rollbackDigest,
        platform: "linux/amd64",
        label: "Helm revision 232",
      }),
    ).toEqual({
      kind: "oci-index-platform-member",
      indexDigest: rollbackIndexDigest,
      platform: "linux/amd64",
      manifestDigest: rollbackDigest,
    });

    expect(() =>
      assertOciIndexPlatformManifestMembership({
        index: productionIndex,
        indexDigest: rollbackIndexDigest,
        manifestDigest: `sha256:${"3".repeat(64)}`,
        platform: "linux/amd64",
        label: "Helm revision 232",
      }),
    ).toThrow("is not the linux/amd64 manifest");
  });

  it.each([
    {
      observedCount: 2,
      index: {
        ...productionIndex,
        manifests: [
          productionIndex.manifests[0],
          {
            ...productionIndex.manifests[0],
            digest: failedCandidateDigest,
          },
        ],
      },
    },
    {
      observedCount: 0,
      index: {
        ...productionIndex,
        manifests: productionIndex.manifests.map((descriptor) => ({
          ...descriptor,
          platform: { os: "linux", architecture: "arm64" },
        })),
      },
    },
  ])("rejects an OCI index with $observedCount linux/amd64 members", ({ index, observedCount }) => {
    expect(() =>
      assertOciIndexPlatformManifestMembership({
        index,
        indexDigest: rollbackIndexDigest,
        manifestDigest: rollbackDigest,
        platform: "linux/amd64",
      }),
    ).toThrowError(
      new Error(
        `Captured OCI index ${rollbackIndexDigest} must contain exactly one linux/amd64 manifest; observed ${observedCount}.`,
      ),
    );
  });

  it("rejects a linux/amd64 index descriptor instead of treating it as an image manifest", () => {
    const nestedIndex = {
      ...productionIndex,
      manifests: [
        {
          ...productionIndex.manifests[0],
          mediaType: "application/vnd.oci.image.index.v1+json",
        },
      ],
    };

    expect(() =>
      assertOciIndexPlatformManifestMembership({
        index: nestedIndex,
        indexDigest: rollbackIndexDigest,
        manifestDigest: rollbackDigest,
        platform: "linux/amd64",
      }),
    ).toThrowError(
      new Error(
        `Captured OCI index ${rollbackIndexDigest} linux/amd64 member mediaType "application/vnd.oci.image.index.v1+json" is not an image manifest.`,
      ),
    );
  });

  it("parses the OCI index evidence required by the capture command", () => {
    expect(
      parseArgs(
        [
          "capture-rollback-target",
          `--digest=${rollbackIndexDigest}`,
          "--index-manifest=artifacts/production-rollback-index.json",
          "--platform=linux/amd64",
        ],
        {},
      ),
    ).toMatchObject({
      command: "capture-rollback-target",
      digest: rollbackIndexDigest,
      indexManifestPath: "artifacts/production-rollback-index.json",
      platform: "linux/amd64",
    });
  });

  it("cryptographically binds an index to its digest before accepting its production platform manifest", async () => {
    const rawIndex = JSON.stringify(productionIndex);
    const capturedIndexDigest = `sha256:${createHash("sha256").update(rawIndex).digest("hex")}`;
    const capturedHistory = [{ revision: 232, status: "deployed", description: "Upgrade complete" }];
    const target = await captureKubernetesRollbackTarget({
      release: "proof",
      namespace: "production",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: capturedIndexDigest,
      indexManifest: rawIndex,
      platform: "linux/amd64",
      lastKnownGoodCommit: rollbackTag,
      releaseTag: "release-20260728185747-c0bd688d",
      spawn: completedSpawn(
        [],
        [
          { code: 0, stdout: helmHistory(capturedHistory) },
          { code: 0, stdout: JSON.stringify(rollbackValues) },
          { code: 0, stdout: rollbackWorkloadList() },
          { code: 0, stdout: helmHistory(capturedHistory) },
        ],
      ),
    });

    expect(target).toMatchObject({
      sourceRevision: 232,
      digest: rollbackDigest,
      observedDigest: rollbackDigest,
      imageIdentityProof: {
        kind: "oci-index-platform-member",
        indexDigest: capturedIndexDigest,
        platform: "linux/amd64",
        manifestDigest: rollbackDigest,
      },
    });
  });

  it("rejects one-byte-mutated OCI index bytes when the captured digest remains bound to the clean index", async () => {
    const rawIndex = Buffer.from(JSON.stringify(productionIndex));
    const capturedIndexDigest = `sha256:${createHash("sha256").update(rawIndex).digest("hex")}`;
    const mutatedIndex = Buffer.from(rawIndex);
    const mutationOffset = rawIndex.indexOf("unknown") + "unknow".length;
    mutatedIndex[mutationOffset] = "o".charCodeAt(0);
    const mutatedIndexDigest = `sha256:${createHash("sha256").update(mutatedIndex).digest("hex")}`;
    const capturedHistory = [{ revision: 232, status: "deployed", description: "Upgrade complete" }];

    await expect(
      captureKubernetesRollbackTarget({
        release: "proof",
        namespace: "production",
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        tag: rollbackTag,
        digest: capturedIndexDigest,
        indexManifest: mutatedIndex,
        platform: "linux/amd64",
        lastKnownGoodCommit: rollbackTag,
        releaseTag: "release-20260728185747-c0bd688d",
        spawn: completedSpawn(
          [],
          [
            { code: 0, stdout: helmHistory(capturedHistory) },
            { code: 0, stdout: JSON.stringify(rollbackValues) },
            { code: 0, stdout: rollbackWorkloadList() },
            { code: 0, stdout: helmHistory(capturedHistory) },
          ],
        ),
      }),
    ).rejects.toThrowError(
      new Error(
        `Captured OCI index bytes digest "${mutatedIndexDigest}" does not match captured rollback identity "${capturedIndexDigest}".`,
      ),
    );
  });

  it("blocks a different valid Helm digest even when the captured OCI index bytes are valid", async () => {
    const rawIndex = JSON.stringify(productionIndex);
    const capturedIndexDigest = `sha256:${createHash("sha256").update(rawIndex).digest("hex")}`;
    const mismatchedValues = structuredClone(rollbackValues);
    mismatchedValues.global.image.digest = `sha256:${"3".repeat(64)}`;
    const capturedHistory = [{ revision: 232, status: "deployed", description: "Upgrade complete" }];

    await expect(
      captureKubernetesRollbackTarget({
        release: "proof",
        namespace: "production",
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        tag: rollbackTag,
        digest: capturedIndexDigest,
        indexManifest: rawIndex,
        platform: "linux/amd64",
        lastKnownGoodCommit: rollbackTag,
        releaseTag: "release-20260728185747-c0bd688d",
        spawn: completedSpawn(
          [],
          [
            { code: 0, stdout: helmHistory(capturedHistory) },
            { code: 0, stdout: JSON.stringify(mismatchedValues) },
          ],
        ),
      }),
    ).rejects.toThrow("is not the linux/amd64 manifest");
  });

  it("refuses ambiguous target capture and last-known-good digest disagreement", async () => {
    await expect(
      captureKubernetesRollbackTarget({
        release: "proof",
        namespace: "production",
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        tag: rollbackTag,
        digest: rollbackDigest,
        platform: "linux/amd64",
        lastKnownGoodCommit: rollbackTag,
        releaseTag: "release-proof",
        spawn: completedSpawn(
          [],
          [
            {
              code: 0,
              stdout: helmHistory([
                { revision: 227, status: "deployed", description: "invalid duplicate" },
                { revision: 228, status: "deployed", description: "current" },
              ]),
            },
          ],
        ),
      }),
    ).rejects.toThrow("exactly one deployed Helm revision");

    const mismatchedValues = structuredClone(rollbackValues);
    mismatchedValues.global.image.digest = `sha256:${"3".repeat(64)}`;
    await expect(
      captureKubernetesRollbackTarget({
        release: "proof",
        namespace: "production",
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        tag: rollbackTag,
        digest: rollbackDigest,
        platform: "linux/amd64",
        lastKnownGoodCommit: rollbackTag,
        releaseTag: "release-proof",
        spawn: completedSpawn(
          [],
          [
            {
              code: 0,
              stdout: helmHistory([{ revision: 228, status: "deployed", description: "Upgrade complete" }]),
            },
            { code: 0, stdout: JSON.stringify(mismatchedValues) },
          ],
        ),
      }),
    ).rejects.toThrow("index-manifest is required");
  });

  it.each([
    {
      name: "absent source revision",
      completions: [
        { code: 0, stdout: '{"name":"proof"}' },
        {
          code: 0,
          stdout: helmHistory([{ revision: 229, status: "failed", description: "candidate failed" }]),
        },
      ],
      reason: "revision 228 is absent",
    },
    {
      name: "failed source revision",
      completions: [
        { code: 0, stdout: '{"name":"proof"}' },
        {
          code: 0,
          stdout: helmHistory([{ revision: 228, status: "failed", description: "candidate failed" }]),
        },
      ],
      reason: "not a successful deployed or superseded revision",
    },
    {
      name: "history movement during validation",
      completions: [
        { code: 0, stdout: '{"name":"proof"}' },
        {
          code: 0,
          stdout: helmHistory([
            { revision: 228, status: "superseded", description: "LKG" },
            { revision: 230, status: "failed", description: "atomic rollback failed" },
          ]),
        },
        { code: 0, stdout: JSON.stringify(rollbackValues) },
        {
          code: 0,
          stdout: helmHistory([
            { revision: 228, status: "superseded", description: "LKG" },
            { revision: 230, status: "failed", description: "atomic rollback failed" },
            { revision: 231, status: "pending-upgrade", description: "concurrent movement" },
          ]),
        },
      ],
      reason: "history moved during pre-rollback validation",
    },
  ])("fails closed on $name before invoking Helm rollback", async ({ completions, reason }) => {
    const calls = [];
    const result = await rollbackPlatformOnKubernetes({
      values: rollbackValues,
      release: "proof",
      namespace: "production",
      revision: "228",
      spawn: completedSpawn(calls, completions),
    });

    expect(result.result).toBe("failure");
    expect(result.reason).toContain(reason);
    expect(calls.some((call) => call.command === "helm" && call.args[0] === "rollback")).toBe(false);
  });

  it("waits for Deployments when Helm restores a revision from before Argo activation", async () => {
    const calls = [];
    const historicalValues = {
      ...rollbackValues,
      components: {
        "public-web": { enabled: true, kind: "service", rollout: { enabled: false } },
        marketplace: { enabled: true, kind: "service", rollout: { enabled: false } },
        "platform-worker": { enabled: true, kind: "worker" },
      },
    };
    const before = [{ revision: 3, status: "deployed", description: "Upgrade complete" }];
    const after = [
      { revision: 3, status: "superseded", description: "Upgrade complete" },
      { revision: 4, status: "deployed", description: "Rollback to 3" },
    ];
    const notFound = (name) =>
      `Error from server (NotFound): rollouts.argoproj.io "proof-chase-sets-platform-${name}" not found`;
    const workloadItems = JSON.parse(rollbackWorkloadList()).items;
    for (const component of ["public-web", "marketplace"]) {
      workloadItems.push({
        kind: "Deployment",
        metadata: {
          name: `proof-chase-sets-platform-${component}`,
          labels: { "app.kubernetes.io/instance": "proof", "app.kubernetes.io/component": component },
        },
        spec: { template: { spec: { containers: [{ name: component, image: rollbackImageRef }] } } },
      });
    }
    const result = await rollbackPlatformOnKubernetes({
      values: historicalValues,
      rolloutsEnabled: true,
      release: "proof",
      namespace: "staging",
      timeout: "30s",
      revision: "3",
      spawn: completedSpawn(calls, [
        { code: 0, stdout: '{"name":"proof"}' },
        { code: 0, stdout: helmHistory(before) },
        { code: 0, stdout: JSON.stringify(historicalValues) },
        { code: 0, stdout: helmHistory(before) },
        { code: 0 },
        { code: 0 },
        { code: 1, stderr: notFound("public-web") },
        { code: 0 },
        { code: 1, stderr: notFound("marketplace") },
        { code: 0 },
        { code: 0, stdout: helmHistory(after) },
        { code: 0, stdout: JSON.stringify(historicalValues) },
        { code: 0, stdout: JSON.stringify({ apiVersion: "v1", kind: "List", items: workloadItems }) },
        { code: 0, stdout: helmHistory(after) },
      ]),
    });

    expect(result.result).toBe("success");
    expect(calls.filter((call) => call.args[0] === "rollout" && call.args[1] === "status")).toHaveLength(3);
    expect(calls.filter((call) => call.args[0] === "get" && call.args[1]?.startsWith("rollout/"))).toHaveLength(2);
  });

  it("records rollback command failures as a separate failure outcome", async () => {
    const calls = [];
    const result = await rollbackPlatformOnKubernetes({
      values: sampleValues,
      release: "proof",
      namespace: "production",
      timeout: "30s",
      revision: "3",
      spawn: completedSpawn(calls, [
        { code: 0, stdout: '{"name":"proof"}' },
        {
          code: 0,
          stdout: helmHistory([{ revision: 3, status: "deployed", description: "Upgrade complete" }]),
        },
        { code: 0, stdout: JSON.stringify(rollbackValues) },
        {
          code: 0,
          stdout: helmHistory([{ revision: 3, status: "deployed", description: "Upgrade complete" }]),
        },
        { code: 1, stderr: "rollback timed out" },
      ]),
    });

    expect(result).toMatchObject({
      action: "rollback",
      result: "failure",
      release: "proof",
      namespace: "production",
    });
    expect(result.reason).toContain("helm rollback proof");
    expect(calls).toHaveLength(5);
  });

  it("keeps readiness failure blocking after an exact-revision rollback command succeeds", async () => {
    const history = [{ revision: 3, status: "deployed", description: "Upgrade complete" }];
    const result = await rollbackPlatformOnKubernetes({
      values: rollbackValues,
      release: "proof",
      namespace: "production",
      timeout: "30s",
      revision: "3",
      spawn: completedSpawn(
        [],
        [
          { code: 0, stdout: '{"name":"proof"}' },
          { code: 0, stdout: helmHistory(history) },
          { code: 0, stdout: JSON.stringify(rollbackValues) },
          { code: 0, stdout: helmHistory(history) },
          { code: 0 },
          { code: 1, stderr: "deployment exceeded its progress deadline" },
        ],
      ),
    });

    expect(result).toMatchObject({
      result: "failure",
      rollbackIdentity: { sourceRevision: 3, resultingRevision: null },
    });
    expect(result.reason).toContain("kubectl rollout status deployment/proof-chase-sets-platform-platform-worker");
  });

  it("rejects ready workloads that still run the failed candidate digest", async () => {
    const before = [{ revision: 3, status: "deployed", description: "Upgrade complete" }];
    const after = [
      { revision: 3, status: "superseded", description: "Upgrade complete" },
      { revision: 4, status: "deployed", description: "Rollback to 3" },
    ];
    const result = await rollbackPlatformOnKubernetes({
      values: rollbackValues,
      release: "proof",
      namespace: "production",
      timeout: "30s",
      revision: "3",
      spawn: completedSpawn(
        [],
        [
          { code: 0, stdout: '{"name":"proof"}' },
          { code: 0, stdout: helmHistory(before) },
          { code: 0, stdout: JSON.stringify(rollbackValues) },
          { code: 0, stdout: helmHistory(before) },
          { code: 0 },
          { code: 0 },
          { code: 0, stdout: helmHistory(after) },
          { code: 0, stdout: JSON.stringify(rollbackValues) },
          {
            code: 0,
            stdout: rollbackWorkloadList(
              `registry.digitalocean.com/chase-sets/chase-sets-platform@${failedCandidateDigest}`,
            ),
          },
        ],
      ),
    });

    expect(result).toMatchObject({
      result: "failure",
      rollbackIdentity: { sourceRevision: 3, resultingRevision: 4 },
    });
    expect(result.reason).toContain("does not match");
    expect(result.reason).toContain(rollbackDigest);
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

  it("builds Helm uninstall, namespace delete, and namespace get arguments", () => {
    expect(
      buildHelmUninstallArgs({ release: "chase-sets-pr-42", namespace: "chase-sets-pr-42", timeout: "5m" }),
    ).toEqual(["uninstall", "chase-sets-pr-42", "--namespace", "chase-sets-pr-42", "--wait", "--timeout", "5m"]);
    expect(buildNamespaceDeleteArgs({ namespace: "chase-sets-pr-42", timeout: "5m" })).toEqual([
      "delete",
      "namespace",
      "chase-sets-pr-42",
      "--ignore-not-found",
      "--wait=true",
      "--timeout=5m",
    ]);
    expect(buildNamespaceGetArgs({ namespace: "chase-sets-pr-42" })).toEqual([
      "get",
      "namespace",
      "chase-sets-pr-42",
      "--output",
      "name",
    ]);
  });

  it("tears down a preview namespace by uninstalling the Helm release then deleting the namespace", async () => {
    const calls = [];
    const result = await teardownPlatformKubernetesNamespace({
      release: "chase-sets-pr-42",
      namespace: "chase-sets-pr-42",
      timeout: "5m",
      spawn: completedSpawn(calls, [
        { code: 0, stdout: '{"name":"chase-sets-pr-42"}' }, // helm status
        { code: 0 }, // helm uninstall
        { code: 0 }, // kubectl delete namespace
        { code: 1, stderr: 'Error from server (NotFound): namespaces "chase-sets-pr-42" not found' }, // kubectl get namespace
      ]),
    });

    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["helm", "status"],
      ["helm", "uninstall"],
      ["kubectl", "delete"],
      ["kubectl", "get"],
    ]);
    expect(result).toMatchObject({
      action: "teardown",
      release: "chase-sets-pr-42",
      namespace: "chase-sets-pr-42",
      result: "success",
      releaseUninstalled: true,
    });
  });

  it("tears down a preview namespace without uninstalling a Helm release that never deployed", async () => {
    const calls = [];
    const result = await teardownPlatformKubernetesNamespace({
      release: "chase-sets-pr-43",
      namespace: "chase-sets-pr-43",
      timeout: "5m",
      spawn: completedSpawn(calls, [
        { code: 1, stderr: "Error: release: not found" }, // helm status
        { code: 0 }, // kubectl delete namespace
        { code: 1, stderr: 'Error from server (NotFound): namespaces "chase-sets-pr-43" not found' }, // kubectl get namespace
      ]),
    });

    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["helm", "status"],
      ["kubectl", "delete"],
      ["kubectl", "get"],
    ]);
    expect(result).toMatchObject({ result: "success", releaseUninstalled: false });
  });

  it("fails a teardown run instead of reporting success when the namespace survives the delete", async () => {
    await expect(
      teardownPlatformKubernetesNamespace({
        release: "chase-sets-pr-44",
        namespace: "chase-sets-pr-44",
        timeout: "5m",
        spawn: completedSpawn(
          [],
          [
            { code: 1, stderr: "Error: release: not found" }, // helm status
            { code: 0 }, // kubectl delete namespace
            { code: 0, stdout: "namespace/chase-sets-pr-44" }, // kubectl get namespace: still present
          ],
        ),
      }),
    ).rejects.toThrow("Namespace chase-sets-pr-44 still exists after kubectl delete namespace completed");
  });

  it("tears down any namespace inside the chase-sets-verify- prefix", async () => {
    const calls = [];
    const result = await teardownPlatformKubernetesNamespace({
      release: "csv-manual-proof",
      namespace: "chase-sets-verify-manual-proof",
      timeout: "5m",
      spawn: completedSpawn(calls, [
        { code: 0, stdout: '{"name":"csv-manual-proof"}' }, // helm status
        { code: 0 }, // helm uninstall
        { code: 0 }, // kubectl delete namespace
        { code: 1, stderr: 'Error from server (NotFound): namespaces "chase-sets-verify-manual-proof" not found' }, // kubectl get namespace
      ]),
    });

    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ["helm", "status"],
      ["helm", "uninstall"],
      ["kubectl", "delete"],
      ["kubectl", "get"],
    ]);
    expect(result).toMatchObject({
      action: "teardown",
      release: "csv-manual-proof",
      namespace: "chase-sets-verify-manual-proof",
      result: "success",
      releaseUninstalled: true,
    });
  });

  it("idempotently succeeds tearing down an already-absent verification namespace", async () => {
    const result = await teardownPlatformKubernetesNamespace({
      release: "csv-100-2",
      namespace: "chase-sets-verify-100-2",
      timeout: "5m",
      spawn: completedSpawn(
        [],
        [
          { code: 1, stderr: "Error: release: not found" }, // helm status
          { code: 0 }, // kubectl delete namespace (already gone: no-op)
          { code: 1, stderr: 'Error from server (NotFound): namespaces "chase-sets-verify-100-2" not found' }, // kubectl get namespace
        ],
      ),
    });

    expect(result).toMatchObject({ result: "success", releaseUninstalled: false });
  });

  it("tears down a merge-gate namespace inside the bounded chase-sets-gate-<run>-<attempt> shape", async () => {
    const calls = [];
    const result = await teardownPlatformKubernetesNamespace({
      release: "csg-1234-1",
      namespace: "chase-sets-gate-1234-1",
      timeout: "5m",
      spawn: completedSpawn(calls, [
        { code: 0, stdout: '{"name":"csg-1234-1"}' }, // helm status
        { code: 0 }, // helm uninstall
        { code: 0 }, // kubectl delete namespace
        { code: 1, stderr: 'Error from server (NotFound): namespaces "chase-sets-gate-1234-1" not found' }, // kubectl get namespace
      ]),
    });

    expect(result).toMatchObject({
      action: "teardown",
      namespace: "chase-sets-gate-1234-1",
      result: "success",
      releaseUninstalled: true,
    });
  });

  it("refuses to tear down namespaces that are neither preview nor verification kinds", async () => {
    for (const namespace of [
      "chase-sets-platform", // production/staging default
      "staging",
      "production",
      "kube-system",
      "chase-sets-verify-", // missing run/attempt
      "other-chase-sets-verify-abc-1", // prefix appears away from the start
      "chase-sets-pr-", // missing number
      "chase-sets-pr-verify-1-1", // hybrid that matches neither exact kind
      "chase-sets-gate-", // gate kind missing run/attempt
      "chase-sets-gate-1234", // gate kind missing attempt
      "chase-sets-gate-abc-1", // gate run identity must be numeric
      "other-chase-sets-gate-1-1", // gate prefix appears away from the start
      "chase-sets-gate-1-1-fixture", // trailing suffix breaks the bounded shape
      "",
    ]) {
      await expect(
        teardownPlatformKubernetesNamespace({
          release: "chase-sets-platform",
          namespace,
          timeout: "5m",
          spawn: successfulSpawn([]),
        }),
      ).rejects.toThrow(/Refusing to tear down non-disposable namespace|namespace is required/);
    }
  });

  it("builds kubectl diagnostics from Kubernetes state", () => {
    const commands = buildDiagnosticsCommands({
      values: sampleValues,
      release: "proof",
      namespace: "staging",
      tailLines: 50,
    });

    expect(commands.slice(0, 5)).toEqual([
      [
        "kubectl",
        ["get", "pods", "--namespace", "staging", "--sort-by=.metadata.creationTimestamp", "--output", "wide"],
      ],
      ["kubectl", ["get", "jobs", "--namespace", "staging", "--sort-by=.metadata.creationTimestamp"]],
      ["kubectl", ["get", "deployments", "--namespace", "staging", "--sort-by=.metadata.creationTimestamp"]],
      ["kubectl", ["get", "rollouts,analysisruns", "--namespace", "staging", "--sort-by=.metadata.creationTimestamp"]],
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

  it("builds release-health-friendly Kubernetes rollback targets", () => {
    expect(
      buildKubernetesRollbackTarget({
        values: sampleValues,
        release: "proof",
        namespace: "production",
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        tag: "a".repeat(40),
        digest: rollbackDigest,
        releaseTag: "release-20260705120000-abcdef12",
        lastKnownGoodCommit: "a".repeat(40),
        sourceRevision: 228,
        sourceStatus: "deployed",
        sourceDescription: "Upgrade complete",
        checkedAt: "2026-07-05T12:00:00.000Z",
      }),
    ).toEqual({
      schemaVersion: "platform-kubernetes-rollback-target/v2",
      capturedAt: "2026-07-05T12:00:00.000Z",
      release: "proof",
      namespace: "production",
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: "a".repeat(40),
      digest: rollbackDigest,
      imageRef: rollbackImageRef,
      componentNames: [
        "proof-chase-sets-platform-marketplace",
        "proof-chase-sets-platform-platform-bootstrap",
        "proof-chase-sets-platform-platform-worker",
        "proof-chase-sets-platform-public-web",
      ],
      lastKnownGoodCommit: "a".repeat(40),
      releaseTag: "release-20260705120000-abcdef12",
      sourceRevision: 228,
      sourceStatus: "deployed",
      sourceDescription: "Upgrade complete",
      observedTag: "a".repeat(40),
      observedDigest: rollbackDigest,
      workloadIdentities: [],
    });
  });
});
