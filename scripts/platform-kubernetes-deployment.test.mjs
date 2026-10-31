import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAMLParseError, parse as parseYaml, parseDocument } from "yaml";
import { describe, expect, it, vi } from "vitest";
import {
  PLATFORM_KUBERNETES_SCENARIO_SEED_VERSION,
  abortPlatformRollouts,
  assertExclusiveProductionHelmWriter,
  assertOciIndexPlatformManifestMembership,
  buildDeploymentEvidence,
  buildDiagnosticsCommands,
  buildApplicationWorkloadIdentityArgs,
  buildHelmHistoryArgs,
  buildHelmRollbackArgs,
  buildHelmStatusArgs,
  buildHelmUninstallArgs,
  buildHelmUpgradeArgs as buildHelmUpgradeArgsUnderTest,
  buildHelmValuesArgs,
  buildWaveExposureHelmSetArgs,
  buildKubernetesRollbackTarget,
  buildManagedPostgresCaReconcileArgs,
  buildNamespaceDeleteArgs,
  buildNamespaceGetArgs,
  buildPreviewWildcardSecretApplyArgs,
  buildPreviewWildcardSecretGetArgs,
  buildScenarioSeedAccessManifest,
  buildScenarioSeedJobManifest as buildScenarioSeedJobManifestUnderTest,
  copyPreviewWildcardTlsSecret,
  captureKubernetesRollbackTarget,
  deployPlatformToKubernetes as deployPlatformToKubernetesUnderTest,
  helmReleaseExists,
  parsePlatformImageRef,
  parseArgs,
  platformValuesPathForEnvironment,
  platformKubernetesWorkloads,
  promotePlatformRollouts,
  readGitHubProductionWriterCensus,
  readHelmOperationCensus,
  recoverStableStalePendingUpgrade,
  releaseScenarioSeedQuiesce,
  reconcileManagedPostgresCaOnKubernetes,
  rollbackPlatformOnKubernetes,
  runScenarioSeedOnKubernetes as runScenarioSeedOnKubernetesUnderTest,
  sanitizeCopiedSecretManifest,
  scenarioSeedMaxActiveDeadlineSeconds,
  selectFailedRollbackRecoveryTarget,
  selectStableDeployedHelmSource,
  selectStableStalePendingUpgrade,
  teardownPlatformKubernetesNamespace,
  verifyKubernetesDeploymentTransition,
  verifyStalePendingRecoveryTransition,
} from "./platform-kubernetes-deployment.mjs";
import * as platformKubernetesDeployment from "./platform-kubernetes-deployment.mjs";
import {
  classifyAdmissionWebhookTransient,
  classifyDeploymentRootCause,
  readDeployDiagnostics,
  redactDeployDiagnosticText,
} from "./platform-deploy-incident.mjs";
import { assertExclusiveMarkerWriter } from "./production-release-marker.mjs";
import { previewPostgresDemand } from "./lib/browser-e2e-postgres-demand.mjs";

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
const managedPostgresCaSha256 = "a".repeat(64);
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

describe("release-tuple support deployment instance", () => {
  const nativeHelm = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;
  function render(
    release,
    namespace,
    extra = [],
    chart = "infrastructure/helm/platform",
    component = "platform-api",
    plantApiEnv = true,
  ) {
    const env = ["CHASE_SETS_DEPLOYMENT_INSTANCE", "CHASE_SETS_IMPLEMENTATION_SHA"].map((name) => ({
      name,
      secret: true,
      value: "PLANTED_OVERRIDE",
    }));
    const args = [
      "template",
      release,
      chart,
      "--namespace",
      namespace,
      "--show-only",
      "templates/deployment.yaml",
      "--set-string",
      "global.fullnameOverride=shared",
      "--set-string",
      `global.image.tag=${"a".repeat(40)}`,
      ...(plantApiEnv ? ["--set-json", `components.platform-api.env=${JSON.stringify(env)}`] : []),
      "--set-json",
      'global.envOverrides={"CHASE_SETS_DEPLOYMENT_INSTANCE":"PLANTED_OVERRIDE"}',
      "--set-json",
      'components.platform-api.envOverrides={"CHASE_SETS_DEPLOYMENT_INSTANCE":"PLANTED_OVERRIDE"}',
      "--set-json",
      'components.platform-worker.envOverrides={"CHASE_SETS_DEPLOYMENT_INSTANCE":"PLANTED_OVERRIDE"}',
      ...extra,
    ];
    // Script CI has Docker but not a native Helm binary; use the chart job's pinned image.
    const output = execFileSync(
      nativeHelm ? "helm" : "docker",
      nativeHelm
        ? args
        : [
            "run",
            "--rm",
            "-v",
            `${process.cwd()}:/repo`,
            "-v",
            `${tmpdir()}:${tmpdir()}`,
            "-w",
            "/repo",
            "alpine/helm:3.15.4",
            ...args,
          ],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    );
    const deployments = output
      .split(/^---\s*$/m)
      .map((part) => parseYaml(part))
      .filter(Boolean);
    const rendered = deployments.find((item) => item.metadata.labels["app.kubernetes.io/component"] === component);
    return rendered.spec.template.spec.containers[0].env;
  }
  it("kills the fullname-derived and override/secret bypass mutants through actual Helm rendering", () => {
    const a = render("release-a", "preview-a");
    const instance = (env) => env.find((item) => item.name === "CHASE_SETS_DEPLOYMENT_INSTANCE");
    expect(instance(a)).toEqual({
      name: "CHASE_SETS_DEPLOYMENT_INSTANCE",
      value: '["support-deployment-instance/v1","preview-a","release-a"]',
    });
    expect(instance(render("release-b", "preview-a"))).not.toEqual(instance(a));
    expect(instance(render("release-a", "preview-b"))).not.toEqual(instance(a));
    expect(instance(render("release-a", "preview-a", ["--set-string", "global.nameOverride=another"]))).toEqual(
      instance(a),
    );
    const longRelease = `release-${"a".repeat(45)}`;
    expect(instance(render(longRelease, "preview-a")).value).toBe(
      JSON.stringify(["support-deployment-instance/v1", "preview-a", longRelease]),
    );
    expect(a.find((item) => item.name === "CHASE_SETS_IMPLEMENTATION_SHA")).toEqual({
      name: "CHASE_SETS_IMPLEMENTATION_SHA",
      value: "a".repeat(40),
    });
    const helper = readFileSync("infrastructure/helm/platform/templates/_helpers.tpl", "utf8");
    expect(helper).toContain(
      'list "support-deployment-instance/v1" $root.Release.Namespace $root.Release.Name | toJson',
    );
  });
  it("renders the evidence-window admission key optional for api and worker and leaves other secrets required", () => {
    const keep = (name) => ["CHASE_SETS_DEPLOYMENT_INSTANCE", "CHASE_SETS_IMPLEMENTATION_SHA"].includes(name);
    for (const component of ["platform-api", "platform-worker"]) {
      const env = render("release-a", "preview-a", [], undefined, component, false).filter((item) => !keep(item.name));
      const windowKey = env.filter((item) => item.name === "EVIDENCE_WINDOW_ADMISSION_SECRET");
      expect(windowKey).toEqual([
        {
          name: "EVIDENCE_WINDOW_ADMISSION_SECRET",
          valueFrom: {
            secretKeyRef: {
              name: "chase-sets-platform-runtime",
              key: "EVIDENCE_WINDOW_ADMISSION_SECRET",
              optional: true,
            },
          },
        },
      ]);
      const required = env.filter((item) => item.valueFrom?.secretKeyRef && item.name !== windowKey[0].name);
      expect(required.map((item) => item.name)).toContain("STRIPE_SECRET_KEY");
      expect(required.filter((item) => "optional" in item.valueFrom.secretKeyRef)).toEqual([]);
    }
  });
  it("scopes the worker's Support evidence cleanup binding by the same release tuple", () => {
    const pick = (env, name) => env.find((item) => item.name === name);
    const worker = render("release-a", "preview-a", [], undefined, "platform-worker");
    expect(pick(worker, "CHASE_SETS_DEPLOYMENT_INSTANCE")).toEqual(
      pick(render("release-a", "preview-a"), "CHASE_SETS_DEPLOYMENT_INSTANCE"),
    );
    expect(pick(worker, "CHASE_SETS_IMPLEMENTATION_SHA")).toEqual({
      name: "CHASE_SETS_IMPLEMENTATION_SHA",
      value: "a".repeat(40),
    });
    expect(pick(worker, "SUPPORT_EVIDENCE_CLEANUP_BINDING_JSON")).toEqual({
      name: "SUPPORT_EVIDENCE_CLEANUP_BINDING_JSON",
      value: "",
    });
    expect(
      pick(render("release-b", "preview-a", [], undefined, "platform-worker"), "CHASE_SETS_DEPLOYMENT_INSTANCE"),
    ).not.toEqual(pick(worker, "CHASE_SETS_DEPLOYMENT_INSTANCE"));
  });
  it("executes a fullname-derived mutant and observes the release-isolation assertion fail", () => {
    const temp = mkdtempSync(join(tmpdir(), "support-instance-mutant-"));
    try {
      const chart = join(temp, "chart");
      cpSync("infrastructure/helm/platform", chart, { recursive: true });
      const helper = join(chart, "templates", "_helpers.tpl");
      const original = readFileSync(helper, "utf8");
      const canonical = 'list "support-deployment-instance/v1" $root.Release.Namespace $root.Release.Name | toJson';
      expect(original).toContain(canonical);
      writeFileSync(
        helper,
        original.replace(
          canonical,
          'list "support-deployment-instance/v1" $root.Release.Namespace (include "chase-sets-platform.fullname" $root) | toJson',
        ),
      );
      const instance = (release) =>
        render(release, "preview-a", [], chart).find((item) => item.name === "CHASE_SETS_DEPLOYMENT_INSTANCE").value;
      const a = instance("release-a");
      const b = instance("release-b");
      expect(() => expect(a).not.toEqual(b)).toThrow();
      expect(a).toEqual(b);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

function withManagedPostgresCa(options) {
  return {
    ...options,
    env: { GITHUB_RUN_ID: "107110001", GITHUB_RUN_ATTEMPT: "1", ...options.env },
    managedPostgresCaSha256: options.managedPostgresCaSha256 ?? managedPostgresCaSha256,
  };
}

function buildHelmUpgradeArgs(options) {
  return buildHelmUpgradeArgsUnderTest(withManagedPostgresCa(options));
}

function buildScenarioSeedJobManifest(options) {
  return buildScenarioSeedJobManifestUnderTest(withManagedPostgresCa(options));
}

function deployPlatformToKubernetes(options) {
  return deployPlatformToKubernetesUnderTest(withManagedPostgresCa(options));
}

function runScenarioSeedOnKubernetes(options) {
  return runScenarioSeedOnKubernetesUnderTest(withManagedPostgresCa(options));
}
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

// Retained production evidence from #8104: Helm's resource-patch failure path
// rewrites the rollback revision's description, so revision 415 no longer says
// "Rollback to 413".
const productionFailedRollbackDescription =
  'Rollback "chase-sets-platform" failed: cannot patch "chase-sets-platform-doks-tls" with kind Certificate: Internal error occurred: failed calling webhook "webhook.cert-manager.io": failed to call webhook: Post "https://cert-manager-webhook.cert-manager.svc:443/validate?timeout=30s": dial tcp 10.108.83.28:443: connect: connection refused';
const failedRollbackPreHistory = [
  { revision: 413, status: "superseded", description: "Rollback to 411" },
  { revision: 414, status: "superseded", description: "Upgrade complete" },
  { revision: 415, status: "failed", description: productionFailedRollbackDescription },
];
const failedRollbackPostHistory = [
  ...failedRollbackPreHistory,
  { revision: 416, status: "deployed", description: "Rollback to 413" },
];
const supersededCandidateValues = structuredClone(rollbackValues);
supersededCandidateValues.global.image.tag = "f".repeat(40);
supersededCandidateValues.global.image.digest = failedCandidateDigest;

function failedRollbackCaptureOptions(calls, completions) {
  return {
    values: rollbackValues,
    release: "proof",
    namespace: "production",
    registryName: "chase-sets",
    repository: "chase-sets-platform",
    tag: rollbackTag,
    digest: rollbackDigest,
    lastKnownGoodCommit: rollbackTag,
    releaseTag: "release-synthetic-proof",
    timeout: "30s",
    checkedAt: "2026-09-21T12:00:00.000Z",
    spawn: completedSpawn(calls, completions),
  };
}

// Capture admission: history, values for 415 (failed tail), 414 (newest
// superseded candidate, differs), 413 (matches), live workloads against 413,
// Helm operation census, stable history.
function failedRollbackAdmissionCompletions() {
  return [
    { code: 0, stdout: helmHistory(failedRollbackPreHistory) },
    { code: 0, stdout: JSON.stringify(rollbackValues) },
    { code: 0, stdout: JSON.stringify(supersededCandidateValues) },
    { code: 0, stdout: JSON.stringify(rollbackValues) },
    { code: 0, stdout: rollbackWorkloadList() },
    { code: 0, stdout: '{"items":[]}' },
    { code: 0, stdout: helmHistory(failedRollbackPreHistory) },
  ];
}

// rollbackPlatformOnKubernetes with releaseExists: history, source values,
// stable history, helm rollback, rollout status, resulting history, resulting
// values, workloads, stable resulting history.
function failedRollbackHealCompletions() {
  return [
    { code: 0, stdout: helmHistory(failedRollbackPreHistory) },
    { code: 0, stdout: JSON.stringify(rollbackValues) },
    { code: 0, stdout: helmHistory(failedRollbackPreHistory) },
    { code: 0 },
    { code: 0 },
    { code: 0, stdout: helmHistory(failedRollbackPostHistory) },
    { code: 0, stdout: JSON.stringify(rollbackValues) },
    { code: 0, stdout: rollbackWorkloadList() },
    { code: 0, stdout: helmHistory(failedRollbackPostHistory) },
  ];
}

// The ordinary capture from the healed head: history, values 416, workloads,
// stable history.
function failedRollbackCaptureCompletions() {
  return [
    { code: 0, stdout: helmHistory(failedRollbackPostHistory) },
    { code: 0, stdout: JSON.stringify(rollbackValues) },
    { code: 0, stdout: rollbackWorkloadList() },
    { code: 0, stdout: helmHistory(failedRollbackPostHistory) },
  ];
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
  it.each([undefined, "true", "false"])(
    "threads Catalog send-window %s through real CLI parsing and Helm arguments",
    (flag) => {
      const argv = ["deploy", "--image", rollbackImageRef, "--runtime-env", "DEPLOYMENT_ENVIRONMENT=staging"];
      if (flag !== undefined) argv.push("--runtime-env", `CATALOG_PROVIDER_SEND_WINDOW_ENABLED=${flag}`);
      const parsed = parseArgs(argv, {});
      expect(parsed.envOverrides.CATALOG_PROVIDER_SEND_WINDOW_ENABLED).toBe(flag);
      const args = buildHelmUpgradeArgs(parsed);
      expect(args).toContain("infrastructure/helm/platform/values.staging.yaml");
      const index = args.indexOf(`global.envOverrides.CATALOG_PROVIDER_SEND_WINDOW_ENABLED=${flag}`);
      if (flag === undefined) {
        expect(args.some((arg) => arg.includes("CATALOG_PROVIDER_SEND_WINDOW_ENABLED"))).toBe(false);
      } else {
        expect(index).toBeGreaterThan(0);
        expect(args[index - 1]).toBe("--set-string");
      }
    },
  );

  it("does not introduce the Catalog send-window override into production Helm arguments", () => {
    const parsed = parseArgs(
      ["deploy", "--image", rollbackImageRef, "--runtime-env", "DEPLOYMENT_ENVIRONMENT=production"],
      {},
    );
    const args = buildHelmUpgradeArgs(parsed);
    expect(args).toContain("infrastructure/helm/platform/values.production.yaml");
    expect(args.some((arg) => arg.includes("CATALOG_PROVIDER_SEND_WINDOW_ENABLED"))).toBe(false);
  });

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
    expect(manifest.spec.template.metadata.annotations["chase-sets.com/managed-postgres-ca-sha256"]).toBe(
      managedPostgresCaSha256,
    );
    expect(manifest.spec.template.spec.volumes).toEqual([
      {
        name: "managed-postgres-ca",
        secret: {
          secretName: "chase-sets-platform-runtime",
          items: [{ key: "managed-postgres-ca.crt", path: "ca.crt" }],
        },
      },
    ]);
    expect(container.volumeMounts).toEqual([
      {
        name: "managed-postgres-ca",
        mountPath: "/var/run/secrets/chase-sets/managed-postgres",
        readOnly: true,
      },
    ]);
    const access = buildScenarioSeedAccessManifest({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      jobName: "staging-scenario-seed-proof",
    });
    expect(manifest.spec.template.spec.serviceAccountName).toBe(access.items[0].metadata.name);
    expect(container.args).toEqual([
      "node ./infrastructure/helm/platform/scripts/bootstrap-quiesce.mjs -- pnpm --filter @chase-sets/app-platform-api run bootstrap:production",
    ]);
    expect(env.get("PLATFORM_DATA_PROFILES")).toEqual({ name: "PLATFORM_DATA_PROFILES", value: "scenario-seed" });
    expect(env.get("CHASE_SETS_QUIESCE_MODE")?.value).toBe("scenario-seed");
    expect(env.get("CHASE_SETS_QUIESCE_OWNER")?.value).toBe("scenario-seed:staging-scenario-seed-proof");
    expect(env.get("DATABASE_POOL_MAX")).toEqual({ name: "DATABASE_POOL_MAX", value: "1" });
    expect(env.get("CHASE_SETS_QUIESCE_RESTORE_ON_SUCCESS")).toEqual({
      name: "CHASE_SETS_QUIESCE_RESTORE_ON_SUCCESS",
      value: "true",
    });
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
      jobName: "staging-scenario-seed-proof",
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
        apiGroups: [""],
        resources: ["pods"],
        verbs: ["list"],
      },
      {
        apiGroups: ["keda.sh"],
        resources: ["scaledobjects"],
        resourceNames: ["chase-sets-platform-chase-sets-platform-platform-worker"],
        verbs: ["get", "patch"],
      },
    ]);
    expect(roleBinding.roleRef.name).toBe(role.metadata.name);
    expect(roleBinding.subjects).toEqual([
      { kind: "ServiceAccount", name: serviceAccount.metadata.name, namespace: "chase-sets-platform" },
    ]);
    expect(serviceAccount.metadata.labels["chase-sets.com/scenario-seed-job"]).toBe("staging-scenario-seed-proof");
    expect(
      buildScenarioSeedAccessManifest({
        release: "chase-sets-platform",
        namespace: "chase-sets-platform",
        jobName: "staging-scenario-seed-another-attempt",
      }).items[0].metadata.name,
    ).not.toBe(serviceAccount.metadata.name);
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
    expect(env.get("DATABASE_POOL_MAX")).toEqual({ name: "DATABASE_POOL_MAX", value: "1" });
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
    expect(calls.at(-1).args).toContain(`serviceaccount/${accessManifest.items[0].metadata.name}`);
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

  it("leaves run-specific quiesce access in place when a Job is still active at CLI timeout", async () => {
    const calls = [];
    let clock = 0;
    await expect(
      runScenarioSeedOnKubernetes({
        release: "chase-sets-platform",
        namespace: "chase-sets-platform",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:proof",
        timeout: "2m",
        jobName: "staging-scenario-seed-proof",
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
        now: () => (clock += 120_000),
        spawn: completedSpawn(calls, [
          { code: 0 },
          { code: 0 },
          { code: 0 },
          { code: 0, stdout: JSON.stringify({ status: { active: 1 } }) },
        ]),
      }),
    ).rejects.toThrow("Timed out after 2m");
    expect(calls.map((call) => call.args[0])).toEqual(["apply", "apply", "logs", "get"]);
  });

  it("scenario seed failure record carries the pod's bootstrap error text", async () => {
    const calls = [];
    // backoffLimit: 0 means the Failed pod is the only place the bootstrap cause exists, and the
    // streamed --follow logs are already gone from the step's stdout by the time evidence is written.
    const podLogs = [
      "Listening on port 3000",
      'Platform API bootstrap failed. Error: relation "source_observation_events" does not exist',
      "    at Object.seedCatalogBrowserFixtures (/app/dist/seeding/seed.js:120:11)",
    ].join("\n");

    const failure = await runScenarioSeedOnKubernetes({
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
        {
          code: 0,
          stdout: JSON.stringify({
            status: {
              failed: 1,
              conditions: [
                {
                  type: "Failed",
                  status: "True",
                  reason: "BackoffLimitExceeded",
                  message: "Job has reached the specified backoff limit",
                },
              ],
            },
          }),
        },
        { code: 1, stdout: podLogs },
      ]),
    }).then(
      () => null,
      (error) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure.evidence).toEqual({
      schemaVersion: PLATFORM_KUBERNETES_SCENARIO_SEED_VERSION,
      action: "scenario-seed",
      result: "failure",
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      jobName: "staging-advisory-scenario-seed",
      reason: "BackoffLimitExceeded",
      bootstrapError: 'Platform API bootstrap failed. Error: relation "source_observation_events" does not exist',
    });
    expect(failure.message).toContain("Post-deploy scenario seed Job staging-advisory-scenario-seed failed");
    expect(failure.message).toContain('relation "source_observation_events" does not exist');

    const tailCall = calls.at(-1);
    expect([tailCall.command, ...tailCall.args]).toEqual([
      "kubectl",
      "logs",
      "job/staging-advisory-scenario-seed",
      "--namespace",
      "chase-sets-platform",
      "--tail=50",
    ]);
    // Piped stdio is what makes the tail readable; an inherited stream would only reach the step log.
    expect(tailCall.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it.each(["refused", "preempted"])("carries actual wrapper %s markers as non-success Job evidence", async (status) => {
    const calls = [];
    const failure = await runScenarioSeedOnKubernetes({
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:proof",
      jobName: "synthetic-seed",
      envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
      spawn: completedSpawn(calls, [
        { code: 0 },
        { code: 0 },
        { code: 0 },
        { code: 0, stdout: JSON.stringify({ status: { failed: 1 } }) },
        { code: 0, stdout: `[bootstrap-quiesce] scenario-seed result=${status}\n` },
        { code: 0 },
      ]),
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.evidence.result).toBe(status);
  });

  it.each(["helm-hook:pod", "scenario-seed:foreign", null])(
    "cleanup refuses foreign/unowned authority %s",
    async (owner) => {
      const calls = [];
      const result = await releaseScenarioSeedQuiesce({
        jobName: "synthetic-seed",
        spawn: completedSpawn(calls, [
          {
            code: 0,
            stdout: JSON.stringify({
              metadata: {
                resourceVersion: "1",
                annotations: {
                  "autoscaling.keda.sh/paused-replicas": "0",
                  ...(owner ? { "chase-sets.com/quiesce-owner": owner } : {}),
                },
              },
            }),
          },
        ]),
      });
      expect(result.result).toBe("refused");
      expect(calls).toHaveLength(1);
    },
  );

  it.each(["active", "pending", "ambiguous-pod", "live-pod", "missing-job", "terminal", "conflict"])(
    "reclaim proves an inactive terminal Job and CAS ownership: %s",
    async (state) => {
      const calls = [];
      const resource = {
        metadata: {
          resourceVersion: "17",
          annotations: {
            "chase-sets.com/quiesce-owner": "scenario-seed:synthetic-seed",
            "autoscaling.keda.sh/paused-replicas": "0",
          },
        },
      };
      const job = {
        metadata: { name: "synthetic-seed", uid: "synthetic-uid" },
        status: {
          active: state === "active" ? 1 : 0,
          conditions: state === "pending" ? [] : [{ type: "Complete", status: "True" }],
        },
      };
      const pods = {
        items: [
          {
            metadata: {
              ownerReferences: [{ kind: "Job", uid: state === "ambiguous-pod" ? "foreign" : "synthetic-uid" }],
            },
            status: { phase: state === "live-pod" ? "Running" : "Succeeded" },
          },
        ],
      };
      const outputs = [
        { code: 0, stdout: JSON.stringify(resource) },
        state === "missing-job" ? { code: 1, stderr: "NotFound" } : { code: 0, stdout: JSON.stringify(job) },
        { code: 0, stdout: JSON.stringify(pods) },
        state === "conflict" ? { code: 1, stderr: "Error from server (Conflict)" } : { code: 0, stdout: "{}" },
        {
          code: 0,
          stdout: JSON.stringify({
            metadata: { resourceVersion: "18", annotations: { "chase-sets.com/quiesce-owner": "helm-hook:pod" } },
          }),
        },
      ];
      const result = await releaseScenarioSeedQuiesce({
        jobName: "synthetic-seed",
        reclaim: true,
        spawn: completedSpawn(calls, outputs),
      });
      expect(result.result).toBe(state === "terminal" ? "released" : "refused");
      const patch = calls.find((call) => call.args[0] === "patch");
      if (["terminal", "conflict"].includes(state)) {
        expect(JSON.parse(patch.args[patch.args.indexOf("--patch") + 1])).toEqual({
          metadata: {
            resourceVersion: "17",
            annotations: { "chase-sets.com/quiesce-owner": null, "autoscaling.keda.sh/paused-replicas": null },
          },
        });
      } else expect(patch).toBeUndefined();
      expect(calls.every((call) => call.args.includes("--request-timeout=2s"))).toBe(true);
    },
  );

  it("release clears only its own owner and exposes a single release/reclaim CLI", async () => {
    const calls = [];
    expect(parseArgs(["scenario-seed-release", "--job-name", "synthetic-seed", "--reclaim", "true"], {})).toMatchObject(
      { command: "scenario-seed-release", jobName: "synthetic-seed", reclaim: true },
    );
    const result = await releaseScenarioSeedQuiesce({
      jobName: "synthetic-seed",
      spawn: completedSpawn(calls, [
        {
          code: 0,
          stdout: JSON.stringify({
            metadata: {
              resourceVersion: "1",
              annotations: { "chase-sets.com/quiesce-owner": "scenario-seed:synthetic-seed" },
            },
          }),
        },
        { code: 0, stdout: "{}" },
      ]),
    });
    expect(result.result).toBe("released");
    expect(calls.map((call) => call.args[0])).toEqual(["get", "patch"]);
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

  it("reuses the admitted Helm release for day-after CA reconciliation", async () => {
    const args = buildManagedPostgresCaReconcileArgs({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      timeout: "15m",
      managedPostgresCaSha256,
    });
    expect(args).toEqual([
      "upgrade",
      "chase-sets-platform",
      "infrastructure/helm/platform",
      "--namespace",
      "chase-sets-platform",
      "--reuse-values",
      "--wait",
      "--timeout",
      "15m",
      "--atomic",
      "--no-hooks",
      "--set-string",
      `global.managedPostgresCaSha256=${managedPostgresCaSha256}`,
    ]);
    expect(() =>
      buildManagedPostgresCaReconcileArgs({ managedPostgresCaSha256: managedPostgresCaSha256.toUpperCase() }),
    ).toThrow("lowercase SHA-256");

    const calls = [];
    await reconcileManagedPostgresCaOnKubernetes({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      timeout: "15m",
      managedPostgresCaSha256,
      helmPath: "C:/synthetic/helm-double.exe",
      kubectlPath: "C:/synthetic/kubectl-double.exe",
      workloads: { deployments: [], rollouts: [], jobs: [] },
      spawn: successfulSpawn(calls),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("C:/synthetic/helm-double.exe");
    expect(calls[0].args).toEqual(args);
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

  it("loads the environment-specific Helm overlays for preview, staging and production", () => {
    expect(platformValuesPathForEnvironment("preview")).toBe("infrastructure/helm/platform/values.preview.yaml");
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

  it("refuses when exact admitted history moves before the rollback mutation", async () => {
    const admitted = [
      { revision: 308, status: "deployed", description: "Upgrade complete" },
      { revision: 309, status: "pending-upgrade", description: "Preparing upgrade" },
    ];
    const moved = [...admitted, { revision: 310, status: "failed", description: "Concurrent mutation" }];
    const calls = [];
    const result = await rollbackPlatformOnKubernetes({
      release: "proof",
      namespace: "production",
      revision: 308,
      expectedPreRollbackHistory: admitted,
      spawn: completedSpawn(calls, [
        { code: 0, stdout: '{"name":"proof"}' },
        { code: 0, stdout: helmHistory(moved) },
      ]),
    });

    expect(result).toMatchObject({ result: "failure", reason: expect.stringContaining("exact pre-rollback compare") });
    expect(calls.some((call) => call.command === "helm" && call.args[0] === "rollback")).toBe(false);
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

  describe("concurrency-queued production writer census", () => {
    const deployPath = ".github/workflows/platform-production.yml";
    const recoveryPath = ".github/workflows/platform-production-stale-helm-recovery.yml";
    const workflowSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

    async function collect(overrides = {}) {
      // Synthetic identities; reproduces #8910's run/job states, not its live evidence.
      const current = {
        id: 91001,
        workflow_id: 910,
        name: "Platform Deploy",
        path: deployPath,
        status: "in_progress",
        event: "workflow_dispatch",
        head_sha: "a".repeat(40),
        head_branch: "main",
        run_attempt: 1,
        ...overrides.current,
      };
      const successor = {
        ...current,
        id: 91002,
        head_sha: "b".repeat(40),
        status: "pending",
        ...overrides.successor,
      };
      let jobsFailures = overrides.jobsFailures ?? 0;
      const fetch = vi.fn(async (url) => {
        const request = new URL(url);
        let body;
        if (request.pathname.endsWith("/actions/runs")) {
          const workflow_runs = (overrides.omitCurrent ? [successor] : [current, successor]).filter(
            (run) =>
              (run === successor ? (overrides.listStatus ?? run.status) : run.status) ===
              request.searchParams.get("status"),
          );
          body = overrides.runsBody ?? { total_count: workflow_runs.length, workflow_runs };
        } else if (request.pathname === `/repos/synthetic/repository/actions/runs/${current.id}`) {
          body = current;
        } else if (request.pathname.includes("/contents/")) {
          if (overrides.sourceFailure) return { ok: false, status: 403 };
          const path = request.pathname.split("/contents/")[1];
          const source =
            request.searchParams.get("ref") === successor.head_sha
              ? (overrides.source ?? workflowSource(path))
              : (overrides.currentSource ?? workflowSource(path));
          body = overrides.sourceBody ?? {
            type: "file",
            encoding: "base64",
            content: Buffer.from(source).toString("base64"),
          };
        } else if (
          request.pathname ===
          `/repos/synthetic/repository/actions/runs/${successor.id}/attempts/${successor.run_attempt}/jobs`
        ) {
          if (jobsFailures > 0) {
            jobsFailures -= 1;
            return { ok: false, status: 503 };
          }
          body = overrides.jobs ?? { total_count: 0, jobs: [] };
        } else {
          throw new Error(`Unexpected synthetic request: ${url}`);
        }
        return { ok: true, status: 200, json: async () => body };
      });
      const census = await readGitHubProductionWriterCensus({
        fetch,
        sleep: async () => {},
        env: {
          GITHUB_TOKEN: "synthetic-token",
          GITHUB_REPOSITORY: "synthetic/repository",
          GITHUB_RUN_ID: String(current.id),
          GITHUB_RUN_ATTEMPT: String(current.run_attempt),
          GITHUB_WORKFLOW: current.name,
          GITHUB_API_URL: "https://api.example.invalid",
        },
      });
      return { census, fetch };
    }

    it("pins the whole-workflow non-cancelling concurrency contract", () => {
      expect(parseYaml(workflowSource(deployPath)).concurrency).toEqual({
        group:
          "${{ inputs.decommission_plan_only && format('platform-production-decommission-plan-{0}', github.ref) || 'platform-registry-mutation' }}",
        "cancel-in-progress": false,
      });
      expect(parseYaml(workflowSource(recoveryPath)).concurrency).toEqual({
        group: "platform-registry-mutation",
        "cancel-in-progress": false,
      });
    });

    it.each(["pending", "queued"])(
      "admits the current deploy with a %s same-workflow successor and zero jobs",
      async (status) => {
        const { census, fetch } = await collect({ successor: { status } });
        expect(census.writerRuns.map(({ id }) => id)).toEqual([91001]);
        expect(census.runs.map(({ id }) => id)).toEqual([91001, 91002]);
        expect(census.concurrencyQueuedRuns).toEqual([expect.objectContaining({ id: 91002 })]);
        expect(fetch.mock.calls.map(([url]) => url)).toContain(
          "https://api.example.invalid/repos/synthetic/repository/actions/runs/91002/attempts/1/jobs?per_page=100&page=1",
        );
      },
    );

    it("applies the same predicate to the stale Helm recovery caller", async () => {
      const { census } = await collect({
        current: { name: "Platform Production Stale Helm Recovery", path: recoveryPath },
      });
      expect(assertExclusiveProductionHelmWriter(census, { currentRunId: "91001" }).id).toBe(91001);
    });

    it("preserves concurrency-queued successor classification when the current rerun is absent from lists", async () => {
      const { census } = await collect({
        omitCurrent: true,
        current: { run_attempt: 2 },
        successor: { run_attempt: 1 },
      });
      expect(census.runs.map(({ id }) => id)).toEqual([91001, 91002]);
      expect(census.concurrencyQueuedRuns.map(({ id }) => id)).toEqual([91002]);
      expect(() => assertExclusiveMarkerWriter(census, "91001")).not.toThrow();
    });

    it.each([
      [
        "started job",
        { jobs: { total_count: 1, jobs: [{ status: "in_progress", started_at: "2026-10-06T18:00:00Z" }] } },
      ],
      [
        "completed job",
        { jobs: { total_count: 1, jobs: [{ status: "completed", started_at: "2026-10-06T18:00:00Z" }] } },
      ],
      ["queued job (conservative)", { jobs: { total_count: 1, jobs: [{ status: "queued", started_at: null }] } }],
      [
        "other writer workflow",
        { successor: { name: "Platform Production Stale Helm Recovery", path: recoveryPath, workflow_id: 911 } },
      ],
      ["environment wait", { successor: { status: "waiting" } }],
      ["unknown status", { successor: { status: "unknown" }, listStatus: "pending" }],
      ["requested status", { successor: { status: "requested" } }],
      ["active peer", { successor: { status: "in_progress" } }],
      ["missing workflow id", { successor: { workflow_id: undefined } }],
      ["different workflow id", { successor: { workflow_id: 911 } }],
      ["different workflow path", { successor: { path: recoveryPath } }],
      ["missing attempt", { successor: { run_attempt: undefined } }],
      ["rerun with prior-attempt jobs unknown", { successor: { run_attempt: 2 } }],
      ["missing head", { successor: { head_sha: undefined } }],
      ["non-main peer", { successor: { head_branch: "untrusted" } }],
      ["inactive current run", { current: { status: "waiting" } }],
      ["changed current workflow", { currentSource: "name: Platform Deploy\n" }],
      [
        "changed concurrency",
        { source: workflowSource(deployPath).replace("cancel-in-progress: false", "cancel-in-progress: true") },
      ],
      [
        "job-level concurrency only",
        { source: "name: Platform Deploy\njobs:\n  deploy:\n    concurrency: platform-registry-mutation\n" },
      ],
    ])("retains a conflicting writer for %s", async (_label, overrides) => {
      const { census } = await collect(overrides);
      expect(census.writerRuns).toHaveLength(2);
    });

    it.each([
      { jobs: [] },
      { total_count: 0 },
      { total_count: 0, jobs: [{ status: "in_progress" }] },
      { total_count: 1, jobs: [] },
      { total_count: -1, jobs: [] },
    ])("refuses malformed or incomplete job evidence: %j", async (jobs) => {
      await expect(collect({ jobs })).rejects.toThrow(/job census/);
    });

    it.each([
      ["unavailable workflow", { sourceFailure: true }, /workflow source.*HTTP 403/],
      ["jobs unavailable after two re-reads", { jobsFailures: 3 }, /job census.*HTTP 503/],
      ["malformed workflow response", { sourceBody: { type: "file", encoding: "none" } }, /workflow source census/],
      ["malformed runs response", { runsBody: { total_count: 0 } }, /run census.*invalid response/],
      ["missing run identity", { successor: { id: undefined } }, /malformed run identity/],
      ["duplicate run identity", { successor: { id: 91001 } }, /duplicate or moving run/],
    ])("fails closed for %s", async (_label, overrides, error) => {
      await expect(collect(overrides)).rejects.toThrow(error);
    });

    it("re-reads a job census 503 twice and admits the recovered answer", async () => {
      const { census, fetch } = await collect({ jobsFailures: 2 });
      expect(census.concurrencyQueuedRuns.map(({ id }) => id)).toEqual([91002]);
      expect(fetch.mock.calls.filter(([url]) => new URL(url).pathname.endsWith("/jobs"))).toHaveLength(3);
    });

    describe("successor serialization projection", () => {
      // Fixtures revise the real checked-in definitions. Each refusal adds one change to the
      // admitted drift control, so that change alone decides the result.
      const deploySource = workflowSource(deployPath);
      const recoverySource = workflowSource(recoveryPath);
      const deployDocument = parseDocument(deploySource);
      const recoveryDocument = parseDocument(recoverySource);
      const deployJobIds = Object.keys(parseYaml(deploySource).jobs);
      const recoveryJobIds = Object.keys(parseYaml(recoverySource).jobs);
      const recovery = { name: "Platform Production Stale Helm Recovery", path: recoveryPath };
      const decommissionInput = ["on", "workflow_dispatch", "inputs", "decommission_plan_only"];
      const permutedKeyOrderPaths = [
        ["concurrency"],
        decommissionInput,
        ["jobs", "decommission-live-plan", "steps", 2],
      ];
      const revise = (document, ...changes) => {
        const revised = document.clone();
        for (const change of changes) change(revised);
        return String(revised);
      };
      // The #9367 shape: #9357 added job env and a step to Deploy Production.
      const driftDeployProduction = (document) => {
        document.setIn(
          ["jobs", "deploy-production", "env", "SYNTHETIC_SUCCESSOR_REFERENCE"],
          "${{ vars.SYNTHETIC_SUCCESSOR_REFERENCE || '' }}",
        );
        document.addIn(
          ["jobs", "deploy-production", "steps"],
          document.createNode({ name: "Synthetic successor step", run: "echo synthetic" }),
        );
      };
      const driftRecovery = (document) =>
        document.addIn(
          ["jobs", "recover-production-stale-helm-upgrade", "steps"],
          document.createNode({ name: "Synthetic successor step", run: "echo synthetic" }),
        );
      const addNonGroupInput = (document) =>
        document.setIn(
          ["on", "workflow_dispatch", "inputs", "synthetic_note"],
          document.createNode({
            description: "Synthetic non-group input.",
            required: false,
            default: "",
            type: "string",
          }),
        );
      const permuteProjectedKeyOrder = (document) => {
        for (const path of permutedKeyOrderPaths) document.getIn(path).items.reverse();
      };
      const addWorkflowBashEnv = (document) =>
        document.set("env", document.createNode({ BASH_ENV: "./synthetic-production-writer.sh" }));
      const driftedDeploySource = revise(deployDocument, driftDeployProduction);
      const queuedIds = ({ census }) => census.concurrencyQueuedRuns.map(({ id }) => id);
      const writerIds = ({ census }) => census.writerRuns.map(({ id }) => id);
      const preProductionJobs = {
        total_count: 2,
        jobs: [
          { name: "Resolve Release", status: "completed", conclusion: "success", started_at: "2026-10-06T18:00:00Z" },
          {
            name: "Build Release Image",
            status: "completed",
            conclusion: "success",
            started_at: "2026-10-06T18:01:00Z",
          },
        ],
      };

      // Frozen control shared by the refusals: drifted definition, pending, attempt 1, zero jobs.
      let deployControl;
      async function expectDriftControlAdmitted() {
        deployControl ??= collect({ source: driftedDeploySource });
        expect(queuedIds(await deployControl)).toEqual([91002]);
      }

      async function expectRetained(overrides) {
        const result = await collect(overrides);
        expect(queuedIds(result)).toEqual([]);
        expect(writerIds(result)).toEqual([91001, 91002]);
        return result.census;
      }

      const expectMarkerRefused = (census) =>
        expect(() => assertExclusiveMarkerWriter(census, "91001")).toThrow("active or conflicting production writer");

      it("permutes only nested mapping key order in the real projected members", () => {
        const real = parseYaml(deploySource);
        const permuted = parseYaml(revise(deployDocument, permuteProjectedKeyOrder));
        expect(permuted).toEqual(real);
        for (const path of permutedKeyOrderPaths) {
          const keys = (workflow) => Object.keys(path.reduce((member, key) => member[key], workflow));
          expect(keys(permuted)).toEqual(keys(real).reverse());
        }
      });

      it.each([
        ["(i) the #9367 job env and step drift", driftDeployProduction],
        ["(ii) an added non-group input", addNonGroupInput],
        ["(iii) only nested mapping key order permuted", permuteProjectedKeyOrder],
      ])("admits a pending or queued successor whose whole file differs by %s", async (_label, change) => {
        const source = revise(deployDocument, change);
        expect(source).not.toBe(deploySource);
        for (const status of ["pending", "queued"]) {
          const result = await collect({ source, successor: { status } });
          expect(queuedIds(result)).toEqual([91002]);
          expect(writerIds(result)).toEqual([91001]);
          expect(() => assertExclusiveMarkerWriter(result.census, "91001")).not.toThrow();
        }
      });

      it("admits drifted successors although real jobs legitimately lack needs", async () => {
        const withoutNeeds = (source) =>
          Object.entries(parseYaml(source).jobs)
            .filter(([, job]) => !Object.hasOwn(job, "needs"))
            .map(([id]) => id);
        expect(withoutNeeds(deploySource)).toEqual([
          "decommission-live-plan",
          "resolve-release",
          "reconcile-production-marker",
        ]);
        expect(withoutNeeds(recoverySource)).toEqual(["refuse-unconfirmed"]);
        await expectDriftControlAdmitted();
        const result = await collect({ current: recovery, source: revise(recoveryDocument, driftRecovery) });
        expect(queuedIds(result)).toEqual([91002]);
        expect(assertExclusiveProductionHelmWriter(result.census, { currentRunId: "91001" }).id).toBe(91001);
      });

      it.each([
        [
          "the top-level group",
          (document) => document.setIn(["concurrency", "group"], "platform-registry-mutation-v2"),
        ],
        ["cancel-in-progress", (document) => document.setIn(["concurrency", "cancel-in-progress"], true)],
        ["the name", (document) => document.set("name", "Platform Deploy Synthetic")],
        ["the decommission input declaration", (document) => document.setIn([...decommissionInput, "type"], "string")],
        [
          "a job if",
          (document) => document.setIn(["jobs", "resolve-release", "if"], "github.event_name == 'workflow_dispatch'"),
        ],
        [
          "a job needs",
          (document) =>
            document.setIn(["jobs", "deploy-production", "needs"], document.createNode(["resolve-release"])),
        ],
        [
          "an added job",
          (document) =>
            document.setIn(
              ["jobs", "synthetic-writer"],
              document.createNode({ "runs-on": "ubuntu-latest", steps: [{ run: "echo synthetic" }] }),
            ),
        ],
        ["a removed job", (document) => document.deleteIn(["jobs", "notify-production-rollback-incident"])],
        [
          "the decommission-live-plan body",
          (document) =>
            document.addIn(
              ["jobs", "decommission-live-plan", "steps"],
              document.createNode({ name: "Synthetic writer", run: "terraform apply -auto-approve" }),
            ),
        ],
        [
          "an added workflow-level defaults.run.shell",
          (document) =>
            document.set(
              "defaults",
              document.createNode({ run: { shell: 'bash -c "echo SYNTHETIC_UNSERIALIZED_WRITER; bash {0}"' } }),
            ),
        ],
        [
          "an added workflow-level defaults.run.working-directory",
          (document) => document.set("defaults", document.createNode({ run: { "working-directory": "synthetic" } })),
        ],
        ["an added workflow-level env.BASH_ENV", addWorkflowBashEnv],
      ])("retains a successor whose projection differs only in %s", async (_label, change) => {
        await expectDriftControlAdmitted();
        expectMarkerRefused(await expectRetained({ source: revise(deployDocument, driftDeployProduction, change) }));
      });

      it.each([
        ["lacks concurrency", (document) => document.delete("concurrency")],
        ["lacks jobs", (document) => document.delete("jobs")],
        ["lacks the referenced input", (document) => document.deleteIn(decommissionInput)],
        ["lacks the isolated job", (document) => document.deleteIn(["jobs", "decommission-live-plan"])],
        ["has a non-mapping concurrency", (document) => document.set("concurrency", "platform-registry-mutation")],
        [
          "has a non-mapping inputs container",
          (document) => document.setIn(["on", "workflow_dispatch", "inputs"], "decommission_plan_only"),
        ],
        ["has an empty jobs mapping", (document) => document.set("jobs", document.createNode({}))],
        [
          "has a non-mapping job",
          (document) => document.setIn(["jobs", "close-resolved-deploy-incidents"], "ubuntu-latest"),
        ],
        ["has an empty referenced input", (document) => document.setIn(decommissionInput, document.createNode({}))],
        [
          "has an empty isolated job",
          (document) => document.setIn(["jobs", "decommission-live-plan"], document.createNode({})),
        ],
        ["removes a present needs", (document) => document.deleteIn(["jobs", "deploy-production", "needs"])],
        ["removes a present if", (document) => document.deleteIn(["jobs", "resolve-release", "if"])],
        [
          "adds needs where the contract has none",
          (document) => document.setIn(["jobs", "resolve-release", "needs"], "decommission-live-plan"),
        ],
        [
          "adds null needs where the contract has none",
          (document) => document.setIn(["jobs", "resolve-release", "needs"], null),
        ],
      ])("retains a successor whose definition %s", async (_label, change) => {
        await expectDriftControlAdmitted();
        expectMarkerRefused(await expectRetained({ source: revise(deployDocument, driftDeployProduction, change) }));
      });

      it.each([
        ["a scalar", "Platform Deploy\n"],
        ["a sequence", "- name: Platform Deploy\n"],
        ["null", "null\n"],
        ["nothing", ""],
      ])("retains a successor whose definition parses to %s", async (_label, source) => {
        await expectDriftControlAdmitted();
        expectMarkerRefused(await expectRetained({ source }));
      });

      it("retains the successor when the current definition lacks required structure", async () => {
        await expectDriftControlAdmitted();
        const currentSource = revise(deployDocument, (document) => document.delete("concurrency"));
        expectMarkerRefused(await expectRetained({ currentSource }));
      });

      it("fails closed for an unparseable successor definition", async () => {
        // The refusal keeps the parser error as its cause but never quotes the definition.
        await expect(collect({ source: "name: [Platform Deploy\n" })).rejects.toMatchObject({
          message: expect.stringMatching(/^census-unclassified after 1 pass: YAMLParseError \(BAD_INDENT\)\. /),
          cause: expect.any(YAMLParseError),
        });
      });

      it.each([
        ["an identical", deploySource],
        ["a drifted", driftedDeploySource],
      ])("retains an in_progress successor with %s definition and zero jobs", async (_label, source) => {
        expect(queuedIds(await collect({ source }))).toEqual([91002]);
        expectMarkerRefused(await expectRetained({ source, successor: { status: "in_progress" } }));
      });

      it.each([
        ["an identical", deploySource],
        ["a drifted", driftedDeploySource],
      ])("retains an in_progress successor with %s definition and only pre-production jobs", async (_label, source) => {
        expectMarkerRefused(
          await expectRetained({ source, jobs: preProductionJobs, successor: { status: "in_progress" } }),
        );
      });

      it("retains a current run whose valid workflow bytes drift outside the projection", async () => {
        for (const currentSource of [
          `# Synthetic comment outside the projection.\n${deploySource}`,
          revise(deployDocument, (document) =>
            document.setIn(
              ["on", "workflow_dispatch", "inputs", "release_ref", "description"],
              "Synthetic non-group input description.",
            ),
          ),
          driftedDeploySource,
        ]) {
          expect(currentSource).not.toBe(deploySource);
          // The same bytes as the successor's definition prove an equal, valid projection.
          expect(queuedIds(await collect({ source: currentSource }))).toEqual([91002]);
          expectMarkerRefused(await expectRetained({ currentSource }));
        }
      });

      it("finds the real members the projections must contain", () => {
        const decommissionDeclaration = decommissionInput.reduce((member, key) => member[key], parseYaml(deploySource));
        expect(Object.keys(decommissionDeclaration)).not.toHaveLength(0);
        expect(deployJobIds).toContain("decommission-live-plan");
        expect(deployJobIds.length).toBeGreaterThanOrEqual(14);
        expect(recoveryJobIds).toEqual(["refuse-unconfirmed", "recover-production-stale-helm-upgrade"]);
      });

      it.each(deployJobIds)("projects real Platform Deploy job %s", async (id) => {
        await expectDriftControlAdmitted();
        const source = revise(deployDocument, driftDeployProduction, (document) => document.deleteIn(["jobs", id]));
        expectMarkerRefused(await expectRetained({ source }));
      });

      it.each([
        ["its group", (document) => document.setIn(["concurrency", "group"], "platform-registry-mutation-v2")],
        ...recoveryJobIds.map((id) => [`job ${id}`, (document) => document.deleteIn(["jobs", id])]),
        ["an added workflow-level env.BASH_ENV", addWorkflowBashEnv],
      ])(
        "projects the real stale Helm recovery contract, retaining a successor changing %s",
        async (_label, change) => {
          const control = await collect({ current: recovery, source: revise(recoveryDocument, driftRecovery) });
          expect(queuedIds(control)).toEqual([91002]);
          const census = await expectRetained({
            current: recovery,
            source: revise(recoveryDocument, driftRecovery, change),
          });
          expect(() => assertExclusiveProductionHelmWriter(census, { currentRunId: "91001" })).toThrow(
            /only active writer; observed 2/,
          );
        },
      );
    });
  });

  describe("current rerun production writer census", () => {
    // Synthetic identities, not retained production authority.
    const current = {
      id: 98301,
      name: "Platform Deploy",
      workflow_id: 983,
      path: ".github/workflows/platform-production.yml",
      status: "in_progress",
      event: "workflow_dispatch",
      head_sha: "a".repeat(40),
      head_branch: "main",
      run_attempt: 2,
    };
    const env = {
      GITHUB_TOKEN: "synthetic-token",
      GITHUB_REPOSITORY: "synthetic/repository",
      GITHUB_RUN_ID: String(current.id),
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_WORKFLOW: current.name,
      GITHUB_API_URL: "https://api.example.invalid",
    };

    async function collect({
      listed = [],
      direct = current,
      httpStatus = 200,
      environment = {},
      directReads = [],
      sleep = vi.fn(async () => {}),
    } = {}) {
      const fetch = vi.fn(async (url) => {
        const request = new URL(url);
        if (request.pathname.endsWith("/actions/runs")) {
          const workflow_runs = listed.filter((run) => run.status === request.searchParams.get("status"));
          return { ok: true, json: async () => ({ total_count: workflow_runs.length, workflow_runs }) };
        }
        expect(request.pathname).toBe(`/repos/synthetic/repository/actions/runs/${current.id}`);
        directReads.push(url);
        return { ok: httpStatus === 200, status: httpStatus, json: async () => direct };
      });
      const census = await readGitHubProductionWriterCensus({ fetch, sleep, env: { ...env, ...environment } });
      return { census, fetch, sleep };
    }

    it("current rerun absent from status lists is admitted from direct GET", async () => {
      const { census, fetch, sleep } = await collect();
      expect(census.runs).toEqual([
        expect.objectContaining({ id: current.id, workflowId: 983, runAttempt: 2, headSha: current.head_sha }),
      ]);
      expect(census.writerRuns).toEqual(census.runs);
      expect(() => assertExclusiveMarkerWriter(census, env.GITHUB_RUN_ID)).not.toThrow();
      expect(fetch.mock.calls.map(([url]) => new URL(url).search)).toEqual([
        "?status=requested&per_page=100&page=1",
        "?status=pending&per_page=100&page=1",
        "?status=queued&per_page=100&page=1",
        "?status=in_progress&per_page=100&page=1",
        "?status=waiting&per_page=100&page=1",
        "",
      ]);
      expect(sleep).not.toHaveBeenCalled();
    });

    it.each(["Platform Deploy", "Platform Production Stale Helm Recovery"])(
      "direct-GET fallback preserves a listed conflicting writer (%s)",
      async (name) => {
        const conflicting = { ...current, id: current.id - 1, name };
        const { census } = await collect({ listed: [conflicting] });
        expect(census.runs.map(({ id }) => id)).toEqual([conflicting.id, current.id]);
        expect(census.writerRuns).toEqual(census.runs);
        expect(() => assertExclusiveMarkerWriter(census, env.GITHUB_RUN_ID)).toThrow(
          "active or conflicting production writer",
        );
      },
    );

    it("does not direct-GET or duplicate the current run already in the stable lists", async () => {
      const { census, fetch } = await collect({ listed: [current], direct: null });
      expect(census.runs).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(5);
      expect(() => assertExclusiveMarkerWriter(census, env.GITHUB_RUN_ID)).not.toThrow();
    });

    it("admits the matching stale Helm recovery workflow without granting marker authority", async () => {
      const name = "Platform Production Stale Helm Recovery";
      const { census } = await collect({
        direct: { ...current, name, path: ".github/workflows/platform-production-stale-helm-recovery.yml" },
        environment: { GITHUB_WORKFLOW: name },
      });
      expect(assertExclusiveProductionHelmWriter(census, { currentRunId: env.GITHUB_RUN_ID }).id).toBe(current.id);
      expect(() => assertExclusiveMarkerWriter(census, env.GITHUB_RUN_ID)).toThrow(
        "active or conflicting production writer",
      );
    });

    it.each([
      ["null", null],
      ["an array", []],
      ["missing identity", {}],
      ["a string ID", { ...current, id: String(current.id) }],
      ["a mismatched ID", { ...current, id: current.id + 1 }],
      ["a mismatched name", { ...current, name: "Synthetic CI" }],
      ["a mismatched path", { ...current, path: ".github/workflows/synthetic.yml" }],
      [
        "another writer workflow",
        {
          ...current,
          name: "Platform Production Stale Helm Recovery",
          path: ".github/workflows/platform-production-stale-helm-recovery.yml",
        },
      ],
      ["a wrong event", { ...current, event: "push" }],
      ["a wrong branch", { ...current, head_branch: "synthetic" }],
      ["a malformed SHA", { ...current, head_sha: "stale" }],
      ["a non-string SHA", { ...current, head_sha: ["a".repeat(40)] }],
      ["a missing SHA", { ...current, head_sha: undefined }],
      ["a zero workflow ID", { ...current, workflow_id: 0 }],
      ["a string workflow ID", { ...current, workflow_id: "983" }],
      ["an unsafe workflow ID", { ...current, workflow_id: Number.MAX_SAFE_INTEGER + 1 }],
      ["a missing workflow ID", { ...current, workflow_id: undefined }],
      ["a zero attempt", { ...current, run_attempt: 0 }],
      ["a string attempt", { ...current, run_attempt: "2" }],
      ["a stale attempt", { ...current, run_attempt: 1 }],
      ["a newer attempt", { ...current, run_attempt: 3 }],
      ["a missing attempt", { ...current, run_attempt: undefined }],
      ["a terminal run", { ...current, status: "completed" }],
      ["a missing status", { ...current, status: undefined }],
      ["an unknown status", { ...current, status: "synthetic" }],
    ])("refuses a direct GET with %s", async (_label, direct) => {
      await expect(collect({ direct })).rejects.toThrow("current run census returned an unverified run identity");
    });

    it.each(["requested", "pending", "queued", "waiting"])(
      "retains an active %s current run without fabricating an in-progress marker writer",
      async (status) => {
        const { census } = await collect({ direct: { ...current, status } });
        expect(census.writerRuns).toEqual([expect.objectContaining({ id: current.id, status })]);
        expect(() => assertExclusiveMarkerWriter(census, env.GITHUB_RUN_ID)).toThrow(
          "active or conflicting production writer",
        );
      },
    );

    it.each([
      { GITHUB_RUN_ATTEMPT: undefined },
      { GITHUB_RUN_ATTEMPT: "0" },
      { GITHUB_WORKFLOW: undefined },
      { GITHUB_WORKFLOW: "Synthetic CI" },
    ])("refuses absent or invalid execution identity %j", async (environment) => {
      await expect(collect({ environment })).rejects.toThrow("current run census returned an unverified run identity");
    });

    it("fails closed when the direct GET stays unavailable after two re-reads", async () => {
      const directReads = [];
      const sleep = vi.fn(async () => {});
      await expect(collect({ httpStatus: 503, directReads, sleep })).rejects.toThrow(
        "current run census failed with HTTP 503",
      );
      expect(directReads).toHaveLength(3);
      expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
    });
  });

  describe("moving active run census", () => {
    // Synthetic identities; reproduces #8982's moving in_progress total, not its live evidence.
    const deploy = { id: 98201, name: "Platform Deploy", status: "in_progress" };
    const recovery = { id: 98202, name: "Platform Production Stale Helm Recovery", status: "in_progress" };
    const ci = (id, status = "in_progress") => ({ id, name: "Synthetic CI", status });
    const ciBatch = (from, count) => Array.from({ length: count }, (_, index) => ci(from + index));
    const page = (total, runs) => ({ total_count: total, workflow_runs: runs });
    const movingPass = { in_progress: [page(101, [deploy, ...ciBatch(1, 99)]), page(102, [ci(150), ci(151)])] };
    const stablePass = { in_progress: [page(101, [deploy, ...ciBatch(1, 99)]), page(101, [ci(200)])] };
    const passRequests = (pass, inProgressPages = 1) => [
      `${pass}:requested:1`,
      `${pass}:pending:1`,
      `${pass}:queued:1`,
      ...Array.from({ length: inProgressPages }, (_, index) => `${pass}:in_progress:${index + 1}`),
      `${pass}:waiting:1`,
    ];

    // Each pass is a status -> pages script, plus `windows`: created -> pages (a map or a
    // function) for partition reads; the last pass repeats once the script runs out. A page
    // given as an array answers successive reads of that page in order, its last entry repeating.
    async function readPasses(passes, { token = "synthetic-token", headers = {} } = {}) {
      let pass = 0;
      const requests = [];
      const inits = [];
      const lines = [];
      const served = new Map();
      const fetch = vi.fn(async (url, init) => {
        const request = new URL(url);
        const status = request.searchParams.get("status");
        const created = request.searchParams.get("created");
        const pageNumber = Number(request.searchParams.get("page"));
        if (status === "requested" && pageNumber === 1) pass += 1;
        const key = created === null ? `${pass}:${status}:${pageNumber}` : `${pass}:${status}:${created}:${pageNumber}`;
        requests.push(key);
        inits.push(init);
        const script = passes[Math.min(pass, passes.length) - 1];
        const pages =
          created === null
            ? script[status]
            : typeof script.windows === "function"
              ? script.windows(created)
              : script.windows?.[created];
        let body = (pages ?? [page(0, [])])[pageNumber - 1];
        if (Array.isArray(body)) {
          const index = served.get(key) ?? 0;
          served.set(key, index + 1);
          body = body[Math.min(index, body.length - 1)];
        }
        const responseHeaders = new Headers({
          "x-github-request-id": `SYNTH:${pass}:${status}:${pageNumber}`,
          link: `<https://api.example.invalid/repositories/1/actions/runs?status=${status}&per_page=100&page=${pageNumber + 1}>; rel="next"`,
          ...headers,
        });
        if (body?.transportError) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        if (body?.httpStatus) return { ok: false, status: body.httpStatus, headers: responseHeaders };
        if (body?.malformedJson) {
          return {
            ok: true,
            status: 200,
            headers: responseHeaders,
            json: async () => JSON.parse("SENTINEL-BODY-10858 {"),
          };
        }
        return { ok: true, status: 200, headers: responseHeaders, json: async () => body };
      });
      const sleep = vi.fn(async () => {});
      const stderrSink = { write: (chunk) => lines.push(String(chunk)) };
      const evidence = () => {
        expect(lines).toHaveLength(1);
        expect(lines[0].startsWith("production-writer-census-evidence {")).toBe(true);
        expect(lines[0].indexOf("\n")).toBe(lines[0].length - 1);
        return JSON.parse(lines[0].slice("production-writer-census-evidence ".length));
      };
      try {
        const census = await readGitHubProductionWriterCensus({
          fetch,
          sleep,
          stderrSink,
          env: {
            GITHUB_TOKEN: token,
            GITHUB_REPOSITORY: "synthetic/repository",
            GITHUB_RUN_ID: String(deploy.id),
            GITHUB_API_URL: "https://api.example.invalid",
          },
        });
        return { census, requests, sleep, inits, lines, evidence };
      } catch (error) {
        return { error, requests, sleep, inits, lines, evidence };
      }
    }

    it("discards a pass whose total moved and returns only the next complete stable pass", async () => {
      const { census, error, requests, sleep } = await readPasses([movingPass, stablePass]);
      expect(error).toBeUndefined();
      expect(requests).toEqual([
        ...passRequests(1).slice(0, 3),
        "1:in_progress:1",
        "1:in_progress:2",
        ...passRequests(2, 2),
      ]);
      expect(sleep.mock.calls).toEqual([[1_000]]);
      const ids = census.runs.map(({ id }) => id);
      expect(ids).toHaveLength(101);
      expect(ids).toContain(200);
      expect(ids).not.toContain(150);
      expect(census.writerRuns.map(({ id }) => id)).toEqual([deploy.id]);
      expect(() => assertExclusiveMarkerWriter(census, String(deploy.id))).not.toThrow();
    });

    it.each([
      [
        "a duplicate or moving run",
        { queued: [page(1, [ci(300, "queued")])], in_progress: [page(2, [deploy, ci(300)])] },
        { in_progress: [page(2, [deploy, ci(300)])] },
        1,
      ],
      [
        "an empty page under a stable total",
        { in_progress: [page(102, [deploy, ...ciBatch(1, 99)]), page(102, [])] },
        { in_progress: [page(101, [deploy, ...ciBatch(1, 99)]), page(101, [ci(300)])] },
        2,
      ],
    ])("re-reads the whole census after %s and trusts only the stable pass", async (_label, moving, stable, pages) => {
      const { census, error, requests, sleep } = await readPasses([moving, stable]);
      expect(error).toBeUndefined();
      expect(requests.filter((request) => request.startsWith("2:"))).toEqual(passRequests(2, pages));
      expect(sleep.mock.calls).toEqual([[1_000]]);
      expect(census.runs.find(({ id }) => id === 300)).toMatchObject({ status: "in_progress" });
      expect(census.writerRuns.map(({ id }) => id)).toEqual([deploy.id]);
    });

    it("keeps refusing with the original error when every bounded pass moves", async () => {
      const { census, error, requests, sleep } = await readPasses([movingPass]);
      expect(census).toBeUndefined();
      // Every pass repeats the same moved total, so the provider answer is stable (N3 keeps the sub-reason).
      expect(error.message).toBe(
        "census-stable-count-list-drift after 5 passes: GitHub Actions in_progress run census total moved during pagination. Final pass per-status total/collected: requested 0/0, pending 0/0, queued 0/0, in_progress 101/100.",
      );
      expect(requests.filter((request) => request.endsWith(":requested:1"))).toHaveLength(5);
      expect(requests.at(-1)).toBe("5:in_progress:2");
      expect(sleep.mock.calls).toEqual([[1_000], [2_000], [3_000], [4_000]]);
    });

    it("still refuses a conflicting writer that only the stable pass observed", async () => {
      const conflicting = { in_progress: [page(101, [deploy, ...ciBatch(1, 99)]), page(101, [recovery])] };
      const { census, error } = await readPasses([movingPass, conflicting]);
      expect(error).toBeUndefined();
      expect(census.writerRuns.map(({ id }) => id)).toEqual([deploy.id, recovery.id]);
      expect(() => assertExclusiveMarkerWriter(census, String(deploy.id))).toThrow(
        "active or conflicting production writer",
      );
      expect(() => assertExclusiveProductionHelmWriter(census, { currentRunId: String(deploy.id) })).toThrow(
        /only active writer; observed 2/,
      );
    });

    it.each([
      [
        "a malformed run identity",
        [page(1, [{ id: 0, name: "Synthetic CI" }])],
        /malformed run identity/,
        "census-malformed",
      ],
      [
        "an invalid response",
        [{ total_count: 1 }],
        /in_progress run census returned an invalid response/,
        "census-invalid-response",
      ],
      [
        "an HTTP client failure",
        [{ httpStatus: 404 }],
        /in_progress run census failed with HTTP 404/,
        "census-http-status",
      ],
      [
        "an exceeded page bound",
        Array.from({ length: 10 }, (_, index) => page(1001, ciBatch(1 + index * 100, 100))),
        /exceeded the bounded 10-page limit/,
        "census-page-limit",
      ],
    ])("does not retry %s", async (_label, inProgress, message, refusalClass) => {
      const { error, requests, sleep, evidence } = await readPasses([{ in_progress: inProgress }, stablePass]);
      expect(error.message).toMatch(message);
      expect(error.message.startsWith(`${refusalClass} after 1 pass: GitHub Actions `)).toBe(true);
      expect(requests.every((request) => request.startsWith("1:"))).toBe(true);
      expect(sleep).not.toHaveBeenCalled();
      expect(evidence()).toMatchObject({ outcome: "refused", refusalClass, message: error.message });
    });

    it("records the HTTP status and request ID of every refused read and each 5xx retry", async () => {
      const { evidence } = await readPasses([{ in_progress: [{ httpStatus: 502 }] }]);
      const refused = {
        path: "actions/runs?status=in_progress&per_page=100&page=1",
        httpStatus: 502,
        requestId: "SYNTH:1:in_progress:1",
        linkPages: { next: 2 },
      };
      const line = evidence();
      expect(line.passes[0].statuses.in_progress.requests).toEqual([refused, refused, refused]);
      expect(line.serverErrorRetries).toEqual([
        { ...refused, delayMs: 1_000 },
        { ...refused, delayMs: 2_000 },
      ]);
    });

    describe("census server errors", () => {
      const ok = page(1, [deploy]);
      it.each([
        ["502 then OK recovers", { in_progress: [[{ httpStatus: 502 }, ok]] }, 2, [[1_000]], null],
        [
          "three 503s refuse",
          { in_progress: [[{ httpStatus: 503 }, { httpStatus: 503 }, { httpStatus: 503 }, ok]] },
          3,
          [[1_000], [2_000]],
          "census-http-status after 1 pass: GitHub Actions in_progress run census failed with HTTP 503.",
        ],
        [
          "404 is read once",
          { in_progress: [[{ httpStatus: 404 }, ok]] },
          1,
          [],
          "census-http-status after 1 pass: GitHub Actions in_progress run census failed with HTTP 404.",
        ],
        [
          "429 is read once",
          { in_progress: [[{ httpStatus: 429 }, ok]] },
          1,
          [],
          "census-http-status after 1 pass: GitHub Actions in_progress run census failed with HTTP 429.",
        ],
        [
          "a transport error is read once",
          { in_progress: [[{ transportError: true }, ok]] },
          1,
          [],
          "census-unclassified after 1 pass: TypeError (ECONNRESET).",
        ],
        [
          "malformed JSON is read once",
          { in_progress: [[{ malformedJson: true }, ok]] },
          1,
          [],
          "census-invalid-response after 1 pass: GitHub Actions in_progress run census returned an invalid response.",
        ],
        [
          "an invalid page is read once",
          { in_progress: [[{ total_count: 1 }, ok]] },
          1,
          [],
          "census-invalid-response after 1 pass: GitHub Actions in_progress run census returned an invalid response.",
        ],
        [
          "the exhausted six-retry budget refuses",
          {
            pending: [[{ httpStatus: 502 }, { httpStatus: 502 }, page(0, [])]],
            queued: [[{ httpStatus: 502 }, { httpStatus: 502 }, page(0, [])]],
            in_progress: [[{ httpStatus: 502 }, { httpStatus: 502 }, ok]],
            waiting: [[{ httpStatus: 502 }, page(0, [])]],
          },
          3,
          [[1_000], [2_000], [1_000], [2_000], [1_000], [2_000]],
          "census-http-status after 1 pass: GitHub Actions waiting run census failed with HTTP 502.",
        ],
      ])("%s", async (_label, pass, inProgressReads, sleeps, refusal) => {
        const { census, error, requests, sleep, lines, evidence } = await readPasses([pass]);
        expect(requests.filter((request) => request === "1:in_progress:1")).toHaveLength(inProgressReads);
        expect(sleep.mock.calls).toEqual(sleeps);
        expect(requests.every((request) => request.startsWith("1:"))).toBe(true);
        if (refusal === null) {
          expect(error).toBeUndefined();
          expect(census.writerRuns.map(({ id }) => id)).toEqual([deploy.id]);
          expect(evidence()).toMatchObject({
            outcome: "admitted",
            passes: [{ pass: 1, reason: null }],
            serverErrorRetries: [{ path: "actions/runs?status=in_progress&per_page=100&page=1", httpStatus: 502 }],
          });
        } else {
          expect(census).toBeUndefined();
          expect(error.message.startsWith(refusal)).toBe(true);
          expect(evidence().serverErrorRetries).toHaveLength(sleeps.length);
          expect(lines.join("")).not.toContain("SENTINEL-BODY-10858");
        }
      });
    });

    // Synthetic reproduction of #10842's refusal shape: page 1 lists nine runs, page 2 is empty, total_count is 10.
    const countListDrift = { in_progress: [page(10, [deploy, ...ciBatch(1, 8)]), page(10, [])] };
    const movingShortfall = (pass) => ({ in_progress: [page(10, [deploy, ...ciBatch(pass * 100, 8)]), page(10, [])] });

    it("partitions five identical shortfall passes and refuses windows that do not reconcile", async () => {
      // No window lists a run here, so the partition reads 0 + 0 against the total of 10.
      const { census, error, requests, sleep, inits, evidence } = await readPasses([countListDrift]);
      expect(census).toBeUndefined();
      expect(error.message).toBe(
        "census-partition-unreconciled after 5 passes: GitHub Actions in_progress run census partition did not reconcile: window totals sum to 0, not the global total 10. Final pass per-status total/collected: requested 0/0, pending 0/0, queued 0/0, in_progress 10/9.",
      );
      expect(error.message.length).toBeLessThanOrEqual(512);
      expect(requests.filter((request) => request.endsWith(":requested:1"))).toHaveLength(5);
      expect(sleep.mock.calls).toEqual([[1_000], [2_000], [3_000], [4_000]]);
      expect(inits).toHaveLength(27);
      for (const init of inits) {
        expect(init.method).toBe("GET");
        expect(init).not.toHaveProperty("body");
      }
      const line = evidence();
      expect(line).toMatchObject({
        schemaVersion: "production-writer-census-evidence/v1",
        repository: "synthetic/repository",
        currentRunId: String(deploy.id),
        outcome: "refused",
        refusalClass: "census-partition-unreconciled",
        message: error.message,
        reads: [],
        truncated: false,
      });
      expect(line.partitions).toMatchObject([
        {
          status: "in_progress",
          totalCount: 10,
          windows: [
            { totalCounts: [0], runIds: [] },
            { totalCounts: [0], runIds: [] },
          ],
          reread: null,
          statuses: {},
        },
      ]);
      expect(line.passes.map(({ pass }) => pass)).toEqual([1, 2, 3, 4, 5]);
      for (const pass of line.passes) {
        expect(pass.reason).toBe("GitHub Actions in_progress run census pagination was incomplete; collected 9 of 10.");
        // The incomplete status ends the pass before waiting is read.
        expect(Object.keys(pass.statuses)).toEqual(["requested", "pending", "queued", "in_progress"]);
        expect(pass.statuses.in_progress).toMatchObject({
          readAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
          totalCounts: [10, 10],
          pageLengths: [9, 0],
          runIds: [deploy.id, 1, 2, 3, 4, 5, 6, 7, 8],
        });
        expect(
          pass.statuses.in_progress.requests.map(({ path, requestId, linkPages }) => [path, requestId, linkPages]),
        ).toEqual([
          ["actions/runs?status=in_progress&per_page=100&page=1", `SYNTH:${pass.pass}:in_progress:1`, { next: 2 }],
          ["actions/runs?status=in_progress&per_page=100&page=2", `SYNTH:${pass.pass}:in_progress:2`, { next: 3 }],
        ]);
      }
      // Only the writer candidate keeps full identity; unchanged non-writers stay IDs per status.
      expect(line.runs).toEqual([
        {
          id: deploy.id,
          status: "in_progress",
          name: "Platform Deploy",
          path: null,
          event: null,
          headSha: null,
          headBranch: null,
          runAttempt: null,
          createdAt: null,
          updatedAt: null,
          passes: [1, 2, 3, 4, 5],
        },
      ]);
    });

    it("classifies a shortfall whose run IDs change between passes as moving", async () => {
      const { error, requests, sleep, evidence } = await readPasses([1, 2, 3, 4, 5].map(movingShortfall));
      expect(error.message).toBe(
        "census-moving after 5 passes: GitHub Actions in_progress run census pagination was incomplete; collected 9 of 10. Final pass per-status total/collected: requested 0/0, pending 0/0, queued 0/0, in_progress 10/9.",
      );
      // Moving passes never engage the partition: five passes, no window read.
      expect(requests).toEqual([1, 2, 3, 4, 5].flatMap((pass) => passRequests(pass, 2).slice(0, -1)));
      expect(sleep.mock.calls).toEqual([[1_000], [2_000], [3_000], [4_000]]);
      const line = evidence();
      expect(line.refusalClass).toBe("census-moving");
      // Runs whose membership differs across passes keep full identity, with the passes that listed them.
      expect(line.runs.find(({ id }) => id === 100)).toMatchObject({ name: "Synthetic CI", passes: [1] });
      expect(line.runs.find(({ id }) => id === 500)).toMatchObject({ name: "Synthetic CI", passes: [5] });
      expect(line.runs).toHaveLength(41);
    });

    it("writes one admitted evidence line after a discarded pass and none for a first stable pass", async () => {
      const retried = await readPasses([movingPass, stablePass]);
      expect(retried.error).toBeUndefined();
      expect(retried.evidence()).toMatchObject({
        outcome: "admitted",
        refusalClass: null,
        message: null,
        passes: [
          { pass: 1, reason: "GitHub Actions in_progress run census total moved during pagination." },
          { pass: 2, reason: null },
        ],
      });
      const stable = await readPasses([stablePass]);
      expect(stable.census.writerRuns.map(({ id }) => id)).toEqual([deploy.id]);
      expect(stable.lines).toEqual([]);
    });

    it("keeps the token, other headers, display titles, commit bodies and raw names out of every output", async () => {
      const sentinels = [
        "SENTINEL-TOKEN-10850",
        "SENTINEL-HEADER-10850",
        "SENTINEL-TITLE-10850",
        "SENTINEL-COMMIT-10850",
      ];
      const leaky = (id) => ({
        ...ci(id),
        display_title: "SENTINEL-TITLE-10850",
        head_commit: { message: "SENTINEL-COMMIT-10850", author: { email: "SENTINEL-COMMIT-10850" } },
      });
      const injected = { ...leaky(77), name: "Synthetic CI\n::error::injected" };
      const passes = [
        { in_progress: [page(10, [deploy, injected, leaky(1), leaky(2)]), page(10, [])] },
        { in_progress: [page(10, [deploy, leaky(1), leaky(2)]), page(10, [])] },
      ];
      const options = {
        token: "SENTINEL-TOKEN-10850",
        headers: {
          "x-sentinel": "SENTINEL-HEADER-10850",
          link: '<https://SENTINEL-HEADER-10850.invalid/runs?page=4>; rel="last"',
        },
      };
      const refused = await readPasses(passes, options);
      const admitted = await readPasses([passes[0], { in_progress: [page(3, [deploy, leaky(1), leaky(2)])] }], options);
      // Window and 5xx records: stable drift, a 502 window read, then a recovered leaky run.
      const dated = (run, minute) => ({ ...run, created_at: `2026-10-31T08:0${minute}:00Z` });
      const listed = [dated(deploy, 0), dated(leaky(1), 1), dated(leaky(2), 2)];
      const partitioned = await readPasses(
        [
          {
            in_progress: [page(4, listed), page(4, [])],
            windows: {
              "<2026-10-31T08:01:00Z": [page(1, listed.slice(0, 1))],
              ">=2026-10-31T08:01:00Z": [[{ httpStatus: 502 }, page(3, [...listed.slice(1), dated(leaky(3), 3)])]],
            },
          },
        ],
        options,
      );
      expect(refused.error.message.startsWith("census-moving after 5 passes: ")).toBe(true);
      expect(admitted.error).toBeUndefined();
      expect(partitioned.error).toBeUndefined();
      expect(partitioned.evidence()).toMatchObject({
        partitions: [{ windows: [{ totalCounts: [1] }, { totalCounts: [3], pageLengths: [3] }] }],
        serverErrorRetries: [{ httpStatus: 502, linkPages: { last: 4 }, delayMs: 1_000 }],
      });
      const outputs = [
        refused.lines.join(""),
        refused.error.message,
        admitted.lines.join(""),
        JSON.stringify(admitted.census),
        partitioned.lines.join(""),
        JSON.stringify(partitioned.census),
      ];
      for (const output of outputs) {
        for (const sentinel of sentinels) expect(output).not.toContain(sentinel);
        expect(output).not.toMatch(/authorization|bearer/i);
      }
      for (const { lines, evidence } of [refused, admitted]) {
        const line = evidence();
        expect(lines[0]).toContain(String.raw`"name":"Synthetic CI\n::error::injected"`);
        expect(lines[0].split("\n")).toEqual([expect.stringMatching(/^production-writer-census-evidence \{/), ""]);
        expect(line.passes[0].statuses.in_progress.requests[0].linkPages).toEqual({ last: 4 });
        expect(line.runs.find(({ id }) => id === 77)).toMatchObject({ name: "Synthetic CI\n::error::injected" });
      }
    });

    it.each([
      [
        "writer-candidate identities only",
        1,
        (line) => expect(line.passes[0].statuses.in_progress.runIds).toHaveLength(900),
      ],
      [
        "run ID counts",
        1_000_000_000_000,
        (line) => {
          expect(line.passes[0].statuses.in_progress).not.toHaveProperty("runIds");
          expect(line.passes[0].statuses.in_progress.runIdCount).toBe(900);
        },
      ],
    ])("caps the evidence line at 64 KiB by keeping %s", async (_label, idBase, expectKept) => {
      // Nine full pages of new runs per pass under a total of 1,000 move every pass and keep 4,500 identities.
      const bulk = (pass) => ({
        in_progress: [
          ...Array.from({ length: 9 }, (_, index) =>
            page(
              1_000,
              ciBatch(idBase + pass * 10_000 + index * 100, 100).map((run, offset) =>
                index === 0 && offset === 0 ? deploy : run,
              ),
            ),
          ),
          page(1_000, []),
        ],
      });
      const { error, lines, evidence } = await readPasses([1, 2, 3, 4, 5].map(bulk));
      expect(error.message.startsWith("census-moving after 5 passes: ")).toBe(true);
      const json = lines[0].slice("production-writer-census-evidence ".length, -1);
      expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(65_536);
      const line = evidence();
      expect(line).toMatchObject({ truncated: true, refusalClass: "census-moving", message: error.message });
      expect(line.runs.map(({ id }) => id)).toEqual([deploy.id]);
      expectKept(line);
    });

    describe("stable count/list drift partition", () => {
      // Synthetic identities created a minute apart; #10842's shape lists nine runs under a total of 10.
      const deployPath = ".github/workflows/platform-production.yml";
      const recoveryPath = ".github/workflows/platform-production-stale-helm-recovery.yml";
      const signaturesPath = ".github/workflows/platform-merge-group-failure-signatures.yml";
      const at = (minute) => `2026-10-31T08:${String(minute).padStart(2, "0")}:00Z`;
      const datedDeploy = { ...deploy, path: deployPath, created_at: at(0) };
      const dated = (id, overrides = {}) => ({
        ...ci(id),
        path: ".github/workflows/synthetic-ci.yml",
        created_at: at(id),
        ...overrides,
      });
      const datedBatch = (from, count) => Array.from({ length: count }, (_, index) => dated(from + index));
      const listed = [datedDeploy, ...datedBatch(1, 8)];
      const recovered = dated(9);
      // The median of the nine listed creation times.
      const split = at(4);
      const before = `<${split}`;
      const after = `>=${split}`;
      const reconciled = {
        [before]: [page(4, listed.slice(0, 4))],
        [after]: [page(6, [...listed.slice(4), recovered])],
      };
      const drift = (windows, overrides = {}) => ({
        in_progress: [page(10, listed), page(10, [])],
        windows,
        ...overrides,
      });
      const driftPasses = [1, 2, 3, 4, 5].flatMap((pass) => passRequests(pass, 2).slice(0, -1));
      const onePerPage = (total, runs) => runs.map((run) => page(total, [run]));
      const earlier = (run) => ({ ...run, created_at: "2026-10-31T07:59:00Z" });
      // Captured identity of the provider-side queued ghost (marker-go-1030-r2.run-37642385358.json), unchanged.
      const ghost = {
        id: 37642385358,
        name: "Platform Delivery Failure Signatures",
        workflow_id: 311990192,
        path: signaturesPath,
        status: "queued",
        event: "workflow_run",
        head_sha: "7bef4f208a3586d4f6e1150b129b64b4216de485",
        head_branch: "main",
        run_attempt: 1,
        created_at: "2026-10-07T15:09:11Z",
        run_started_at: "2026-10-07T15:09:11Z",
        updated_at: "2026-10-07T15:09:11Z",
      };
      const unknownQueued = {
        id: 98599,
        name: "Synthetic Unknown Workflow",
        path: ".github/workflows/synthetic-unknown.yml",
        status: "queued",
        created_at: at(30),
      };
      // The ghost is listed; an unknown queued run is counted but unlisted until the windows.
      const queuedDrift = (windowGhost) => ({
        queued: [page(2, [ghost]), page(2, [])],
        in_progress: [page(1, [datedDeploy])],
        windows: {
          [`<${ghost.created_at}`]: [page(0, [])],
          [`>=${ghost.created_at}`]: [page(2, [windowGhost, unknownQueued])],
        },
      });

      it("admits the drifted status when complementary windows list exactly its total", async () => {
        const { census, error, requests, sleep, inits, evidence } = await readPasses([drift(reconciled)]);
        expect(error).toBeUndefined();
        expect(requests).toEqual([
          ...driftPasses,
          `5:in_progress:${before}:1`,
          `5:in_progress:${after}:1`,
          "5:in_progress:1",
          "5:in_progress:2",
          "5:waiting:1",
        ]);
        expect(requests.length - driftPasses.length).toBeLessThanOrEqual(20);
        for (const init of inits) {
          expect(init.method).toBe("GET");
          expect(init).not.toHaveProperty("body");
        }
        expect(sleep.mock.calls).toEqual([[1_000], [2_000], [3_000], [4_000]]);
        expect(census.runs.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, deploy.id]);
        expect(census.writerRuns.map(({ id }) => id)).toEqual([deploy.id]);
        expect(() => assertExclusiveMarkerWriter(census, String(deploy.id))).not.toThrow();
        const line = evidence();
        expect(line).toMatchObject({
          outcome: "admitted",
          refusalClass: null,
          truncated: false,
          partitions: [
            {
              pass: "partition",
              status: "in_progress",
              totalCount: 10,
              split,
              windows: [
                {
                  created: before,
                  totalCounts: [4],
                  pageLengths: [4],
                  runIds: [deploy.id, 1, 2, 3],
                  requests: [
                    {
                      path: `actions/runs?status=in_progress&created=${encodeURIComponent(before)}&per_page=100&page=1`,
                      httpStatus: 200,
                      requestId: "SYNTH:5:in_progress:1",
                    },
                  ],
                },
                { created: after, totalCounts: [6], pageLengths: [6], runIds: [4, 5, 6, 7, 8, 9] },
              ],
              reread: { totalCounts: [10, 10], pageLengths: [9, 0] },
              statuses: { waiting: { totalCounts: [0], runIds: [] } },
            },
          ],
        });
        // Only the partition listed the recovered run, so it keeps full identity.
        expect(line.runs.find(({ id }) => id === 9)).toMatchObject({ name: "Synthetic CI", passes: ["partition"] });
      });

      it("recovers an unknown queued non-writer beside the unchanged ghost and leaves writerRuns identical", async () => {
        const baseline = await readPasses([
          { queued: [page(2, [ghost, unknownQueued])], in_progress: [page(1, [datedDeploy])] },
        ]);
        const { census, error, requests } = await readPasses([queuedDrift(ghost)]);
        expect(error).toBeUndefined();
        expect(requests.slice(-6)).toEqual([
          `5:queued:<${ghost.created_at}:1`,
          `5:queued:>=${ghost.created_at}:1`,
          "5:queued:1",
          "5:queued:2",
          "5:in_progress:1",
          "5:waiting:1",
        ]);
        expect(census.runs.map(({ id }) => id)).toEqual(baseline.census.runs.map(({ id }) => id));
        expect(census.writerRuns).toEqual(baseline.census.writerRuns);
        expect(census.writerRuns.map(({ id }) => id)).toEqual([deploy.id]);
      });

      it("splits at the final global read time when no listed run is dated", async () => {
        const { census, error, requests, evidence } = await readPasses([
          {
            queued: [page(1, [])],
            in_progress: [page(1, [datedDeploy])],
            windows: (created) => (created.startsWith("<") ? [page(1, [ghost])] : [page(0, [])]),
          },
        ]);
        expect(error).toBeUndefined();
        const readAt = evidence().passes[4].statuses.queued.readAt;
        expect(requests.filter((request) => /[<>]/.test(request))).toEqual([
          `5:queued:<${readAt.slice(0, 19)}Z:1`,
          `5:queued:>=${readAt.slice(0, 19)}Z:1`,
        ]);
        expect(census.runs.map(({ id }) => id)).toEqual([deploy.id, ghost.id]);
        expect(census.writerRuns.map(({ id }) => id)).toEqual([deploy.id]);
      });

      it.each([
        ["Platform Deploy at the failure-signatures path", dated(9, { name: "Platform Deploy", path: signaturesPath })],
        [
          "Platform Delivery Failure Signatures at the Platform Deploy path",
          dated(9, { name: "Platform Delivery Failure Signatures", path: deployPath }),
        ],
      ])("refuses the marker when the recovered run is %s", async (_label, writer) => {
        const { census, error } = await readPasses([
          drift({ [before]: reconciled[before], [after]: [page(6, [...listed.slice(4), writer])] }),
        ]);
        expect(error).toBeUndefined();
        expect(census.writerRuns.map(({ id }) => id)).toEqual([9, deploy.id]);
        expect(() => assertExclusiveMarkerWriter(census, String(deploy.id))).toThrow(
          "active or conflicting production writer",
        );
        expect(() => assertExclusiveProductionHelmWriter(census, { currentRunId: String(deploy.id) })).toThrow(
          /only active writer; observed 2/,
        );
      });

      const listed21 = [datedDeploy, ...datedBatch(1, 20)];
      const listed19 = [datedDeploy, ...datedBatch(1, 18)];
      const cappedWriter = earlier(
        dated(98502, { name: "Platform Production Stale Helm Recovery", path: recoveryPath }),
      );
      it.each([
        [
          "an unknown queued run counted but never listed in its window",
          {
            queued: [page(2, [unknownQueued]), page(2, [])],
            in_progress: [page(1, [datedDeploy])],
            windows: { [`<${at(30)}`]: [page(1, [])], [`>=${at(30)}`]: [page(1, [unknownQueued])] },
          },
          /window created<2026-10-31T08:30:00Z pagination was incomplete; collected 0 of 1\./,
        ],
        [
          "a window with an empty page before its total",
          drift({ [before]: reconciled[before], [after]: [page(6, listed.slice(4)), page(6, [])] }),
          /window created>=2026-10-31T08:04:00Z pagination was incomplete; collected 5 of 6\./,
        ],
        [
          "a window that lists more runs than it counts",
          drift({ [before]: [page(3, listed.slice(0, 4))], [after]: [page(7, [...listed.slice(4), recovered])] }),
          /window created<2026-10-31T08:04:00Z pagination was incomplete; collected 4 of 3\./,
        ],
        [
          "window totals that differ from total_count",
          drift({ [before]: reconciled[before], [after]: [page(5, listed.slice(4))] }),
          /window totals sum to 9, not the global total 10\./,
        ],
        [
          "a duplicate ID across windows",
          drift({
            [before]: reconciled[before],
            [after]: [page(6, [...listed.slice(4), dated(3, { created_at: at(9) })])],
          }),
          /duplicate or moving run 3\./,
        ],
        [
          "a window run with another status",
          drift({
            [before]: reconciled[before],
            [after]: [page(6, [...listed.slice(4), dated(9, { status: "queued" })])],
          }),
          /window created>=2026-10-31T08:04:00Z listed run 9 with status "queued"\./,
        ],
        [
          "the ghost renamed between the passes and the windows",
          queuedDrift({ ...ghost, name: "Synthetic Renamed Workflow" }),
          /listed run 37642385358 is absent from or changed in the windows\./,
        ],
        [
          "the ghost with a changed head between the passes and the windows",
          queuedDrift({ ...ghost, head_sha: "c".repeat(40) }),
          /listed run 37642385358 is absent from or changed in the windows\./,
        ],
        [
          "the ghost with a changed status between the passes and the windows",
          queuedDrift({ ...ghost, status: "in_progress" }),
          /listed run 37642385358 with status "in_progress"\./,
        ],
        [
          "a final global re-read that no longer repeats the drift",
          drift(reconciled, { in_progress: [[page(10, listed), page(10, [...listed, recovered])], page(10, [])] }),
          /the final global re-read did not repeat the drift signature\./,
        ],
        [
          "a writer-named run only beyond a window's 10-page bound",
          {
            in_progress: [page(22, listed21), page(22, [])],
            windows: {
              [`<${at(10)}`]: onePerPage(11, [...listed21.slice(0, 10), cappedWriter]),
              [`>=${at(10)}`]: [page(11, listed21.slice(10))],
            },
          },
          /window created<2026-10-31T08:10:00Z exceeded the bounded 10-page limit\./,
        ],
        [
          "an exceeded GET bound",
          {
            in_progress: [page(20, listed19), page(20, [])],
            windows: {
              [`<${at(9)}`]: onePerPage(10, [...listed19.slice(0, 9), earlier(dated(19))]),
              [`>=${at(9)}`]: onePerPage(10, listed19.slice(9)),
            },
          },
          /the fallback exceeded the bounded 20-read limit\./,
        ],
      ])("refuses %s as census-partition-unreconciled", async (_label, pass, reason) => {
        const { census, error, evidence } = await readPasses([pass]);
        expect(census).toBeUndefined();
        expect(error.message).toMatch(
          /^census-partition-unreconciled after 5 passes: GitHub Actions (in_progress|queued) run census partition did not reconcile: /,
        );
        expect(error.message).toMatch(reason);
        expect(evidence()).toMatchObject({ outcome: "refused", refusalClass: "census-partition-unreconciled" });
      });
    });
  });

  describe("writer candidates by name or path", () => {
    const deployPath = ".github/workflows/platform-production.yml";
    const recoveryPath = ".github/workflows/platform-production-stale-helm-recovery.yml";
    const signaturesPath = ".github/workflows/platform-merge-group-failure-signatures.yml";
    // Synthetic current writer runs.
    const deploy = {
      id: 98401,
      name: "Platform Deploy",
      workflow_id: 984,
      path: deployPath,
      status: "in_progress",
      event: "workflow_dispatch",
      head_sha: "a".repeat(40),
      head_branch: "main",
      run_attempt: 1,
      created_at: "2026-10-30T23:00:00Z",
      updated_at: "2026-10-30T23:00:01Z",
    };
    const recovery = {
      ...deploy,
      id: 98402,
      name: "Platform Production Stale Helm Recovery",
      workflow_id: 985,
      path: recoveryPath,
    };
    // Captured identity of the provider-side queued ghost (marker-go-1030-r2.run-37642385358.json), unchanged.
    const ghost = {
      id: 37642385358,
      name: "Platform Delivery Failure Signatures",
      workflow_id: 311990192,
      path: signaturesPath,
      status: "queued",
      event: "workflow_run",
      head_sha: "7bef4f208a3586d4f6e1150b129b64b4216de485",
      head_branch: "main",
      run_attempt: 1,
      created_at: "2026-10-07T15:09:11Z",
      run_started_at: "2026-10-07T15:09:11Z",
      updated_at: "2026-10-07T15:09:11Z",
    };
    const workflowSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

    // Lists `current` and `listed` by status; serves real workflow sources and zero jobs so that
    // only the writer projection, never the fixture, can keep a candidate out of writerRuns.
    async function collect({ current = deploy, listed = [] } = {}) {
      const fetch = vi.fn(async (url) => {
        const request = new URL(url);
        let body;
        if (request.pathname.endsWith("/actions/runs")) {
          const workflow_runs = [current, ...listed].filter((run) => run.status === request.searchParams.get("status"));
          body = { total_count: workflow_runs.length, workflow_runs };
        } else if (request.pathname.includes("/contents/")) {
          const content = workflowSource(request.pathname.split("/contents/")[1]);
          body = { type: "file", encoding: "base64", content: Buffer.from(content).toString("base64") };
        } else if (/\/actions\/runs\/\d+\/attempts\/\d+\/jobs$/.test(request.pathname)) {
          body = { total_count: 0, jobs: [] };
        } else {
          throw new Error(`Unexpected synthetic request: ${url}`);
        }
        return { ok: true, status: 200, json: async () => body };
      });
      return readGitHubProductionWriterCensus({
        fetch,
        sleep: async () => {},
        stderrSink: { write: () => {} },
        env: {
          GITHUB_TOKEN: "synthetic-token",
          GITHUB_REPOSITORY: "synthetic/repository",
          GITHUB_RUN_ID: String(current.id),
          GITHUB_RUN_ATTEMPT: String(current.run_attempt),
          GITHUB_WORKFLOW: current.name,
          GITHUB_API_URL: "https://api.example.invalid",
        },
      });
    }

    it.each([
      ["none of them", []],
      ["the ghost's captured identity", [ghost]],
      [
        "the ghost ID with a synthetic changed name, head and status (still non-writer)",
        [{ ...ghost, name: "Synthetic Renamed Workflow", head_sha: "c".repeat(40), status: "pending" }],
      ],
      [
        "an unknown queued non-writer",
        [{ ...ghost, id: 98499, name: "Synthetic Unknown Workflow", path: ".github/workflows/synthetic-unknown.yml" }],
      ],
    ])("admits the current Platform Deploy with %s", async (_label, listed) => {
      const census = await collect({ listed });
      expect(census.writerRuns).toEqual((await collect()).writerRuns);
      expect(census.writerRuns.map(({ id }) => id)).toEqual([deploy.id]);
      expect(() => assertExclusiveMarkerWriter(census, String(deploy.id))).not.toThrow();
      // Non-writers stay recorded as evidence in runs.
      expect(census.runs.map(({ id }) => id)).toEqual([deploy.id, ...listed.map(({ id }) => id)].sort((a, b) => a - b));
    });

    it("records the ghost with its created and updated times", async () => {
      const census = await collect({ listed: [ghost] });
      expect(census.runs.find(({ id }) => id === ghost.id)).toMatchObject({
        name: "Platform Delivery Failure Signatures",
        path: signaturesPath,
        status: "queued",
        createdAt: "2026-10-07T15:09:11Z",
        updatedAt: "2026-10-07T15:09:11Z",
      });
    });

    it.each([
      ["a Platform Deploy run at a non-writer path", deploy, { ...deploy, id: 98410, path: signaturesPath }],
      [
        "a non-writer name at the Platform Deploy path",
        deploy,
        { ...deploy, id: 98411, name: "Platform Delivery Failure Signatures", workflow_id: 311990192 },
      ],
      ["the ghost identity renamed Platform Deploy", deploy, { ...ghost, name: "Platform Deploy" }],
      [
        "a queued zero-job Platform Production Stale Helm Recovery",
        deploy,
        { ...recovery, id: 98412, status: "queued", head_sha: "b".repeat(40) },
      ],
      [
        "a non-writer name at the Platform Deploy path while the recovery is current",
        recovery,
        { ...deploy, id: 98413, name: "Platform Delivery Failure Signatures", workflow_id: 311990192 },
      ],
    ])("refuses %s as a writer candidate", async (_label, current, candidate) => {
      const census = await collect({ current, listed: [candidate] });
      // Admission is asserted first, so each caller's refusal is proven on its own.
      expect(() => assertExclusiveMarkerWriter(census, String(current.id))).toThrow(
        "active or conflicting production writer",
      );
      expect(() => assertExclusiveProductionHelmWriter(census, { currentRunId: String(current.id) })).toThrow(
        /only active writer; observed 2/,
      );
      expect(census.writerRuns.map(({ id }) => id)).toEqual([current.id, candidate.id].sort((a, b) => a - b));
      expect(census.concurrencyQueuedRuns).toEqual([]);
    });
  });

  it("collects the complete bounded active workflow census before selecting Helm writers", async () => {
    const requestedUrls = [];
    const fetch = vi.fn(async (url) => {
      requestedUrls.push(url);
      const status = new URL(url).searchParams.get("status");
      const workflowRuns =
        status === "in_progress"
          ? [
              {
                id: 7504,
                name: "Platform Production Stale Helm Recovery",
                status,
                event: "workflow_dispatch",
                head_sha: "a".repeat(40),
                head_branch: "main",
                run_attempt: 1,
                actor: { login: "synthetic-operator" },
                created_at: "2026-08-27T07:30:00Z",
                run_started_at: "2026-08-27T07:30:01Z",
                updated_at: "2026-08-27T07:30:02Z",
                html_url: "https://example.invalid/runs/7504",
              },
            ]
          : status === "pending"
            ? [
                {
                  id: 7400,
                  name: "Platform Production Restore Point Cleanup",
                  status,
                  event: "schedule",
                  head_sha: "b".repeat(40),
                  head_branch: "main",
                  run_attempt: 1,
                  actor: { login: "synthetic-scheduler" },
                  created_at: "2026-08-27T07:00:00Z",
                  run_started_at: "2026-08-27T07:00:01Z",
                  updated_at: "2026-08-27T07:00:02Z",
                  html_url: "https://example.invalid/runs/7400",
                },
              ]
            : [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ total_count: workflowRuns.length, workflow_runs: workflowRuns }),
      };
    });

    const census = await readGitHubProductionWriterCensus({
      fetch,
      checkedAt: "2026-08-27T07:31:00Z",
      env: {
        GITHUB_TOKEN: "synthetic-token",
        GITHUB_REPOSITORY: "synthetic/repository",
        GITHUB_RUN_ID: "7504",
        GITHUB_API_URL: "https://api.example.invalid",
      },
    });

    expect(requestedUrls).toHaveLength(5);
    expect(requestedUrls.map((url) => new URL(url).searchParams.get("status"))).toEqual([
      "requested",
      "pending",
      "queued",
      "in_progress",
      "waiting",
    ]);
    expect(census).toMatchObject({
      schemaVersion: "github-actions-production-writer-census/v1",
      currentRunId: "7504",
      runs: [{ id: 7400 }, { id: 7504 }],
      writerRuns: [{ id: 7504, name: "Platform Production Stale Helm Recovery", status: "in_progress" }],
    });
  });

  it("records and rejects an active Helm hook operation without confusing application pods", async () => {
    const calls = [];
    const census = await readHelmOperationCensus({
      release: "proof",
      namespace: "production",
      checkedAt: "2026-08-27T07:31:00Z",
      spawn: completedSpawn(calls, [
        {
          code: 0,
          stdout: JSON.stringify({
            items: [
              {
                kind: "Job",
                metadata: {
                  name: "proof-pre-upgrade",
                  creationTimestamp: "2026-08-27T07:30:00Z",
                  annotations: { "helm.sh/hook": "pre-upgrade" },
                },
                status: { active: 1, conditions: [] },
              },
              {
                kind: "Pod",
                metadata: { name: "proof-application" },
                status: { phase: "Running" },
              },
            ],
          }),
        },
      ]),
    });

    expect(calls[0]).toMatchObject({
      command: "kubectl",
      args: [
        "get",
        "jobs,pods",
        "--namespace",
        "production",
        "--selector",
        "app.kubernetes.io/instance=proof",
        "--output",
        "json",
      ],
    });
    expect(census).toMatchObject({
      schemaVersion: "platform-kubernetes-helm-operation-census/v1",
      hooks: [{ kind: "Job", name: "proof-pre-upgrade", active: true }],
      activeOperations: [{ kind: "Job", name: "proof-pre-upgrade" }],
    });
  });

  it("recovers only the exact stable stale pending-upgrade frontier and refuses duplicate admission", async () => {
    const rawIndex = JSON.stringify(productionIndex);
    const capturedIndexDigest = `sha256:${createHash("sha256").update(rawIndex).digest("hex")}`;
    const admittedHistory = [
      {
        revision: 307,
        status: "superseded",
        description: "Synthetic older release",
        updated: "2026-08-24T15:00:00Z",
        chart: "proof-1.0.0",
        app_version: "1.0.0",
      },
      {
        revision: 308,
        status: "deployed",
        description: "Upgrade complete",
        updated: "2026-08-24T15:35:51Z",
        chart: "proof-1.0.0",
        app_version: "1.0.0",
      },
      {
        revision: 309,
        status: "pending-upgrade",
        description: "Preparing upgrade",
        updated: "2026-08-24T16:57:26Z",
        chart: "proof-1.0.0",
        app_version: "1.0.0",
      },
    ];
    const recoveredHistory = [
      admittedHistory[0],
      { ...admittedHistory[1], status: "superseded" },
      admittedHistory[2],
      {
        revision: 310,
        status: "deployed",
        description: "Rollback to 308",
        updated: "2026-08-27T08:00:00Z",
        chart: "proof-1.0.0",
        app_version: "1.0.0",
      },
    ];
    const census = {
      schemaVersion: "github-actions-production-writer-census/v1",
      capturedAt: "2026-08-27T07:30:00Z",
      currentRunId: "7504",
      runs: [],
      writerRuns: [
        {
          id: 7504,
          name: "Platform Production Stale Helm Recovery",
          status: "in_progress",
        },
      ],
    };
    const rollback = vi.fn(async (options) => ({
      action: "rollback",
      result: "success",
      rollbackIdentity: {
        sourceRevision: Number(options.revision),
        resultingRevision: 310,
        observedTag: rollbackTag,
        observedDigest: rollbackDigest,
        workloadIdentities: [],
      },
    }));
    const admissions = [];
    const calls = [];
    const result = await recoverStableStalePendingUpgrade({
      release: "proof",
      namespace: "production",
      sourceRevision: 308,
      pendingRevision: 309,
      sourceDescription: "Upgrade complete",
      pendingDescription: "Preparing upgrade",
      issueNumber: 7504,
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: capturedIndexDigest,
      indexManifest: rawIndex,
      platform: "linux/amd64",
      lastKnownGoodCommit: rollbackTag,
      releaseTag: "release-synthetic-proof",
      checkedAt: "2026-08-27T07:30:00Z",
      env: { GITHUB_RUN_ID: "7504" },
      readWriterCensus: async () => structuredClone(census),
      readOperationCensus: async () => ({
        schemaVersion: "platform-kubernetes-helm-operation-census/v1",
        activeOperations: [],
      }),
      rollback,
      onAdmission: async (admission) => admissions.push(admission),
      spawn: completedSpawn(calls, [
        { code: 0, stdout: helmHistory(admittedHistory) },
        { code: 0, stdout: JSON.stringify(rollbackValues) },
        { code: 0, stdout: rollbackWorkloadList() },
        { code: 0, stdout: helmHistory(admittedHistory) },
        { code: 0, stdout: helmHistory(recoveredHistory) },
        { code: 0, stdout: helmHistory(recoveredHistory) },
      ]),
    });

    expect(result).toMatchObject({
      schemaVersion: "platform-kubernetes-stale-pending-recovery/v1",
      result: "success",
      admission: {
        schemaVersion: "platform-kubernetes-stale-pending-recovery-admission/v1",
        sourceRevision: 308,
        pendingRevision: 309,
        sourceUpdated: "2026-08-24T15:35:51Z",
        pendingUpdated: "2026-08-24T16:57:26Z",
      },
      rollback: { result: "success", rollbackIdentity: { resultingRevision: 310 } },
    });
    expect(admissions).toHaveLength(1);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(rollback.mock.calls[0][0].expectedPreRollbackHistory).toEqual(
      admittedHistory.map(({ revision, status, description }) => ({ revision, status, description })),
    );

    const duplicateCalls = [];
    const duplicate = await recoverStableStalePendingUpgrade({
      release: "proof",
      namespace: "production",
      sourceRevision: 308,
      pendingRevision: 309,
      sourceDescription: "Upgrade complete",
      pendingDescription: "Preparing upgrade",
      issueNumber: 7504,
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: capturedIndexDigest,
      indexManifest: rawIndex,
      platform: "linux/amd64",
      lastKnownGoodCommit: rollbackTag,
      releaseTag: "release-synthetic-proof",
      env: { GITHUB_RUN_ID: "7504" },
      readWriterCensus: async () => structuredClone(census),
      readOperationCensus: async () => ({
        schemaVersion: "platform-kubernetes-helm-operation-census/v1",
        activeOperations: [],
      }),
      rollback,
      spawn: completedSpawn(duplicateCalls, [{ code: 0, stdout: helmHistory(recoveredHistory) }]),
    });
    expect(duplicate).toMatchObject({ result: "refused" });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(duplicateCalls).toHaveLength(1);
  });

  it("refuses active writers and moved or extended pending-upgrade history before rollback", async () => {
    const history = [
      {
        revision: 308,
        status: "deployed",
        description: "Upgrade complete",
        updated: "2026-08-24T15:35:51Z",
      },
      {
        revision: 309,
        status: "pending-upgrade",
        description: "Preparing upgrade",
        updated: "2026-08-24T16:57:26Z",
      },
    ];
    const baseCensus = {
      schemaVersion: "github-actions-production-writer-census/v1",
      currentRunId: "7504",
      writerRuns: [{ id: 7504, name: "Platform Production Stale Helm Recovery", status: "in_progress" }],
    };
    const baseOptions = {
      release: "proof",
      namespace: "production",
      sourceRevision: 308,
      pendingRevision: 309,
      sourceDescription: "Upgrade complete",
      pendingDescription: "Preparing upgrade",
      issueNumber: 7504,
      registryName: "chase-sets",
      repository: "chase-sets-platform",
      tag: rollbackTag,
      digest: rollbackDigest,
      lastKnownGoodCommit: rollbackTag,
      releaseTag: "release-synthetic-proof",
      env: { GITHUB_RUN_ID: "7504" },
      readOperationCensus: async () => ({
        schemaVersion: "platform-kubernetes-helm-operation-census/v1",
        activeOperations: [],
      }),
    };
    const rollback = vi.fn();

    const activeWriterCalls = [];
    const activeWriter = await recoverStableStalePendingUpgrade({
      ...baseOptions,
      readWriterCensus: async () => ({
        ...baseCensus,
        writerRuns: [...baseCensus.writerRuns, { id: 7505, name: "Platform Deploy", status: "in_progress" }],
      }),
      rollback,
      spawn: completedSpawn(activeWriterCalls, []),
    });
    expect(activeWriter).toMatchObject({ result: "refused", reason: expect.stringContaining("only active writer") });
    expect(activeWriterCalls).toHaveLength(0);

    const activeOperationCalls = [];
    const activeOperation = await recoverStableStalePendingUpgrade({
      ...baseOptions,
      readWriterCensus: async () => structuredClone(baseCensus),
      readOperationCensus: async () => ({
        schemaVersion: "platform-kubernetes-helm-operation-census/v1",
        activeOperations: [{ kind: "Job", name: "proof-pre-upgrade" }],
      }),
      rollback,
      spawn: completedSpawn(activeOperationCalls, []),
    });
    expect(activeOperation).toMatchObject({
      result: "refused",
      reason: expect.stringContaining("Job/proof-pre-upgrade"),
    });
    expect(activeOperationCalls).toHaveLength(0);

    const movedCalls = [];
    const moved = await recoverStableStalePendingUpgrade({
      ...baseOptions,
      readWriterCensus: async () => structuredClone(baseCensus),
      rollback,
      spawn: completedSpawn(movedCalls, [
        { code: 0, stdout: helmHistory(history) },
        { code: 0, stdout: JSON.stringify(rollbackValues) },
        { code: 0, stdout: rollbackWorkloadList() },
        {
          code: 0,
          stdout: helmHistory([
            ...history,
            {
              revision: 310,
              status: "failed",
              description: "Concurrent revision",
              updated: "2026-08-27T07:31:00Z",
            },
          ]),
        },
      ]),
    });
    expect(moved).toMatchObject({ result: "refused", reason: expect.stringContaining("history moved") });

    const extraCalls = [];
    const extra = await recoverStableStalePendingUpgrade({
      ...baseOptions,
      readWriterCensus: async () => structuredClone(baseCensus),
      rollback,
      spawn: completedSpawn(extraCalls, [
        {
          code: 0,
          stdout: helmHistory([
            ...history,
            {
              revision: 310,
              status: "failed",
              description: "Existing extra revision",
              updated: "2026-08-27T07:29:00Z",
            },
          ]),
        },
      ]),
    });
    expect(extra).toMatchObject({ result: "refused", reason: expect.stringContaining("exactly one revision") });
    expect(rollback).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong source revision", { sourceRevision: 307 }],
    ["wrong source status", { sourceStatus: "superseded" }],
    ["wrong source description", { sourceDescription: "Install complete" }],
    ["wrong pending status", { pendingStatus: "failed" }],
    ["unknown pending state", { pendingStatus: "unknown" }],
    ["wrong pending description", { pendingDescription: "Upgrade failed" }],
  ])("refuses the stale pending-upgrade one-factor mutant: %s", (_label, mutant) => {
    const history = [
      {
        revision: 308,
        status: mutant.sourceStatus ?? "deployed",
        description: mutant.sourceDescription ?? "Upgrade complete",
        updated: "2026-08-24T15:35:51Z",
      },
      {
        revision: 309,
        status: mutant.pendingStatus ?? "pending-upgrade",
        description: mutant.pendingDescription ?? "Preparing upgrade",
        updated: "2026-08-24T16:57:26Z",
      },
    ];
    expect(() =>
      selectStableStalePendingUpgrade(history, {
        sourceRevision: mutant.sourceRevision ?? 308,
        pendingRevision: 309,
        sourceDescription: "Upgrade complete",
        pendingDescription: "Preparing upgrade",
      }),
    ).toThrow(/Stale pending-upgrade recovery/);
  });

  it("verifies only the exact post-recovery revision and preserved pending frontier", () => {
    const before = [
      {
        revision: 308,
        status: "deployed",
        description: "Upgrade complete",
        updated: "2026-08-24T15:35:51Z",
      },
      {
        revision: 309,
        status: "pending-upgrade",
        description: "Preparing upgrade",
        updated: "2026-08-24T16:57:26Z",
      },
    ];
    const after = [
      { ...before[0], status: "superseded" },
      before[1],
      {
        revision: 310,
        status: "deployed",
        description: "Rollback to 308",
        updated: "2026-08-27T08:00:00Z",
      },
    ];
    expect(verifyStalePendingRecoveryTransition(before, after, { sourceRevision: 308, pendingRevision: 309 })).toEqual(
      after[2],
    );
    expect(() =>
      verifyStalePendingRecoveryTransition(before, [...after, { ...after[2], revision: 311 }], {
        sourceRevision: 308,
        pendingRevision: 309,
      }),
    ).toThrow("exactly resulting revision 310");
    expect(() =>
      verifyStalePendingRecoveryTransition(before, [after[0], { ...before[1], status: "failed" }, after[2]], {
        sourceRevision: 308,
        pendingRevision: 309,
      }),
    ).toThrow('revision 309 must have status "pending-upgrade"');
  });

  it("verifies a stale pending-upgrade recovery across a saturated Helm history window", () => {
    const before = Array.from({ length: 10 }, (_, index) => {
      const revision = 300 + index;
      return {
        revision,
        status: revision === 308 ? "deployed" : revision === 309 ? "pending-upgrade" : "superseded",
        description: revision === 309 ? "Preparing upgrade" : `Revision ${revision}`,
        updated: `2026-08-24T15:${revision - 300}0:00Z`,
      };
    });
    const after = [
      ...before.slice(1, 8),
      { ...before[8], status: "superseded" },
      before[9],
      {
        revision: 310,
        status: "deployed",
        description: "Rollback to 308",
        updated: "2026-08-27T08:00:00Z",
      },
    ];
    const verify = (observedHistory) =>
      verifyStalePendingRecoveryTransition(before, observedHistory, {
        sourceRevision: 308,
        pendingRevision: 309,
      });
    const replaceRevision = (revision, replacement) =>
      after.map((entry) => (entry.revision === revision ? { ...entry, ...replacement } : entry));

    expect(verify(after)).toEqual(after.at(-1));
    expect(() => verify([...after, { ...after.at(-1), revision: 311 }])).toThrow("exactly resulting revision 310");
    expect(() => verify(after.filter((entry) => entry.revision !== 308))).toThrow("removed required revision 308");
    expect(() => verify(after.filter((entry) => entry.revision !== 309))).toThrow("removed required revision 309");
    expect(() => verify(replaceRevision(301, { description: "Changed retained revision" }))).toThrow(
      "moved revision 301",
    );
    expect(() => verify(replaceRevision(301, { status: "failed" }))).toThrow(
      'revision 301 must have status "superseded"',
    );
    expect(() => verify(replaceRevision(310, { status: "failed" }))).toThrow("resulting revision 310 must be deployed");
    expect(() => verify(replaceRevision(310, { description: "Rollback to 307" }))).toThrow(
      "resulting revision 310 must be deployed",
    );
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

  it("selects a failed-rollback recovery target only for a superseded target with a uniform failed rollback tail", () => {
    // Revisions 406-415 replay the retained production history from #8104
    // (helm-history-pre-rollback-1220.json): Helm replaced revision 415's
    // "Rollback to 413" description with its failure text, so the target is
    // recovered from the values Helm copied verbatim from 413 into 415.
    const productionHistory = [
      ...[406, 407, 408, 409, 410, 411, 412].map((revision) => ({
        revision,
        status: "superseded",
        description: "Upgrade complete",
      })),
      { revision: 413, status: "superseded", description: "Rollback to 411" },
      { revision: 414, status: "superseded", description: "Upgrade complete" },
      { revision: 415, status: "failed", description: productionFailedRollbackDescription },
    ];
    expect(
      selectFailedRollbackRecoveryTarget(productionHistory, {
        revisionValues: new Map([
          [415, rollbackValues],
          [414, supersededCandidateValues],
          [413, rollbackValues],
        ]),
      }),
    ).toBe(413);
    // Values-based identification never guesses: without the failed revision's
    // values, or with an unread newer candidate, there is no target.
    expect(selectFailedRollbackRecoveryTarget(productionHistory)).toBeNull();
    expect(
      selectFailedRollbackRecoveryTarget(productionHistory, {
        revisionValues: new Map([
          [415, rollbackValues],
          [413, rollbackValues],
        ]),
      }),
    ).toBeNull();
    expect(
      selectFailedRollbackRecoveryTarget(productionHistory, {
        revisionValues: new Map([
          [415, rollbackValues],
          [414, supersededCandidateValues],
          [413, supersededCandidateValues],
        ]),
      }),
    ).toBeNull();

    const supersededHistory = [
      { revision: 411, status: "superseded", description: "Upgrade complete" },
      { revision: 413, status: "superseded", description: "Rollback to 411" },
      { revision: 414, status: "superseded", description: "Upgrade complete" },
    ];
    const failedRollbacks = (count, description = "Rollback to 413") =>
      Array.from({ length: count }, (_, index) => ({ revision: 415 + index, status: "failed", description }));
    for (const count of [1, 2, 3]) {
      expect(selectFailedRollbackRecoveryTarget([...supersededHistory, ...failedRollbacks(count)])).toBe(413);
      expect(
        selectFailedRollbackRecoveryTarget(
          [...supersededHistory, ...failedRollbacks(count, productionFailedRollbackDescription)],
          {
            revisionValues: new Map([
              [415, rollbackValues],
              [416, rollbackValues],
              [417, rollbackValues],
              [414, supersededCandidateValues],
              [413, rollbackValues],
            ]),
          },
        ),
      ).toBe(413);
    }
    expect(selectFailedRollbackRecoveryTarget([...supersededHistory, ...failedRollbacks(4)])).toBeNull();
    expect(
      selectFailedRollbackRecoveryTarget([...supersededHistory, ...failedRollbacks(1, 'Upgrade "proof" failed: hook')]),
    ).toBeNull();
    expect(
      selectFailedRollbackRecoveryTarget([...supersededHistory, ...failedRollbacks(1, "Synthetic failure")]),
    ).toBeNull();
    expect(
      selectFailedRollbackRecoveryTarget([
        ...supersededHistory,
        ...failedRollbacks(1),
        { revision: 416, status: "failed", description: "Rollback to 411" },
      ]),
    ).toBeNull();
    expect(
      selectFailedRollbackRecoveryTarget([...supersededHistory, ...failedRollbacks(1, "Rollback to 999")]),
    ).toBeNull();
    expect(
      selectFailedRollbackRecoveryTarget([
        { revision: 411, status: "failed", description: 'Upgrade "proof" failed: hook' },
        { revision: 412, status: "superseded", description: "Upgrade complete" },
        { revision: 413, status: "failed", description: "Rollback to 411" },
      ]),
    ).toBeNull();
    expect(
      selectFailedRollbackRecoveryTarget([
        { revision: 413, status: "deployed", description: "Rollback to 411" },
        { revision: 414, status: "failed", description: "Rollback to 413" },
      ]),
    ).toBeNull();
    expect(
      selectFailedRollbackRecoveryTarget([
        ...supersededHistory,
        { revision: 415, status: "pending-rollback", description: "Rollback to 413" },
      ]),
    ).toBeNull();
    expect(selectFailedRollbackRecoveryTarget(supersededHistory)).toBeNull();
  });

  it("heals a failed-rollback tail by exact rollback before capturing the target", async () => {
    const calls = [];
    const target = await captureKubernetesRollbackTarget(
      failedRollbackCaptureOptions(calls, [
        ...failedRollbackAdmissionCompletions(),
        ...failedRollbackHealCompletions(),
        ...failedRollbackCaptureCompletions(),
      ]),
    );

    const rollbackCalls = calls.filter((call) => call.command === "helm" && call.args[0] === "rollback");
    expect(rollbackCalls).toHaveLength(1);
    expect(rollbackCalls[0].args).toEqual([
      "rollback",
      "proof",
      "413",
      "--namespace",
      "production",
      "--wait",
      "--timeout",
      "30s",
    ]);
    expect(calls.some((call) => call.args[0] === "upgrade")).toBe(false);
    expect(calls.slice(0, 7).map((call) => [call.command, call.args[0], call.args[1]])).toEqual([
      ["helm", "history", "proof"],
      ["helm", "get", "values"],
      ["helm", "get", "values"],
      ["helm", "get", "values"],
      ["kubectl", "get", "deployments.apps,jobs.batch,rollouts.argoproj.io"],
      ["kubectl", "get", "jobs,pods"],
      ["helm", "history", "proof"],
    ]);
    expect(calls.slice(1, 4).map((call) => call.args[call.args.indexOf("--revision") + 1])).toEqual([
      "415",
      "414",
      "413",
    ]);
    expect(calls.indexOf(rollbackCalls[0])).toBeGreaterThan(6);

    expect(target).toMatchObject({
      sourceRevision: 416,
      sourceStatus: "deployed",
      sourceDescription: "Rollback to 413",
      observedTag: rollbackTag,
      observedDigest: rollbackDigest,
      imageIdentityProof: { kind: "exact-digest", digest: rollbackDigest },
      historyHeadRevision: 416,
      terminalFailedSuffix: [],
      preDeployHistory: failedRollbackPostHistory,
    });
    expect(target.failedRollbackRecovery).toEqual({
      preRecoveryHistory: failedRollbackPreHistory,
      targetRevision: 413,
      failedRollbackRevisions: [415],
      rollback: expect.objectContaining({
        action: "rollback",
        result: "success",
        release: "proof",
        namespace: "production",
        rollbackIdentity: expect.objectContaining({
          sourceRevision: 413,
          resultingRevision: 416,
          observedTag: rollbackTag,
          observedDigest: rollbackDigest,
        }),
      }),
      resultingRevision: 416,
    });
    expect(target.workloadIdentities).toHaveLength(1);

    const ordinaryCalls = [];
    const ordinary = await captureKubernetesRollbackTarget(
      failedRollbackCaptureOptions(ordinaryCalls, failedRollbackCaptureCompletions()),
    );
    expect(ordinaryCalls.some((call) => call.args[0] === "rollback")).toBe(false);
    expect(ordinaryCalls.map((call) => [call.command, call.args[0]])).toEqual([
      ["helm", "history"],
      ["helm", "get"],
      ["kubectl", "get"],
      ["helm", "history"],
    ]);
    expect(ordinary).toMatchObject({
      sourceRevision: 416,
      historyHeadRevision: 416,
      preDeployHistory: failedRollbackPostHistory,
    });
    expect(ordinary).not.toHaveProperty("failedRollbackRecovery");
  });

  it("refuses failed-rollback recovery on any mismatch and stops on a failed heal", async () => {
    const admission = failedRollbackAdmissionCompletions();
    const refusals = [
      {
        name: "live workload image differs from the target",
        completions: [
          ...admission.slice(0, 4),
          {
            code: 0,
            stdout: rollbackWorkloadList(
              `registry.digitalocean.com/chase-sets/chase-sets-platform@${failedCandidateDigest}`,
            ),
          },
        ],
        message: "does not match",
      },
      {
        name: "active Helm hook operation",
        completions: [
          ...admission.slice(0, 5),
          {
            code: 0,
            stdout: JSON.stringify({
              items: [
                {
                  kind: "Job",
                  metadata: {
                    name: "proof-chase-sets-platform-platform-bootstrap",
                    annotations: { "helm.sh/hook": "pre-upgrade" },
                  },
                  status: { active: 1, conditions: [] },
                },
              ],
            }),
          },
        ],
        message: "requires no active Helm hook operation",
      },
      {
        name: "history moves between reads",
        completions: [
          ...admission.slice(0, 6),
          {
            code: 0,
            stdout: helmHistory([
              ...failedRollbackPreHistory,
              { revision: 416, status: "failed", description: "Rollback to 413" },
            ]),
          },
        ],
        message: "Helm history moved during failed-rollback recovery admission",
      },
      {
        name: "target values disagree with the expected identity",
        completions: [
          admission[0],
          { code: 0, stdout: JSON.stringify(supersededCandidateValues) },
          { code: 0, stdout: JSON.stringify(supersededCandidateValues) },
        ],
        message: "does not match captured rollback identity",
      },
    ];
    for (const refusal of refusals) {
      const calls = [];
      await expect(
        captureKubernetesRollbackTarget(failedRollbackCaptureOptions(calls, refusal.completions)),
        refusal.name,
      ).rejects.toThrow(refusal.message);
      expect(
        calls.some((call) => call.args[0] === "rollback"),
        refusal.name,
      ).toBe(false);
      expect(
        calls.some((call) => call.args[0] === "upgrade"),
        refusal.name,
      ).toBe(false);
    }

    for (const unrecoverableTail of [
      [{ revision: 415, status: "failed", description: 'Upgrade "proof" failed: Synthetic hook failure' }],
      Array.from({ length: 4 }, (_, index) => ({
        revision: 415 + index,
        status: "failed",
        description: "Rollback to 413",
      })),
    ]) {
      const calls = [];
      await expect(
        captureKubernetesRollbackTarget(
          failedRollbackCaptureOptions(calls, [
            { code: 0, stdout: helmHistory([...failedRollbackPreHistory.slice(0, 2), ...unrecoverableTail]) },
          ]),
        ),
      ).rejects.toThrow("Rollback target capture requires exactly one deployed Helm revision; observed 0.");
      expect(calls.map((call) => [call.command, call.args[0]])).toEqual([["helm", "history"]]);
    }

    const failedHealCalls = [];
    await expect(
      captureKubernetesRollbackTarget(
        failedRollbackCaptureOptions(failedHealCalls, [
          ...admission,
          ...failedRollbackHealCompletions().slice(0, 3),
          { code: 1, stderr: "Error: cannot patch Certificate" },
        ]),
      ),
    ).rejects.toThrow(
      /^Failed-rollback recovery to revision 413 failed: .*helm rollback proof 413 .*exited with code 1/,
    );
    expect(failedHealCalls.filter((call) => call.args[0] === "rollback")).toHaveLength(1);
    expect(failedHealCalls.at(-1).args[0]).toBe("rollback");
    expect(failedHealCalls.some((call) => call.args[0] === "upgrade")).toBe(false);

    const wrongHeadCalls = [];
    await expect(
      captureKubernetesRollbackTarget(
        failedRollbackCaptureOptions(wrongHeadCalls, [
          ...admission,
          ...failedRollbackHealCompletions(),
          {
            code: 0,
            stdout: helmHistory([
              ...failedRollbackPostHistory,
              { revision: 417, status: "deployed", description: "Upgrade complete" },
            ]),
          },
        ]),
      ),
    ).rejects.toThrow("Failed-rollback recovery to revision 413 must leave revision 416 deployed");
    expect(wrongHeadCalls.some((call) => call.args[0] === "upgrade")).toBe(false);
  });

  it("verifies a deployment transition from a healed rollback target", async () => {
    const healed = await captureKubernetesRollbackTarget(
      failedRollbackCaptureOptions(
        [],
        [
          ...failedRollbackAdmissionCompletions(),
          ...failedRollbackHealCompletions(),
          ...failedRollbackCaptureCompletions(),
        ],
      ),
    );
    // The workflow round-trips the record through a JSON file before the
    // transition check consumes its preDeployHistory.
    const rollbackTarget = JSON.parse(JSON.stringify(healed));
    expect(rollbackTarget.failedRollbackRecovery.targetRevision).toBe(413);
    const observedHistory = [
      failedRollbackPostHistory[0],
      failedRollbackPostHistory[1],
      failedRollbackPostHistory[2],
      { ...failedRollbackPostHistory[3], status: "superseded" },
      { revision: 417, status: "deployed", description: "Upgrade complete" },
    ];

    const transition = await verifyKubernetesDeploymentTransition({
      release: "proof",
      namespace: "production",
      checkedAt: "2026-09-21T13:00:00.000Z",
      rollbackTarget,
      spawn: completedSpawn([], [{ code: 0, stdout: helmHistory(observedHistory) }]),
    });
    expect(transition).toEqual({
      schemaVersion: "platform-kubernetes-deployment-transition/v1",
      checkedAt: "2026-09-21T13:00:00.000Z",
      release: "proof",
      namespace: "production",
      capturedHeadRevision: 416,
      resultingHeadRevision: 417,
      capturedHistory: failedRollbackPostHistory,
      observedHistory,
    });

    for (const [name, observed, message] of [
      [
        "healed head not superseded by a deployed revision",
        [...failedRollbackPostHistory, { revision: 417, status: "failed", description: "Upgrade failed" }],
        'to have status "deployed"',
      ],
      [
        "failed rollback revision changed after the heal",
        [...observedHistory.slice(0, 2), { ...observedHistory[2], status: "superseded" }, ...observedHistory.slice(3)],
        "Captured Helm revision 415 moved during deployment transition",
      ],
      [
        "two new revisions after the healed head",
        [...observedHistory, { revision: 418, status: "deployed", description: "Upgrade complete" }],
        "expected only revision 417",
      ],
    ]) {
      await expect(
        verifyKubernetesDeploymentTransition({
          rollbackTarget,
          spawn: completedSpawn([], [{ code: 0, stdout: helmHistory(observed) }]),
        }),
        name,
      ).rejects.toThrow(message);
    }
  });

  it("verifies one exact deployed Helm transition", async () => {
    const capturedHistory = [
      { revision: 308, status: "deployed", description: "Synthetic source" },
      { revision: 309, status: "failed", description: "Synthetic failure" },
    ];
    const observedHistory = [
      { ...capturedHistory[0], status: "superseded" },
      capturedHistory[1],
      { revision: 310, status: "deployed", description: "Synthetic upgrade complete" },
    ];
    const transition = await verifyKubernetesDeploymentTransition({
      release: "proof",
      namespace: "production",
      checkedAt: "2026-08-25T20:10:00.000Z",
      rollbackTarget: {
        schemaVersion: "platform-kubernetes-rollback-target/v2",
        sourceRevision: 308,
        sourceStatus: "deployed",
        historyHeadRevision: 309,
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
      capturedHeadRevision: 309,
      resultingHeadRevision: 310,
      capturedHistory,
      observedHistory,
    });
  });

  it("verifies one exact deployed Helm transition when saturated history prunes the oldest revision", async () => {
    const capturedHistory = Array.from({ length: 10 }, (_, index) => ({
      revision: 300 + index,
      status: index === 8 ? "deployed" : index === 9 ? "failed" : "superseded",
      description: `Synthetic revision ${300 + index}`,
    }));
    const observedHistory = [
      ...capturedHistory.slice(1, 8),
      { ...capturedHistory[8], status: "superseded" },
      capturedHistory[9],
      { revision: 310, status: "deployed", description: "Synthetic upgrade complete" },
    ];

    const transition = await verifyKubernetesDeploymentTransition({
      rollbackTarget: {
        schemaVersion: "platform-kubernetes-rollback-target/v2",
        sourceRevision: 308,
        sourceStatus: "deployed",
        historyHeadRevision: 309,
        terminalFailedSuffix: [capturedHistory[9]],
        preDeployHistory: capturedHistory,
      },
      spawn: completedSpawn([], [{ code: 0, stdout: helmHistory(observedHistory) }]),
    });

    expect(transition).toMatchObject({
      capturedHeadRevision: 309,
      resultingHeadRevision: 310,
      capturedHistory,
      observedHistory,
    });
  });

  it.each([
    {
      name: "missing revision",
      observed: [
        { revision: 700, status: "superseded", description: "Synthetic source" },
        { revision: 701, status: "failed", description: "Synthetic failure" },
      ],
      message: "expected only revision 702; observed none",
    },
    {
      name: "extra revisions",
      observed: [
        { revision: 700, status: "deployed", description: "Synthetic source" },
        { revision: 701, status: "failed", description: "Synthetic failure" },
        { revision: 702, status: "superseded", description: "Synthetic first result" },
        { revision: 703, status: "deployed", description: "Synthetic second result" },
      ],
      message: "expected only revision 702; observed 702, 703",
    },
    {
      name: "nonconsecutive revision",
      observed: [
        { revision: 700, status: "deployed", description: "Synthetic source" },
        { revision: 701, status: "failed", description: "Synthetic failure" },
        { revision: 703, status: "deployed", description: "Synthetic gap" },
      ],
      message: "expected only revision 702; observed 703",
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

  it.each([
    {
      name: "missing terminal failed suffix",
      observed: [
        { revision: 700, status: "superseded", description: "Synthetic source" },
        { revision: 702, status: "deployed", description: "Synthetic upgrade complete" },
      ],
      message: "Captured terminal failed revision 701 moved or disappeared",
    },
    {
      name: "changed terminal failed suffix status",
      observed: [
        { revision: 700, status: "superseded", description: "Synthetic source" },
        { revision: 701, status: "superseded", description: "Synthetic failure" },
        { revision: 702, status: "deployed", description: "Synthetic upgrade complete" },
      ],
      message: "Captured Helm revision 701 moved during deployment transition",
    },
    {
      name: "changed captured description",
      observed: [
        { revision: 700, status: "superseded", description: "Synthetic source changed" },
        { revision: 701, status: "failed", description: "Synthetic failure" },
        { revision: 702, status: "deployed", description: "Synthetic upgrade complete" },
      ],
      message: "Captured Helm revision 700 moved during deployment transition",
    },
  ])("refuses a $name during revision-keyed reconciliation", async ({ observed, message }) => {
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

  it("parses the closed stale pending-upgrade recovery command grammar", () => {
    expect(
      parseArgs(
        [
          "recover-stale-pending-upgrade",
          "--revision=308",
          "--pending-revision=309",
          "--source-description=Upgrade complete",
          "--pending-description=Preparing upgrade",
          "--issue-number=7504",
          "--admission-out=artifacts/admission.json",
        ],
        { GITHUB_RUN_ID: "7504" },
      ),
    ).toMatchObject({
      command: "recover-stale-pending-upgrade",
      sourceRevision: "308",
      pendingRevision: "309",
      sourceDescription: "Upgrade complete",
      pendingDescription: "Preparing upgrade",
      issueNumber: "7504",
      admissionOutPath: "artifacts/admission.json",
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

// #9662 admission-webhook transient retry. Real fixtures come from Platform Deploy run 38672454609:
// attempt-1 rollback target 683-692 (artifact 11945153043), attempt-2 rollback target 686-695
// (artifact 11946120539) and attempt-2 transition 695 -> 696 (artifact 11946265479). Every one-job
// reshape below is labelled synthetic.
const retryRelease = "chase-sets-platform";
const retryNamespace = "chase-sets-platform";
const admissionNoAgentCall =
  'cannot patch "chase-sets-platform-doks-tls" with kind Certificate: Internal error occurred: failed calling webhook "webhook.cert-manager.io": failed to call webhook: Post "https://cert-manager-webhook.cert-manager.svc:443/validate?timeout=30s": No agent available';
const admissionTransientStderr = `Error: UPGRADE FAILED: an error occurred while rolling back the release. original upgrade error: ${admissionNoAgentCall}: ${admissionNoAgentCall}\n`;
const admissionTransientLine = admissionTransientStderr.trim().slice("Error: ".length, "Error: ".length + 500);
const admissionCode = "doks-admission-webhook-unreachable";
// Synthetic: a webhook path long enough that the 500-character bound drops `No agent available`.
const longAdmissionTransientStderr = admissionTransientStderr.replaceAll("/validate", `/synthetic-${"x".repeat(250)}`);
const plantedEnvOverride = "planted-override-9662.invalid";
const retryCapturedHistory = Array.from({ length: 10 }, (_, index) => ({
  revision: 683 + index,
  status: index === 9 ? "deployed" : "superseded",
  description: "Upgrade complete",
}));
const retryUpgradeFailure = {
  revision: 693,
  status: "superseded",
  description: `Upgrade "chase-sets-platform" failed: ${admissionNoAgentCall}`,
};
const retryRollbackFailure = {
  revision: 694,
  status: "failed",
  description: `Rollback "chase-sets-platform" failed: ${admissionNoAgentCall}`,
};
// Synthetic: the in-job history between the failed atomic rollback and the restore; Helm keeps
// ten revisions, so 693 and 694 prune 683-684 while the captured source 692 is still deployed.
const retryAdmissionHistory = [...retryCapturedHistory.slice(2), retryUpgradeFailure, retryRollbackFailure];
// Real: the attempt-2 rollback target history 686-695.
const retryBaselineHistory = [
  ...retryCapturedHistory.slice(3, 9),
  { ...retryCapturedHistory[9], status: "superseded" },
  retryUpgradeFailure,
  retryRollbackFailure,
  { revision: 695, status: "deployed", description: "Rollback to 692" },
];
// Real: the attempt-2 transition's observed history 687-696.
const retryObservedHistory = [
  ...retryBaselineHistory.slice(1, 9),
  { ...retryBaselineHistory[9], status: "superseded" },
  { revision: 696, status: "deployed", description: "Upgrade complete" },
];
// Synthetic: Helm's atomic rollback succeeded, leaving a deployed `Rollback to 692` at H+2.
const atomicRolledBackHistory = [
  ...retryCapturedHistory.slice(2, 9),
  { ...retryCapturedHistory[9], status: "superseded" },
  { ...retryUpgradeFailure, status: "failed" },
  { revision: 694, status: "deployed", description: "Rollback to 692" },
];
// The attempts record's representation of a history: each exact description only as its SHA-256.
const descriptionSha256 = (description) => `sha256:${createHash("sha256").update(description).digest("hex")}`;
const fingerprintedHistory = (history) =>
  history.map(({ revision, status, description }) => ({
    revision,
    status,
    descriptionSha256: descriptionSha256(description),
  }));
// Synthetic: error text that a retained captured revision (690) and a failed intermediate (694)
// can carry in their Helm descriptions; neither may reach the attempts record.
const retainedHistorySentinel = "SYNTHETIC_RETAINED_HISTORY_VALUE_9662";
const intermediateFailureSentinel = "SYNTHETIC_INTERMEDIATE_FAILURE_VALUE_9662";
const withHistorySentinels = (history, intermediateValue = intermediateFailureSentinel) =>
  history.map((entry) => {
    if (entry.revision === 690) {
      return { ...entry, description: `Synthetic retained Helm failure: TOKEN=${retainedHistorySentinel}` };
    }
    if (entry.revision === 694) {
      return { ...entry, description: `${entry.description}: synthetic API_TOKEN=${intermediateValue}` };
    }
    return entry;
  });
const retryWorkloadList = rollbackWorkloadList().replaceAll('"proof', `"${retryRelease}`);
const probeCertificate = "certificate/chase-sets-platform-doks-tls";

function manualClock() {
  const epoch = Date.parse("2026-10-15T03:00:00.000Z");
  const timers = [];
  let now = 0;
  let sequence = 0;
  return {
    now: () => now,
    isoNow: () => new Date(epoch + now).toISOString(),
    setTimeout(callback, milliseconds) {
      const timer = { at: now + Math.max(0, milliseconds), callback, sequence: sequence++ };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = timers.indexOf(timer);
      if (index !== -1) timers.splice(index, 1);
    },
    fireNext() {
      timers.sort((left, right) => left.at - right.at || left.sequence - right.sequence);
      const timer = timers.shift();
      if (!timer) return false;
      now = Math.max(now, timer.at);
      timer.callback();
      return true;
    },
  };
}

async function runOnClock(clock, promise) {
  let settled = null;
  promise.then(
    (value) => (settled = { value }),
    (error) => (settled = { error }),
  );
  for (let turn = 0; turn < 20_000 && !settled; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!settled) clock.fireNext();
  }
  if (!settled) throw new Error("The deploy did not settle on the manual clock.");
  if (settled.error) throw settled.error;
  return settled.value;
}

function stderrSink() {
  const chunks = [];
  return { chunks, write: (chunk) => chunks.push(String(chunk)) > 0, text: () => chunks.join("") };
}

// Routes each fake child by its command so every scenario scripts only what it changes.
function retrySpawn(calls, scenario) {
  return (command, args, options) => {
    const call = { command, args, options, killed: null };
    calls.push(call);
    let completion;
    if (command === "helm" && args[0] === "upgrade") completion = scenario.upgrades.shift();
    else if (command === "helm" && args[0] === "history") {
      const history = scenario.histories.shift();
      completion = history && { stdout: helmHistory(history) };
    } else if (command === "helm" && args[0] === "get") completion = { stdout: JSON.stringify(rollbackValues) };
    else if (command === "helm" && args[0] === "rollback") completion = { code: scenario.rollbackCode ?? 0 };
    else if (command === "kubectl" && args[0] === "annotate") completion = scenario.probes.shift();
    else if (command === "kubectl" && args[1] === "jobs,pods")
      completion = { stdout: scenario.census ?? '{"items":[]}' };
    else if (command === "kubectl" && args[1] === "deployments.apps,jobs.batch,rollouts.argoproj.io")
      completion = { stdout: retryWorkloadList };
    else completion = { code: 0 };
    if (!completion) throw new Error(`Unscripted ${command} ${args[0]} call.`);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = (signal) => {
      call.killed = signal;
      return true;
    };
    const finish = () => {
      if (completion.stdout) child.stdout.emit("data", Buffer.from(completion.stdout));
      if (completion.stderr) child.stderr.emit("data", Buffer.from(completion.stderr));
      child.emit("close", completion.code ?? 0);
    };
    if (completion.hang) return child;
    if (completion.delayMs) scenario.clock.setTimeout(finish, completion.delayMs);
    else queueMicrotask(finish);
    return child;
  };
}

async function retryRollbackTarget(history = retryCapturedHistory) {
  const target = await captureKubernetesRollbackTarget({
    values: rollbackValues,
    release: retryRelease,
    namespace: retryNamespace,
    registryName: "chase-sets",
    repository: "chase-sets-platform",
    tag: rollbackTag,
    digest: rollbackDigest,
    lastKnownGoodCommit: rollbackTag,
    releaseTag: "release-synthetic-9662",
    checkedAt: "2026-10-15T02:55:00.000Z",
    spawn: completedSpawn(
      [],
      [
        { code: 0, stdout: helmHistory(history) },
        { code: 0, stdout: JSON.stringify(rollbackValues) },
        { code: 0, stdout: retryWorkloadList },
        { code: 0, stdout: helmHistory(history) },
      ],
    ),
  });
  // The workflow round-trips the record through production-rollback-target.json.
  return JSON.parse(JSON.stringify(target));
}

function retryScenario(overrides = {}) {
  return {
    clock: manualClock(),
    upgrades: [{ code: 1, stderr: admissionTransientStderr }, { code: 0 }],
    histories: [
      retryAdmissionHistory,
      retryAdmissionHistory,
      retryAdmissionHistory,
      retryBaselineHistory,
      retryBaselineHistory,
      retryBaselineHistory,
    ],
    probes: [
      { code: 0, delayMs: 900 },
      { code: 0, delayMs: 900 },
    ],
    ...overrides,
  };
}

function retryDeployOptions(scenario, calls, extra = {}) {
  return {
    values: rollbackValues,
    release: retryRelease,
    namespace: retryNamespace,
    timeout: "30s",
    image: `registry.digitalocean.com/chase-sets/chase-sets-platform:${"e".repeat(40)}@sha256:${"d".repeat(64)}`,
    envOverrides: { DEPLOYMENT_ENVIRONMENT: "production", ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS: plantedEnvOverride },
    // A context whose own default namespace is `default`; the probe must still name the deploy namespace.
    env: { KUBECONFIG: "/synthetic/kubeconfig-with-default-namespace" },
    clock: scenario.clock,
    stderrSink: stderrSink(),
    spawn: retrySpawn(calls, scenario),
    ...extra,
  };
}

async function runRetryDeploy(scenario, extra = {}) {
  const calls = [];
  const records = [];
  const options = retryDeployOptions(scenario, calls, {
    admissionRetryRollbackTarget: await retryRollbackTarget(),
    onAttempts: (record) => records.push(record),
    ...extra,
  });
  let outcome;
  try {
    outcome = { value: await runOnClock(scenario.clock, deployPlatformToKubernetes(options)) };
  } catch (error) {
    outcome = { error };
  }
  return { ...outcome, calls, records, options };
}

const upgradeCalls = (calls) => calls.filter((call) => call.command === "helm" && call.args[0] === "upgrade");
const rollbackCalls = (calls) => calls.filter((call) => call.command === "helm" && call.args[0] === "rollback");
const probeCalls = (calls) => calls.filter((call) => call.command === "kubectl" && call.args[0] === "annotate");
const probeArgs = (iso) => [
  "annotate",
  probeCertificate,
  `chasesets.com/admission-probe=${iso}`,
  "--namespace",
  retryNamespace,
  "--overwrite",
  "--dry-run=server",
  "--request-timeout=10s",
];

describe("admission transient retry", () => {
  it("restores the captured source, probes the namespaced Certificate, and retries the failed-rollback shape once", async () => {
    const scenario = retryScenario();
    const { value, error, calls, records, options } = await runRetryDeploy(scenario);

    expect(error).toBeUndefined();
    expect(value).toMatchObject({ action: "deploy", result: "success", release: retryRelease });
    const upgrades = upgradeCalls(calls);
    expect(upgrades).toHaveLength(2);
    expect(upgrades[1].args).toEqual(upgrades[0].args);
    expect(upgrades[0].args).toEqual(buildHelmUpgradeArgs(options));
    expect(upgrades[0].args).toContain("--atomic");
    expect(upgrades.map((call) => call.options.stdio)).toEqual([
      ["inherit", "inherit", "pipe"],
      ["inherit", "inherit", "pipe"],
    ]);
    expect(rollbackCalls(calls).map((call) => call.args)).toEqual([
      ["rollback", retryRelease, "692", "--namespace", retryNamespace, "--wait", "--timeout", "30s"],
    ]);
    expect(probeCalls(calls).map((call) => call.args)).toEqual([
      probeArgs("2026-10-15T03:00:00.000Z"),
      probeArgs("2026-10-15T03:00:10.900Z"),
    ]);
    expect(probeCalls(calls).every((call) => !call.args.includes("default"))).toBe(true);
    const order = (predicate) => calls.findIndex(predicate);
    expect(order((call) => call.args[0] === "annotate")).toBeLessThan(order((call) => call.args[0] === "rollback"));
    expect(order((call) => call.args[0] === "rollback")).toBeLessThan(order((call) => call.args[1] === "jobs,pods"));
    expect(order((call) => call.args[1] === "jobs,pods")).toBeLessThan(calls.indexOf(upgrades[1]));
    expect(scenario.histories).toEqual([]);
    expect(options.stderrSink.text()).toBe(admissionTransientStderr);

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      schemaVersion: "platform-kubernetes-deploy-attempts/v1",
      release: retryRelease,
      namespace: retryNamespace,
      result: "success",
      retry: "performed",
      refusal: null,
      attempts: [
        {
          attempt: 1,
          result: "failure",
          admissionWebhookTransient: admissionTransientLine,
          admissionWebhookTransientCode: admissionCode,
        },
        { attempt: 2, result: "success", admissionWebhookTransient: null, admissionWebhookTransientCode: null },
      ],
      probeSamples: [
        { outcome: "success", elapsedMs: 900 },
        { outcome: "success", elapsedMs: 11_800 },
      ],
      recovery: { sourceRevision: 692, resultingRevision: 695, rolledBack: true },
      // The real 683-692 -> 686-695 trim: only the oldest unprotected prefix disappeared.
      preRetryHistory: fingerprintedHistory(retryBaselineHistory),
    });
  });

  it("retries the synthetic successful-atomic-rollback shape without restoring again", async () => {
    const scenario = retryScenario({ histories: [atomicRolledBackHistory, atomicRolledBackHistory] });
    const { error, calls, records } = await runRetryDeploy(scenario);

    expect(error).toBeUndefined();
    expect(upgradeCalls(calls)).toHaveLength(2);
    expect(rollbackCalls(calls)).toEqual([]);
    expect(records[0]).toMatchObject({
      result: "success",
      retry: "performed",
      recovery: { sourceRevision: 692, resultingRevision: 694, rolledBack: false },
      preRetryHistory: fingerprintedHistory(atomicRolledBackHistory),
    });
  });

  it("retries a matched transient whose bounded line is cut before `No agent available`", async () => {
    // Eligibility comes from the match on the complete original error, not from the bounded line.
    const stderr = longAdmissionTransientStderr;
    const line = classifyAdmissionWebhookTransient(stderr);
    expect(line).toHaveLength(500);
    expect(line).not.toContain("No agent available");
    const { error, calls, records } = await runRetryDeploy(
      retryScenario({ upgrades: [{ code: 1, stderr }, { code: 0 }] }),
    );

    expect(error).toBeUndefined();
    const upgrades = upgradeCalls(calls);
    expect(upgrades).toHaveLength(2);
    expect(upgrades[1].args).toEqual(upgrades[0].args);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      result: "success",
      retry: "performed",
      refusal: null,
      attempts: [
        {
          attempt: 1,
          result: "failure",
          admissionWebhookTransient: line,
          admissionWebhookTransientCode: admissionCode,
        },
        { attempt: 2, result: "success", admissionWebhookTransient: null, admissionWebhookTransientCode: null },
      ],
    });
  });
});

describe("admission transient refusals", () => {
  async function expectRefusal(scenario, refusal, extra = {}, originalStderr = admissionTransientStderr) {
    const result = await runRetryDeploy(scenario, extra);
    // The original upgrade error is rethrown, not a wrapper and not a later stage's error.
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.name).toBe("ProcessExitError");
    expect(result.error.message).toMatch(/^helm upgrade --install /);
    expect(result.error.stderr).toBe(originalStderr);
    expect(upgradeCalls(result.calls)).toHaveLength(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({ result: "failure", retry: "refused", refusal });
    return result;
  }

  it("rethrows a non-transient upgrade failure without reading history", async () => {
    const stderr =
      "Error: UPGRADE FAILED: release chase-sets-platform failed, and has been rolled back due to atomic being set: timed out waiting for the condition\n";
    const { calls, records } = await expectRefusal(
      retryScenario({ upgrades: [{ code: 1, stderr }, { code: 0 }] }),
      "not-transient",
      {},
      stderr,
    );
    expect(calls).toHaveLength(1);
    expect(records[0].attempts).toEqual([
      { attempt: 1, result: "failure", admissionWebhookTransient: null, admissionWebhookTransientCode: null },
    ]);
  });

  it("classifies but never retries a transient failure without the retry flag", async () => {
    const { calls, records } = await expectRefusal(retryScenario(), "retry-not-eligible", {
      admissionRetryRollbackTarget: undefined,
    });
    expect(calls).toHaveLength(1);
    expect(records[0].attempts).toEqual([
      {
        attempt: 1,
        result: "failure",
        admissionWebhookTransient: admissionTransientLine,
        admissionWebhookTransientCode: admissionCode,
      },
    ]);
  });

  it.each([
    [
      "a pending revision",
      [...retryAdmissionHistory.slice(0, -1), { ...retryRollbackFailure, status: "pending-rollback" }],
    ],
    [
      "an extra revision",
      [
        ...retryAdmissionHistory.slice(1),
        { revision: 695, status: "failed", description: 'Upgrade "chase-sets-platform" failed: other' },
      ],
    ],
    [
      "another first revision",
      [...retryAdmissionHistory.slice(0, -2), { ...retryUpgradeFailure, description: "Upgrade complete" }],
    ],
    ["a missing protected source", retryAdmissionHistory.filter((entry) => entry.revision !== 692)],
    ["an interior gap", retryAdmissionHistory.filter((entry) => entry.revision !== 688)],
    [
      "an inserted old revision",
      [{ revision: 682, status: "superseded", description: "Upgrade complete" }, ...retryAdmissionHistory.slice(1)],
    ],
    [
      "a changed retained entry",
      retryAdmissionHistory.map((entry) => (entry.revision === 690 ? { ...entry, status: "failed" } : entry)),
    ],
    [
      "a changed retained description",
      retryAdmissionHistory.map((entry) =>
        entry.revision === 692 ? { ...entry, description: "Rollback to 690" } : entry,
      ),
    ],
  ])("refuses %s before any probe or rollback", async (_name, history) => {
    const { calls } = await expectRefusal(retryScenario({ histories: [history] }), "history-unexpected");
    expect(probeCalls(calls)).toEqual([]);
    expect(rollbackCalls(calls)).toEqual([]);
  });

  it("refuses a retained pending revision even when the capture already held it", async () => {
    // Synthetic: a pending-upgrade older than the source survives capture unchanged.
    const capturedWithPending = retryCapturedHistory.map((entry) =>
      entry.revision === 688 ? { ...entry, status: "pending-upgrade" } : entry,
    );
    const admission = [...capturedWithPending.slice(2), retryUpgradeFailure, retryRollbackFailure];
    const { calls } = await expectRefusal(retryScenario({ histories: [admission] }), "history-unexpected", {
      admissionRetryRollbackTarget: await retryRollbackTarget(capturedWithPending),
    });
    expect(probeCalls(calls)).toEqual([]);
  });

  it("refuses the retry when the post-restore baseline is not the recorded chain", async () => {
    // Still a well-formed chain, but its failed rollback is not the one admitted before the restore.
    const movedBaseline = retryBaselineHistory.map((entry) =>
      entry.revision === 694 ? { ...entry, description: 'Rollback "chase-sets-platform" failed: concurrent' } : entry,
    );
    const scenario = retryScenario({
      histories: [...retryScenario().histories.slice(0, 5), movedBaseline],
    });
    const { calls, records } = await expectRefusal(scenario, "baseline-unexpected");
    expect(rollbackCalls(calls)).toHaveLength(1);
    expect(records[0].preRetryHistory).toBeNull();
  });

  it("kills and settles a never-closing probe child at the deadline", async () => {
    const scenario = retryScenario({ probes: [{ hang: true }] });
    const { calls, records } = await expectRefusal(scenario, "probe-deadline");
    expect(probeCalls(calls)).toHaveLength(1);
    expect(probeCalls(calls)[0].killed).toBe("SIGKILL");
    expect(scenario.clock.now()).toBe(180_000);
    expect(records[0].probeSamples).toEqual([{ outcome: "timeout", elapsedMs: 180_000 }]);
    expect(rollbackCalls(calls)).toEqual([]);
  });

  it("resets the streak on an interleaved failure and starts no probe at or after expiry", async () => {
    const probes = Array.from({ length: 25 }, (_, index) => ({ code: index % 2 }));
    const scenario = retryScenario({ probes });
    const { calls, records } = await expectRefusal(scenario, "probe-deadline");
    const started = probeCalls(calls);
    expect(started).toHaveLength(18);
    expect(started.at(-1).args[2]).toBe("chasesets.com/admission-probe=2026-10-15T03:02:50.000Z");
    expect(records[0].probeSamples.map((sample) => sample.outcome)).toEqual(
      Array.from({ length: 18 }, (_, index) => (index % 2 ? "failure" : "success")),
    );
    expect(rollbackCalls(calls)).toEqual([]);
  });

  it("does not count a success that completes at expiry", async () => {
    const scenario = retryScenario({ probes: [{ code: 0 }, { code: 0, delayMs: 170_000 }] });
    const { calls, records } = await expectRefusal(scenario, "probe-deadline");
    expect(records[0].probeSamples).toEqual([
      { outcome: "success", elapsedMs: 0 },
      { outcome: "timeout", elapsedMs: 180_000 },
    ]);
    expect(probeCalls(calls)[1].killed).toBeNull();
    expect(rollbackCalls(calls)).toEqual([]);
  });

  it("stops after a failed restore without a second upgrade", async () => {
    const scenario = retryScenario({
      rollbackCode: 1,
      histories: [retryAdmissionHistory, retryAdmissionHistory, retryAdmissionHistory],
    });
    const { records } = await expectRefusal(scenario, "recovery-failed");
    expect(records[0].recovery).toEqual({ sourceRevision: 692, resultingRevision: null, rolledBack: true });
  });

  it("stops before the retry when a Helm hook operation is still active", async () => {
    const census = JSON.stringify({
      items: [
        {
          kind: "Job",
          metadata: { name: "chase-sets-platform-bootstrap", annotations: { "helm.sh/hook": "pre-upgrade" } },
          status: { active: 1 },
        },
      ],
    });
    await expectRefusal(retryScenario({ census }), "helm-operation-active");
  });

  it("never runs a third upgrade after a failed retry", async () => {
    const scenario = retryScenario({
      upgrades: [
        { code: 1, stderr: admissionTransientStderr },
        { code: 1, stderr: `${admissionTransientStderr}retry\n` },
        { code: 0 },
      ],
    });
    const { error, calls, records } = await runRetryDeploy(scenario);
    expect(upgradeCalls(calls)).toHaveLength(2);
    expect(scenario.upgrades).toEqual([{ code: 0 }]);
    // The retry's own error is the step's terminal error.
    expect(error.stderr).toBe(`${admissionTransientStderr}retry\n`);
    expect(records[0]).toMatchObject({
      result: "failure",
      retry: "performed",
      attempts: [1, 2].map((attempt) => ({
        attempt,
        result: "failure",
        admissionWebhookTransient: admissionTransientLine,
        admissionWebhookTransientCode: admissionCode,
      })),
    });
  });

  it("keeps a deploy without either flag (staging, preview) on base spawn calls and inherited stdio", async () => {
    const scenario = retryScenario();
    const calls = [];
    const options = retryDeployOptions(scenario, calls);
    await expect(runOnClock(scenario.clock, deployPlatformToKubernetes(options))).rejects.toThrow(/^helm upgrade /);
    expect(calls.map((call) => [call.command, call.args, call.options.stdio])).toEqual([
      ["helm", buildHelmUpgradeArgs(options), ["inherit", "inherit", "inherit"]],
    ]);
    expect(options.stderrSink.text()).toBe("");
  });

  it("lets the workflow rollback restore a superseded source after a failed retry", async () => {
    // Synthetic: the second upgrade failed and Helm's atomic rollback returned to 695's content.
    const afterFailedRetry = [
      ...retryBaselineHistory.slice(2, 9),
      { ...retryBaselineHistory[9], status: "superseded" },
      { revision: 696, status: "failed", description: `Upgrade "chase-sets-platform" failed: ${admissionNoAgentCall}` },
      { revision: 697, status: "deployed", description: "Rollback to 695" },
    ];
    const restored = [
      ...afterFailedRetry.slice(1, 9),
      { ...afterFailedRetry[9], status: "superseded" },
      { revision: 698, status: "deployed", description: "Rollback to 692" },
    ];
    const calls = [];
    const result = await rollbackPlatformOnKubernetes({
      values: rollbackValues,
      release: retryRelease,
      namespace: retryNamespace,
      timeout: "30s",
      revision: 692,
      releaseExists: true,
      rollbackTarget: await retryRollbackTarget(),
      spawn: retrySpawn(calls, {
        clock: manualClock(),
        upgrades: [],
        probes: [],
        histories: [afterFailedRetry, afterFailedRetry, restored, restored],
      }),
    });
    expect(result).toMatchObject({
      result: "success",
      rollbackIdentity: { sourceRevision: 692, resultingRevision: 698 },
    });
  });
});

describe("attempts record", () => {
  async function performedRecord() {
    const { records } = await runRetryDeploy(retryScenario());
    return records[0];
  }

  it("is closed and carries exactly one terminal result", async () => {
    const record = await performedRecord();
    expect(platformKubernetesDeployment.assertDeployAttemptsRecord(structuredClone(record))).toEqual(record);
    for (const [name, mutate] of [
      ["unknown field", (value) => Object.assign(value, { helmArgs: [] })],
      ["unknown attempt field", (value) => Object.assign(value.attempts[0], { message: "helm upgrade" })],
      ["missing field", (value) => delete value.preRetryHistory],
      ["second terminal result", (value) => Object.assign(value, { result: "failure" })],
      [
        "third attempt",
        (value) =>
          value.attempts.push({
            attempt: 3,
            result: "success",
            admissionWebhookTransient: null,
            admissionWebhookTransientCode: null,
          }),
      ],
      ["unbounded line", (value) => Object.assign(value.attempts[0], { admissionWebhookTransient: "x".repeat(501) })],
      ["empty line", (value) => Object.assign(value.attempts[0], { admissionWebhookTransient: "" })],
      ["missing code", (value) => delete value.attempts[0].admissionWebhookTransientCode],
      ["unknown code", (value) => Object.assign(value.attempts[0], { admissionWebhookTransientCode: "unknown" })],
      ["line without its code", (value) => Object.assign(value.attempts[0], { admissionWebhookTransientCode: null })],
      ["code without its line", (value) => Object.assign(value.attempts[0], { admissionWebhookTransient: null })],
      [
        "code on a successful attempt",
        (value) =>
          Object.assign(value.attempts[1], {
            admissionWebhookTransient: admissionTransientLine,
            admissionWebhookTransientCode: admissionCode,
          }),
      ],
      [
        "unrecognized failure refused as anything but not-transient",
        (value) =>
          Object.assign(value, {
            retry: "refused",
            refusal: "probe-deadline",
            attempts: [
              { attempt: 1, result: "failure", admissionWebhookTransient: null, admissionWebhookTransientCode: null },
            ],
            result: "failure",
            recovery: null,
            preRetryHistory: null,
          }),
      ],
      [
        "recognized not-transient refusal",
        (value) =>
          Object.assign(value, {
            retry: "refused",
            refusal: "not-transient",
            attempts: value.attempts.slice(0, 1),
            result: "failure",
            recovery: null,
            preRetryHistory: null,
          }),
      ],
      ["retry without recovery", (value) => Object.assign(value, { recovery: null })],
      [
        "unknown refusal",
        (value) =>
          Object.assign(value, {
            retry: "refused",
            refusal: "other",
            attempts: value.attempts.slice(0, 1),
            result: "failure",
          }),
      ],
      ["untyped probe sample", (value) => Object.assign(value.probeSamples[0], { outcome: "pending" })],
      [
        "a raw history description",
        (value) => Object.assign(value.preRetryHistory[0], { description: retryBaselineHistory[0].description }),
      ],
      [
        "a description in place of its fingerprint",
        (value) => Object.assign(value.preRetryHistory[0], { descriptionSha256: retryBaselineHistory[0].description }),
      ],
      [
        "an unprefixed fingerprint",
        (value) => Object.assign(value.preRetryHistory[0], { descriptionSha256: "a".repeat(64) }),
      ],
      ["an unnormalized status", (value) => Object.assign(value.preRetryHistory[0], { status: "Superseded" })],
    ]) {
      const mutated = structuredClone(record);
      mutate(mutated);
      expect(() => platformKubernetesDeployment.assertDeployAttemptsRecord(mutated), name).toThrow(
        "Deploy attempts record",
      );
    }
  });

  it("keeps a matcher line whose 500-character cut ends in a space", async () => {
    // Synthetic: padding that puts a space at the cut, which re-matching trims.
    const head = `UPGRADE FAILED: an error occurred while rolling back the release. original upgrade error: ${admissionNoAgentCall}: `;
    const stderr = `Error: ${head}${"p".repeat(499 - head.length)} synthetic tail beyond the cut\n`;
    const line = classifyAdmissionWebhookTransient(stderr);
    expect(line).toHaveLength(500);
    expect(line.endsWith(" ")).toBe(true);
    const { error, records } = await runRetryDeploy(retryScenario({ upgrades: [{ code: 1, stderr }, { code: 0 }] }));
    expect(error).toBeUndefined();
    expect(records[0]).toMatchObject({
      retry: "performed",
      attempts: [{ admissionWebhookTransient: line }, { result: "success" }],
    });
  });

  it.each([
    ["recovered", [{ code: 1, stderr: admissionTransientStderr }, { code: 0 }], 0],
    ["refused", [{ code: 1, stderr: admissionTransientStderr }], 1],
  ])(
    "keeps planted override and history values out of the %s record and CLI output",
    async (_name, upgrades, exitCode) => {
      const directory = mkdtempSync(join(tmpdir(), "platform-deploy-attempts-"));
      const targetPath = join(directory, "production-rollback-target.json");
      const attemptsPath = join(directory, "production-kubernetes-deploy-attempts.json");
      const histories = retryScenario().histories.map((history) => withHistorySentinels(history));
      const scenario = retryScenario({
        upgrades,
        histories: [...histories],
        ...(exitCode ? { probes: [{ hang: true }] } : {}),
      });
      const calls = [];
      const sink = stderrSink();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        writeFileSync(
          targetPath,
          JSON.stringify(await retryRollbackTarget(withHistorySentinels(retryCapturedHistory))),
        );
        const code = await runOnClock(
          scenario.clock,
          platformKubernetesDeployment.runPlatformKubernetesDeploymentCli(
            [
              "--",
              "deploy",
              "--image",
              `registry.digitalocean.com/chase-sets/chase-sets-platform:${"e".repeat(40)}@sha256:${"d".repeat(64)}`,
              "--runtime-env",
              "DEPLOYMENT_ENVIRONMENT=production",
              "--runtime-env",
              `ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS=${plantedEnvOverride}`,
              "--managed-postgres-ca-sha256",
              managedPostgresCaSha256,
              "--namespace",
              retryNamespace,
              "--release",
              retryRelease,
              "--timeout",
              "30s",
              "--attempts-out",
              attemptsPath,
              "--admission-retry-rollback-target",
              targetPath,
            ],
            {},
            { values: rollbackValues, spawn: retrySpawn(calls, scenario), clock: scenario.clock, stderrSink: sink },
          ),
        );
        expect(code).toBe(exitCode);
        expect(upgradeCalls(calls)[0].args.join(" ")).toContain(plantedEnvOverride);
        const record = readFileSync(attemptsPath, "utf8");
        expect(JSON.parse(record)).toMatchObject({
          result: exitCode ? "failure" : "success",
          preRetryHistory: exitCode ? null : fingerprintedHistory(withHistorySentinels(retryBaselineHistory)),
        });
        // No raw description of any history the deploy read reaches the record, JSON-escaped or not.
        for (const { description } of new Set(histories.flat())) {
          expect(record).not.toContain(description);
          expect(record).not.toContain(JSON.stringify(description).slice(1, -1));
        }
        const output = [record, sink.text(), ...log.mock.calls.flat(), ...error.mock.calls.flat()]
          .map(String)
          .join("\n");
        expect(output).toContain("No agent available");
        for (const planted of [plantedEnvOverride, retainedHistorySentinel, intermediateFailureSentinel]) {
          expect(output).not.toContain(planted);
        }
        expect(output).not.toContain("--set-string");
        if (exitCode) expect(error.mock.calls.flat()).toEqual(["helm upgrade exited with code 1."]);
      } finally {
        log.mockRestore();
        error.mockRestore();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("parses the production deploy and verifier record flags without environment fallbacks", () => {
    expect(
      parseArgs(
        [
          "deploy",
          "--attempts-out=artifacts/release-health/production-kubernetes-deploy-attempts.json",
          "--admission-retry-rollback-target=artifacts/release-health/production-rollback-target.json",
        ],
        {},
      ),
    ).toMatchObject({
      attemptsOutPath: "artifacts/release-health/production-kubernetes-deploy-attempts.json",
      admissionRetryRollbackTargetPath: "artifacts/release-health/production-rollback-target.json",
    });
    expect(
      parseArgs(["verify-deployment-transition", "--deploy-attempts", "attempts.json"], {}).deployAttemptsPath,
    ).toBe("attempts.json");
    expect(parseArgs(["deploy"], { PLATFORM_KUBERNETES_ROLLBACK_TARGET: "target.json" })).toMatchObject({
      attemptsOutPath: undefined,
      admissionRetryRollbackTargetPath: undefined,
      deployAttemptsPath: undefined,
    });
  });
});

describe("transition with retry record", () => {
  async function retriedChain(withHistory = (history) => history) {
    const rollbackTarget = await retryRollbackTarget(withHistory(retryCapturedHistory));
    const { records } = await runRetryDeploy(
      retryScenario({ histories: retryScenario().histories.map((history) => withHistory(history)) }),
      { admissionRetryRollbackTarget: rollbackTarget },
    );
    return { rollbackTarget, deployAttempts: JSON.parse(JSON.stringify(records[0])) };
  }
  const verify = (chain, observed, extra = {}) =>
    verifyKubernetesDeploymentTransition({
      release: retryRelease,
      namespace: retryNamespace,
      checkedAt: "2026-10-15T03:20:00.000Z",
      ...chain,
      spawn: completedSpawn([], [{ code: 0, stdout: helmHistory(observed) }]),
      ...extra,
    });

  it("validates the whole chain, then emits the final hop from the recorded pre-retry baseline", async () => {
    const transition = await verify(await retriedChain(), retryObservedHistory);
    // The same 695 -> 696 hop the attempt-2 host rerun emitted (artifact 11946265479).
    expect(transition).toEqual({
      schemaVersion: "platform-kubernetes-deployment-transition/v1",
      checkedAt: "2026-10-15T03:20:00.000Z",
      release: retryRelease,
      namespace: retryNamespace,
      capturedHeadRevision: 695,
      resultingHeadRevision: 696,
      capturedHistory: retryBaselineHistory,
      observedHistory: retryObservedHistory,
    });
  });

  it.each([
    [
      "an altered intermediate",
      retryObservedHistory.map((entry) => (entry.revision === 694 ? { ...entry, status: "superseded" } : entry)),
    ],
    ["a missing intermediate", retryObservedHistory.filter((entry) => entry.revision !== 693)],
    ["a moved captured source", retryObservedHistory.filter((entry) => entry.revision !== 692)],
    [
      "a second new revision",
      [...retryObservedHistory.slice(1), { revision: 697, status: "deployed", description: "Upgrade complete" }],
    ],
    [
      "a non-deployed final hop",
      [...retryObservedHistory.slice(0, -1), { revision: 696, status: "failed", description: "Upgrade failed" }],
    ],
  ])("refuses %s before emission", async (_name, observed) => {
    await expect(verify(await retriedChain(), observed)).rejects.toThrow();
  });

  it("rebuilds recorded descriptions from observed history without the record carrying them", async () => {
    const chain = await retriedChain(withHistorySentinels);
    const record = JSON.stringify(chain.deployAttempts);
    expect(record).not.toContain(retainedHistorySentinel);
    expect(record).not.toContain(intermediateFailureSentinel);
    // 686 was pruned before verification, so its description comes from the captured target.
    expect(await verify(chain, withHistorySentinels(retryObservedHistory))).toMatchObject({
      capturedHeadRevision: 695,
      resultingHeadRevision: 696,
      capturedHistory: withHistorySentinels(retryBaselineHistory),
    });
  });

  it.each([690, 692, 693, 694, 695])("refuses a changed observed description at revision %i", async (revision) => {
    const observed = retryObservedHistory.map((entry) =>
      entry.revision === revision ? { ...entry, description: `${entry.description} (synthetic change)` } : entry,
    );
    await expect(verify(await retriedChain(), observed)).rejects.toThrow();
  });

  it("refuses an intermediate whose different description redacts identically", async () => {
    const chain = await retriedChain((history) => withHistorySentinels(history, "synthetic-recorded-value"));
    const observed = withHistorySentinels(retryObservedHistory, "synthetic-observed-value");
    const recorded = withHistorySentinels(retryBaselineHistory, "synthetic-recorded-value").find(
      (entry) => entry.revision === 694,
    ).description;
    const changed = observed.find((entry) => entry.revision === 694).description;
    expect(changed).not.toBe(recorded);
    expect(redactDeployDiagnosticText(changed)).toBe(redactDeployDiagnosticText(recorded));
    await expect(verify(chain, observed)).rejects.toThrow("pre-retry revision 694 does not match");
    expect(await verify(chain, withHistorySentinels(retryObservedHistory, "synthetic-recorded-value"))).toMatchObject({
      resultingHeadRevision: 696,
    });
  });

  it.each([
    ["an unrecorded intermediate", (record) => record.preRetryHistory.splice(-2, 1)],
    [
      "an altered recorded intermediate",
      (record) => Object.assign(record.preRetryHistory.at(-2), { status: "superseded" }),
    ],
    [
      "a recovery that is not the recorded head",
      (record) => Object.assign(record.recovery, { resultingRevision: 694 }),
    ],
    ["a recovery from another source", (record) => Object.assign(record.recovery, { sourceRevision: 691 })],
    [
      "a failed deploy",
      (record) =>
        Object.assign(record, {
          result: "failure",
          attempts: [record.attempts[0], { ...record.attempts[1], result: "failure" }],
        }),
    ],
    ["another release", (record) => Object.assign(record, { release: "proof" })],
    [
      "another pruned captured description",
      (record) => Object.assign(record.preRetryHistory[0], { descriptionSha256: descriptionSha256("Other") }),
    ],
    [
      "another recorded head description",
      (record) => Object.assign(record.preRetryHistory.at(-1), { descriptionSha256: descriptionSha256("Other") }),
    ],
  ])("refuses a record with %s before emission", async (_name, mutate) => {
    const chain = await retriedChain();
    mutate(chain.deployAttempts);
    await expect(verify(chain, retryObservedHistory)).rejects.toThrow();
  });

  it("is unchanged without a performed retry", async () => {
    const capturedHistory = [{ revision: 308, status: "deployed", description: "Synthetic source" }];
    const rollbackTarget = {
      schemaVersion: "platform-kubernetes-rollback-target/v2",
      sourceRevision: 308,
      sourceStatus: "deployed",
      historyHeadRevision: 308,
      terminalFailedSuffix: [],
      preDeployHistory: capturedHistory,
    };
    const observed = [
      { ...capturedHistory[0], status: "superseded" },
      { revision: 309, status: "deployed", description: "Synthetic upgrade complete" },
    ];
    const deployAttempts = {
      schemaVersion: "platform-kubernetes-deploy-attempts/v1",
      release: retryRelease,
      namespace: retryNamespace,
      result: "success",
      retry: "not-needed",
      refusal: null,
      attempts: [
        { attempt: 1, result: "success", admissionWebhookTransient: null, admissionWebhookTransientCode: null },
      ],
      probeSamples: [],
      recovery: null,
      preRetryHistory: null,
    };
    expect(await verify({ rollbackTarget, deployAttempts }, observed)).toEqual(
      await verify({ rollbackTarget }, observed),
    );
  });
});

describe("admission webhook root cause", () => {
  // The actual producer writes the record through --attempts-out and the production classify
  // step reads that file; only the recorded code of a failed last attempt names the cause.
  async function classifiedDeploy(scenario, { retryFlag = true } = {}) {
    const directory = mkdtempSync(join(tmpdir(), "platform-deploy-attempts-"));
    const targetPath = join(directory, "production-rollback-target.json");
    const attemptsPath = join(directory, "production-kubernetes-deploy-attempts.json");
    const calls = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(targetPath, JSON.stringify(await retryRollbackTarget()));
      const exitCode = await runOnClock(
        scenario.clock,
        platformKubernetesDeployment.runPlatformKubernetesDeploymentCli(
          [
            "--",
            "deploy",
            "--image",
            `registry.digitalocean.com/chase-sets/chase-sets-platform:${"e".repeat(40)}@sha256:${"d".repeat(64)}`,
            "--runtime-env",
            "DEPLOYMENT_ENVIRONMENT=production",
            "--managed-postgres-ca-sha256",
            managedPostgresCaSha256,
            "--namespace",
            retryNamespace,
            "--release",
            retryRelease,
            "--timeout",
            "30s",
            "--attempts-out",
            attemptsPath,
            ...(retryFlag ? ["--admission-retry-rollback-target", targetPath] : []),
          ],
          {},
          {
            values: rollbackValues,
            spawn: retrySpawn(calls, scenario),
            clock: scenario.clock,
            stderrSink: stderrSink(),
          },
        ),
      );
      const record = JSON.parse(readFileSync(attemptsPath, "utf8"));
      const rootCause = classifyDeploymentRootCause({
        phase: "production-deploy",
        diagnostics: readDeployDiagnostics([attemptsPath]),
      });
      return { exitCode, calls, record, rootCause, errors: error.mock.calls.flat() };
    } finally {
      log.mockRestore();
      error.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const longLine = classifyAdmissionWebhookTransient(longAdmissionTransientStderr);
  const longCall = admissionNoAgentCall.replace("/validate", `/synthetic-${"x".repeat(250)}`);
  // Synthetic long originals that are not AC1: a condition timeout and a no-agent rollback-only error.
  const longTimeoutStderr = `Error: UPGRADE FAILED: release chase-sets-platform failed, and has been rolled back due to atomic being set: timed out waiting for the condition: ${"synthetic-".repeat(60)}\n`;
  const longRollbackOnlyStderr = `Error: UPGRADE FAILED: an error occurred while rolling back the release. original upgrade error: timed out waiting for the condition: ${longCall}\n`;
  const recognized = (attempt) => ({
    attempt,
    result: "failure",
    admissionWebhookTransient: longLine,
    admissionWebhookTransientCode: admissionCode,
  });

  it("names the cause when a long transient's retry fails the same way", async () => {
    expect(longLine).toHaveLength(500);
    expect(longLine).not.toContain("No agent available");
    const scenario = retryScenario({
      upgrades: [
        { code: 1, stderr: longAdmissionTransientStderr },
        { code: 1, stderr: longAdmissionTransientStderr },
        { code: 0 },
      ],
    });
    const { exitCode, calls, record, rootCause } = await classifiedDeploy(scenario);
    expect(exitCode).toBe(1);
    expect(upgradeCalls(calls)).toHaveLength(2);
    expect(platformKubernetesDeployment.assertDeployAttemptsRecord(structuredClone(record))).toEqual(record);
    expect(record).toMatchObject({ result: "failure", retry: "performed", attempts: [recognized(1), recognized(2)] });
    expect(rootCause).toMatchObject({ rootCauseCode: "doks-admission-webhook-unreachable", providerReason: longLine });
  });

  it.each([
    [
      "refused for its history",
      retryScenario({
        upgrades: [{ code: 1, stderr: longAdmissionTransientStderr }],
        histories: [[...retryAdmissionHistory.slice(0, -1), { ...retryRollbackFailure, status: "pending-rollback" }]],
      }),
      {},
      "history-unexpected",
    ],
    [
      "without the retry flag",
      retryScenario({ upgrades: [{ code: 1, stderr: longAdmissionTransientStderr }] }),
      { retryFlag: false },
      "retry-not-eligible",
    ],
  ])("names the cause of a long transient %s", async (_name, scenario, options, refusal) => {
    const { exitCode, calls, record, rootCause, errors } = await classifiedDeploy(scenario, options);
    expect(exitCode).toBe(1);
    expect(upgradeCalls(calls)).toHaveLength(1);
    expect(errors).toEqual(["helm upgrade exited with code 1."]);
    expect(record).toMatchObject({ result: "failure", retry: "refused", refusal, attempts: [recognized(1)] });
    expect(rootCause).toMatchObject({ rootCauseCode: "doks-admission-webhook-unreachable", providerReason: longLine });
  });

  it.each([
    ["condition timeout", longTimeoutStderr],
    ["no-agent rollback-only error", longRollbackOnlyStderr],
  ])("leaves a long %s original untagged", async (_name, stderr) => {
    expect(stderr.length).toBeGreaterThan(500);
    const { exitCode, calls, record, rootCause } = await classifiedDeploy(
      retryScenario({ upgrades: [{ code: 1, stderr }] }),
    );
    expect(exitCode).toBe(1);
    expect(upgradeCalls(calls)).toHaveLength(1);
    expect(record).toMatchObject({
      retry: "refused",
      refusal: "not-transient",
      attempts: [
        { attempt: 1, result: "failure", admissionWebhookTransient: null, admissionWebhookTransientCode: null },
      ],
    });
    expect(rootCause.rootCauseCode).toBe("unknown");
  });

  it("reads only the last attempt after a long transient retry fails otherwise", async () => {
    const scenario = retryScenario({
      upgrades: [
        { code: 1, stderr: longAdmissionTransientStderr },
        { code: 1, stderr: longTimeoutStderr },
        { code: 0 },
      ],
    });
    const { exitCode, calls, record, rootCause } = await classifiedDeploy(scenario);
    expect(exitCode).toBe(1);
    expect(upgradeCalls(calls)).toHaveLength(2);
    expect(scenario.upgrades).toEqual([{ code: 0 }]);
    expect(record).toMatchObject({
      result: "failure",
      retry: "performed",
      attempts: [
        recognized(1),
        { attempt: 2, result: "failure", admissionWebhookTransient: null, admissionWebhookTransientCode: null },
      ],
    });
    expect(rootCause.rootCauseCode).toBe("unknown");
  });

  it("names no cause after a long transient recovers", async () => {
    const scenario = retryScenario({ upgrades: [{ code: 1, stderr: longAdmissionTransientStderr }, { code: 0 }] });
    const { exitCode, calls, record, rootCause } = await classifiedDeploy(scenario);
    expect(exitCode).toBe(0);
    const upgrades = upgradeCalls(calls);
    expect(upgrades).toHaveLength(2);
    expect(upgrades[1].args).toEqual(upgrades[0].args);
    expect(record).toMatchObject({
      result: "success",
      retry: "performed",
      attempts: [
        recognized(1),
        { attempt: 2, result: "success", admissionWebhookTransient: null, admissionWebhookTransientCode: null },
      ],
    });
    expect(rootCause.rootCauseCode).toBe("unknown");
  });
});

describe("preview Postgres connection ceiling and diagnostics (#10022)", () => {
  const nativeHelm = spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0;
  // Script CI has Docker but not a native Helm binary; use the chart job's pinned image.
  const helmTemplate = (args) =>
    execFileSync(
      nativeHelm ? "helm" : "docker",
      nativeHelm ? args : ["run", "--rm", "-v", `${process.cwd()}:/repo`, "-w", "/repo", "alpine/helm:3.15.4", ...args],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  // The exact deploy argv, rendered instead of installed.
  const templateArgs = (upgradeArgs) => {
    expect(upgradeArgs.slice(0, 2)).toEqual(["upgrade", "--install"]);
    const rest = upgradeArgs.slice(4);
    const timeoutIndex = rest.indexOf("--timeout");
    return [
      "template",
      upgradeArgs[2],
      upgradeArgs[3],
      ...rest.filter(
        (arg, index) =>
          !["--create-namespace", "--wait", "--atomic", "--timeout"].includes(arg) && index !== timeoutIndex + 1,
      ),
    ];
  };
  const deployArgs = (environment, namespace) =>
    buildHelmUpgradeArgs({
      release: namespace,
      namespace,
      timeout: "15m",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:release-sha",
      envOverrides: {
        DEPLOYMENT_ENVIRONMENT: environment,
        ...(environment === "preview" ? { PREVIEW_IDENTIFIER: "pr-123" } : {}),
      },
      env: { DOKS_INGRESS_TARGET: "203.0.113.10", PRODUCTION_DOKS_INGRESS_TARGET: "203.0.113.20" },
    });
  const documents = (output) =>
    output
      .split(/^---\s*$/m)
      .map((part) => parseYaml(part))
      .filter(Boolean);

  it("renders the demand-derived max_connections into every preview release", () => {
    const { demand, settings } = previewPostgresDemand();
    const reservations = settings.superuser_reserved_connections + settings.reserved_connections;
    expect(settings.max_connections).toBe(50 * Math.ceil((demand + reservations + 8) / 50));
    // PR, merge-gate and ephemeral-verification previews share buildHelmUpgradeArgs.
    for (const namespace of ["chase-sets-pr-123", "chase-sets-gate-1-1", "chase-sets-verify-1-1"]) {
      const postgres = documents(helmTemplate(templateArgs(deployArgs("preview", namespace)))).find(
        (item) =>
          item.kind === "Deployment" && item.metadata.labels["app.kubernetes.io/component"] === "preview-postgres",
      );
      expect(postgres.spec.template.spec.containers[0].args).toEqual([
        "-c",
        `max_connections=${settings.max_connections}`,
        "-c",
        `reserved_connections=${settings.reserved_connections}`,
        "-c",
        `superuser_reserved_connections=${settings.superuser_reserved_connections}`,
      ]);
    }
  });

  it("reserves memory and requires single-node, cross-namespace release isolation for PR, gate and verify", () => {
    const memoryByComponent = {
      "public-web": "1024Mi",
      marketplace: "1152Mi",
      "admin-web": "832Mi",
      "platform-api": "640Mi",
      "platform-worker": "832Mi",
      "platform-bootstrap": "1152Mi",
      "preview-postgres": "448Mi",
    };
    for (const release of ["chase-sets-pr-123", "chase-sets-gate-1-1", "chase-sets-verify-1-1"]) {
      const args = deployArgs("preview", release);
      expect(args).toEqual(expect.arrayContaining(["--values", "infrastructure/helm/platform/values.preview.yaml"]));
      const pods = documents(helmTemplate(templateArgs(args))).filter((item) => item.spec?.template);
      expect(pods).toHaveLength(7);
      expect(pods.map((item) => item.metadata.labels["app.kubernetes.io/component"]).sort()).toEqual(
        Object.keys(memoryByComponent).sort(),
      );
      for (const pod of pods) {
        const component = pod.metadata.labels["app.kubernetes.io/component"];
        const { spec, metadata } = pod.spec.template;
        expect(spec.containers).toHaveLength(1);
        expect(spec.containers[0].resources).toEqual({ requests: { memory: memoryByComponent[component] } });
        const selector = (operator) => ({
          matchExpressions: [
            { key: "app.kubernetes.io/name", operator: "In", values: ["chase-sets-platform"] },
            { key: "app.kubernetes.io/instance", operator, values: [release] },
          ],
        });
        expect(spec.affinity).toEqual({
          podAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: [
              { topologyKey: "kubernetes.io/hostname", labelSelector: selector("In") },
            ],
          },
          podAntiAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: [
              { topologyKey: "kubernetes.io/hostname", namespaceSelector: {}, labelSelector: selector("NotIn") },
            ],
          },
        });
        for (const expression of selector("In").matchExpressions) {
          expect(expression.values).toContain(metadata.labels[expression.key]);
        }
        if (component === "preview-postgres") {
          expect(pod.kind).toBe("Deployment");
          expect(pod.metadata.annotations["helm.sh/hook"]).toBe("pre-install,pre-upgrade");
          expect(pod.metadata.annotations["helm.sh/hook-weight"]).toBe("-40");
        } else if (component === "platform-bootstrap") {
          expect(pod.kind).toBe("Job");
          expect(pod.metadata.annotations["helm.sh/hook-weight"]).toBe("-20");
          expect(pod.spec.activeDeadlineSeconds).toBe(890);
        } else {
          expect(pod.kind).toBe("Deployment");
        }
      }
    }
  });

  it("refuses conflicting global affinity when preview stack isolation is enabled", () => {
    expect(() =>
      helmTemplate([
        ...templateArgs(deployArgs("preview", "chase-sets-pr-123")),
        "--set",
        "global.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=pool",
      ]),
    ).toThrow(/global.affinity cannot be set when global.previewStackIsolation is enabled/);
  });

  it("does not add pod affinity or anti-affinity to staging or production", () => {
    for (const environment of ["staging", "production"]) {
      const rendered = helmTemplate(templateArgs(deployArgs(environment, "chase-sets-platform")));
      expect(rendered).not.toContain("podAffinity:");
      expect(rendered).not.toContain("podAntiAffinity:");
    }
  });

  it("refuses a preview render without max_connections", () => {
    expect(() =>
      helmTemplate([
        ...templateArgs(deployArgs("preview", "chase-sets-pr-123")),
        "--set",
        "previewPostgres.settings=null",
      ]),
    ).toThrow(/previewPostgres\.settings\.max_connections is required/);
  });

  it("keeps staging and production renders independent of the preview connection settings", () => {
    for (const environment of ["staging", "production"]) {
      const args = templateArgs(deployArgs(environment, "chase-sets-platform"));
      const rendered = helmTemplate(args);
      expect(rendered).not.toContain("preview-postgres");
      expect(rendered).not.toContain("max_connections");
      expect(helmTemplate([...args, "--set", "previewPostgres.settings=null"])).toBe(rendered);
    }
  });

  it("adds preview-postgres state, logs and the structural snapshot only to opted-in diagnostics", () => {
    const options = { values: sampleValues, release: "chase-sets-pr-7", namespace: "chase-sets-pr-7", tailLines: 50 };
    const base = buildDiagnosticsCommands(options);
    const withPreview = buildDiagnosticsCommands({ ...options, previewPostgres: true });
    const selector = "app.kubernetes.io/instance=chase-sets-pr-7,app.kubernetes.io/component=preview-postgres";
    const deployment = "chase-sets-pr-7-chase-sets-platform-preview-postgres";

    expect(JSON.stringify(base)).not.toContain("preview-postgres");
    expect(withPreview.slice(0, base.length)).toEqual(base);
    expect(withPreview.slice(base.length)).toEqual([
      ["kubectl", ["get", "deployment", deployment, "--namespace", "chase-sets-pr-7", "--output", "wide"]],
      ["kubectl", ["describe", "deployment", deployment, "--namespace", "chase-sets-pr-7"]],
      ["kubectl", ["get", "pods", "--namespace", "chase-sets-pr-7", "--selector", selector, "--output", "wide"]],
      ["kubectl", ["describe", "pods", "--namespace", "chase-sets-pr-7", "--selector", selector]],
      [
        "kubectl",
        ["logs", "--namespace", "chase-sets-pr-7", "--selector", selector, "--all-containers", "--tail", "50"],
        { redact: "postgres-server-log" },
      ],
      [
        "kubectl",
        [
          "logs",
          "--namespace",
          "chase-sets-pr-7",
          "--selector",
          selector,
          "--all-containers",
          "--previous",
          "--tail",
          "50",
        ],
        { redact: "postgres-server-log" },
      ],
      ...platformKubernetesDeployment.buildPreviewPostgresConnectionSnapshotCommands(options),
    ]);
  });

  it("prints preview-postgres server-log tails without statement text or password literals", async () => {
    const serverLog = [
      "2026-10-18 12:36:28.101 UTC [61] FATAL:  sorry, too many clients already",
      '2026-10-18 12:36:28.102 UTC [62] ERROR:  role "cs_preview_auth" already exists',
      "2026-10-18 12:36:28.102 UTC [62] STATEMENT:  create role \"cs_preview_auth\" with login password 'synthetic-password'",
      "\tselect 1",
      "2026-10-18 12:36:28.103 UTC [63] LOG:  checkpoint complete",
      "",
    ].join("\n");
    const redacted = platformKubernetesDeployment.redactPostgresServerLog(serverLog);
    expect(redacted).not.toContain("synthetic-password");
    expect(redacted).not.toContain("create role");
    expect(redacted).not.toContain("select 1");
    expect(redacted).toContain("[62] STATEMENT:  [REDACTED]\n");
    expect(redacted).toContain("FATAL:  sorry, too many clients already");
    expect(redacted).toContain("LOG:  checkpoint complete");

    const calls = [];
    const printed = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => printed.push(String(chunk)));
    try {
      await platformKubernetesDeployment.capturePlatformKubernetesDiagnostics({
        values: sampleValues,
        release: "chase-sets-pr-7",
        namespace: "chase-sets-pr-7",
        previewPostgres: true,
        spawn: (command, args, options) => {
          const isServerLog = args[0] === "logs" && args.join(" ").includes("component=preview-postgres");
          calls.push({ args, stdio: options.stdio });
          return completedSpawn([], [{ code: 0, stdout: isServerLog ? serverLog : "" }])(command, args, options);
        },
      });
    } finally {
      write.mockRestore();
    }
    const serverLogCalls = calls.filter(
      ({ args }) => args[0] === "logs" && args.join(" ").includes("component=preview-postgres"),
    );
    expect(serverLogCalls).toHaveLength(2);
    expect(serverLogCalls.every(({ stdio }) => stdio[1] === "pipe")).toBe(true);
    expect(printed.filter((chunk) => chunk.includes("UTC [62]"))).toEqual([redacted, redacted]);
  });

  it("snapshots only the connection ceiling, reservations and grouped held-connection counts", () => {
    const [[command, args], ...rest] = platformKubernetesDeployment.buildPreviewPostgresConnectionSnapshotCommands({
      release: "chase-sets-pr-7",
      namespace: "chase-sets-pr-7",
    });
    expect(rest).toEqual([]);
    expect(command).toBe("kubectl");
    expect(args.slice(0, args.indexOf("--command"))).toEqual([
      "exec",
      "--namespace",
      "chase-sets-pr-7",
      "deployment/chase-sets-pr-7-chase-sets-platform-preview-postgres",
      "--container",
      "postgres",
      "--",
      "psql",
      "--no-psqlrc",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
      "--pset",
      "pager=off",
    ]);
    const statements = args.filter((_, index) => args[index - 1] === "--command");
    expect(statements).toEqual(platformKubernetesDeployment.previewPostgresConnectionSnapshotStatements);
    expect(statements.slice(0, 3)).toEqual([
      "SHOW max_connections",
      "SHOW superuser_reserved_connections",
      "SHOW reserved_connections",
    ]);
    expect(statements[3]).toMatch(/GROUP BY datname, usename, state/);
    const sql = statements.join("\n").toLowerCase();
    for (const forbidden of ["query", "client_addr", "client_hostname", "client_port", "application_name"]) {
      expect(sql).not.toContain(forbidden);
    }
    expect(sql).not.toMatch(/select\s+\*/);
  });

  it("runs the snapshot once and reports a failed probe through its exit code", async () => {
    expect(parseArgs(["diagnostics", "--preview-postgres", "true"], {}).previewPostgres).toBe(true);
    expect(parseArgs(["diagnostics"], {}).previewPostgres).toBeUndefined();
    const argv = ["preview-postgres-snapshot", "--namespace", "chase-sets-pr-7", "--release", "chase-sets-pr-7"];
    for (const [code, expected] of [
      [0, 0],
      [2, 1],
    ]) {
      const calls = [];
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          platformKubernetesDeployment.runPlatformKubernetesDeploymentCli(
            argv,
            {},
            {
              spawn: completedSpawn(calls, [{ code }]),
            },
          ),
        ).resolves.toBe(expected);
      } finally {
        error.mockRestore();
      }
      expect(calls.map((call) => [call.command, call.args])).toEqual(
        platformKubernetesDeployment.buildPreviewPostgresConnectionSnapshotCommands({
          release: "chase-sets-pr-7",
          namespace: "chase-sets-pr-7",
        }),
      );
    }
  });

  it("kills a hung snapshot or diagnostics command at its own deadline and moves on", async () => {
    const deadlineMs = platformKubernetesDeployment.diagnosticsCommandDeadlineMs;
    const hangingSpawn = (calls, hangs) => (command, args) => {
      const call = { command, args, killed: null };
      calls.push(call);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = (signal) => {
        call.killed = signal;
        return true;
      };
      if (!hangs(args, calls.length - 1)) queueMicrotask(() => child.emit("close", 0));
      return child;
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const snapshotCalls = [];
      const snapshotClock = manualClock();
      await expect(
        runOnClock(
          snapshotClock,
          platformKubernetesDeployment.runPlatformKubernetesDeploymentCli(
            ["preview-postgres-snapshot", "--namespace", "chase-sets-pr-7", "--release", "chase-sets-pr-7"],
            {},
            { spawn: hangingSpawn(snapshotCalls, () => true), clock: snapshotClock },
          ),
        ),
      ).resolves.toBe(1);
      expect(snapshotCalls.map((call) => [call.args[0], call.killed])).toEqual([["exec", "SIGKILL"]]);
      expect(snapshotClock.now()).toBe(deadlineMs);

      const options = { values: sampleValues, release: "chase-sets-pr-7", namespace: "chase-sets-pr-7" };
      const commands = buildDiagnosticsCommands({ ...options, previewPostgres: true });
      const hung = commands.findIndex(([, args]) => args[0] === "logs");
      const diagnosticsCalls = [];
      const diagnosticsClock = manualClock();
      const diagnostics = await runOnClock(
        diagnosticsClock,
        platformKubernetesDeployment.capturePlatformKubernetesDiagnostics({
          ...options,
          previewPostgres: true,
          captureOutput: true,
          clock: diagnosticsClock,
          spawn: hangingSpawn(diagnosticsCalls, (_, index) => index === hung),
        }),
      );
      expect(diagnosticsCalls.map((call) => call.args)).toEqual(commands.map(([, args]) => args));
      expect(diagnosticsCalls.map((call, index) => [index, call.killed]).filter(([, killed]) => killed)).toEqual([
        [hung, "SIGKILL"],
      ]);
      expect(diagnostics.commands[hung]).toMatchObject({ code: null, stderr: "kubectl logs exceeded its deadline." });
      expect(diagnostics.commands.filter((result) => result.code === 0)).toHaveLength(commands.length - 1);
      expect(diagnosticsClock.now()).toBe(deadlineMs);
    } finally {
      error.mockRestore();
    }
  });
});
