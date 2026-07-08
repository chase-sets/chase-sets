#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { buildPlatformHelmValues, renderYaml } from "./render-platform-helm-values.mjs";

const chartRelativePath = "infrastructure/helm/platform";
const chartName = "chase-sets-platform";
const defaultReleaseName = "chase-sets-local";
const defaultNamespace = "chase-sets-platform-local-boot";
const defaultTimeout = "180s";

const serviceCommand =
  "node -e \"const http=require('node:http');const port=Number(process.env.PORT||8080);http.createServer((_request,response)=>{response.writeHead(200);response.end('ok')}).listen(port,'0.0.0.0',()=>console.log('local boot http ready '+port))\"";
// The worker now carries DOKS liveness/readiness/startup probes (#4620), so its
// local-boot proof must answer them; a 200-to-everything HTTP server on PORT
// keeps the boot proof green and exercises the probe wiring end to end.
const workerCommand =
  "node -e \"const http=require('node:http');const port=Number(process.env.PORT||8080);http.createServer((_request,response)=>{response.writeHead(200);response.end('ok')}).listen(port,'0.0.0.0',()=>console.log('platform-worker local boot proof ready '+port))\"";
const jobCommand = "node -e \"console.log('platform-bootstrap local boot proof complete')\"";

export function buildPlatformHelmLocalBootValues(options = {}) {
  const values = structuredClone(options.values ?? buildPlatformHelmValues({ repoRoot: options.repoRoot }));

  values.global.image = {
    registry: options.imageRegistry ?? "docker.io",
    registryName: options.imageRegistryName ?? "library",
    repository: options.imageRepository ?? "node",
    tag: options.imageTag ?? "24-alpine",
    digest: "",
    pullPolicy: options.imagePullPolicy ?? "IfNotPresent",
  };
  values.global.existingSecretName = "chase-sets-platform-local-boot";
  values.global.podLabels = {
    ...(values.global.podLabels ?? {}),
    "chase-sets.com/local-boot": "true",
  };

  for (const [name, component] of Object.entries(values.components ?? {})) {
    component.replicas = component.kind === "job" ? 1 : 1;
    component.command = localBootCommandFor(component.kind);
    component.env = (component.env ?? []).map(toLocalBootEnvEntry);
    component.resources = {};
    component.podLabels = {
      ...(component.podLabels ?? {}),
      "chase-sets.com/local-boot-component": name,
    };

    if (component.kind === "job" && component.job?.quiesce) {
      component.job.quiesce = {
        ...component.job.quiesce,
        enabled: false,
      };
    }
  }

  return values;
}

export function renderPlatformHelmLocalBootValues(options = {}) {
  return `${renderYaml(buildPlatformHelmLocalBootValues(options))}\n`;
}

export function summarizePlatformHelmLocalBoot(options = {}) {
  const release = options.release ?? defaultReleaseName;
  const values = options.values ?? buildPlatformHelmLocalBootValues(options);
  const workloads = platformHelmLocalBootWorkloads({ values, release });

  return {
    namespace: options.namespace ?? defaultNamespace,
    release,
    image: `${values.global.image.registry}/${values.global.image.registryName}/${values.global.image.repository}:${values.global.image.tag}`,
    deployments: workloads.deployments,
    jobs: workloads.jobs,
  };
}

export function platformHelmLocalBootWorkloads(options = {}) {
  const values = options.values ?? buildPlatformHelmLocalBootValues(options);
  const release = options.release ?? defaultReleaseName;
  const deployments = [];
  const jobs = [];

  for (const [name, component] of Object.entries(values.components ?? {})) {
    if (!component.enabled) {
      continue;
    }

    const workloadName = componentName(release, name);
    if (component.kind === "service" || component.kind === "worker") {
      deployments.push(workloadName);
    } else if (component.kind === "job") {
      jobs.push(workloadName);
    }
  }

  return { deployments, jobs };
}

export async function renderPlatformHelmLocalBootManifest(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? ".");
  const tempDir = mkdtempSync(path.join(tmpdir(), "chase-sets-platform-helm-local-boot-"));
  const valuesPath = path.join(tempDir, "values.yaml");

  try {
    writeFileSync(valuesPath, renderPlatformHelmLocalBootValues(options), "utf8");
    const result = await runProcess({
      command: options.dockerPath ?? "docker",
      args: [
        "run",
        "--rm",
        "-v",
        `${rootDir}:/repo`,
        "-v",
        `${tempDir}:/values`,
        "-w",
        "/repo",
        options.helmImage ?? "alpine/helm:3.15.4",
        "template",
        options.release ?? defaultReleaseName,
        chartRelativePath,
        "-f",
        "/values/values.yaml",
      ],
      captureStdout: true,
      spawn: options.spawn,
    });
    return result.stdout;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function applyPlatformHelmLocalBoot(options = {}) {
  const namespace = options.namespace ?? defaultNamespace;
  const release = options.release ?? defaultReleaseName;
  const timeout = options.timeout ?? defaultTimeout;
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const manifest = options.manifest ?? (await renderPlatformHelmLocalBootManifest(options));
  const workloads = platformHelmLocalBootWorkloads({
    values: options.values ?? buildPlatformHelmLocalBootValues(options),
    release,
  });

  await runProcess({
    command: kubectlPath,
    args: ["create", "namespace", namespace, "--dry-run=client", "-o", "yaml"],
    captureStdout: true,
    spawn: options.spawn,
  }).then((result) =>
    runProcess({
      command: kubectlPath,
      args: ["apply", "-f", "-"],
      input: result.stdout,
      spawn: options.spawn,
    }),
  );

  await runProcess({
    command: kubectlPath,
    args: ["apply", "-n", namespace, "-f", "-"],
    input: manifest,
    spawn: options.spawn,
  });

  for (const deployment of workloads.deployments) {
    await runProcess({
      command: kubectlPath,
      args: ["rollout", "status", `deployment/${deployment}`, "-n", namespace, `--timeout=${timeout}`],
      spawn: options.spawn,
    });
  }

  for (const job of workloads.jobs) {
    await runProcess({
      command: kubectlPath,
      args: ["wait", "--for=condition=Complete", `job/${job}`, "-n", namespace, `--timeout=${timeout}`],
      spawn: options.spawn,
    });
  }

  return { namespace, release, ...workloads };
}

function localBootCommandFor(kind) {
  if (kind === "job") {
    return jobCommand;
  }
  if (kind === "worker") {
    return workerCommand;
  }
  return serviceCommand;
}

function toLocalBootEnvEntry(entry) {
  if (!entry.secret) {
    return entry;
  }

  return {
    name: entry.name,
    value: localBootEnvValue(entry.name),
  };
}

function localBootEnvValue(name) {
  if (name.includes("DATABASE_URL")) {
    return "postgres://local-boot:not-used@localhost:5432/local_boot";
  }
  if (name.includes("SECRET") || name.includes("KEY") || name.includes("TOKEN")) {
    return "local-boot-placeholder";
  }
  return "";
}

function componentName(release, name) {
  return trimKubernetesName(`${release}-${chartName}-${name}`);
}

function trimKubernetesName(name) {
  return name.slice(0, 63).replace(/-+$/g, "");
}

async function runProcess(options) {
  const spawnImpl = options.spawn ?? spawn;

  return await new Promise((resolve, reject) => {
    const child = spawnImpl(options.command, options.args, {
      cwd: options.cwd,
      stdio: [options.input ? "pipe" : "ignore", options.captureStdout ? "pipe" : "inherit", "inherit"],
      windowsHide: true,
    });
    let stdout = "";

    child.on("error", reject);
    if (options.captureStdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }
      reject(new Error(`${options.command} ${options.args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });
    if (options.input) {
      child.stdin.end(options.input);
    }
  });
}

function parseArgs(argv, env = process.env) {
  const options = {
    namespace: env.CHASE_SETS_KUBERNETES_NAMESPACE ?? defaultNamespace,
    release: env.CHASE_SETS_HELM_RELEASE ?? defaultReleaseName,
    timeout: env.CHASE_SETS_KUBERNETES_ROLLOUT_TIMEOUT ?? defaultTimeout,
    kubectlPath: env.KUBECTL_PATH ?? "kubectl",
    dockerPath: env.DOCKER_PATH ?? "docker",
    dryRun: false,
    printValues: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--print-values") {
      options.printValues = true;
    } else if (arg === "--namespace") {
      options.namespace = readNextArg(argv, ++index, arg);
    } else if (arg === "--release") {
      options.release = readNextArg(argv, ++index, arg);
    } else if (arg === "--timeout") {
      options.timeout = readNextArg(argv, ++index, arg);
    } else if (arg === "--image-tag") {
      options.imageTag = readNextArg(argv, ++index, arg);
    } else if (arg === "--kubectl") {
      options.kubectlPath = readNextArg(argv, ++index, arg);
    } else if (arg === "--docker") {
      options.dockerPath = readNextArg(argv, ++index, arg);
    } else {
      throw new Error(
        "Usage: node ./scripts/platform-helm-local-boot.mjs [--dry-run] [--print-values] [--namespace <name>] [--release <name>] [--timeout <duration>] [--image-tag <tag>] [--kubectl <path>] [--docker <path>]",
      );
    }
  }

  return options;
}

function readNextArg(argv, index, name) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

async function main(argv, env = process.env) {
  const options = parseArgs(argv, env);
  if (options.printValues) {
    process.stdout.write(renderPlatformHelmLocalBootValues(options));
    return 0;
  }

  if (options.dryRun) {
    await renderPlatformHelmLocalBootManifest(options);
    console.log(JSON.stringify(summarizePlatformHelmLocalBoot(options), null, 2));
    return 0;
  }

  const result = await applyPlatformHelmLocalBoot(options);
  console.log(
    `Platform Helm local boot passed in ${result.namespace}: ${result.deployments.length} deployments available, ${result.jobs.length} jobs complete.`,
  );
  return 0;
}

if (process.argv[1]?.endsWith("platform-helm-local-boot.mjs")) {
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
