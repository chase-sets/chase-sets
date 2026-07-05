#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { buildPlatformHelmValues } from "./render-platform-helm-values.mjs";

export const PLATFORM_KUBERNETES_DEPLOYMENT_VERSION = "platform-kubernetes-deployment/v1";

const chartName = "chase-sets-platform";
const chartPath = "infrastructure/helm/platform";
const defaultRelease = "chase-sets-platform";
const defaultNamespace = "chase-sets-platform";
const defaultTimeout = "10m";

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
  ];
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
    [
      "kubectl",
      ["get", "pods,jobs,deployments,events", "--namespace", namespace, "--sort-by=.metadata.creationTimestamp"],
    ],
    ...workloads.deployments.map((deployment) => [
      "kubectl",
      ["describe", "deployment", deployment, "--namespace", namespace],
    ]),
    ...workloads.jobs.map((job) => ["kubectl", ["describe", "job", job, "--namespace", namespace]]),
    ...componentSelectors.map((component) => [
      "kubectl",
      ["logs", "--namespace", namespace, "--selector", component.selector, "--all-containers", "--tail", tailLines],
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
    workloads,
  };
}

export async function deployPlatformToKubernetes(options = {}) {
  const helmPath = options.helmPath ?? "helm";
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const workloads = options.workloads ?? platformKubernetesWorkloads(options);

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

async function runProcess(options) {
  const spawnImpl = options.spawn ?? spawn;

  await new Promise((resolve, reject) => {
    const child = spawnImpl(options.command, options.args, {
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", options.allowFailure ? resolve : reject);
    child.on("close", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve();
        return;
      }
      reject(new Error(`${options.command} ${options.args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });
  });
}

function parseArgs(argv, env = process.env) {
  const command = argv.find((arg) => arg !== "--");
  if (!command || !["deploy", "rollback", "diagnostics", "plan"].includes(command)) {
    throw new Error(
      "Usage: node ./scripts/platform-kubernetes-deployment.mjs <deploy|rollback|diagnostics|plan> [--image <ref>] [--namespace <name>] [--release <name>] [--timeout <duration>] [--revision <n>]",
    );
  }

  const rest = argv.slice(argv.indexOf(command) + 1);
  return {
    command,
    image: readOption(rest, "--image", env.PLATFORM_IMAGE_REF),
    namespace: readOption(rest, "--namespace", env.CHASE_SETS_KUBERNETES_NAMESPACE ?? defaultNamespace),
    release: readOption(rest, "--release", env.CHASE_SETS_HELM_RELEASE ?? defaultRelease),
    timeout: readOption(rest, "--timeout", env.CHASE_SETS_KUBERNETES_ROLLOUT_TIMEOUT ?? defaultTimeout),
    revision: readOption(rest, "--revision", env.CHASE_SETS_HELM_ROLLBACK_REVISION),
    helmPath: readOption(rest, "--helm", env.HELM_PATH ?? "helm"),
    kubectlPath: readOption(rest, "--kubectl", env.KUBECTL_PATH ?? "kubectl"),
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
    console.log(JSON.stringify(await rollbackPlatformOnKubernetes(options), null, 2));
    return 0;
  }

  await capturePlatformKubernetesDiagnostics(options);
  return 0;
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
