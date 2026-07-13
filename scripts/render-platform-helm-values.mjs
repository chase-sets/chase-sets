import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";

export const chartValuesRelativePath = "infrastructure/helm/platform/values.yaml";
export const chartStagingValuesRelativePath = "infrastructure/helm/platform/values.staging.yaml";
export const runtimeValuesRelativePath = "infrastructure/helm/platform/runtime-values.json";
const generatedBy = "node ./scripts/render-platform-helm-values.mjs";
const platformHelmChartName = "chase-sets-platform";
const platformHelmReleaseName = "chase-sets-platform";
const bootstrapDatabaseSecretKeyPrefix = "BOOTSTRAP_";
const bootstrapQuiesceTimeoutSeconds = 45;
const bootstrapCommandTimeoutSeconds = 780;
const bootstrapHookActiveDeadlineSeconds = 890;
const rootDomain = "chasesets.com";
const stagingEnvironmentZone = `staging.${rootDomain}`;
const doksIngressClassName = "nginx";
const doksIngressClusterIssuer = "letsencrypt-production";
const doksIngressTlsSecretName = "chase-sets-platform-doks-tls";
const previewEnvironmentZone = "preview.chasesets.com";
const previewPostgresPort = 5432;
const previewPostgresSecretName = "chase-sets-preview-postgres";
// Every preview namespace references this SAME shared *.preview.chasesets.com
// wildcard certificate secret (copied in before the Helm deploy runs) instead
// of requesting a per-PR certificate, so the name is a stable constant rather
// than derived from the preview identifier.
export const previewWildcardTlsSecretName = "preview-wildcard-tls";
export const previewWildcardTlsSecretNamespace = "cert-manager";

// Exported so scripts/platform-compose-ingress.mjs (the CI compose
// boot+smoke job's ingress stand-in) routes requests by the exact same path
// prefixes the real Kubernetes ingress uses, instead of maintaining a
// second, driftable copy of this list.
export const platformApiIngressPrefixes = [
  "/.well-known",
  "/ucp",
  "/mcp",
  "/api/payments/provider/webhooks",
  "/api/settlement/provider/money-movement/webhooks",
  "/api/notifications/provider/email/webhooks",
  "/api/fulfillment/provider/postage/webhooks",
  "/api",
];

export const doksStagingWorkerEnvOverrides = {
  // DOKS staging keeps operation/job runners at the compact Helm baseline but
  // widens the projection runner group to 4: a ~1.8M-event backlog
  // across ~28 independent projection groups was draining serially through the
  // single default slot, so the 2 large discovery cascade groups monopolised it
  // pass-after-pass and 26 small groups (auth, identity, checkout, ordering,
  // settlement, ...) made zero progress. Groups are independent (own lease +
  // checkpoint), so concurrent runners are safe by design. Runner budget:
  // 4 projection + 1 operations + 1 job + 1 inventory-import + 1 dispatch +
  // 1 scheduled + 3 wake = 12. Each projection runner holds ~1 connection
  // during its transaction, so DATABASE_POOL_MAX rises from 9 to 12 one-for-one
  // with the +3 projection slots. DOKS staging query traffic is still DIRECT
  // (its Secret exporter builds DATABASE_URL_* from cluster host/port, not from
  // the PgBouncer pool resources), so this +3 counts one-for-one against the
  // cluster backend budget: DOKS staging steady-state 30->33 and rolling
  // overlap 56->62, both well under the 94 tier limit and the 75 upgrade
  // trigger (see docs/architecture/push-wake-connection-budget.md). The direct
  // relay LISTEN connections are separate and unchanged.
  DATABASE_POOL_MAX: "12",
  WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS: "4",
  WORKER_WAKE_MAX_CONCURRENT_RUNNERS: "3",
  WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT: "2",
  // The staging DOKS worker owns the projection wake relay.
  // Omitting the retired compute worker entirely when DOKS owns the
  // estate removes the only relay-enabled process: without this setting the
  // `projection-wake-relay:active` lease sits expired under the
  // dead owner and relay fan-out ceases fleet-wide (empty wake ledger;
  // authenticated login/session read-after-write times out while guest flows
  // pass). The Helm base keeps the relay off for previews (no listener URLs
  // there by design), but the estate's ONLY worker must run the relay. The
  // seven direct LISTEN connections transferred from the retired compute
  // worker, so the cluster connection budget is unchanged and the relay lease
  // remains single-flight during rolling Kubernetes overlap.
  WORKER_PROJECTION_WAKE_RELAY_ENABLED: "true",
};

export const platformWorkerWakeDepthQuery =
  "SELECT COUNT(*)::integer FROM platform_projection_wake_intents WHERE state IN ('queued', 'failed') AND next_eligible_at <= now() AND expires_at > now()";

export const doksStagingWorkerAutoscaling = {
  // The base chart keeps this disabled for previews, where KEDA and the
  // shared work-signal database are intentionally not part of the estate.
  enabled: false,
  minReplicaCount: 1,
  maxReplicaCount: 4,
  pollingInterval: 15,
  cooldownPeriod: 300,
  triggers: [
    {
      type: "postgresql",
      metadata: {
        connectionFromEnv: "PLATFORM_WORK_SIGNAL_DATABASE_URL",
        query: platformWorkerWakeDepthQuery,
        targetQueryValue: "1",
        activationTargetQueryValue: "0",
      },
    },
  ],
};

const rolloutEligibleComponents = new Set(["public-web", "marketplace", "platform-api"]);

function rolloutValues(enabled, nginxEnabled, analysisPath) {
  return {
    enabled,
    revisionHistoryLimit: 5,
    progressDeadlineSeconds: 900,
    rollbackWindowRevisions: 3,
    analysis: {
      enabled: false,
      path: analysisPath,
      initialDelay: "30s",
      interval: "10s",
      count: 5,
      failureLimit: 2,
      timeoutSeconds: 5,
    },
    canary: {
      canaryServiceSuffix: "canary",
      trafficRouting: {
        nginx: {
          enabled: nginxEnabled,
        },
      },
      weights: [10, 25, 50, 100],
      pauseAfterWeight: 10,
    },
  };
}

export const doksStagingApiOverrides = {
  // The cutover-evidence battery fans authenticated setup across many
  // clients. Keep one API available while another is briefly busy or rolling,
  // and give the scheduler enough information to avoid memory-pressure churn.
  // This mirrors the existing 1 vCPU / 1 GiB production API envelope while
  // reserving a conservative baseline that lets the scheduler place both.
  //
  // Tolerant process liveness (startupPath/livenessPath/livenessProbe) is now
  // a base-chart default for platform-api (see componentsWithStartupProbe /
  // componentsWithTolerantLiveness below), inherited here through the
  // values.yaml + values.staging.yaml Helm merge, so it is intentionally NOT
  // duplicated in this staging-only overlay.
  replicas: 2,
  resources: {
    requests: {
      cpu: "250m",
      memory: "512Mi",
    },
    limits: {
      cpu: "1",
      memory: "1Gi",
    },
  },
  rollout: rolloutValues(true, true, "/health/ready"),
};

export function platformHelmFullname(options = {}) {
  const fullnameOverride = options.fullnameOverride ?? "";
  if (fullnameOverride) {
    return helmDnsName(fullnameOverride);
  }

  const chartName = helmDnsName(options.nameOverride || options.chartName || platformHelmChartName);
  return helmDnsName(`${options.releaseName || platformHelmReleaseName}-${chartName}`);
}

export function platformHelmComponentName(componentName, options = {}) {
  return helmDnsName(`${platformHelmFullname(options)}-${componentName}`);
}

export function platformHelmPreviewPostgresName(options = {}) {
  return helmDnsName(`${platformHelmFullname(options)}-preview-postgres`);
}

function platformApiInternalOrigin() {
  return `http://${platformHelmComponentName("platform-api")}:8080`;
}

function helmDnsName(value) {
  return String(value).slice(0, 63).replace(/-+$/u, "");
}

// DOKS-only health wiring. Workers expose no public HTTP ingress, but the
// worker runs an in-process health server (/health/live + /health/ready) that
// only binds after full boot (heartbeat + runner loops), so probing it makes a
// boot-crashing worker fail the Helm rollout instead of silently passing.
// Readiness gates the rollout on /health/ready; the startup probe holds
// liveness off /health/live for up to 5 minutes of boot before liveness takes
// over, so a slow (but healthy) boot is never killed mid-start.
const doksHealthProbeByComponent = {
  "platform-worker": {
    port: 8080,
    readinessPath: "/health/ready",
  },
};

// The base chart's liveness probe defaults to whatever
// path readiness uses (see the `livenessPath` fallback in _helpers.tpl),
// which puts platform-api's liveness on the DB-aware /health/ready check with
// Kubernetes' default 1s timeout / 10s period / 3-failure threshold. A live
// preview namespace (chase-sets-pr-4766) proved this kills healthy pods
// (Exit Code 137, kubelet "failed liveness probe ... /health/ready") under
// nothing worse than brief DB or event-loop pressure, breaking that PR's own
// Stripe money smoke step with 502/503s. Readiness must stay strict on
// /health/ready so traffic gating is unchanged; liveness must instead test
// process life via the DB-free /health/live endpoint with a tolerant ~60s
// failure window, so only a genuinely hung process gets restarted.
//
// Only components verified (by reading their server source) to actually
// serve /health/live get tolerant liveness: platform-api (createHealthRoutes
// in infrastructure/platform-runtime/health.ts, mounted at /health) and
// platform-worker (deployables/platform-worker/src/main.ts).
//
// The React Router web deployables (admin-web,
// marketplace, public-web) are also probed on the DB-free-in-name-only
// `health/ready` route with Kubernetes' tight defaults; a live preview
// run (chase-sets-pr-4736) showed the kubelet killing admin-web on the same
// pattern. Each also registers a `health/live` route
// (deployables/<name>/app/routes.ts + routes/health-live.ts, built on
// createWebLiveLoader in infrastructure/platform-runtime/web-assets.ts) that
// returns { status: "ok" } with no database or upstream call, so they opt
// into the same tolerant livenessPath/livenessProbe as platform-api/worker.
//
// startupPath stays scoped to platform-api/platform-worker only: it exists to
// hold liveness off during their heavier event-store-catch-up boot, a
// concern the React Router web servers do not share, and (per the
// decoupling in _helpers.tpl) is intentionally independent of which
// components opt into tolerant liveness.
const tolerantLivenessPath = "/health/live";
const tolerantLivenessProbe = {
  periodSeconds: 10,
  timeoutSeconds: 5,
  failureThreshold: 6,
};
const componentsWithStartupProbe = new Set(["platform-api", "platform-worker"]);
const componentsWithTolerantLiveness = new Set([
  "platform-api",
  "platform-worker",
  "admin-web",
  "marketplace",
  "public-web",
]);

// platform-api readiness probes the DB-aware /health/ready (SELECT 1 on
// the control pool). Kubernetes' default 1s probe timeout is too tight for a
// DB-touching check: under battery load the readiness query cannot acquire a
// pooled connection within 1s, both replicas flap to 503, and the whole API is
// ejected from its Service endpoints. Relax the timeout to 3s while keeping the
// period (10s) and failure threshold (3) unchanged, so a genuinely unreachable
// DB still goes NotReady within ~30s (3 failures x 10s period) — readiness
// stays strict and traffic-gating is preserved. Liveness is deliberately
// untouched (it correctly probes the DB-free /health/live).
const readinessProbeTuning = {
  timeoutSeconds: 3,
  periodSeconds: 10,
  failureThreshold: 3,
};
const componentsWithReadinessTuning = new Set(["platform-api"]);

export function buildPlatformHelmValues(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const runtimeValuesPath = path.join(rootDir, runtimeValuesRelativePath);
  const runtimeValues = JSON.parse(readFileSync(runtimeValuesPath, "utf8"));
  if (runtimeValues.schemaVersion !== "platform-runtime-values/v1") {
    throw new Error(`${runtimeValuesRelativePath} must use schemaVersion platform-runtime-values/v1.`);
  }

  const { schemaVersion: _schemaVersion, ...values } = runtimeValues;
  return values;
}

export function renderPlatformHelmValues(options = {}) {
  return `${renderYaml(buildPlatformHelmValues(options))}\n`
    .replace(
      `      activeDeadlineSeconds: ${bootstrapHookActiveDeadlineSeconds}\n`,
      [
        "      # Fail the hook inside Helm's 15m rollout timeout so atomic rollback sees a Kubernetes Job failure instead of a generic Helm condition timeout.",
        `      activeDeadlineSeconds: ${bootstrapHookActiveDeadlineSeconds}`,
      ].join("\n") + "\n",
    )
    .replace(
      `        timeoutSeconds: ${bootstrapQuiesceTimeoutSeconds}\n        commandTimeoutSeconds: ${bootstrapCommandTimeoutSeconds}\n`,
      [
        "        # Keep 45s drain + 780s bootstrap command + 5s kill grace + 45s restore below the hook deadline.",
        `        timeoutSeconds: ${bootstrapQuiesceTimeoutSeconds}`,
        `        commandTimeoutSeconds: ${bootstrapCommandTimeoutSeconds}`,
      ].join("\n") + "\n",
    );
}

export function buildPlatformHelmStagingValues(options = {}) {
  return {
    generatedBy,
    doksIngress: buildDoksIngressValues({ env: options.env }),
    components: {
      "public-web": {
        rollout: rolloutValues(true, true, "/health/ready"),
      },
      marketplace: {
        rollout: rolloutValues(true, true, "/health/ready"),
      },
      "platform-api": doksStagingApiOverrides,
      "platform-worker": {
        autoscaling: {
          ...doksStagingWorkerAutoscaling,
          enabled: true,
        },
        envOverrides: doksStagingWorkerEnvOverrides,
      },
    },
  };
}

export function renderPlatformHelmStagingValues() {
  return `${renderYaml(buildPlatformHelmStagingValues())}\n`.replace(
    "  platform-worker:\n",
    [
      "  platform-worker:",
      "    # Keep one warm worker for health and deploy continuity; KEDA adds up to four pods when eligible wake intents accumulate.",
      "    # The cap preserves the staging database connection budget while covering representative wake and import bursts.",
    ].join("\n") + "\n",
  );
}

export function buildDoksIngressValues(options = {}) {
  const env = options.env ?? {};
  const target = String(env.DOKS_INGRESS_TARGET ?? "").trim();
  const deploymentEnvironment = String(env.DEPLOYMENT_ENVIRONMENT ?? "staging").trim();
  if (!["staging", "production"].includes(deploymentEnvironment)) {
    throw new Error("DOKS live ingress requires DEPLOYMENT_ENVIRONMENT=staging or production.");
  }

  return {
    enabled: target !== "",
    className: doksIngressClassName,
    clusterIssuer: doksIngressClusterIssuer,
    annotations: {},
    tls: {
      enabled: true,
      secretName: doksIngressTlsSecretName,
    },
    hosts: target !== "" ? buildDoksIngressHosts(deploymentEnvironment) : [],
  };
}

export function buildPreviewDoksIngressValues(options = {}) {
  const previewIdentifier = String(options.previewIdentifier ?? options.env?.PREVIEW_IDENTIFIER ?? "").trim();
  if (!/^pr-[0-9]+$/.test(previewIdentifier)) {
    throw new Error("Preview DOKS ingress requires a preview identifier like pr-123.");
  }

  return {
    enabled: true,
    className: doksIngressClassName,
    // Previews reference the shared *.preview.chasesets.com wildcard secret
    // (copied into this namespace before the Helm deploy runs; see
    // copyPreviewWildcardTlsSecret in platform-kubernetes-deployment.mjs)
    // instead of requesting a per-PR certificate, so no cert-manager
    // cluster-issuer annotation belongs on this Ingress: a high-throughput PR
    // day issuing one certificate per namespace exhausted Let's Encrypt's
    // 50-certificates-per-168h quota and blocked every PR.
    clusterIssuer: "",
    annotations: {},
    tls: {
      enabled: true,
      secretName: previewWildcardTlsSecretName,
    },
    hosts: buildPreviewDoksIngressHosts(previewIdentifier),
  };
}

function buildDoksIngressHosts(deploymentEnvironment) {
  const environmentZone = deploymentEnvironment === "production" ? rootDomain : stagingEnvironmentZone;
  const hosts = {
    apex: environmentZone,
    www: `www.${environmentZone}`,
    marketplace: `marketplace.${environmentZone}`,
    admin: `admin.${environmentZone}`,
  };

  return [
    {
      host: hosts.apex,
      paths: doksIngressPaths("marketplace"),
    },
    {
      host: hosts.www,
      paths: doksIngressPaths("public-web"),
    },
    {
      host: hosts.marketplace,
      paths: doksIngressPaths("marketplace"),
    },
    {
      host: hosts.admin,
      paths: doksIngressPaths("admin-web"),
    },
  ];
}

// Single-level preview hostnames: `pr-<n>`, `pr-<n>-marketplace`, and
// `pr-<n>-admin` are each exactly one label under preview.chasesets.com, so
// the single shared `*.preview.chasesets.com` wildcard certificate covers
// every preview's every app host. The retired two-label shape
// (`marketplace.pr-<n>.preview...`, `admin.pr-<n>.preview...`) required a
// fresh per-PR certificate because a wildcard only matches one label.
function buildPreviewDoksIngressHosts(previewIdentifier) {
  return [
    {
      host: `${previewIdentifier}.${previewEnvironmentZone}`,
      paths: doksIngressPaths("public-web"),
    },
    {
      host: `${previewIdentifier}-marketplace.${previewEnvironmentZone}`,
      paths: doksIngressPaths("marketplace"),
    },
    {
      host: `${previewIdentifier}-admin.${previewEnvironmentZone}`,
      paths: doksIngressPaths("admin-web"),
    },
  ];
}

function doksIngressPaths(rootService) {
  return [
    ...platformApiIngressPrefixes.map((pathPrefix) => ({ path: pathPrefix, service: "platform-api" })),
    { path: "/", service: rootService },
  ];
}

export function syncPlatformHelmValues(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const generatedFiles = [
    {
      relativePath: chartValuesRelativePath,
      content: renderPlatformHelmValues({ repoRoot: rootDir }),
    },
    {
      relativePath: chartStagingValuesRelativePath,
      content: renderPlatformHelmStagingValues(),
    },
  ];

  if (options.check) {
    for (const generatedFile of generatedFiles) {
      const outputPath = path.join(rootDir, generatedFile.relativePath);
      if (!existsSync(outputPath)) {
        throw new Error(`${normalizeRelative(outputPath, rootDir)} is missing`);
      }
      const currentContent = readFileSync(outputPath, "utf8");
      if (currentContent !== generatedFile.content) {
        throw new Error(`${normalizeRelative(outputPath, rootDir)} is stale; run ${generatedBy}`);
      }
    }
    return { checked: true };
  }

  for (const generatedFile of generatedFiles) {
    writeFileSync(path.join(rootDir, generatedFile.relativePath), generatedFile.content, "utf8");
  }
  return { checked: false };
}

export function renderYaml(value, indent = 0) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return value
      .map((entry) => {
        if (isPlainObject(entry)) {
          const rendered = renderYaml(entry, indent + 2);
          const [firstLine, ...rest] = rendered.split("\n");
          return `${" ".repeat(indent)}- ${firstLine.trimStart()}${rest.length > 0 ? `\n${rest.join("\n")}` : ""}`;
        }
        return `${" ".repeat(indent)}- ${yamlScalar(entry)}`;
      })
      .join("\n");
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    return entries
      .map(([key, entry]) => {
        if (Array.isArray(entry)) {
          if (entry.length === 0) {
            return `${" ".repeat(indent)}${key}: []`;
          }
          return `${" ".repeat(indent)}${key}:\n${renderYaml(entry, indent + 2)}`;
        }
        if (isPlainObject(entry)) {
          if (Object.keys(entry).length === 0) {
            return `${" ".repeat(indent)}${key}: {}`;
          }
          return `${" ".repeat(indent)}${key}:\n${renderYaml(entry, indent + 2)}`;
        }
        return `${" ".repeat(indent)}${key}: ${yamlScalar(entry)}`;
      })
      .join("\n");
  }

  return yamlScalar(value);
}

function yamlScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }

  return JSON.stringify(String(value));
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(args) {
  if (args.length === 0) {
    return { check: false };
  }

  if (args.length === 1 && args[0] === "--check") {
    return { check: true };
  }

  throw new Error(`Usage: ${generatedBy} [--check]`);
}

function main() {
  const result = syncPlatformHelmValues(parseArgs(process.argv.slice(2)));
  console.log(result.checked ? "Platform Helm values are current." : "Platform Helm values generated.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
