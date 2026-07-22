#!/usr/bin/env node
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const chartDir = path.join(scriptDir, "..", "infrastructure", "helm", "doks-ingress");
const configurationMarkerPrefix = "chase-sets-doks-addons:v1:";
const configurationMarkerPattern = /^chase-sets-doks-addons:v1:[a-f0-9]{64}$/;
const materialValueFlags = new Set(["--set", "--set-string", "--set-json", "--set-file"]);

// Pinned upstream releases. Bump deliberately with an operator note; the DOKS
// cutover proves ingress and cert issuance against these exact versions.
export const pinned = {
  ingressNginx: {
    releaseName: "ingress-nginx",
    repoName: "ingress-nginx",
    repoUrl: "https://kubernetes.github.io/ingress-nginx",
    chart: "ingress-nginx/ingress-nginx",
    version: "4.11.3",
    namespace: "ingress-nginx",
    valuesFile: path.join(chartDir, "ingress-nginx-values.yaml"),
  },
  certManager: {
    releaseName: "cert-manager",
    repoName: "jetstack",
    repoUrl: "https://charts.jetstack.io",
    chart: "jetstack/cert-manager",
    version: "v1.16.2",
    namespace: "cert-manager",
    valuesFile: path.join(chartDir, "cert-manager-values.yaml"),
  },
  argoRollouts: {
    releaseName: "argo-rollouts",
    repoName: "argo",
    repoUrl: "https://argoproj.github.io/argo-helm",
    chart: "argo/argo-rollouts",
    version: "2.41.0",
    appVersion: "v1.9.0",
    namespace: "argo-rollouts",
    valuesFile: path.join(chartDir, "argo-rollouts-values.yaml"),
  },
  clusterIssuers: {
    releaseName: "chase-sets-doks-ingress",
    // The ACME account keys and issued certificate Secrets live in cert-manager's
    // namespace, so the ClusterIssuer release rides in the same namespace.
    namespace: "cert-manager",
    chartPath: chartDir,
    version: "0.1.0",
    valuesFile: path.join(chartDir, "values.yaml"),
  },
};

const releaseRequirements = [
  { key: "ingressNginx", chartName: "ingress-nginx" },
  { key: "certManager", chartName: "cert-manager" },
  { key: "argoRollouts", chartName: "argo-rollouts" },
  { key: "clusterIssuers", chartName: "chase-sets-doks-ingress" },
];

const supportedEnvironments = new Set(["staging", "production"]);

// Only staging hosts previews, while production needs DNS-01 for the
// pre-cutover live-host certificate. Both clusters therefore receive the
// namespaced DNS token Secret, but each ClusterIssuer solver is constrained
// to the one zone it owns for this purpose.
const previewEnvironment = "staging";
export const doksDnsTokenSecretName = "digitalocean-dns-token";
export const doksDnsTokenSecretKey = "access-token";
export const doksDnsTokenSecretNamespace = "cert-manager";

export function loadBalancerName(environment) {
  return `chase-sets-${environment}-doks-ingress`;
}

export function canonicalValuesChecksum(valuesFile) {
  return createHash("sha256").update(readFileSync(valuesFile)).digest("hex");
}

function releaseNameFromUpgradeCommand(command) {
  const installFlagIndex = command.indexOf("--install");
  return installFlagIndex >= 0 ? command[installFlagIndex + 1] : undefined;
}

function namespaceFromCommand(command) {
  const namespaceFlagIndex = command.indexOf("--namespace");
  return namespaceFlagIndex >= 0 ? command[namespaceFlagIndex + 1] : undefined;
}

export function materialOverridesFromCommand(command) {
  const overrides = [];
  for (let index = 0; index < command.length; index += 1) {
    const flag = command[index];
    if (!materialValueFlags.has(flag)) {
      continue;
    }
    const assignment = command[++index];
    if (typeof assignment !== "string" || !assignment.includes("=")) {
      throw new Error(`${flag} requires a key=value assignment.`);
    }
    overrides.push({ flag, assignment });
  }
  return overrides;
}

function valuesFilesFromCommand(command) {
  const valuesFiles = [];
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === "--values" || command[index] === "-f") {
      const valuesFile = command[++index];
      if (typeof valuesFile !== "string" || !valuesFile) {
        throw new Error("Helm values flags require a file path.");
      }
      valuesFiles.push(valuesFile);
    }
  }
  return valuesFiles;
}

function fingerprintedOverride(override) {
  if (override.flag !== "--set-file") {
    return override;
  }
  const separatorIndex = override.assignment.indexOf("=");
  const key = override.assignment.slice(0, separatorIndex);
  const valuesFile = override.assignment.slice(separatorIndex + 1);
  return { flag: override.flag, assignment: `${key}=sha256:${canonicalValuesChecksum(valuesFile)}` };
}

// The marker covers source-owned values bytes and every material Helm value
// override in the real plan. Operational flags such as wait timeouts are
// deliberately absent so they cannot force a release mutation.
export function effectiveConfigurationFingerprint(valuesFiles, command) {
  const allValuesFiles = [...new Set([...valuesFiles, ...valuesFilesFromCommand(command)])];
  const materialPlan = {
    valuesFiles: allValuesFiles.map((valuesFile) => canonicalValuesChecksum(valuesFile)),
    overrides: materialOverridesFromCommand(command).map(fingerprintedOverride),
  };
  return createHash("sha256").update(JSON.stringify(materialPlan)).digest("hex");
}

export function configurationMarkerForStep(step, valuesFiles) {
  return `${configurationMarkerPrefix}${effectiveConfigurationFingerprint(valuesFiles, step.command)}`;
}

export function requiredClusterAddons(options = {}) {
  const environment = options.environment ?? "staging";
  const steps = options.steps ?? planClusterAddons({ environment });

  return releaseRequirements.map(({ key, chartName }) => {
    const release = pinned[key];
    const step = steps.find(
      (candidate) =>
        releaseNameFromUpgradeCommand(candidate.command) === release.releaseName &&
        namespaceFromCommand(candidate.command) === release.namespace,
    );
    if (!step) {
      throw new Error(`No install step found for Helm release ${release.releaseName}.`);
    }
    const valuesFiles = [release.valuesFile];
    return {
      releaseName: release.releaseName,
      namespace: release.namespace,
      chart: chartName,
      version: release.version,
      materialOverrides: materialOverridesFromCommand(step.command),
      configurationMarker: configurationMarkerForStep(step, valuesFiles),
    };
  });
}

export function parseReleaseMetadata(output) {
  const metadata = JSON.parse(output);
  if (
    !metadata ||
    typeof metadata !== "object" ||
    typeof metadata.name !== "string" ||
    typeof metadata.namespace !== "string" ||
    typeof metadata.chart !== "string" ||
    typeof metadata.version !== "string" ||
    typeof metadata.appVersion !== "string" ||
    !Number.isInteger(metadata.revision) ||
    metadata.revision < 1 ||
    typeof metadata.status !== "string" ||
    typeof metadata.deployedAt !== "string"
  ) {
    throw new Error("Helm release metadata has an unexpected shape.");
  }
  return metadata;
}

export function parseReleaseValues(output) {
  const values = JSON.parse(output);
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Helm release values have an unexpected shape.");
  }
  return values;
}

export function parseReleaseHistory(output) {
  const history = JSON.parse(output);
  if (
    !Array.isArray(history) ||
    history.length !== 1 ||
    !Number.isInteger(history[0]?.revision) ||
    history[0].revision < 1 ||
    typeof history[0].updated !== "string" ||
    typeof history[0].status !== "string" ||
    typeof history[0].chart !== "string" ||
    typeof history[0].app_version !== "string" ||
    typeof history[0].description !== "string"
  ) {
    throw new Error("Helm release history has an unexpected shape.");
  }
  return history[0];
}

function parseConfigurationMarker(description) {
  if (!configurationMarkerPattern.test(description)) {
    throw new Error("Helm release configuration marker has an unexpected shape.");
  }
  return description;
}

function valuePathFromAssignment(assignment) {
  const separatorIndex = assignment.indexOf("=");
  const key = assignment.slice(0, separatorIndex);
  const pathParts = [];
  let part = "";
  for (let index = 0; index < key.length; index += 1) {
    const character = key[index];
    if (character === "\\") {
      if (index + 1 >= key.length) {
        throw new Error("Helm value path ends with an escape character.");
      }
      part += key[++index];
    } else if (character === ".") {
      if (!part) {
        throw new Error("Helm value path contains an empty segment.");
      }
      pathParts.push(part);
      part = "";
    } else if (character === "[") {
      if (part) {
        pathParts.push(part);
        part = "";
      }
      const closingIndex = key.indexOf("]", index + 1);
      const arrayIndex = key.slice(index + 1, closingIndex);
      if (closingIndex < 0 || !/^\d+$/.test(arrayIndex)) {
        throw new Error("Helm value path contains an invalid array index.");
      }
      pathParts.push(Number(arrayIndex));
      index = closingIndex;
    } else {
      part += character;
    }
  }
  if (part) {
    pathParts.push(part);
  }
  if (pathParts.length === 0) {
    throw new Error("Helm value path is empty.");
  }
  return pathParts;
}

function expectedOverrideValue({ flag, assignment }) {
  const rawValue = assignment.slice(assignment.indexOf("=") + 1);
  if (flag === "--set-string") {
    return rawValue;
  }
  if (flag === "--set-json") {
    return JSON.parse(rawValue);
  }
  if (flag === "--set-file") {
    return readFileSync(rawValue, "utf8");
  }
  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }
  if (rawValue === "null") {
    return null;
  }
  if (/^-?\d+$/.test(rawValue)) {
    return Number(rawValue);
  }
  return rawValue;
}

function releaseValuesMatchMaterialOverrides(values, overrides) {
  return overrides.every((override) => {
    let actualValue = values;
    for (const part of valuePathFromAssignment(override.assignment)) {
      if (actualValue === null || typeof actualValue !== "object" || !(part in actualValue)) {
        return false;
      }
      actualValue = actualValue[part];
    }
    return JSON.stringify(actualValue) === JSON.stringify(expectedOverrideValue(override));
  });
}

export async function clusterAddonsAreUpToDate(options = {}) {
  const runCommand = options.runCommand;
  if (typeof runCommand !== "function") {
    throw new Error("clusterAddonsAreUpToDate requires a runCommand function.");
  }

  try {
    const releaseChecks = await Promise.all(
      requiredClusterAddons({ environment: options.environment }).map(async (required) => {
        const reads = await Promise.allSettled([
          runCommand("helm", [
            "get",
            "metadata",
            required.releaseName,
            "--namespace",
            required.namespace,
            "--output",
            "json",
          ]),
          runCommand("helm", [
            "get",
            "values",
            required.releaseName,
            "--namespace",
            required.namespace,
            "--output",
            "json",
          ]),
          runCommand("helm", [
            "history",
            required.releaseName,
            "--namespace",
            required.namespace,
            "--max",
            "1",
            "--output",
            "json",
          ]),
        ]);
        if (reads.some((read) => read.status === "rejected")) {
          return false;
        }
        const metadata = parseReleaseMetadata(reads[0].value);
        const values = parseReleaseValues(reads[1].value);
        const history = parseReleaseHistory(reads[2].value);
        return (
          metadata.name === required.releaseName &&
          metadata.namespace === required.namespace &&
          metadata.status === "deployed" &&
          metadata.chart === required.chart &&
          metadata.version === required.version &&
          history.revision === metadata.revision &&
          history.status === "deployed" &&
          parseConfigurationMarker(history.description) === required.configurationMarker &&
          releaseValuesMatchMaterialOverrides(values, required.materialOverrides)
        );
      }),
    );
    return releaseChecks.every(Boolean);
  } catch {
    // A missing release, malformed output, or a failed read is drift. The
    // caller deliberately falls through to the existing fail-loud install path.
    return false;
  }
}

// Pure planner: returns the ordered helm steps so a dry run and the tests can
// assert the exact commands without a live cluster.
export function planClusterAddons(options = {}) {
  const environment = options.environment ?? "staging";
  if (!supportedEnvironments.has(environment)) {
    throw new Error(`environment must be one of ${[...supportedEnvironments].join(", ")}.`);
  }

  const installTimeout = options.installTimeout ?? "10m";
  const issuerTimeout = options.issuerTimeout ?? "5m";
  const lbName = loadBalancerName(environment);
  const dns01Zone = environment === "production" ? "chasesets.com" : "preview.chasesets.com";
  const lbAnnotationKey = "controller.service.annotations.service\\.beta\\.kubernetes\\.io/do-loadbalancer-name";

  return [
    {
      name: "add ingress-nginx repo",
      command: ["helm", "repo", "add", pinned.ingressNginx.repoName, pinned.ingressNginx.repoUrl, "--force-update"],
    },
    {
      name: "add cert-manager repo",
      command: ["helm", "repo", "add", pinned.certManager.repoName, pinned.certManager.repoUrl, "--force-update"],
    },
    {
      name: "add Argo repo",
      command: ["helm", "repo", "add", pinned.argoRollouts.repoName, pinned.argoRollouts.repoUrl, "--force-update"],
    },
    {
      name: "refresh repos",
      command: [
        "helm",
        "repo",
        "update",
        pinned.ingressNginx.repoName,
        pinned.certManager.repoName,
        pinned.argoRollouts.repoName,
      ],
    },
    {
      name: "install ingress-nginx controller and DigitalOcean load balancer",
      command: [
        "helm",
        "upgrade",
        "--install",
        pinned.ingressNginx.releaseName,
        pinned.ingressNginx.chart,
        "--version",
        pinned.ingressNginx.version,
        "--namespace",
        pinned.ingressNginx.namespace,
        "--create-namespace",
        "--values",
        pinned.ingressNginx.valuesFile,
        "--set-string",
        `${lbAnnotationKey}=${lbName}`,
        "--atomic",
        "--wait",
        "--timeout",
        installTimeout,
      ],
    },
    {
      name: "install cert-manager",
      command: [
        "helm",
        "upgrade",
        "--install",
        pinned.certManager.releaseName,
        pinned.certManager.chart,
        "--version",
        pinned.certManager.version,
        "--namespace",
        pinned.certManager.namespace,
        "--create-namespace",
        "--values",
        pinned.certManager.valuesFile,
        "--atomic",
        "--wait",
        "--timeout",
        installTimeout,
      ],
    },
    {
      name: "install Argo Rollouts controller and CRDs",
      command: [
        "helm",
        "upgrade",
        "--install",
        pinned.argoRollouts.releaseName,
        pinned.argoRollouts.chart,
        "--version",
        pinned.argoRollouts.version,
        "--namespace",
        pinned.argoRollouts.namespace,
        "--create-namespace",
        "--values",
        pinned.argoRollouts.valuesFile,
        "--atomic",
        "--wait",
        "--timeout",
        installTimeout,
      ],
    },
    {
      name: "install ACME cluster issuers",
      command: [
        "helm",
        "upgrade",
        "--install",
        pinned.clusterIssuers.releaseName,
        pinned.clusterIssuers.chartPath,
        "--namespace",
        pinned.clusterIssuers.namespace,
        "--atomic",
        "--wait",
        "--timeout",
        issuerTimeout,
        "--set",
        "clusterIssuers.production.dns01.enabled=true",
        "--set-string",
        `clusterIssuers.production.dns01.dnsZones[0]=${dns01Zone}`,
        ...(environment === previewEnvironment ? ["--set", "previewWildcardCertificate.enabled=true"] : []),
      ],
    },
  ];
}

export function dryRunOutput(options = {}) {
  const environment = options.environment ?? "staging";
  const steps = planClusterAddons(options);
  return JSON.stringify(
    {
      environment,
      loadBalancerName: loadBalancerName(environment),
      steps: steps.map((step) => ({ name: step.name, command: step.command.join(" ") })),
    },
    null,
    2,
  );
}

// Pure manifest builder: never printed or logged with a real token (the
// caller passes it straight to kubectl's stdin, never through a command-line
// argument), so it is safe to unit test without a live cluster or secret
// material.
export function buildDoksDnsTokenSecretManifest(token, environment = "staging") {
  if (!token || !String(token).trim()) {
    throw new Error(
      `DIGITALOCEAN_ACCESS_TOKEN is required to create the ${doksDnsTokenSecretName} secret that the DOKS ${environment} DNS-01 solver reads.`,
    );
  }

  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: doksDnsTokenSecretName,
      namespace: doksDnsTokenSecretNamespace,
      labels: {
        "app.kubernetes.io/name": "chase-sets-doks-ingress",
        "app.kubernetes.io/component": `${environment}-dns01`,
        "app.kubernetes.io/managed-by": "doks-cluster-addons",
      },
    },
    type: "Opaque",
    data: {
      [doksDnsTokenSecretKey]: Buffer.from(String(token), "utf8").toString("base64"),
    },
  };
}

// Applies the manifest by piping it to `kubectl apply -f -` stdin so the
// token value never appears in a spawned command's argv (visible in process
// listings) or in this planner's --dry-run output. The caller invokes this only
// after cert-manager was installed or its deployed release passed preflight.
export function applyDoksDnsTokenSecret(options = {}) {
  const spawnImpl = options.spawn ?? spawn;
  const kubectlPath = options.kubectlPath ?? "kubectl";
  const manifest = buildDoksDnsTokenSecretManifest(options.token, options.environment);
  const input = `${JSON.stringify(manifest)}\n`;

  return new Promise((resolve, reject) => {
    const child = spawnImpl(kubectlPath, ["apply", "-f", "-"], {
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ name: manifest.metadata.name, namespace: manifest.metadata.namespace });
        return;
      }
      reject(new Error(`${kubectlPath} apply -f - exited with code ${code ?? "unknown"}.`));
    });
    child.stdin.end(input);
  });
}

function runStep(step) {
  return new Promise((resolve, reject) => {
    const [command, ...args] = step.command;
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Step "${step.name}" failed with exit code ${code}.`));
      }
    });
  });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
      }
    });
  });
}

function withConfigurationMarker(step, requiredClusterAddons) {
  const required = requiredClusterAddons.find(
    (entry) =>
      entry.releaseName === releaseNameFromUpgradeCommand(step.command) &&
      entry.namespace === namespaceFromCommand(step.command),
  );
  if (!required) {
    return step;
  }
  return {
    ...step,
    // Helm stores descriptions in release metadata rather than chart values,
    // so closed values schemas (notably cert-manager's) never see this marker.
    command: [...step.command, "--description", required.configurationMarker],
  };
}

export function installStepsWithConfigurationMarkers(steps) {
  const required = requiredClusterAddons({ steps });
  return steps.map((step) => withConfigurationMarker(step, required));
}

function parseArgs(argv) {
  const options = { environment: "staging", dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--environment") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--environment requires a value.");
      }
      options.environment = value;
    } else if (arg === "--install-timeout") {
      options.installTimeout = argv[++index];
    } else if (arg === "--issuer-timeout") {
      options.issuerTimeout = argv[++index];
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(
        "Usage: node ./scripts/doks-cluster-addons.mjs [--environment staging|production] [--install-timeout <duration>] [--issuer-timeout <duration>] [--dry-run]",
      );
    }
  }

  if (!supportedEnvironments.has(options.environment)) {
    throw new Error(`--environment must be one of ${[...supportedEnvironments].join(", ")}.`);
  }

  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const steps = planClusterAddons(options);

  if (options.dryRun) {
    console.log(dryRunOutput(options));
    return 0;
  }

  if (await clusterAddonsAreUpToDate({ runCommand, environment: options.environment })) {
    console.log(`DOKS cluster add-ons up to date for ${options.environment}; skipped.`);
    // Credential rotation is independent of Helm release drift. Reconcile the
    // Secret on every invocation, including the steady-state Helm fast path.
    console.log(`==> apply ${options.environment} DNS-01 token secret`);
    const applied = await applyDoksDnsTokenSecret({
      token: process.env.DIGITALOCEAN_ACCESS_TOKEN,
      environment: options.environment,
    });
    console.log(`Applied ${applied.name} secret in namespace ${applied.namespace}.`);
    return 0;
  }

  const installSteps = installStepsWithConfigurationMarkers(steps);
  for (const step of installSteps) {
    console.log(`==> ${step.name}`);
    await runStep(step);

    // The environment-scoped DNS-01 solver reads this Secret, so it must
    // exist before the next step installs the ClusterIssuer that references
    // it. The token is piped over stdin and never appears in argv or output.
    if (step.name === "install cert-manager") {
      console.log(`==> apply ${options.environment} DNS-01 token secret`);
      const applied = await applyDoksDnsTokenSecret({
        token: process.env.DIGITALOCEAN_ACCESS_TOKEN,
        environment: options.environment,
      });
      console.log(`Applied ${applied.name} secret in namespace ${applied.namespace}.`);
    }
  }

  console.log(`DOKS cluster ingress add-ons installed for ${options.environment}.`);
  return 0;
}

if (process.argv[1]?.endsWith("doks-cluster-addons.mjs")) {
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
