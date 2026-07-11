#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import {
  buildDoksIngressValues,
  buildPlatformHelmValues,
  buildPreviewDoksIngressValues,
  previewWildcardTlsSecretName,
  previewWildcardTlsSecretNamespace,
} from "./render-platform-helm-values.mjs";

export const PLATFORM_KUBERNETES_DEPLOYMENT_VERSION = "platform-kubernetes-deployment/v1";
export const PLATFORM_KUBERNETES_ROLLBACK_TARGET_VERSION = "platform-kubernetes-rollback-target/v1";
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
const defaultRelease = "chase-sets-platform";
const defaultNamespace = "chase-sets-platform";
const defaultTimeout = "10m";
// teardown only ever deletes preview namespaces/releases. The bare
// "chase-sets-platform" default above is the staging/production namespace,
// so teardown must never fall through to it: require an explicit
// chase-sets-pr-<number> namespace, matching how the preview deploy names
// its namespace and Helm release in platform-pr.yml.
const previewNamespacePattern = /^chase-sets-pr-\d+$/;

export function platformKubernetesWorkloads(options = {}) {
  const values = options.values ?? buildPlatformHelmValues({ repoRoot: options.repoRoot });
  const release = options.release ?? defaultRelease;
  const deployments = [];
  const jobs = [];

  for (const [name, component] of Object.entries(values.components ?? {})) {
    if (!component.enabled) {
      continue;
    }

    const workloadName = kubernetesComponentName(release, name);
    if (component.kind === "service" || component.kind === "worker") {
      deployments.push(workloadName);
    } else if (component.kind === "job") {
      jobs.push(workloadName);
    }
  }

  return { deployments, jobs };
}

export function buildHelmUpgradeArgs(options = {}) {
  const release = requiredOption(options.release ?? defaultRelease, "release");
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const timeout = requiredOption(options.timeout ?? defaultTimeout, "timeout");
  const image = parsePlatformImageRef(requiredOption(options.image, "image"));
  const imagePullSecret = options.imagePullSecret ?? "";
  const envOverrides = normalizeEnvOverrides(options.envOverrides ?? {});
  const environmentValuesPath = platformValuesPathForEnvironment(envOverrides.DEPLOYMENT_ENVIRONMENT);
  const doksIngressSetArgs =
    envOverrides.DEPLOYMENT_ENVIRONMENT === "staging"
      ? buildDoksIngressHelmSetArgs(buildDoksIngressValues({ env: options.env ?? {} }))
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
    ...(imagePullSecret ? ["--set-string", `global.imagePullSecrets[0].name=${imagePullSecret}`] : []),
    ...Object.entries(envOverrides).flatMap(([name, value]) => [
      "--set-string",
      `global.envOverrides.${name}=${escapeHelmSetStringValue(value)}`,
    ]),
  ];
}

export function platformValuesPathForEnvironment(environmentName) {
  return environmentName === "staging" ? stagingValuesPath : null;
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
  const revision = options.revision;

  return [
    "rollback",
    release,
    ...(revision ? [String(revision)] : []),
    "--namespace",
    namespace,
    "--wait",
    "--timeout",
    timeout,
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

export function buildDiagnosticsCommands(options = {}) {
  const namespace = requiredOption(options.namespace ?? defaultNamespace, "namespace");
  const workloads = options.workloads ?? platformKubernetesWorkloads(options);
  const tailLines = String(options.tailLines ?? 300);
  const componentSelectors = [...workloads.deployments, ...workloads.jobs].map((name) => ({
    name,
    selector: `app.kubernetes.io/instance=${options.release ?? defaultRelease},app.kubernetes.io/component=${componentFromWorkloadName(name, options.release ?? defaultRelease)}`,
  }));

  return [
    ["kubectl", ["get", "pods", "--namespace", namespace, "--sort-by=.metadata.creationTimestamp", "--output", "wide"]],
    ["kubectl", ["get", "jobs", "--namespace", namespace, "--sort-by=.metadata.creationTimestamp"]],
    ["kubectl", ["get", "deployments", "--namespace", namespace, "--sort-by=.metadata.creationTimestamp"]],
    ["kubectl", ["get", "events", "--namespace", namespace, "--sort-by=.lastTimestamp"]],
    ...workloads.deployments.map((deployment) => [
      "kubectl",
      ["describe", "deployment", deployment, "--namespace", namespace],
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
  };
}

export function buildKubernetesRollbackTarget(options = {}) {
  const registryName = requiredOption(options.registryName, "registryName");
  const repository = requiredOption(options.repository, "repository");
  const tag = options.tag ?? options.releaseTag ?? "";
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
    componentNames: [...workloads.deployments, ...workloads.jobs].sort(),
    lastKnownGoodCommit: options.lastKnownGoodCommit ?? "",
    releaseTag: options.releaseTag ?? "",
  };
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
  await waitForPlatformRollouts({ ...options, kubectlPath, workloads });

  return buildDeploymentEvidence({
    ...options,
    action: "deploy",
    result: "success",
    workloads,
  });
}

export async function rollbackPlatformOnKubernetes(options = {}) {
  const helmPath = options.helmPath ?? "helm";
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const workloads = options.workloads ?? platformKubernetesWorkloads(options);
  const releaseExists = options.releaseExists ?? (await helmReleaseExists({ ...options, helmPath }));

  if (!releaseExists) {
    return buildDeploymentEvidence({
      ...options,
      action: "rollback",
      result: "skipped",
      reason: "helm-release-not-found",
      workloads,
    });
  }

  await runProcess({
    command: helmPath,
    args: buildHelmRollbackArgs(options),
    spawn: options.spawn,
  });
  await waitForPlatformRollouts({ ...options, kubectlPath, workloads });

  return buildDeploymentEvidence({
    ...options,
    action: "rollback",
    result: "success",
    workloads,
  });
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
  if (!previewNamespacePattern.test(namespace)) {
    throw new Error(`Refusing to tear down non-preview namespace "${namespace}"; expected chase-sets-pr-<number>.`);
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
      `Preview namespace ${namespace} still exists after kubectl delete namespace completed; refusing to report cleanup success.`,
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

  for (const [command, args] of commands) {
    await runProcess({
      command: command === "kubectl" ? (options.kubectlPath ?? "kubectl") : command,
      args,
      spawn: options.spawn,
      allowFailure: true,
    });
  }

  return { commandCount: commands.length };
}

async function waitForPlatformRollouts(options) {
  for (const deployment of options.workloads.deployments) {
    await runProcess({
      command: options.kubectlPath,
      args: buildRolloutStatusArgs(deployment, options),
      spawn: options.spawn,
    });
  }
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

function componentFromWorkloadName(workloadName, release) {
  return workloadName.replace(`${trimKubernetesName(`${release}-${chartName}`)}-`, "");
}

function trimKubernetesName(name) {
  return name.slice(0, 63).replace(/-+$/g, "");
}

function requiredOption(value, name) {
  if (value == null || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
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

// Exported so the deploy-artifact guard can drive the EXACT workflow argv
// end-to-end (CLI parse -> helm arg construction).
export function parseArgs(argv, env = process.env) {
  const command = argv.find((arg) => arg !== "--");
  if (
    !command ||
    !["deploy", "rollback", "diagnostics", "plan", "capture-rollback-target", "teardown"].includes(command)
  ) {
    throw new Error(
      "Usage: node ./scripts/platform-kubernetes-deployment.mjs <deploy|rollback|diagnostics|plan|capture-rollback-target|teardown> [--image <ref>] [--namespace <name>] [--release <name>] [--timeout <duration>] [--revision <n>] [--runtime-env NAME=VALUE] [--out <path>] [--github-output <path>]",
    );
  }

  const rest = argv.slice(argv.indexOf(command) + 1);
  return {
    command,
    image: readOption(rest, "--image", env.PLATFORM_IMAGE_REF),
    imagePullSecret: readOption(rest, "--image-pull-secret", env.CHASE_SETS_IMAGE_PULL_SECRET_NAME ?? ""),
    envOverrides: readEnvOverrides(rest),
    namespace: readOption(rest, "--namespace", env.CHASE_SETS_KUBERNETES_NAMESPACE ?? defaultNamespace),
    release: readOption(rest, "--release", env.CHASE_SETS_HELM_RELEASE ?? defaultRelease),
    timeout: readOption(rest, "--timeout", env.CHASE_SETS_KUBERNETES_ROLLOUT_TIMEOUT ?? defaultTimeout),
    revision: readOption(rest, "--revision", env.CHASE_SETS_HELM_ROLLBACK_REVISION),
    helmPath: readOption(rest, "--helm", env.HELM_PATH ?? "helm"),
    kubectlPath: readOption(rest, "--kubectl", env.KUBECTL_PATH ?? "kubectl"),
    registryName: readOption(rest, "--registry-name", env.DIGITALOCEAN_CONTAINER_REGISTRY_NAME),
    repository: readOption(rest, "--repository", env.PLATFORM_IMAGE_REPOSITORY),
    lastKnownGoodCommit: readOption(rest, "--last-known-good-commit", env.LAST_KNOWN_GOOD_COMMIT ?? ""),
    releaseTag: readOption(rest, "--release-tag", env.ROLLBACK_RELEASE_TAG ?? ""),
    outPath: readOption(rest, "--out", env.PLATFORM_KUBERNETES_ROLLBACK_TARGET_OUT),
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

  if (options.command === "rollback") {
    const evidence = await rollbackPlatformOnKubernetes(options);
    if (options.outPath) {
      const { writeJsonRecord } = await import("./lib/output-file.mjs");
      await writeJsonRecord(options.outPath, evidence);
    }
    writeGithubOutput(options.githubOutputPath, {
      result: evidence.result,
      rollback_skip_reason: evidence.reason ?? "",
    });
    console.log(JSON.stringify(evidence, null, 2));
    return 0;
  }

  if (options.command === "capture-rollback-target") {
    const target = buildKubernetesRollbackTarget(options);
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

  await capturePlatformKubernetesDiagnostics(options);
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
