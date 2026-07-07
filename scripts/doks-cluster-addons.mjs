#!/usr/bin/env node
import process from "node:process";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const chartDir = path.join(scriptDir, "..", "infrastructure", "helm", "doks-ingress");

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
  clusterIssuers: {
    releaseName: "chase-sets-doks-ingress",
    // The ACME account keys and issued certificate Secrets live in cert-manager's
    // namespace, so the ClusterIssuer release rides in the same namespace.
    namespace: "cert-manager",
    chartPath: chartDir,
  },
};

const supportedEnvironments = new Set(["staging", "production"]);

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
      name: "refresh repos",
      command: ["helm", "repo", "update", pinned.ingressNginx.repoName, pinned.certManager.repoName],
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
      ],
    },
  ];
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
