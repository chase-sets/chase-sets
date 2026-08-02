#!/usr/bin/env node
import process from "node:process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const chartDir = path.join(scriptDir, "..", "infrastructure", "helm", "doks-ingress");
const chartYamlPath = path.join(chartDir, "Chart.yaml");

function chartVersionParseError(message) {
  const error = new Error(`DOKS_INGRESS_CHART_VERSION_UNPARSABLE: ${message}`);
  error.code = "DOKS_INGRESS_CHART_VERSION_UNPARSABLE";
  return error;
}

function parseQuotedChartVersion(rawValue) {
  const quote = rawValue[0];
  let closingIndex = -1;
  for (let index = 1; index < rawValue.length; index += 1) {
    if (rawValue[index] !== quote) continue;
    if (quote === "'" && rawValue[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote === '"' && rawValue[index - 1] === "\\") continue;
    closingIndex = index;
    break;
  }
  if (closingIndex === -1) {
    throw chartVersionParseError("the top-level version scalar has an unterminated quote.");
  }

  const remainder = rawValue.slice(closingIndex + 1).trim();
  if (remainder && !remainder.startsWith("#")) {
    throw chartVersionParseError("the top-level version scalar has content after its closing quote.");
  }
  return rawValue.slice(1, closingIndex);
}

export function parseDoksIngressChartVersion(source) {
  const matches = String(source)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("version:"));
  if (matches.length !== 1) {
    throw chartVersionParseError(`expected exactly one top-level version key, but found ${matches.length}.`);
  }

  const rawValue = matches[0].slice("version:".length).trim();
  const value =
    rawValue.startsWith("'") || rawValue.startsWith('"')
      ? parseQuotedChartVersion(rawValue)
      : rawValue.split("#", 1)[0].trim();
  if (!value) {
    throw chartVersionParseError("the top-level version scalar is empty.");
  }
  return value;
}

export function readDoksIngressChartVersion(chartPath = chartYamlPath) {
  return parseDoksIngressChartVersion(readFileSync(chartPath, "utf8"));
}

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
  },
};

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
// listings) or in this planner's --dry-run output. cert-manager's namespaced
// resource (this Secret) must exist in the `cert-manager` namespace the
// preceding "install cert-manager" step just created.
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
    console.log(
      JSON.stringify(
        {
          environment: options.environment,
          loadBalancerName: loadBalancerName(options.environment),
          steps: steps.map((step) => ({ name: step.name, command: step.command.join(" ") })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  for (const step of steps) {
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
