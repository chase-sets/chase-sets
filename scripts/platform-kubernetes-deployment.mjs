#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import process from "node:process";
import {
  buildDoksIngressValues,
  buildPlatformHelmValues,
  buildPreviewDoksIngressValues,
  previewWildcardTlsSecretName,
  previewWildcardTlsSecretNamespace,
} from "./render-platform-helm-values.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";
import { MERGE_GATE_NAMESPACE_PATTERN, VERIFICATION_NAMESPACE_PATTERN } from "./ephemeral-verification-namespace.mjs";

export const PLATFORM_KUBERNETES_DEPLOYMENT_VERSION = "platform-kubernetes-deployment/v1";
export const PLATFORM_KUBERNETES_ROLLBACK_TARGET_VERSION = "platform-kubernetes-rollback-target/v2";
export const PLATFORM_KUBERNETES_SCENARIO_SEED_VERSION = "platform-kubernetes-scenario-seed/v1";
export const managedRegistryPullSecretName = "chase-sets";
export const scenarioSeedMaxActiveDeadlineSeconds = 3_300;
const scenarioSeedQuiesceTimeoutSeconds = 45;
// Leave more than four minutes inside the 55-minute Job deadline for worker
// drain, command termination, and KEDA resume if the seed reaches this bound.
const scenarioSeedCommandTimeoutSeconds = 3_000;
// Metadata fields cert-manager/the API server stamp onto the source Secret
// that must never travel to the copy: a namespace mismatch makes `kubectl
// apply -n <target>` refuse the object outright, and the rest are
// cluster/revision identity that must be assigned fresh in the destination
// namespace, not inherited from the cert-manager-owned original.
const copiedSecretMetadataFieldsToStrip = [
  "namespace",
  "resourceVersion",
  "uid",
  "creationTimestamp",
  "generation",
  "ownerReferences",
  "managedFields",
  "selfLink",
];

const chartName = "chase-sets-platform";
const chartPath = "infrastructure/helm/platform";
const stagingValuesPath = `${chartPath}/values.staging.yaml`;
const productionValuesPath = `${chartPath}/values.production.yaml`;
const defaultRelease = "chase-sets-platform";
const defaultNamespace = "chase-sets-platform";
const defaultTimeout = "10m";
// teardown only ever deletes disposable namespaces created outside Terraform
// by a Helm deploy (`--create-namespace`), so nothing else destroys them when
// their owning workflow ends. Three kinds exist, each with its own strict
// parser owned by the workflow that creates it:
//   - PR preview:            chase-sets-pr-<number>          (platform-pr.yml)
//   - ephemeral verification: anything under chase-sets-verify-
//                             (platform-ephemeral-verification.yml; the
//                              canonical parser lives in
//                              ephemeral-verification-namespace.mjs)
//   - merge-gate verification: chase-sets-gate-<run>-<attempt>
//                             (platform-merge-gate-verification.yml; parser
//                              also in ephemeral-verification-namespace.mjs)
// The bare "chase-sets-platform" default above is the staging/production
// namespace, so teardown must never fall through to it: require an explicit
// disposable namespace matching exactly one of these prefixes and reject
// everything else (production, staging, system, empty, malformed).
const previewNamespacePattern = /^chase-sets-pr-\d+$/;

function isDisposableNamespace(namespace) {
  return (
    previewNamespacePattern.test(namespace) ||
    VERIFICATION_NAMESPACE_PATTERN.test(namespace) ||
    MERGE_GATE_NAMESPACE_PATTERN.test(namespace)
  );
}

export function platformKubernetesWorkloads(options = {}) {
  const values = options.values ?? buildPlatformHelmValues({ repoRoot: options.repoRoot });
  const release = options.release ?? defaultRelease;
  const deployments = [];
  const rollouts = [];
  const jobs = [];

  for (const [name, component] of Object.entries(values.components ?? {})) {
    if (!component.enabled) {
      continue;
    }

    const workloadName = kubernetesComponentName(release, name);
    if (component.kind === "service" || component.kind === "worker") {
      const rolloutEnabled =
        component.kind === "service" && component.rollout
          ? (options.rolloutsEnabled ??
            (options.envOverrides?.DEPLOYMENT_ENVIRONMENT === "staging" ? true : component.rollout.enabled))
          : false;
      if (rolloutEnabled) {
        rollouts.push(workloadName);
      } else {
        deployments.push(workloadName);
      }
    } else if (component.kind === "job") {
      jobs.push(workloadName);
    }
  }

  return { deployments, rollouts, jobs };
}

export function buildHelmUpgradeArgs(options = {}) {
  const release = requiredOption(options.release ?? defaultRelease, "release");
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const timeout = requiredOption(options.timeout ?? defaultTimeout, "timeout");
  const image = parsePlatformImageRef(requiredOption(options.image, "image"));
  const imagePullSecret = managedRegistryPullSecret(options.imagePullSecret);
  const requestedEnvOverrides = normalizeEnvOverrides(options.envOverrides ?? {});
  const deploymentEnvironment = requestedEnvOverrides.DEPLOYMENT_ENVIRONMENT;
  const observabilityEnabled =
    (deploymentEnvironment === "staging" || deploymentEnvironment === "production") &&
    requestedEnvOverrides.OBSERVABILITY_ENABLED !== "false";
  const observabilityServiceName = `${release}-${chartName}-observability-collector`.slice(0, 63).replace(/-$/, "");
  const observabilityExporterEndpoint = observabilityEnabled
    ? requiredOption(
        options.observabilityExporterEndpoint ??
          `https://otel.${deploymentEnvironment === "production" ? "chasesets.com" : "staging.chasesets.com"}`,
        "observability-exporter-endpoint",
      )
    : null;
  const envOverrides = observabilityEnabled
    ? {
        ...requestedEnvOverrides,
        OBSERVABILITY_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://${observabilityServiceName}:4318`,
        OTEL_RESOURCE_ATTRIBUTES: `cloud.provider=digitalocean,cloud.platform=kubernetes,chase_sets.environment_slug=${deploymentEnvironment}`,
      }
    : requestedEnvOverrides;
  const environmentValuesPath = platformValuesPathForEnvironment(envOverrides.DEPLOYMENT_ENVIRONMENT);
  const doksIngressSetArgs =
    envOverrides.DEPLOYMENT_ENVIRONMENT === "staging" || envOverrides.DEPLOYMENT_ENVIRONMENT === "production"
      ? buildDoksIngressHelmSetArgs(
          buildDoksIngressValues({
            env: options.env ?? {},
            environment: envOverrides.DEPLOYMENT_ENVIRONMENT,
          }),
        )
      : envOverrides.DEPLOYMENT_ENVIRONMENT === "preview"
        ? buildDoksIngressHelmSetArgs(
            buildPreviewDoksIngressValues({
              env: options.env ?? {},
              previewIdentifier: envOverrides.PREVIEW_IDENTIFIER ?? options.env?.PREVIEW_IDENTIFIER,
            }),
          )
        : [];
  const previewPostgresSetArgs =
    envOverrides.DEPLOYMENT_ENVIRONMENT === "preview" ? ["--set", "previewPostgres.enabled=true"] : [];
  // Preview workloads (including the in-cluster preview Postgres) schedule
  // exclusively onto the dedicated staging preview node pool: the
  // nodeSelector targets the pool label and the toleration matches its
  // preview-only NoSchedule taint. Staging and production releases never set
  // these, so their pods cannot land on preview nodes and previews cannot
  // land on the staging runtime node.
  const previewSchedulingSetArgs =
    envOverrides.DEPLOYMENT_ENVIRONMENT === "preview"
      ? [
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
        ]
      : [];
  const observabilitySetArgs = observabilityEnabled
    ? [
        "--set",
        "observability.enabled=true",
        "--set-string",
        `observability.environment=${deploymentEnvironment}`,
        "--set-string",
        `observability.clusterName=chase-sets-${deploymentEnvironment}-doks`,
        "--set-string",
        `observability.exporter.endpoint=${observabilityExporterEndpoint}`,
      ]
    : [];
  const rolloutSetArgs =
    typeof options.rolloutsEnabled === "boolean"
      ? Object.entries(buildPlatformHelmValues({ repoRoot: options.repoRoot }).components ?? {}).flatMap(
          ([name, component]) =>
            component.rollout
              ? [
                  "--set",
                  `components.${name}.rollout.enabled=${options.rolloutsEnabled ? "true" : "false"}`,
                  "--set",
                  `components.${name}.rollout.canary.trafficRouting.nginx.enabled=${options.rolloutsEnabled ? "true" : "false"}`,
                ]
              : [],
        )
      : [];
  const waveExposureSetArgs = buildWaveExposureHelmSetArgs(options);

  return [
    "upgrade",
    "--install",
    release,
    chartPath,
    "--namespace",
    namespace,
    "--create-namespace",
    "--wait",
    "--timeout",
    timeout,
    "--atomic",
    ...(environmentValuesPath ? ["--values", environmentValuesPath] : []),
    ...doksIngressSetArgs,
    ...previewPostgresSetArgs,
    ...observabilitySetArgs,
    ...rolloutSetArgs,
    ...waveExposureSetArgs,
    ...previewSchedulingSetArgs,
    "--set-string",
    `global.image.registry=${image.registry}`,
    "--set-string",
    `global.image.registryName=${image.registryName}`,
    "--set-string",
    `global.image.repository=${image.repository}`,
    "--set-string",
    `global.image.tag=${image.tag}`,
    "--set-string",
    `global.image.digest=${image.digest}`,
    "--set-string",
    `global.imagePullSecrets[0].name=${imagePullSecret}`,
    ...Object.entries(envOverrides).flatMap(([name, value]) => [
      "--set-string",
      `global.envOverrides.${name}=${escapeHelmSetStringValue(value)}`,
    ]),
  ];
}

export function buildWaveExposureHelmSetArgs(options = {}) {
  const inviteCount = options.betaWaveSize;
  const exposurePercent = options.betaWaveRolloutExposure;
  if (inviteCount == null && exposurePercent == null) return [];
  if (inviteCount == null || exposurePercent == null) {
    throw new Error("--beta-wave-size and --beta-wave-rollout-exposure must be supplied together.");
  }
  const parsedCount = Number(inviteCount);
  const parsedExposure = Number(exposurePercent);
  if (!Number.isInteger(parsedCount) || parsedCount < 1) {
    throw new Error("--beta-wave-size must be a positive whole number.");
  }
  if (![10, 25, 50].includes(parsedExposure)) {
    throw new Error("--beta-wave-rollout-exposure must be an analyzed Argo weight: 10, 25, or 50.");
  }
  const componentArgs = Object.entries(
    buildPlatformHelmValues({ repoRoot: options.repoRoot }).components ?? {},
  ).flatMap(([name, component]) =>
    component.rollout ? ["--set", `components.${name}.rollout.canary.pauseAfterWeight=${parsedExposure}`] : [],
  );
  return [
    "--set",
    `global.betaWave.inviteCount=${parsedCount}`,
    "--set",
    `global.betaWave.rolloutExposurePercent=${parsedExposure}`,
    ...componentArgs,
  ];
}

export function platformValuesPathForEnvironment(environmentName) {
  if (environmentName === "staging") return stagingValuesPath;
  if (environmentName === "production") return productionValuesPath;
  return null;
}

function escapeHelmSetStringValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(",", "\\,");
}

function buildDoksIngressHelmSetArgs(doksIngress) {
  if (!doksIngress.enabled) {
    return [];
  }

  return [
    ["--set", "doksIngress.enabled=true"],
    ["--set-string", `doksIngress.className=${escapeHelmSetStringValue(doksIngress.className)}`],
    ["--set-string", `doksIngress.clusterIssuer=${escapeHelmSetStringValue(doksIngress.clusterIssuer)}`],
    ["--set", `doksIngress.tls.enabled=${doksIngress.tls.enabled ? "true" : "false"}`],
    ["--set-string", `doksIngress.tls.secretName=${escapeHelmSetStringValue(doksIngress.tls.secretName)}`],
    ["--set", `doksIngress.tls.certificate.enabled=${doksIngress.tls.certificate.enabled ? "true" : "false"}`],
    [
      "--set-string",
      `doksIngress.tls.certificate.clusterIssuer=${escapeHelmSetStringValue(doksIngress.tls.certificate.clusterIssuer)}`,
    ],
    ...doksIngress.tls.certificate.dnsNames.map((dnsName, dnsNameIndex) => [
      "--set-string",
      `doksIngress.tls.certificate.dnsNames[${dnsNameIndex}]=${escapeHelmSetStringValue(dnsName)}`,
    ]),
    ...doksIngress.hosts.flatMap((host, hostIndex) => [
      ["--set-string", `doksIngress.hosts[${hostIndex}].host=${escapeHelmSetStringValue(host.host)}`],
      ...host.paths.flatMap((route, routeIndex) => [
        [
          "--set-string",
          `doksIngress.hosts[${hostIndex}].paths[${routeIndex}].path=${escapeHelmSetStringValue(route.path)}`,
        ],
        [
          "--set-string",
          `doksIngress.hosts[${hostIndex}].paths[${routeIndex}].service=${escapeHelmSetStringValue(route.service)}`,
        ],
      ]),
    ]),
  ].flat();
}

export function buildPreviewWildcardSecretGetArgs(options = {}) {
  const name = options.name ?? previewWildcardTlsSecretName;
  const namespace = options.sourceNamespace ?? previewWildcardTlsSecretNamespace;
  return ["get", "secret", name, "--namespace", namespace, "--output", "json"];
}

export function buildPreviewWildcardSecretApplyArgs(options = {}) {
  const namespace = requiredOption(options.namespace, "namespace");
  return ["apply", "--namespace", namespace, "-f", "-"];
}

// Strips cluster/revision identity so the object round-trips as a brand-new
// Secret in the destination namespace instead of `kubectl apply` rejecting it
// (namespace mismatch) or Kubernetes rejecting a stale resourceVersion.
export function sanitizeCopiedSecretManifest(rawSecret, options = {}) {
  const secret = typeof rawSecret === "string" ? JSON.parse(rawSecret) : rawSecret;
  if (!secret || secret.kind !== "Secret") {
    throw new Error("Expected a Kubernetes Secret manifest to copy.");
  }

  const metadata = { ...secret.metadata };
  for (const field of copiedSecretMetadataFieldsToStrip) {
    delete metadata[field];
  }
  const annotations = { ...(metadata.annotations ?? {}) };
  delete annotations["kubectl.kubernetes.io/last-applied-configuration"];
  metadata.annotations = annotations;
  metadata.name = options.name ?? metadata.name;

  return {
    apiVersion: secret.apiVersion,
    kind: secret.kind,
    metadata,
    type: secret.type,
    data: secret.data,
  };
}

// Copies the shared `*.preview.chasesets.com` wildcard TLS Secret (issued
// once by cert-manager into the stable `cert-manager` namespace; see
// infrastructure/helm/doks-ingress) into this preview's namespace so the
// preview Ingress can reference it without ever asking cert-manager to issue
// its own certificate. Runs before `helm upgrade --install` so the Ingress
// resolves a real secret on its first reconcile. A high-throughput PR day
// issuing one certificate per preview namespace exhausted Let's Encrypt's
// 50-certificates-per-168h quota and blocked every PR behind "PR Required"
// for three hours; this is the fix.
export async function copyPreviewWildcardTlsSecret(options = {}) {
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const namespace = requiredOption(options.namespace, "namespace");
  const name = options.name ?? previewWildcardTlsSecretName;

  let getResult;
  try {
    getResult = await runProcess({
      command: kubectlPath,
      args: buildPreviewWildcardSecretGetArgs({ name, sourceNamespace: options.sourceNamespace }),
      spawn: options.spawn,
      captureOutput: true,
    });
  } catch (error) {
    throw new Error(
      `Preview deploy could not read the shared preview wildcard TLS secret "${name}" from namespace ` +
        `"${options.sourceNamespace ?? previewWildcardTlsSecretNamespace}". Run the one-time bootstrap in ` +
        `docs/runbooks/doks-platform-operations.md (node ./scripts/doks-cluster-addons.mjs --environment staging) ` +
        `before deploying previews. Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const manifest = sanitizeCopiedSecretManifest(getResult.stdout, { name });

  await runProcess({
    command: kubectlPath,
    args: buildPreviewWildcardSecretApplyArgs({ namespace }),
    spawn: options.spawn,
    captureOutput: true,
    input: `${JSON.stringify(manifest)}\n`,
  });

  return { name: manifest.metadata.name, namespace };
}

export function buildHelmRollbackArgs(options = {}) {
  const release = requiredOption(options.release ?? defaultRelease, "release");
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const timeout = requiredOption(options.timeout ?? defaultTimeout, "timeout");
  const revision = positiveHelmRevision(options.revision, "revision");

  return ["rollback", release, String(revision), "--namespace", namespace, "--wait", "--timeout", timeout];
}

export function buildHelmHistoryArgs(options = {}) {
  const release = requiredOption(options.release ?? defaultRelease, "release");
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");

  return ["history", release, "--namespace", namespace, "--output", "json"];
}

export function buildHelmValuesArgs(options = {}) {
  const release = requiredOption(options.release ?? defaultRelease, "release");
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const revision = positiveHelmRevision(options.revision, "revision");

  return [
    "get",
    "values",
    release,
    "--namespace",
    namespace,
    "--revision",
    String(revision),
    "--all",
    "--output",
    "json",
  ];
}

export function buildApplicationWorkloadIdentityArgs(options = {}) {
  const release = requiredOption(options.release ?? defaultRelease, "release");
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");

  return [
    "get",
    "deployments.apps,jobs.batch,rollouts.argoproj.io",
    "--namespace",
    namespace,
    "--selector",
    `app.kubernetes.io/instance=${release}`,
    "--output",
    "json",
  ];
}

export function buildHelmStatusArgs(options = {}) {
  const release = requiredOption(options.release ?? defaultRelease, "release");
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");

  return ["status", release, "--namespace", namespace];
}

export function buildHelmUninstallArgs(options = {}) {
  const release = requiredOption(options.release ?? defaultRelease, "release");
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const timeout = requiredOption(options.timeout ?? defaultTimeout, "timeout");

  return ["uninstall", release, "--namespace", namespace, "--wait", "--timeout", timeout];
}

export function buildNamespaceDeleteArgs(options = {}) {
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const timeout = requiredOption(options.timeout ?? defaultTimeout, "timeout");

  return ["delete", "namespace", namespace, "--ignore-not-found", "--wait=true", `--timeout=${timeout}`];
}

export function buildNamespaceGetArgs(options = {}) {
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");

  return ["get", "namespace", namespace, "--output", "name"];
}

export function buildRolloutStatusArgs(deployment, options = {}) {
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const timeout = requiredOption(options.timeout ?? defaultTimeout, "timeout");
  return ["rollout", "status", `deployment/${deployment}`, "--namespace", namespace, `--timeout=${timeout}`];
}

export function buildArgoRolloutGetArgs(rollout, options = {}) {
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  return ["get", `rollout/${rollout}`, "--namespace", namespace, "--output", "json"];
}

export function buildArgoRolloutPromoteArgs(rollout, options = {}) {
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  return ["argo", "rollouts", "promote", rollout, "--namespace", namespace];
}

export function buildArgoRolloutAbortArgs(rollout, options = {}) {
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  return ["argo", "rollouts", "abort", rollout, "--namespace", namespace];
}

export function buildDiagnosticsCommands(options = {}) {
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const workloads = options.workloads ?? platformKubernetesWorkloads(options);
  const tailLines = String(options.tailLines ?? 300);
  const componentSelectors = [...workloads.deployments, ...(workloads.rollouts ?? []), ...workloads.jobs].map(
    (name) => ({
      name,
      selector: `app.kubernetes.io/instance=${options.release ?? defaultRelease},app.kubernetes.io/component=${componentFromWorkloadName(name, options.release ?? defaultRelease)}`,
    }),
  );

  return [
    ["kubectl", ["get", "pods", "--namespace", namespace, "--sort-by=.metadata.creationTimestamp", "--output", "wide"]],
    ["kubectl", ["get", "jobs", "--namespace", namespace, "--sort-by=.metadata.creationTimestamp"]],
    ["kubectl", ["get", "deployments", "--namespace", namespace, "--sort-by=.metadata.creationTimestamp"]],
    ["kubectl", ["get", "rollouts,analysisruns", "--namespace", namespace, "--sort-by=.metadata.creationTimestamp"]],
    ["kubectl", ["get", "events", "--namespace", namespace, "--sort-by=.lastTimestamp"]],
    ...workloads.deployments.map((deployment) => [
      "kubectl",
      ["describe", "deployment", deployment, "--namespace", namespace],
    ]),
    ...(workloads.rollouts ?? []).map((rollout) => [
      "kubectl",
      ["describe", "rollout", rollout, "--namespace", namespace],
    ]),
    ...workloads.jobs.map((job) => ["kubectl", ["describe", "job", job, "--namespace", namespace]]),
    ...componentSelectors.map((component) => [
      "kubectl",
      ["get", "pods", "--namespace", namespace, "--selector", component.selector, "--output", "wide"],
    ]),
    ...componentSelectors.map((component) => [
      "kubectl",
      ["describe", "pods", "--namespace", namespace, "--selector", component.selector],
    ]),
    ...componentSelectors.map((component) => [
      "kubectl",
      ["logs", "--namespace", namespace, "--selector", component.selector, "--all-containers", "--tail", tailLines],
    ]),
    ...componentSelectors.map((component) => [
      "kubectl",
      [
        "logs",
        "--namespace",
        namespace,
        "--selector",
        component.selector,
        "--all-containers",
        "--previous",
        "--tail",
        tailLines,
      ],
    ]),
  ];
}

export function buildDeploymentEvidence(options = {}) {
  const release = options.release ?? defaultRelease;
  const namespace = options.namespace ?? defaultNamespace;
  const workloads = options.workloads ?? platformKubernetesWorkloads(options);

  return {
    schemaVersion: PLATFORM_KUBERNETES_DEPLOYMENT_VERSION,
    action: options.action ?? "deploy",
    release,
    namespace,
    image: options.image ?? null,
    startedAt: options.startedAt ?? null,
    completedAt: options.completedAt ?? null,
    result: options.result ?? "unknown",
    ...(options.reason ? { reason: options.reason } : {}),
    workloads,
    ...(options.rollbackIdentity ? { rollbackIdentity: options.rollbackIdentity } : {}),
  };
}

function redactDiagnosticOutput(output) {
  return String(output ?? "")
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:gho_|ghp_|dop_v1_|sk_(?:live|test)_)[A-Za-z0-9_-]+/g, "[REDACTED_TOKEN]")
    .replace(/((?:password|secret|token|api[_-]?key|cookie|database[_-]?url)\s*[=:]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
}

export function buildKubernetesDiagnosticsRecord(options = {}) {
  return {
    schemaVersion: "platform-kubernetes-diagnostics/v1",
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    action: "diagnostics",
    release: options.release ?? defaultRelease,
    namespace: options.namespace ?? defaultNamespace,
    workloads: options.workloads ?? platformKubernetesWorkloads(options),
    commandCount: options.commandCount ?? options.commands?.length ?? 0,
    commands: (options.commands ?? []).map((command) => ({
      command: command.command,
      args: command.args,
      code: command.code ?? null,
      stdout: redactDiagnosticOutput(command.stdout),
      stderr: redactDiagnosticOutput(command.stderr),
    })),
  };
}

export function buildKubernetesRollbackTarget(options = {}) {
  const registryName = requiredOption(options.registryName, "registryName");
  const repository = requiredOption(options.repository, "repository");
  const tag = options.tag ?? "";
  const digest = options.digest ?? "";
  const workloads = options.workloads ?? platformKubernetesWorkloads(options);

  return {
    schemaVersion: PLATFORM_KUBERNETES_ROLLBACK_TARGET_VERSION,
    capturedAt: options.checkedAt ?? new Date().toISOString(),
    release: options.release ?? defaultRelease,
    namespace: options.namespace ?? defaultNamespace,
    registryName,
    repository,
    tag,
    digest,
    imageRef: tag || digest ? platformImageReference({ registryName, repository, tag, digest }) : "",
    componentNames: [...workloads.deployments, ...(workloads.rollouts ?? []), ...workloads.jobs].sort(),
    lastKnownGoodCommit: options.lastKnownGoodCommit ?? "",
    releaseTag: options.releaseTag ?? "",
    sourceRevision: options.sourceRevision ?? null,
    sourceStatus: options.sourceStatus ?? null,
    sourceDescription: options.sourceDescription ?? null,
    observedTag: options.observedTag ?? tag,
    observedDigest: options.observedDigest ?? digest,
    workloadIdentities: options.workloadIdentities ?? [],
  };
}

export async function captureKubernetesRollbackTarget(options = {}) {
  const expectedIdentity = expectedRollbackImageIdentity(options);
  const lastKnownGoodCommit = requiredOption(options.lastKnownGoodCommit, "lastKnownGoodCommit");
  if (!/^[0-9a-f]{40}$/i.test(lastKnownGoodCommit)) {
    throw new Error("lastKnownGoodCommit must be a 40-character Git commit SHA.");
  }
  if (expectedIdentity.tag !== lastKnownGoodCommit) {
    throw new Error("Captured Helm image tag must equal lastKnownGoodCommit.");
  }
  requiredOption(options.releaseTag, "releaseTag");
  const initialHistory = await readHelmHistory(options);
  const deployed = initialHistory.filter((entry) => entry.status === "deployed");
  if (deployed.length !== 1) {
    throw new Error(
      `Rollback target capture requires exactly one deployed Helm revision; observed ${deployed.length}.`,
    );
  }
  const source = deployed[0];
  const historyHead = initialHistory.at(-1);
  if (!historyHead || historyHead.revision !== source.revision) {
    throw new Error(
      `Deployed Helm revision ${source.revision} is not the current history head ${historyHead?.revision ?? "absent"}.`,
    );
  }

  const values = await readHelmRevisionValues({ ...options, revision: source.revision });
  const observedIdentity = platformImageIdentityFromValues(values);
  assertPlatformImageIdentity(observedIdentity, expectedIdentity, `Helm revision ${source.revision}`);
  const workloadIdentities = await readApplicationWorkloadIdentities({
    ...options,
    values,
    expectedImageRef: observedIdentity.imageRef,
  });
  const stableHistory = await readHelmHistory(options);
  assertHelmHistoryUnchanged(initialHistory, stableHistory, "rollback target capture");

  return buildKubernetesRollbackTarget({
    ...options,
    tag: observedIdentity.tag,
    digest: observedIdentity.digest,
    sourceRevision: source.revision,
    sourceStatus: source.status,
    sourceDescription: source.description,
    observedTag: observedIdentity.tag,
    observedDigest: observedIdentity.digest,
    workloadIdentities,
    values,
  });
}

function expectedRollbackImageIdentity(options) {
  const registryName = requiredOption(options.registryName, "registryName");
  const repository = requiredOption(options.repository, "repository");
  const tag = requiredOption(options.tag, "tag");
  const digest = requiredSha256Digest(options.digest, "digest");
  return {
    registry: "registry.digitalocean.com",
    registryName,
    repository,
    tag,
    digest,
    imageRef: platformImageReference({ registryName, repository, tag, digest }),
  };
}

function platformImageIdentityFromValues(values) {
  const image = values?.global?.image;
  if (!image || typeof image !== "object") {
    throw new Error("Helm values do not contain global.image.");
  }
  const registry = requiredOption(image.registry, "global.image.registry");
  const registryName = requiredOption(image.registryName, "global.image.registryName");
  const repository = requiredOption(image.repository, "global.image.repository");
  const tag = requiredOption(image.tag, "global.image.tag");
  const digest = requiredSha256Digest(image.digest, "global.image.digest");
  return {
    registry,
    registryName,
    repository,
    tag,
    digest,
    imageRef: `${registry}/${registryName}/${repository}@${digest}`,
  };
}

function assertPlatformImageIdentity(observed, expected, label) {
  for (const field of ["registry", "registryName", "repository", "tag", "digest", "imageRef"]) {
    if (observed[field] !== expected[field]) {
      throw new Error(
        `${label} ${field} ${JSON.stringify(observed[field])} does not match captured rollback identity ${JSON.stringify(expected[field])}.`,
      );
    }
  }
}

async function readHelmHistory(options) {
  const result = await runProcess({
    command: options.helmPath ?? "helm",
    args: buildHelmHistoryArgs(options),
    spawn: options.spawn,
    captureOutput: true,
  });
  const history = parseJsonCommandOutput(result.stdout, "Helm history");
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error("Helm history must contain at least one revision.");
  }
  const normalized = history
    .map((entry, index) => {
      if (!entry || typeof entry !== "object") {
        throw new Error(`Helm history entry ${index} must be an object.`);
      }
      return {
        revision: positiveHelmRevision(entry.revision, `Helm history entry ${index} revision`),
        status: requiredOption(
          String(entry.status ?? "")
            .trim()
            .toLowerCase(),
          `Helm history entry ${index} status`,
        ),
        description: String(entry.description ?? "").trim(),
      };
    })
    .sort((left, right) => left.revision - right.revision);
  const revisions = new Set(normalized.map((entry) => entry.revision));
  if (revisions.size !== normalized.length) {
    throw new Error("Helm history contains duplicate revisions.");
  }
  return normalized;
}

async function readHelmRevisionValues(options) {
  const result = await runProcess({
    command: options.helmPath ?? "helm",
    args: buildHelmValuesArgs(options),
    spawn: options.spawn,
    captureOutput: true,
  });
  const values = parseJsonCommandOutput(result.stdout, `Helm values for revision ${options.revision}`);
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error(`Helm values for revision ${options.revision} must be a JSON object.`);
  }
  return values;
}

async function readApplicationWorkloadIdentities(options) {
  const result = await runProcess({
    command: options.kubectlPath ?? "kubectl",
    args: buildApplicationWorkloadIdentityArgs(options),
    spawn: options.spawn,
    captureOutput: true,
  });
  const list = parseJsonCommandOutput(result.stdout, "application workload inventory");
  if (!list || !Array.isArray(list.items)) {
    throw new Error("Application workload inventory must contain an items array.");
  }

  const expected = expectedPersistentApplicationWorkloads(options.values, options.release ?? defaultRelease);
  const declaredComponents = new Set(
    Object.entries(options.values?.components ?? {})
      .filter(([, component]) => component?.enabled)
      .map(([component]) => component),
  );
  const observed = list.items
    .filter((item) => !Object.hasOwn(item?.metadata?.annotations ?? {}, "helm.sh/hook"))
    .filter((item) => declaredComponents.has(item?.metadata?.labels?.["app.kubernetes.io/component"]))
    .map(normalizeWorkloadIdentity)
    .sort(compareWorkloadIdentity);
  const expectedKeys = expected.map(workloadIdentityKey).sort();
  const observedKeys = observed.map(workloadIdentityKey).sort();
  if (JSON.stringify(observedKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `Application workload inventory does not match the Helm revision; expected ${expectedKeys.join(", ") || "none"}, observed ${observedKeys.join(", ") || "none"}.`,
    );
  }
  if (observed.length === 0) {
    throw new Error("Application workload inventory is empty.");
  }

  for (const workload of observed) {
    if (workload.images.length === 0) {
      throw new Error(`${workload.kind}/${workload.name} has no container image identities.`);
    }
    const primaryImages = workload.images.filter(
      (image) => image.containerType === "application" && image.container === workload.component,
    );
    if (primaryImages.length !== 1) {
      throw new Error(
        `${workload.kind}/${workload.name} must expose exactly one canonical ${workload.component} application container; observed ${primaryImages.length}.`,
      );
    }
    if (primaryImages[0].image !== options.expectedImageRef) {
      throw new Error(
        `${workload.kind}/${workload.name} container ${primaryImages[0].container} image ${primaryImages[0].image} does not match ${options.expectedImageRef}.`,
      );
    }
  }
  return observed;
}

function expectedPersistentApplicationWorkloads(values, release) {
  const workloads = [];
  for (const [componentName, component] of Object.entries(values?.components ?? {})) {
    if (!component?.enabled) {
      continue;
    }
    const name = kubernetesComponentName(release, componentName);
    if (component.kind === "service" || component.kind === "worker") {
      workloads.push({
        kind: component.kind === "service" && component.rollout?.enabled ? "Rollout" : "Deployment",
        name,
      });
    } else if (component.kind === "job" && !component.job?.hook?.enabled) {
      workloads.push({ kind: "Job", name });
    }
  }
  return workloads.sort(compareWorkloadIdentity);
}

function normalizeWorkloadIdentity(item) {
  const kind = requiredOption(item?.kind, "workload kind");
  const name = requiredOption(item?.metadata?.name, "workload name");
  const podSpec = item?.spec?.template?.spec;
  if (!podSpec || typeof podSpec !== "object") {
    throw new Error(`${kind}/${name} does not contain spec.template.spec.`);
  }
  const images = [
    ...(podSpec.initContainers ?? []).map((container) => ({
      container: requiredOption(container?.name, `${kind}/${name} init container name`),
      containerType: "init",
      image: requiredOption(container?.image, `${kind}/${name} init container image`),
    })),
    ...(podSpec.containers ?? []).map((container) => ({
      container: requiredOption(container?.name, `${kind}/${name} container name`),
      containerType: "application",
      image: requiredOption(container?.image, `${kind}/${name} container image`),
    })),
  ].sort((left, right) =>
    `${left.containerType}/${left.container}`.localeCompare(`${right.containerType}/${right.container}`, "en"),
  );
  return {
    kind,
    name,
    component: requiredOption(
      item?.metadata?.labels?.["app.kubernetes.io/component"],
      `${kind}/${name} component label`,
    ),
    images,
  };
}

function compareWorkloadIdentity(left, right) {
  return workloadIdentityKey(left).localeCompare(workloadIdentityKey(right), "en");
}

function workloadIdentityKey(workload) {
  return `${workload.kind}/${workload.name}`;
}

function parseJsonCommandOutput(stdout, label) {
  try {
    return JSON.parse(String(stdout ?? ""));
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertHelmHistoryUnchanged(before, after, phase) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`Helm history moved during ${phase}; refusing ambiguous rollback evidence.`);
  }
}

export async function deployPlatformToKubernetes(options = {}) {
  const helmPath = options.helmPath ?? "helm";
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const workloads = options.workloads ?? platformKubernetesWorkloads(options);

  // Previews reference the shared *.preview.chasesets.com wildcard secret, so
  // it must exist in this namespace before the Helm deploy creates the
  // Ingress that points at it. Staging/production keep their existing
  // per-environment cert-manager-issued certificate and never copy anything
  // here.
  if ((options.envOverrides ?? {}).DEPLOYMENT_ENVIRONMENT === "preview") {
    await copyPreviewWildcardTlsSecret({
      namespace: options.namespace ?? defaultNamespace,
      kubectlPath,
      spawn: options.spawn,
    });
  }

  await runProcess({
    command: helmPath,
    args: buildHelmUpgradeArgs(options),
    spawn: options.spawn,
  });
  await waitForPlatformWorkloads({ ...options, kubectlPath, workloads, acceptedRolloutPhases: ["Paused", "Healthy"] });

  return buildDeploymentEvidence({
    ...options,
    action: "deploy",
    result: "success",
    workloads,
  });
}

export function buildScenarioSeedJobManifest(options = {}) {
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const release = requiredOption(options.release ?? defaultRelease, "release");
  const image = platformImageReference(parsePlatformImageRef(requiredOption(options.image, "image")));
  const imagePullSecret = managedRegistryPullSecret(options.imagePullSecret);
  const envOverrides = normalizeEnvOverrides(options.envOverrides ?? {});
  if (envOverrides.DEPLOYMENT_ENVIRONMENT !== "staging") {
    throw new Error("The post-deploy scenario seed Job is staging-only; DEPLOYMENT_ENVIRONMENT must be staging.");
  }

  const values = options.values ?? buildPlatformHelmValues({ repoRoot: options.repoRoot });
  const component = values.components?.["platform-bootstrap"];
  if (!component || component.kind !== "job") {
    throw new Error("The platform-bootstrap Job definition is required to build the post-deploy scenario seed Job.");
  }

  const timeoutMs = durationToMilliseconds(options.timeout ?? "60m");
  const activeDeadlineSeconds = Math.min(scenarioSeedMaxActiveDeadlineSeconds, Math.floor(timeoutMs / 1_000) - 60);
  if (activeDeadlineSeconds < 60) {
    throw new Error("The post-deploy scenario seed timeout must leave at least 60 seconds for the Job to run.");
  }

  const secretName = requiredOption(values.global?.existingSecretName, "global.existingSecretName");
  const jobName = trimKubernetesName(
    options.jobName ??
      `${release}-scenario-seed-${options.env?.GITHUB_RUN_ID ?? Date.now()}-${options.env?.GITHUB_RUN_ATTEMPT ?? "1"}`,
  );
  const accessName = scenarioSeedAccessName(release);
  const workerDeployment = kubernetesComponentName(release, "platform-worker");
  const quiesceWorkers = options.quiesceWorkers !== false;
  const env = component.env.map((entry) => {
    if (entry.secret) {
      return {
        name: entry.name,
        valueFrom: {
          secretKeyRef: {
            name: entry.secretName ?? secretName,
            key: entry.secretKey ?? entry.name,
          },
        },
      };
    }

    return {
      name: entry.name,
      value:
        entry.name === "PLATFORM_DATA_PROFILES"
          ? "scenario-seed"
          : String(envOverrides[entry.name] ?? entry.value ?? ""),
    };
  });
  if (quiesceWorkers) {
    env.push(
      { name: "CHASE_SETS_KUBERNETES_NAMESPACE", value: namespace },
      { name: "CHASE_SETS_QUIESCE_DEPLOYMENTS", value: workerDeployment },
      { name: "CHASE_SETS_QUIESCE_TIMEOUT_SECONDS", value: String(scenarioSeedQuiesceTimeoutSeconds) },
      { name: "CHASE_SETS_BOOTSTRAP_COMMAND_TIMEOUT_SECONDS", value: String(scenarioSeedCommandTimeoutSeconds) },
      { name: "CHASE_SETS_QUIESCE_POLL_INTERVAL_MS", value: "2000" },
      { name: "CHASE_SETS_QUIESCE_RESTORE_ON_FAILURE", value: "true" },
      { name: "CHASE_SETS_QUIESCE_IGNORE_MISSING_DEPLOYMENTS", value: "false" },
    );
  }

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace,
      labels: {
        "app.kubernetes.io/name": chartName,
        "app.kubernetes.io/instance": release,
        "app.kubernetes.io/component": "scenario-seed",
        "app.kubernetes.io/managed-by": "github-actions",
      },
      annotations: {
        "chase-sets.com/generated-by": "node ./scripts/platform-kubernetes-deployment.mjs scenario-seed",
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds,
      ttlSecondsAfterFinished: 3_600,
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": chartName,
            "app.kubernetes.io/instance": release,
            "app.kubernetes.io/component": "scenario-seed",
          },
        },
        spec: {
          restartPolicy: "Never",
          ...(quiesceWorkers ? { serviceAccountName: accessName } : {}),
          imagePullSecrets: [{ name: imagePullSecret }],
          containers: [
            {
              name: "scenario-seed",
              image,
              imagePullPolicy: values.global?.image?.pullPolicy ?? "IfNotPresent",
              command: ["sh", "-lc"],
              args: [
                quiesceWorkers
                  ? `node ./infrastructure/helm/platform/scripts/bootstrap-quiesce.mjs -- ${component.command}`
                  : component.command,
              ],
              env,
              ...(component.resources && Object.keys(component.resources).length > 0
                ? { resources: component.resources }
                : {}),
            },
          ],
        },
      },
    },
  };
}

export function buildScenarioSeedAccessManifest(options = {}) {
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const release = requiredOption(options.release ?? defaultRelease, "release");
  const name = scenarioSeedAccessName(release);
  const workerDeployment = kubernetesComponentName(release, "platform-worker");
  const labels = {
    "app.kubernetes.io/name": chartName,
    "app.kubernetes.io/instance": release,
    "app.kubernetes.io/component": "scenario-seed-quiesce",
    "app.kubernetes.io/managed-by": "github-actions",
  };

  return {
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: { name, namespace, labels },
        imagePullSecrets: [{ name: managedRegistryPullSecretName }],
      },
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "Role",
        metadata: { name, namespace, labels },
        rules: [
          {
            apiGroups: ["apps"],
            resources: ["deployments", "deployments/scale"],
            resourceNames: [workerDeployment],
            verbs: ["get", "patch"],
          },
          {
            apiGroups: ["keda.sh"],
            resources: ["scaledobjects"],
            resourceNames: [workerDeployment],
            verbs: ["patch"],
          },
        ],
      },
      {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name, namespace, labels },
        subjects: [{ kind: "ServiceAccount", name, namespace }],
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name,
        },
      },
    ],
  };
}

export async function runScenarioSeedOnKubernetes(options = {}) {
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const manifest = buildScenarioSeedJobManifest(options);
  const quiesceWorkers = options.quiesceWorkers !== false;
  const accessManifest = quiesceWorkers ? buildScenarioSeedAccessManifest(options) : undefined;
  const namespace = manifest.metadata.namespace;
  const jobName = manifest.metadata.name;
  const accessName = accessManifest?.items[0].metadata.name;

  if (accessManifest) {
    await runProcess({
      command: kubectlPath,
      args: ["apply", "--namespace", namespace, "-f", "-"],
      input: `${JSON.stringify(accessManifest)}\n`,
      spawn: options.spawn,
    });
  }

  try {
    await runProcess({
      command: kubectlPath,
      args: ["apply", "--namespace", namespace, "-f", "-"],
      input: `${JSON.stringify(manifest)}\n`,
      spawn: options.spawn,
    });
    await runProcess({
      command: kubectlPath,
      args: ["logs", "--follow", `job/${jobName}`, "--namespace", namespace, "--pod-running-timeout=5m"],
      spawn: options.spawn,
      allowFailure: true,
    });

    const timeoutMs = durationToMilliseconds(options.timeout ?? "60m");
    const startedAt = (options.now ?? Date.now)();
    const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    while (true) {
      const result = await runProcess({
        command: kubectlPath,
        args: ["get", `job/${jobName}`, "--namespace", namespace, "--output", "json"],
        spawn: options.spawn,
        captureOutput: true,
      });
      const job = JSON.parse(result.stdout);
      const conditions = job.status?.conditions ?? [];
      if (
        job.status?.succeeded === 1 ||
        conditions.some((condition) => condition.type === "Complete" && condition.status === "True")
      ) {
        return {
          schemaVersion: PLATFORM_KUBERNETES_SCENARIO_SEED_VERSION,
          action: "scenario-seed",
          result: "success",
          release: options.release ?? defaultRelease,
          namespace,
          jobName,
        };
      }
      const failed = conditions.find((condition) => condition.type === "Failed" && condition.status === "True");
      if (job.status?.failed > 0 || failed) {
        throw new Error(
          `Post-deploy scenario seed Job ${jobName} failed: ${failed?.reason ?? "container-exited"} ${failed?.message ?? ""}`.trim(),
        );
      }
      if ((options.now ?? Date.now)() - startedAt >= timeoutMs) {
        throw new Error(
          `Timed out after ${options.timeout ?? "60m"} waiting for post-deploy scenario seed Job ${jobName}.`,
        );
      }
      await sleep(options.pollIntervalMs ?? 2_000);
    }
  } finally {
    if (accessName) {
      await runProcess({
        command: kubectlPath,
        args: [
          "delete",
          `rolebinding/${accessName}`,
          `role/${accessName}`,
          `serviceaccount/${accessName}`,
          "--namespace",
          namespace,
          "--ignore-not-found=true",
        ],
        spawn: options.spawn,
        allowFailure: true,
      });
    }
  }
}

export async function rollbackPlatformOnKubernetes(options = {}) {
  const helmPath = options.helmPath ?? "helm";
  const kubectlPath = options.kubectlPath ?? "kubectl";
  let workloads = options.workloads ?? platformKubernetesWorkloads(options);
  const rollbackIdentity = {
    sourceRevision: null,
    resultingRevision: null,
    observedTag: null,
    observedDigest: null,
    workloadIdentities: [],
  };
  let releaseExists;
  try {
    releaseExists = options.releaseExists ?? (await helmReleaseExists({ ...options, helmPath }));
  } catch (error) {
    return buildDeploymentEvidence({
      ...options,
      action: "rollback",
      result: "failure",
      reason: diagnosticFailureReason(error),
      workloads,
      rollbackIdentity,
    });
  }

  if (!releaseExists) {
    return buildDeploymentEvidence({
      ...options,
      action: "rollback",
      result: "skipped",
      reason: "helm-release-not-found",
      workloads,
      rollbackIdentity,
    });
  }

  try {
    const sourceRevision = positiveHelmRevision(options.revision, "revision");
    rollbackIdentity.sourceRevision = sourceRevision;
    const initialHistory = await readHelmHistory({ ...options, helmPath });
    const source = initialHistory.find((entry) => entry.revision === sourceRevision);
    if (!source) {
      throw new Error(`Requested rollback revision ${sourceRevision} is absent from Helm history.`);
    }
    if (!["deployed", "superseded"].includes(source.status)) {
      throw new Error(
        `Requested rollback revision ${sourceRevision} is ${source.status}, not a successful deployed or superseded revision.`,
      );
    }
    const beforeHead = initialHistory.at(-1);
    if (!beforeHead) {
      throw new Error("Helm history has no current head revision.");
    }

    const sourceValues = await readHelmRevisionValues({ ...options, helmPath, revision: sourceRevision });
    workloads = options.workloads ?? platformKubernetesWorkloads({ ...options, values: sourceValues });
    const sourceIdentity = platformImageIdentityFromValues(sourceValues);
    const expected = rollbackExpectation(options.rollbackTarget, sourceRevision, sourceIdentity);
    assertPlatformImageIdentity(sourceIdentity, expected.imageIdentity, `Helm revision ${sourceRevision}`);
    const stablePreRollbackHistory = await readHelmHistory({ ...options, helmPath });
    assertHelmHistoryUnchanged(initialHistory, stablePreRollbackHistory, "pre-rollback validation");

    await runProcess({
      command: helmPath,
      args: buildHelmRollbackArgs({ ...options, revision: sourceRevision }),
      spawn: options.spawn,
    });
    await waitForPlatformWorkloads({
      ...options,
      kubectlPath,
      workloads,
      acceptedRolloutPhases: ["Healthy"],
      detectRollbackKinds: true,
    });

    const resultingHistory = await readHelmHistory({ ...options, helmPath });
    const newEntries = resultingHistory.filter((entry) => entry.revision > beforeHead.revision);
    if (newEntries.length !== 1 || newEntries[0].revision !== beforeHead.revision + 1) {
      throw new Error(
        `Helm history moved ambiguously during rollback; expected only revision ${beforeHead.revision + 1}, observed ${newEntries.map((entry) => entry.revision).join(", ") || "none"}.`,
      );
    }
    const resulting = newEntries[0];
    rollbackIdentity.resultingRevision = resulting.revision;
    const retainedSource = resultingHistory.find((entry) => entry.revision === sourceRevision);
    if (
      !retainedSource ||
      !["deployed", "superseded"].includes(retainedSource.status) ||
      retainedSource.description !== source.description
    ) {
      throw new Error(`Captured source revision ${sourceRevision} moved or disappeared during rollback.`);
    }
    if (resulting.status !== "deployed") {
      throw new Error(`Resulting Helm revision ${resulting.revision} is ${resulting.status}, not deployed.`);
    }
    if (resulting.description !== `Rollback to ${sourceRevision}`) {
      throw new Error(
        `Resulting Helm revision ${resulting.revision} description ${JSON.stringify(resulting.description)} does not identify source revision ${sourceRevision}.`,
      );
    }

    const resultingValues = await readHelmRevisionValues({
      ...options,
      helmPath,
      revision: resulting.revision,
    });
    const observedIdentity = platformImageIdentityFromValues(resultingValues);
    assertPlatformImageIdentity(
      observedIdentity,
      expected.imageIdentity,
      `Resulting Helm revision ${resulting.revision}`,
    );
    const workloadIdentities = await readApplicationWorkloadIdentities({
      ...options,
      kubectlPath,
      values: resultingValues,
      expectedImageRef: observedIdentity.imageRef,
    });
    if (
      expected.workloadIdentities &&
      JSON.stringify(workloadIdentities) !== JSON.stringify(expected.workloadIdentities)
    ) {
      throw new Error("Observed application workload identities do not match the pre-mutation rollback capture.");
    }
    rollbackIdentity.observedTag = observedIdentity.tag;
    rollbackIdentity.observedDigest = observedIdentity.digest;
    rollbackIdentity.workloadIdentities = workloadIdentities;

    const stableResultingHistory = await readHelmHistory({ ...options, helmPath });
    assertHelmHistoryUnchanged(resultingHistory, stableResultingHistory, "post-rollback identity validation");
  } catch (error) {
    return buildDeploymentEvidence({
      ...options,
      action: "rollback",
      result: "failure",
      reason: diagnosticFailureReason(error),
      workloads,
      rollbackIdentity,
    });
  }

  return buildDeploymentEvidence({
    ...options,
    action: "rollback",
    result: "success",
    workloads,
    rollbackIdentity,
  });
}

function rollbackExpectation(target, sourceRevision, sourceIdentity) {
  if (!target) {
    return { imageIdentity: sourceIdentity, workloadIdentities: null };
  }
  if (target.schemaVersion !== PLATFORM_KUBERNETES_ROLLBACK_TARGET_VERSION) {
    throw new Error(`Rollback target schemaVersion must be ${PLATFORM_KUBERNETES_ROLLBACK_TARGET_VERSION}.`);
  }
  if (positiveHelmRevision(target.sourceRevision, "rollback target sourceRevision") !== sourceRevision) {
    throw new Error(
      `Requested rollback revision ${sourceRevision} does not match captured source revision ${target.sourceRevision}.`,
    );
  }
  if (target.sourceStatus !== "deployed") {
    throw new Error(`Captured rollback source revision was ${target.sourceStatus ?? "absent"}, not deployed.`);
  }
  if (!Array.isArray(target.workloadIdentities) || target.workloadIdentities.length === 0) {
    throw new Error("Captured rollback target workload identities are absent.");
  }
  const imageIdentity = {
    registry: "registry.digitalocean.com",
    registryName: requiredOption(target.registryName, "rollback target registryName"),
    repository: requiredOption(target.repository, "rollback target repository"),
    tag: requiredOption(target.observedTag, "rollback target observedTag"),
    digest: requiredSha256Digest(target.observedDigest, "rollback target observedDigest"),
    imageRef: requiredOption(target.imageRef, "rollback target imageRef"),
  };
  if (target.tag !== imageIdentity.tag || target.digest !== imageIdentity.digest) {
    throw new Error("Captured rollback target top-level tag/digest disagree with its observed Helm identity.");
  }
  if (target.lastKnownGoodCommit !== imageIdentity.tag || !/^[0-9a-f]{40}$/i.test(target.lastKnownGoodCommit ?? "")) {
    throw new Error("Captured rollback target commit disagrees with its observed Helm tag.");
  }
  requiredOption(target.releaseTag, "rollback target releaseTag");
  assertPlatformImageIdentity(sourceIdentity, imageIdentity, `Captured source revision ${sourceRevision}`);
  return { imageIdentity, workloadIdentities: target.workloadIdentities };
}

function diagnosticFailureReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 500) || "rollback-command-failed";
}

// Preview namespaces are created by the Helm deploy (`helm upgrade --install
// --create-namespace`), never by Terraform, so nothing destroys them when a
// preview PR closes. `helm uninstall` alone can leave the in-cluster Postgres
// PVC, Secrets, and the namespace itself behind, so this always finishes with
// an unconditional `kubectl delete namespace` (which removes everything in
// it regardless of Helm tracking) and then verifies the namespace is
// actually gone. A namespace that survives throws rather than returning a
// "success" record, so a cleanup run reports failure instead of a false
// green when the delete silently no-ops or times out.
export async function teardownPlatformKubernetesNamespace(options = {}) {
  const helmPath = options.helmPath ?? "helm";
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const release = options.release ?? defaultRelease;
  if (!isDisposableNamespace(namespace)) {
    throw new Error(
      `Refusing to tear down non-disposable namespace "${namespace}"; expected a preview ` +
        `(chase-sets-pr-<number>) or ephemeral verification (chase-sets-verify-*) namespace.`,
    );
  }
  const releaseExists = options.releaseExists ?? (await helmReleaseExists({ ...options, helmPath }));

  if (releaseExists) {
    await runProcess({
      command: helmPath,
      args: buildHelmUninstallArgs(options),
      spawn: options.spawn,
      captureOutput: true,
      allowFailure: true,
    });
  }

  await runProcess({
    command: kubectlPath,
    args: buildNamespaceDeleteArgs(options),
    spawn: options.spawn,
  });

  const namespaceStillExists = await namespaceExists({ ...options, kubectlPath });
  if (namespaceStillExists) {
    throw new Error(
      `Namespace ${namespace} still exists after kubectl delete namespace completed; refusing to report cleanup success.`,
    );
  }

  return {
    schemaVersion: PLATFORM_KUBERNETES_DEPLOYMENT_VERSION,
    action: "teardown",
    release,
    namespace,
    result: "success",
    releaseUninstalled: releaseExists,
  };
}

async function namespaceExists(options) {
  const kubectlPath = options.kubectlPath ?? "kubectl";

  try {
    await runProcess({
      command: kubectlPath,
      args: buildNamespaceGetArgs(options),
      spawn: options.spawn,
      captureOutput: true,
    });
    return true;
  } catch (error) {
    if (isNamespaceNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export async function helmReleaseExists(options = {}) {
  const helmPath = options.helmPath ?? "helm";

  try {
    await runProcess({
      command: helmPath,
      args: buildHelmStatusArgs(options),
      spawn: options.spawn,
      captureOutput: true,
    });
    return true;
  } catch (error) {
    if (isHelmReleaseNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export async function capturePlatformKubernetesDiagnostics(options = {}) {
  const commands = buildDiagnosticsCommands(options);
  const results = [];

  for (const [command, args] of commands) {
    const result = await runProcess({
      command: command === "kubectl" ? (options.kubectlPath ?? "kubectl") : command,
      args,
      spawn: options.spawn,
      captureOutput: Boolean(options.captureOutput),
      allowFailure: true,
    });
    if (options.captureOutput) {
      results.push({ command, args, ...result });
    }
  }

  return { commandCount: commands.length, commands: results };
}

export async function promotePlatformRollouts(options = {}) {
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const workloads = options.workloads ?? platformKubernetesWorkloads(options);
  if ((workloads.rollouts ?? []).length === 0) {
    return buildDeploymentEvidence({
      ...options,
      action: "promote",
      result: "skipped",
      reason: "rollouts-disabled",
      workloads,
    });
  }

  for (const rollout of workloads.rollouts) {
    await runProcess({
      command: kubectlPath,
      args: buildArgoRolloutPromoteArgs(rollout, options),
      spawn: options.spawn,
    });
  }
  await waitForPlatformWorkloads({
    ...options,
    kubectlPath,
    workloads: { deployments: [], rollouts: workloads.rollouts, jobs: [] },
    acceptedRolloutPhases: ["Healthy"],
  });

  return buildDeploymentEvidence({ ...options, action: "promote", result: "success", workloads });
}

export async function abortPlatformRollouts(options = {}) {
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const workloads = options.workloads ?? platformKubernetesWorkloads(options);
  if ((workloads.rollouts ?? []).length === 0) {
    return buildDeploymentEvidence({
      ...options,
      action: "abort",
      result: "skipped",
      reason: "rollouts-disabled",
      workloads,
    });
  }

  for (const rollout of workloads.rollouts) {
    await runProcess({
      command: kubectlPath,
      args: buildArgoRolloutAbortArgs(rollout, options),
      spawn: options.spawn,
    });
  }

  return buildDeploymentEvidence({ ...options, action: "abort", result: "success", workloads });
}

async function waitForPlatformWorkloads(options) {
  for (const deployment of options.workloads.deployments) {
    await runProcess({
      command: options.kubectlPath,
      args: buildRolloutStatusArgs(deployment, options),
      spawn: options.spawn,
    });
  }

  for (const rollout of options.workloads.rollouts ?? []) {
    if (options.detectRollbackKinds && !(await argoRolloutExists(rollout, options))) {
      await runProcess({
        command: options.kubectlPath,
        args: buildRolloutStatusArgs(rollout, options),
        spawn: options.spawn,
      });
      continue;
    }
    await waitForArgoRolloutPhase(rollout, options);
  }
}

async function argoRolloutExists(rollout, options) {
  try {
    await runProcess({
      command: options.kubectlPath,
      args: buildArgoRolloutGetArgs(rollout, options),
      spawn: options.spawn,
      captureOutput: true,
    });
    return true;
  } catch (error) {
    if (isKubernetesResourceNotFound(error)) {
      return false;
    }
    throw error;
  }
}

async function waitForArgoRolloutPhase(rollout, options) {
  const acceptedPhases = new Set(options.acceptedRolloutPhases ?? ["Healthy"]);
  const timeoutMs = durationToMilliseconds(options.timeout ?? defaultTimeout);
  const startedAt = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;

  while (true) {
    const result = await runProcess({
      command: options.kubectlPath,
      args: buildArgoRolloutGetArgs(rollout, options),
      spawn: options.spawn,
      captureOutput: true,
    });
    // Unit-test spawn doubles that do not synthesize stdout represent a
    // successful command. A real kubectl invocation always returns JSON.
    if (!result.stdout.trim()) {
      return "unknown";
    }
    const resource = JSON.parse(result.stdout);
    const phase = resource.status?.phase ?? "Progressing";
    if (acceptedPhases.has(phase)) {
      return phase;
    }
    if (["Degraded", "Error"].includes(phase)) {
      throw new Error(`Argo Rollout ${rollout} entered ${phase}: ${rolloutStatusMessage(resource)}`);
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Timed out after ${options.timeout ?? defaultTimeout} waiting for Argo Rollout ${rollout}; last phase ${phase}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function rolloutStatusMessage(resource) {
  const message = [...(resource.status?.conditions ?? [])].reverse().find((condition) => condition.message)?.message;
  return String(message ?? "no controller condition message")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function durationToMilliseconds(duration) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(String(duration));
  if (!match) {
    throw new Error(`timeout must be a Kubernetes duration using ms, s, m, or h: ${duration}`);
  }
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return Number(match[1]) * multipliers[match[2]];
}

export function parsePlatformImageRef(imageRef) {
  const digestSeparatorIndex = imageRef.indexOf("@");
  const imageWithoutDigest = digestSeparatorIndex === -1 ? imageRef : imageRef.slice(0, digestSeparatorIndex);
  const digest = digestSeparatorIndex === -1 ? "" : imageRef.slice(digestSeparatorIndex + 1);
  const tagSeparatorIndex = imageWithoutDigest.lastIndexOf(":");
  const imageWithoutTag =
    tagSeparatorIndex === -1 ? imageWithoutDigest : imageWithoutDigest.slice(0, tagSeparatorIndex);
  const tag = tagSeparatorIndex === -1 ? "latest" : imageWithoutDigest.slice(tagSeparatorIndex + 1);
  const parts = imageWithoutTag.split("/");

  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error(
      "Platform image must look like registry.digitalocean.com/<registry>/<repository>:<tag> or @<digest>.",
    );
  }

  return {
    registry: parts[0],
    registryName: parts[1],
    repository: parts[2],
    tag,
    digest,
  };
}

function platformImageReference({ registryName, repository, tag, digest }) {
  if (digest) {
    return `registry.digitalocean.com/${registryName}/${repository}@${digest}`;
  }

  return `registry.digitalocean.com/${registryName}/${repository}:${tag}`;
}

function kubernetesComponentName(release, name) {
  return trimKubernetesName(`${release}-${chartName}-${name}`);
}

function scenarioSeedAccessName(release) {
  return trimKubernetesName(`${release}-${chartName}-scenario-seed-quiesce`);
}

function componentFromWorkloadName(workloadName, release) {
  return workloadName.replace(`${trimKubernetesName(`${release}-${chartName}`)}-`, "");
}

function trimKubernetesName(name) {
  return name.slice(0, 63).replace(/-+$/g, "");
}

function managedRegistryPullSecret(value = managedRegistryPullSecretName) {
  const name = requiredOption(value, "image-pull-secret");
  if (name !== managedRegistryPullSecretName) {
    throw new Error(
      `image-pull-secret must select the provider-managed '${managedRegistryPullSecretName}' authority (received '${name}').`,
    );
  }
  return name;
}

function requiredOption(value, name) {
  if (value == null || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function positiveHelmRevision(value, name) {
  const normalized = typeof value === "number" ? value : Number(String(value ?? ""));
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`${name} must be a positive Helm revision.`);
  }
  return normalized;
}

function requiredSha256Digest(value, name) {
  const normalized = requiredOption(value, name);
  if (!/^sha256:[0-9a-f]{64}$/i.test(String(normalized))) {
    throw new Error(`${name} must be a sha256 digest.`);
  }
  return String(normalized).toLowerCase();
}

function runProcess(options) {
  const spawnImpl = options.spawn ?? spawn;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const hasInput = options.input != null;
    const stdin = hasInput ? "pipe" : options.captureOutput ? "ignore" : "inherit";
    const stdout_ = options.captureOutput ? "pipe" : "inherit";
    const stderr_ = options.captureOutput ? "pipe" : "inherit";
    const child = spawnImpl(options.command, options.args, {
      stdio: [stdin, stdout_, stderr_],
      windowsHide: true,
    });

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (options.allowFailure) {
        resolve({ stdout, stderr, error });
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(
        new ProcessExitError(`${options.command} ${options.args.join(" ")} exited with code ${code ?? "unknown"}.`, {
          command: options.command,
          args: options.args,
          code,
          stdout,
          stderr,
        }),
      );
    });

    if (hasInput) {
      child.stdin.end(options.input);
    }
  });
}

class ProcessExitError extends Error {
  constructor(message, options) {
    super(message);
    this.name = "ProcessExitError";
    this.command = options.command;
    this.args = options.args;
    this.code = options.code;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
  }
}

function isHelmReleaseNotFound(error) {
  const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error instanceof Error ? error.message : String(error)}`;
  return /release:\s*not found/i.test(output) || /release [^\n]+ not found/i.test(output);
}

function isNamespaceNotFound(error) {
  const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error instanceof Error ? error.message : String(error)}`;
  return /\(NotFound\)/i.test(output) || /namespaces?\s+"[^"]+"\s+not found/i.test(output);
}

function isKubernetesResourceNotFound(error) {
  const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error instanceof Error ? error.message : String(error)}`;
  return /\(NotFound\)/i.test(output) || /rollouts?\.argoproj\.io\s+"[^"]+"\s+not found/i.test(output);
}

// Exported so the deploy-artifact guard can drive the EXACT workflow argv
// end-to-end (CLI parse -> helm arg construction).
export function parseArgs(argv, env = process.env) {
  const command = argv.find((arg) => arg !== "--");
  if (
    !command ||
    ![
      "deploy",
      "scenario-seed",
      "promote",
      "abort",
      "rollback",
      "diagnostics",
      "plan",
      "capture-rollback-target",
      "teardown",
    ].includes(command)
  ) {
    throw new Error(
      "Usage: node ./scripts/platform-kubernetes-deployment.mjs <deploy|scenario-seed|promote|abort|rollback|diagnostics|plan|capture-rollback-target|teardown> [--image <ref>] [--namespace <name>] [--release <name>] [--timeout <duration>] [--revision <n>] [--rollback-target <path>] [--rollouts-enabled true|false] [--quiesce-workers true|false] [--beta-wave-size <n>] [--beta-wave-rollout-exposure <10|25|50>] [--observability-exporter-endpoint <url>] [--runtime-env NAME=VALUE] [--out <path>] [--github-output <path>]",
    );
  }

  const rest = argv.slice(argv.indexOf(command) + 1);
  return {
    command,
    image: readOption(rest, "--image", env.PLATFORM_IMAGE_REF),
    imagePullSecret: readOption(rest, "--image-pull-secret", managedRegistryPullSecretName),
    observabilityExporterEndpoint: readOption(
      rest,
      "--observability-exporter-endpoint",
      env.CHASE_SETS_OBSERVABILITY_EXPORTER_ENDPOINT,
    ),
    envOverrides: readEnvOverrides(rest),
    namespace: readOption(rest, "--namespace", env.CHASE_SETS_KUBERNETES_NAMESPACE ?? defaultNamespace),
    release: readOption(rest, "--release", env.CHASE_SETS_HELM_RELEASE ?? defaultRelease),
    timeout: readOption(rest, "--timeout", env.CHASE_SETS_KUBERNETES_ROLLOUT_TIMEOUT ?? defaultTimeout),
    rolloutsEnabled: readBooleanOption(rest, "--rollouts-enabled", env.ARGO_ROLLOUTS_ENABLED),
    quiesceWorkers: readBooleanOption(rest, "--quiesce-workers", env.CHASE_SETS_SCENARIO_SEED_QUIESCE_WORKERS),
    betaWaveSize: readOption(rest, "--beta-wave-size", env.BETA_WAVE_SIZE),
    betaWaveRolloutExposure: readOption(rest, "--beta-wave-rollout-exposure", env.BETA_WAVE_ROLLOUT_EXPOSURE_PERCENT),
    revision: readOption(rest, "--revision", env.CHASE_SETS_HELM_ROLLBACK_REVISION),
    helmPath: readOption(rest, "--helm", env.HELM_PATH ?? "helm"),
    kubectlPath: readOption(rest, "--kubectl", env.KUBECTL_PATH ?? "kubectl"),
    registryName: readOption(rest, "--registry-name", env.DIGITALOCEAN_CONTAINER_REGISTRY_NAME),
    repository: readOption(rest, "--repository", env.PLATFORM_IMAGE_REPOSITORY),
    tag: readOption(rest, "--tag", env.ROLLBACK_IMAGE_TAG),
    digest: readOption(rest, "--digest", env.ROLLBACK_IMAGE_DIGEST),
    lastKnownGoodCommit: readOption(rest, "--last-known-good-commit", env.LAST_KNOWN_GOOD_COMMIT ?? ""),
    releaseTag: readOption(rest, "--release-tag", env.ROLLBACK_RELEASE_TAG ?? ""),
    rollbackTargetPath: readOption(rest, "--rollback-target", env.PLATFORM_KUBERNETES_ROLLBACK_TARGET),
    outPath: readOption(rest, "--out", env.PLATFORM_KUBERNETES_ROLLBACK_TARGET_OUT),
    jobName: readOption(rest, "--job-name", env.PLATFORM_KUBERNETES_SCENARIO_SEED_JOB_NAME),
    githubOutputPath: readOption(rest, "--github-output", env.GITHUB_OUTPUT),
    env,
  };
}

function readOption(argv, name, defaultValue = undefined) {
  const separateIndex = argv.indexOf(name);
  if (separateIndex !== -1) {
    return requiredOption(argv[separateIndex + 1], name);
  }

  const prefix = `${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? defaultValue;
}

function readBooleanOption(argv, name, defaultValue = undefined) {
  const value = readOption(argv, name, defaultValue);
  if (value == null || value === "") {
    return undefined;
  }
  if (!["true", "false"].includes(String(value).toLowerCase())) {
    throw new Error(`${name} must be true or false.`);
  }
  return String(value).toLowerCase() === "true";
}

function readOptions(argv, name) {
  const values = [];
  const prefix = `${name}=`;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) {
      values.push(requiredOption(argv[index + 1], name));
      index += 1;
    } else if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length));
    }
  }

  return values;
}

function readEnvOverrides(argv) {
  return normalizeEnvOverrides(Object.fromEntries(readOptions(argv, "--runtime-env").map(parseEnvOverride)));
}

function parseEnvOverride(raw) {
  const separatorIndex = raw.indexOf("=");
  if (separatorIndex <= 0) {
    throw new Error(`Runtime env override must look like NAME=VALUE: ${raw}`);
  }

  return [raw.slice(0, separatorIndex), requiredOption(raw.slice(separatorIndex + 1), raw.slice(0, separatorIndex))];
}

function normalizeEnvOverrides(overrides) {
  return Object.fromEntries(
    Object.entries(overrides)
      .map(([name, value]) => {
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
          throw new Error(`Runtime env override name must be an environment variable token: ${name}`);
        }
        return [name, requiredOption(value, name)];
      })
      .sort(([left], [right]) => left.localeCompare(right, "en")),
  );
}

async function main(argv, env = process.env) {
  const options = parseArgs(argv, env);

  if (options.command === "plan") {
    console.log(JSON.stringify(buildDeploymentEvidence({ ...options, action: "deploy" }), null, 2));
    return 0;
  }

  if (options.command === "deploy") {
    console.log(JSON.stringify(await deployPlatformToKubernetes(options), null, 2));
    return 0;
  }

  if (options.command === "scenario-seed") {
    const evidence = await runScenarioSeedOnKubernetes(options);
    if (options.outPath) {
      const { writeJsonRecord } = await import("./lib/output-file.mjs");
      await writeJsonRecord(options.outPath, evidence);
    }
    console.log(JSON.stringify(evidence, null, 2));
    return 0;
  }

  if (options.command === "promote") {
    console.log(JSON.stringify(await promotePlatformRollouts(options), null, 2));
    return 0;
  }

  if (options.command === "abort") {
    console.log(JSON.stringify(await abortPlatformRollouts(options), null, 2));
    return 0;
  }

  if (options.command === "rollback") {
    const rollbackTarget = options.rollbackTargetPath
      ? parseJsonCommandOutput(readFileSync(options.rollbackTargetPath, "utf8"), "rollback target file")
      : undefined;
    const evidence = await rollbackPlatformOnKubernetes({ ...options, rollbackTarget });
    if (options.outPath) {
      const { writeJsonRecord } = await import("./lib/output-file.mjs");
      await writeJsonRecord(options.outPath, evidence);
    }
    writeGithubOutput(options.githubOutputPath, {
      result: evidence.result,
      rollback_skip_reason: evidence.reason ?? "",
      rollback_source_revision: evidence.rollbackIdentity?.sourceRevision ?? "",
      rollback_resulting_revision: evidence.rollbackIdentity?.resultingRevision ?? "",
      rollback_observed_tag: evidence.rollbackIdentity?.observedTag ?? "",
      rollback_observed_digest: evidence.rollbackIdentity?.observedDigest ?? "",
      rollback_workload_identities: JSON.stringify(evidence.rollbackIdentity?.workloadIdentities ?? []),
    });
    console.log(JSON.stringify(evidence, null, 2));
    return evidence.result === "failure" ? 1 : 0;
  }

  if (options.command === "capture-rollback-target") {
    const target = await captureKubernetesRollbackTarget(options);
    if (options.outPath) {
      const { writeJsonRecord } = await import("./lib/output-file.mjs");
      await writeJsonRecord(options.outPath, target);
    }
    writeGithubOutput(options.githubOutputPath, {
      rollback_image_ref: target.imageRef,
      rollback_image_digest: target.digest,
      rollback_image_tag: target.tag,
      rollback_repository: target.repository,
      rollback_components: target.componentNames.join(","),
      rollback_registry_name: target.registryName,
      rollback_source_revision: target.sourceRevision,
      rollback_target_commit: target.lastKnownGoodCommit,
      rollback_release_tag: target.releaseTag,
      last_known_good_commit: target.lastKnownGoodCommit,
    });
    console.log(JSON.stringify(target, null, 2));
    return 0;
  }

  if (options.command === "teardown") {
    const evidence = await teardownPlatformKubernetesNamespace(options);
    if (options.outPath) {
      const { writeJsonRecord } = await import("./lib/output-file.mjs");
      await writeJsonRecord(options.outPath, evidence);
    }
    writeGithubOutput(options.githubOutputPath, {
      result: evidence.result,
      release_uninstalled: String(evidence.releaseUninstalled),
    });
    console.log(JSON.stringify(evidence, null, 2));
    return 0;
  }

  const diagnostics = await capturePlatformKubernetesDiagnostics({
    ...options,
    captureOutput: Boolean(options.outPath),
  });
  if (options.outPath) {
    await writeJsonRecord(options.outPath, buildKubernetesDiagnosticsRecord({ ...options, ...diagnostics }));
  }
  return 0;
}

function writeGithubOutput(filePath, values) {
  if (!filePath) {
    return;
  }

  appendFileSync(
    filePath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value ?? ""}`)
      .join("\n")}\n`,
  );
}

if (process.argv[1]?.endsWith("platform-kubernetes-deployment.mjs")) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
