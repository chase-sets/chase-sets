import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";

export const chartValuesRelativePath = "infrastructure/helm/platform/values.yaml";
export const chartStagingValuesRelativePath = "infrastructure/helm/platform/values.staging.yaml";
const platformMainRelativePath = "infrastructure/digitalocean/platform/main.tf";
const platformLocalsRelativePath = "infrastructure/digitalocean/platform/locals.tf";
const generatedBy = "node ./scripts/render-platform-helm-values.mjs";
const platformHelmChartName = "chase-sets-platform";
const platformHelmReleaseName = "chase-sets-platform";
const platformBootstrapCommand = "pnpm --filter @chase-sets/app-platform-api run bootstrap:production";
const bootstrapDatabaseSecretKeyPrefix = "BOOTSTRAP_";
const bootstrapQuiesceTimeoutSeconds = 45;
const bootstrapCommandTimeoutSeconds = 780;
const bootstrapHookActiveDeadlineSeconds = 890;
const stagingEnvironmentZone = "staging.chasesets.com";
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

const componentOrder = [
  "public-web",
  "marketplace",
  "admin-web",
  "platform-api",
  "platform-worker",
  "platform-bootstrap",
];

const deploymentKindByTerraformKind = {
  service: "service",
  worker: "worker",
  job: "job",
};

const secretEnvFallbacks = new Set([
  "PLATFORM_CONTROL_DATABASE_URL",
  "PLATFORM_PREVIEW_POSTGRES_ADMIN_URL",
  "PLATFORM_WORK_SIGNAL_DATABASE_URL",
  "PLATFORM_INTERNAL_AUTH_SECRET",
  "PLATFORM_ADMIN_EMAIL",
  "PLATFORM_ADMIN_PASSWORD",
  "STRIPE_SECRET_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "EASYPOST_API_KEY",
  "VOYAGE_API_KEY",
  "EASYPOST_WEBHOOK_SECRET",
  "GOOGLE_SOCIAL_LOGIN_CLIENT_ID",
  "GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET",
  "FACEBOOK_SOCIAL_LOGIN_CLIENT_ID",
  "FACEBOOK_SOCIAL_LOGIN_CLIENT_SECRET",
  "CATALOG_ASSET_S3_ACCESS_KEY_ID",
  "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
  "SES_AWS_ACCESS_KEY_ID",
  "SES_AWS_SECRET_ACCESS_KEY",
  "SES_SOURCE_ARN",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE",
  "SCRYDEX_API_KEY",
  "SCRYDEX_TEAM_ID",
  "CHASE_SETS_DISCORD_INVITE_URL",
]);

const envValueDefaults = {
  NODE_ENV: "production",
  PORT: "8080",
  DEPLOYMENT_ENVIRONMENT: "preview",
  CHASE_SETS_RUNTIME_PROFILE: "public",
  READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED: "false",
  READ_CONSISTENCY_READINESS_NOTIFICATIONS_ENABLED: "false",
  PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED: "false",
  PLATFORM_PROJECTION_WAKE_SOURCE_CONTEXTS: "*",
  DATABASE_POOL_IDLE_TIMEOUT_MS: "5000",
  DATABASE_POOL_CONNECTION_TIMEOUT_MS: "10000",
  CHASE_SETS_TRUST_FORWARDED_HEADERS: "true",
  CHASE_SETS_PUBLIC_INDEXING: "false",
  CHASE_SETS_MARKETPLACE_INDEXING: "false",
  CHASE_SETS_CHECKOUT_SHOPIFY_SIMPLE_KILL_SWITCH_ACTIVE: "false",
  CHASE_SETS_RATE_LIMIT_AUTH_REGISTER_IP_MAX: "30",
  ADMIN_REGISTRATION_ENABLED: "false",
  REALTIME_BACKGROUND_MAINTENANCE_ENABLED: "false",
  REALTIME_WAKE_SIGNAL_ENABLED: "false",
  CATALOG_ASSET_STORAGE_KIND: "s3",
  CATALOG_ASSET_S3_BUCKET: "",
  CATALOG_ASSET_S3_REGION: "nyc3",
  CATALOG_ASSET_S3_ENDPOINT: "https://nyc3.digitaloceanspaces.com",
  CATALOG_ASSET_PUBLIC_BASE_URL: "",
  TAX_PROVIDER_BACKED_QUOTES_REQUIRED: "false",
  OBSERVABILITY_ENABLED: "false",
  OTEL_EXPORTER_OTLP_ENDPOINT: "",
  OTEL_RESOURCE_ATTRIBUTES: "cloud.provider=digitalocean,cloud.platform=kubernetes,chase_sets.environment_slug=preview",
  STRIPE_CONNECT_ACCOUNTS_API: "v2",
  STRIPE_API_BASE_URL: "https://api.stripe.com",
  EASYPOST_API_BASE_URL: "https://api.easypost.com",
  EASYPOST_MODE: "test",
  ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS: "",
  REALTIME_STREAM_LIMITER: "postgres",
  NOTIFICATION_EMAIL_PROVIDER: "noop",
  SES_AWS_REGION: "",
  SES_FROM_EMAIL: "",
  SES_CONFIGURATION_SET_NAME: "",
  PLATFORM_ADMIN_DISPLAY_NAME: "Platform Admin",
  CHASE_SETS_PUBLIC_ORIGIN: "",
  CHASE_SETS_MARKETPLACE_ORIGIN: "",
  CHASE_SETS_INTERNAL_API_ORIGIN: platformApiInternalOrigin(),
  WORKER_MAX_CONCURRENT_RUNNERS: "5",
  WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS: "1",
  WORKER_PROJECTION_OPERATION_RUNNER_COUNT: "1",
  WORKER_JOB_MAX_CONCURRENT_RUNNERS: "1",
  WORKER_WAKE_MAX_CONCURRENT_RUNNERS: "2",
  WORKER_WAKE_HOT_LANE_RUNNER_COUNT: "1",
  WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT: "1",
  WORKER_WAKE_BULK_LANE_RUNNER_COUNT: "1",
  WORKER_WAKE_STATEMENT_TIMEOUT_MS: "30000",
  WORKER_PROJECTION_WAKE_RELAY_ENABLED: "false",
  SOURCE_OBSERVATION_BULK_JOB_LANE_COUNT: "1",
  SOURCE_OBSERVATION_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  SOURCE_OBSERVATION_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  CATALOG_AUTHORING_BULK_JOB_LANE_COUNT: "1",
  CATALOG_AUTHORING_BULK_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  CATALOG_AUTHORING_BULK_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  SOURCE_OBSERVATION_INTEGRATION_JOB_LANE_COUNT: "1",
  SOURCE_OBSERVATION_INTEGRATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  SOURCE_OBSERVATION_INTEGRATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  INVENTORY_IMPORT_BATCH_JOB_LANE_COUNT: "1",
  INVENTORY_IMPORT_BATCH_JOB_MAX_CONCURRENT_RUNNERS: "1",
  INVENTORY_IMPORT_BATCH_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  INVENTORY_IMPORT_BATCH_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  PRICING_RECOMMENDATION_JOB_LANE_COUNT: "1",
  PRICING_RECOMMENDATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  PRICING_RECOMMENDATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  SETTLEMENT_PAYOUT_RECONCILIATION_JOB_LANE_COUNT: "1",
  SETTLEMENT_PAYOUT_RECONCILIATION_JOB_WORKFLOW_MAX_ACTIVE_CLAIMS: "1",
  SETTLEMENT_PAYOUT_RECONCILIATION_JOB_MAX_ACTIVE_CLAIMS_PER_JOB: "1",
  WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS: "1",
  WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS: "1",
  TCGPLAYER_AUTOMATION_REQUEST_DELAY_MS: "250",
  TCGPLAYER_AUTOMATION_RATE_LIMIT_COOLDOWN_MS: "30000",
  TCGPLAYER_AUTOMATION_MAX_CONCURRENT_REQUESTS: "2",
  TCGPLAYER_AUTOMATION_MAX_RETRIES: "3",
  CATALOG_INTEGRATION_CONTROL_PLANE_MODE: "open",
  CATALOG_INTEGRATION_ACTIVATION_MODE: "open",
  CATALOG_INTEGRATION_IMPORTS_DISABLED: "",
  CATALOG_INTEGRATION_PROMOTION_DISABLED: "",
  CATALOG_INTEGRATION_REAPPLY_DISABLED: "",
  CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP: "",
  CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES: "open",
};

const databasePoolMaxByComponent = {
  "platform-api": "6",
  // Must cover every worker runner group summed by the runtime capacity guard
  // and the Terraform worker_runner_capacity check: 1 projection + 1 operations
  // + 1 job + 1 inventory-import + 1 dispatch + 1 scheduled + 2 wake = 8.
  "platform-worker": "8",
  "platform-bootstrap": "4",
};

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
  // Omitting the App Platform worker component entirely when DOKS owns the
  // estate removes the only relay-enabled process: without this setting the
  // `projection-wake-relay:active` lease sits expired under the
  // dead owner and relay fan-out ceases fleet-wide (empty wake ledger;
  // authenticated login/session read-after-write times out while guest flows
  // pass). The Helm base keeps the relay off for previews (no listener URLs
  // there by design), but the estate's ONLY worker must run the relay. The
  // seven direct LISTEN connections simply transfer from the removed App
  // Platform worker, so the cluster connection budget is unchanged, and the
  // relay lease stays single-flight if estates ever coexist again.
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
  // This mirrors the existing 1 vCPU / 1 GiB App Platform API envelope while
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

// DOKS-only health wiring. App Platform workers expose no HTTP port, but the
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

export function readPlatformSources(rootDir = repoRoot) {
  return {
    main: readFileSync(path.join(rootDir, platformMainRelativePath), "utf8"),
    locals: readFileSync(path.join(rootDir, platformLocalsRelativePath), "utf8"),
  };
}

export function extractDigitalOceanPlatformComponents(sources) {
  const locals = parsePlatformLocals(sources.locals);
  const platformResource = extractNamedBlock(sources.main, 'resource "digitalocean_app" "platform"');
  const spec = extractNamedBlock(platformResource, "spec");
  const terraformComponents = collectTopLevelComponents(spec).map((component) =>
    normalizeTerraformComponent(component, locals),
  );
  const byName = new Map(terraformComponents.map((component) => [component.name, component]));

  return componentOrder.map((name) => {
    const component = byName.get(name);
    if (!component) {
      throw new Error(`DigitalOcean platform component '${name}' is missing from ${platformMainRelativePath}.`);
    }
    return component;
  });
}

export function buildPlatformHelmValues(options = {}) {
  const sources = options.sources ?? readPlatformSources(options.repoRoot ?? repoRoot);
  const components = extractDigitalOceanPlatformComponents(sources);

  return {
    generatedBy,
    global: {
      nameOverride: "",
      fullnameOverride: "",
      image: {
        registry: "registry.digitalocean.com",
        registryName: "chase-sets",
        repository: "chase-sets-platform",
        tag: "latest",
        digest: "",
        pullPolicy: "IfNotPresent",
      },
      imagePullSecrets: [],
      envOverrides: {},
      existingSecretName: "chase-sets-platform-runtime",
      serviceAccount: {
        create: true,
        name: "",
      },
      rbac: {
        create: true,
      },
      podAnnotations: {},
      podLabels: {},
      nodeSelector: {},
      tolerations: [],
      affinity: {},
    },
    observability: {
      enabled: false,
      environment: "",
      clusterName: "",
      collector: {
        image: {
          repository: "otel/opentelemetry-collector-contrib",
          tag: "0.119.0",
          pullPolicy: "IfNotPresent",
        },
        resources: {
          requests: { cpu: "50m", memory: "128Mi" },
          limits: { cpu: "500m", memory: "512Mi" },
        },
      },
      kubeStateMetrics: {
        image: {
          repository: "registry.k8s.io/kube-state-metrics/kube-state-metrics",
          tag: "v2.18.0",
          pullPolicy: "IfNotPresent",
        },
        resources: {
          requests: { cpu: "25m", memory: "64Mi" },
          limits: { cpu: "250m", memory: "256Mi" },
        },
      },
      exporter: {
        endpoint: "",
        secretName: "chase-sets-platform-runtime",
        secretKey: "CHASE_SETS_OTLP_TOKEN",
      },
    },
    doksIngress: {
      enabled: false,
      className: "nginx",
      clusterIssuer: "",
      annotations: {},
      tls: {
        enabled: true,
        secretName: "chase-sets-platform-tls",
      },
      hosts: [],
    },
    previewPostgres: {
      enabled: false,
      image: {
        // Same image as local dev (docker-compose.dev.yml) and CI DB-test
        // service containers: Debian-based Postgres 16 with pgvector baked in.
        // The discovery context's schema bootstrap runs CREATE EXTENSION
        // vector, which plain postgres:16-alpine does not ship.
        repository: "pgvector/pgvector",
        tag: "pg16",
        pullPolicy: "IfNotPresent",
      },
      service: {
        port: previewPostgresPort,
      },
      secretName: previewPostgresSecretName,
      superuserSecretKey: "POSTGRES_PASSWORD",
      applicationSecretKey: "APP_DATABASE_PASSWORD",
      storage: {
        emptyDir: {},
      },
      resources: {},
    },
    components: Object.fromEntries(components.map((component) => [component.name, toHelmComponent(component)])),
  };
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
  const serving = String(env.STAGING_APP_SERVING ?? "app-platform").trim() || "app-platform";

  if (!["app-platform", "doks"].includes(serving)) {
    throw new Error('STAGING_APP_SERVING must be either "app-platform" or "doks".');
  }

  const enabled = target !== "";
  const hostMode = serving === "doks" ? "live" : "shadow";

  return {
    enabled,
    className: doksIngressClassName,
    clusterIssuer: doksIngressClusterIssuer,
    annotations: {},
    tls: {
      enabled: true,
      secretName: doksIngressTlsSecretName,
    },
    hosts: enabled ? buildDoksIngressHosts(hostMode) : [],
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

function buildDoksIngressHosts(hostMode) {
  const hosts =
    hostMode === "live"
      ? {
          apex: stagingEnvironmentZone,
          www: `www.${stagingEnvironmentZone}`,
          marketplace: `marketplace.${stagingEnvironmentZone}`,
          admin: `admin.${stagingEnvironmentZone}`,
        }
      : {
          apex: `doks.${stagingEnvironmentZone}`,
          www: `www.doks.${stagingEnvironmentZone}`,
          marketplace: `marketplace.doks.${stagingEnvironmentZone}`,
          admin: `admin.doks.${stagingEnvironmentZone}`,
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

function toHelmComponent(component) {
  const result = {
    enabled: true,
    kind: deploymentKindByTerraformKind[component.terraformKind],
    replicas: component.replicas,
    source: {
      digitalOceanKind: component.terraformKind,
      instanceCountExpression: helmInstanceCountExpression(component),
    },
    command: helmCommand(component),
    env: helmEnv(component),
    resources: {},
    podAnnotations: {},
    podLabels: {},
  };

  if (component.name === "platform-worker") {
    result.autoscaling = { ...doksStagingWorkerAutoscaling };
  }

  if (component.port) {
    result.port = component.port;
    result.service = { type: "ClusterIP", port: component.port };
  }

  if (component.healthPath) {
    result.healthPath = component.healthPath;
  }

  // Attach the DOKS-only health probe port and readiness path for components
  // (workers) that serve health over HTTP but declare no App Platform
  // http_port. No ClusterIP Service is created: the probes target the pod's
  // container port directly, and nothing in-cluster consumes the worker.
  const healthProbe = doksHealthProbeByComponent[component.name];
  if (healthProbe) {
    result.port = healthProbe.port;
    result.healthPath = healthProbe.readinessPath;
  }

  // Tolerant process liveness: only for components verified to serve
  // /health/live. startupPath
  // holds liveness off until boot completes for the components with a
  // heavier boot sequence; livenessPath is the single explicit source of
  // truth for which path liveness probes (see _helpers.tpl) and is
  // intentionally independent of startupPath so a startup grace period never
  // implies a liveness path, nor does opting into tolerant liveness imply a
  // startup grace period.
  if (componentsWithStartupProbe.has(component.name)) {
    result.startupPath = tolerantLivenessPath;
  }
  if (componentsWithTolerantLiveness.has(component.name)) {
    result.livenessPath = tolerantLivenessPath;
    result.livenessProbe = { ...tolerantLivenessProbe };
  }

  // Readiness timing override: give the DB-aware readiness probe a
  // realistic per-probe budget so pool contention under load can no longer
  // flap the pod out of its Service endpoints.
  if (componentsWithReadinessTuning.has(component.name)) {
    result.readinessProbe = { ...readinessProbeTuning };
  }

  if (rolloutEligibleComponents.has(component.name)) {
    result.rollout = rolloutValues(
      false,
      false,
      component.name === "public-web" ? "/health/ready" : component.healthPath,
    );
  }

  if (component.terraformKind === "job") {
    result.job = {
      suspend: false,
      backoffLimit: 0,
      activeDeadlineSeconds: bootstrapHookActiveDeadlineSeconds,
      ttlSecondsAfterFinished: 600,
      hook: {
        enabled: true,
        events: ["pre-install", "pre-upgrade"],
        weight: -20,
        deletePolicy: ["before-hook-creation", "hook-succeeded"],
      },
      quiesce: {
        enabled: true,
        targetComponents: ["platform-worker"],
        timeoutSeconds: bootstrapQuiesceTimeoutSeconds,
        commandTimeoutSeconds: bootstrapCommandTimeoutSeconds,
        pollIntervalMs: 2000,
        restoreOnFailure: true,
        ignoreMissingDeployments: true,
      },
    };
  }

  return result;
}

function helmCommand(component) {
  if (component.name === "platform-bootstrap") {
    return platformBootstrapCommand;
  }

  return component.command;
}

function helmInstanceCountExpression(component) {
  if (component.name === "platform-worker") {
    return "local.worker_instances";
  }

  return component.instanceCountExpression;
}

function helmEnv(component) {
  if (component.name === "platform-bootstrap") {
    return [
      ...component.env
        .filter((entry) => entry.name !== "PLATFORM_BOOTSTRAP_OWNER")
        .map((entry) =>
          isBootstrapDatabaseEnv(entry.name)
            ? { ...entry, secretKey: `${bootstrapDatabaseSecretKeyPrefix}${entry.name}` }
            : entry,
        ),
      {
        name: "PLATFORM_PREVIEW_POSTGRES_ADMIN_URL",
        secret: true,
        secretKey: "PLATFORM_PREVIEW_POSTGRES_ADMIN_URL",
      },
    ].sort((left, right) => left.name.localeCompare(right.name, "en"));
  }

  return component.env;
}

function isBootstrapDatabaseEnv(name) {
  return name === "PLATFORM_CONTROL_DATABASE_URL" || /^DATABASE_URL_[A-Z0-9_]+$/.test(name);
}

function normalizeTerraformComponent(component, locals) {
  const env = collectComponentEnv(component.block, component.name, locals);

  return {
    name: component.name,
    terraformKind: component.kind,
    command: requiredStringAttribute(component.block, "run_command", component.name),
    instanceCountExpression: optionalAttributeExpression(component.block, "instance_count") ?? "1",
    replicas: defaultReplicaCount(component.name),
    port: optionalNumericAttribute(component.block, "http_port"),
    healthPath: optionalNestedStringAttribute(component.block, "health_check", "http_path"),
    env,
  };
}

function collectComponentEnv(block, componentName, locals) {
  const envByName = new Map();

  for (const envBlock of collectNamedBlocks(block, "env")) {
    const key = optionalStringAttribute(envBlock, "key");
    if (!key) {
      continue;
    }
    envByName.set(key, normalizeEnvEntry({ name: key, ...parseExplicitEnv(envBlock) }, componentName));
  }

  for (const dynamicBlock of collectDynamicEnvBlocks(block)) {
    for (const entry of expandDynamicEnv(dynamicBlock, locals)) {
      envByName.set(entry.name, normalizeEnvEntry(entry, componentName));
    }
  }

  return [...envByName.values()].sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function parseExplicitEnv(envBlock) {
  return {
    value: optionalStringAttribute(envBlock, "value"),
    secret: optionalStringAttribute(envBlock, "type") === "SECRET",
  };
}

function normalizeEnvEntry(entry, componentName) {
  const secret = Boolean(entry.secret || secretEnvFallbacks.has(entry.name) || entry.name.startsWith("DATABASE_URL_"));
  if (secret) {
    return {
      name: entry.name,
      secret: true,
      secretKey: entry.name,
    };
  }

  return {
    name: entry.name,
    value: envValue(entry, componentName),
  };
}

function envValue(entry, componentName) {
  if (entry.name === "DATABASE_POOL_MAX") {
    return databasePoolMaxByComponent[componentName] ?? envValueDefaults[entry.name] ?? "";
  }

  if (Object.hasOwn(envValueDefaults, entry.name)) {
    return envValueDefaults[entry.name];
  }

  if (entry.value != null && !entry.value.includes("${")) {
    return entry.value;
  }

  return "";
}

function expandDynamicEnv(dynamicBlock, locals) {
  const forEachExpression = optionalAttributeExpression(dynamicBlock, "for_each");

  if (forEachExpression === "local.observability_runtime_env") {
    return locals.observabilityRuntimeEnv;
  }

  if (forEachExpression === "local.catalog_provider_runtime_env") {
    return locals.catalogProviderRuntimeEnv;
  }

  if (forEachExpression === "local.rate_limit_runtime_env") {
    return locals.rateLimitRuntimeEnv;
  }

  if (forEachExpression === "local.context_database_env") {
    return locals.contextDatabaseEnv.map((name) => ({ name, secret: true }));
  }

  if (forEachExpression === "local.api_waiter_database_urls") {
    return locals.contextWaiterDatabaseEnv.map((name) => ({ name, secret: true }));
  }

  if (forEachExpression === "local.worker_listener_database_urls") {
    return locals.workerListenerDatabaseEnv.map((name) => ({ name, secret: true }));
  }

  throw new Error(`Unsupported dynamic platform env source '${forEachExpression}'.`);
}

function parsePlatformLocals(localsSource) {
  const platformContextNames = extractQuotedListLocal(localsSource, "platform_context_names");
  const apiWaiterContexts = extractQuotedListLocal(localsSource, "api_waiter_contexts");
  const workerListenerSourceContexts = extractQuotedListLocal(localsSource, "worker_listener_source_contexts");

  return {
    platformContextNames,
    apiWaiterContexts,
    workerListenerSourceContexts,
    observabilityRuntimeEnv: extractEnvMapLocal(localsSource, "observability_runtime_env"),
    catalogProviderRuntimeEnv: extractEnvMapLocal(localsSource, "catalog_provider_runtime_env"),
    rateLimitRuntimeEnv: extractEnvMapLocal(localsSource, "rate_limit_runtime_env"),
    contextDatabaseEnv: platformContextNames
      .filter((contextName) => contextName !== "control")
      .map((contextName) => `DATABASE_URL_${envToken(contextName)}`),
    contextWaiterDatabaseEnv: apiWaiterContexts.map((contextName) => `DATABASE_URL_${envToken(contextName)}_WAITER`),
    workerListenerDatabaseEnv: workerListenerSourceContexts.map(
      (contextName) => `WORKER_LISTENER_DATABASE_URL_${envToken(contextName)}`,
    ),
  };
}

function extractEnvMapLocal(source, localName) {
  const assignmentIndex = source.indexOf(`${localName} =`);
  if (assignmentIndex === -1) {
    throw new Error(`local.${localName} is missing from ${platformLocalsRelativePath}.`);
  }

  const block = extractBlockAt(source, source.indexOf("{", assignmentIndex));
  const keys = [];
  let index = 0;

  while (index < block.content.length) {
    const match = /([A-Z][A-Z0-9_]*)\s*=\s*\{/g.exec(block.content.slice(index));
    if (!match) {
      break;
    }
    const keyIndex = index + match.index;
    if (braceDepth(block.content.slice(0, keyIndex)) !== 0) {
      index = keyIndex + match[0].length;
      continue;
    }

    const entryBlock = extractBlockAt(block.content, keyIndex + match[0].lastIndexOf("{"));
    keys.push({
      name: match[1],
      secret: /secret\s*=\s*true/.test(entryBlock.content),
      value: optionalStringAttribute(entryBlock.content, "value"),
    });
    index = entryBlock.end;
  }

  return keys.sort((left, right) => left.name.localeCompare(right.name, "en"));
}

function extractQuotedListLocal(source, localName) {
  const assignmentMatch = new RegExp(`${localName}\\s*=\\s*\\[`).exec(source);
  const assignmentIndex = assignmentMatch?.index ?? -1;
  if (assignmentIndex === -1) {
    throw new Error(`local.${localName} is missing from ${platformLocalsRelativePath}.`);
  }

  const start = source.indexOf("[", assignmentIndex);
  const end = source.indexOf("]", start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function collectTopLevelComponents(spec) {
  const components = [];
  let index = 0;

  while (index < spec.length) {
    const match =
      /(dynamic\s+"service"\s*\{|dynamic\s+"worker"\s*\{|service\s*\{|worker\s*\{|job\s*\{|ingress\s*\{)/g.exec(
        spec.slice(index),
      );
    if (!match) {
      break;
    }

    const absoluteIndex = index + match.index;
    if (braceDepth(spec.slice(0, absoluteIndex)) !== 0) {
      index = absoluteIndex + match[0].length;
      continue;
    }

    if (match[0].startsWith("ingress")) {
      break;
    }

    // The platform-worker is rendered through a conditional
    // dynamic "worker" block (absent when DOKS owns the runtime), so the DOKS
    // helm renderer must resolve it the same as a static worker block.
    const isWorker = match[0].startsWith("worker") || /dynamic\s+"worker"/.test(match[0]);
    const kind = isWorker ? "worker" : match[0].startsWith("job") ? "job" : "service";
    const block = extractBlockAt(spec, absoluteIndex + match[0].lastIndexOf("{"));
    const componentBlock = match[0].startsWith("dynamic") ? extractNamedBlock(block.content, "content") : block.content;
    const name = requiredStringAttribute(componentBlock, "name", kind);
    components.push({ name, kind, block: componentBlock });
    index = block.end;
  }

  return components;
}

function collectNamedBlocks(source, blockName) {
  const blocks = [];
  let index = 0;

  while (index < source.length) {
    const match = new RegExp(`${blockName}\\s*\\{`, "g").exec(source.slice(index));
    if (!match) {
      break;
    }

    const absoluteIndex = index + match.index;
    const block = extractBlockAt(source, absoluteIndex + match[0].lastIndexOf("{"));
    blocks.push(block.content);
    index = block.end;
  }

  return blocks;
}

function collectDynamicEnvBlocks(source) {
  const blocks = [];
  let index = 0;

  while (index < source.length) {
    const match = /dynamic\s+"env"\s*\{/g.exec(source.slice(index));
    if (!match) {
      break;
    }

    const absoluteIndex = index + match.index;
    const block = extractBlockAt(source, absoluteIndex + match[0].lastIndexOf("{"));
    blocks.push(block.content);
    index = block.end;
  }

  return blocks;
}

function extractNamedBlock(source, name) {
  const index = source.indexOf(`${name} {`);
  if (index === -1) {
    throw new Error(`Block '${name}' is missing.`);
  }

  return extractBlockAt(source, source.indexOf("{", index)).content;
}

function extractBlockAt(source, openBraceIndex) {
  if (source[openBraceIndex] !== "{") {
    throw new Error("Expected block to start at an opening brace.");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          content: source.slice(openBraceIndex + 1, index),
          end: index + 1,
        };
      }
    }
  }

  throw new Error("Unclosed block.");
}

function braceDepth(source) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of source) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
    }
  }

  return depth;
}

function requiredStringAttribute(source, name, owner) {
  const value = optionalStringAttribute(source, name);
  if (value == null) {
    throw new Error(`${owner} is missing required string attribute '${name}'.`);
  }
  return value;
}

function optionalStringAttribute(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(source);
  return match?.[1] ?? null;
}

function optionalAttributeExpression(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*([^\\n]+)`).exec(source);
  return match?.[1]?.trim() ?? null;
}

function optionalNumericAttribute(source, name) {
  const expression = optionalAttributeExpression(source, name);
  return expression && /^\d+$/.test(expression) ? Number(expression) : null;
}

function optionalNestedStringAttribute(source, blockName, attributeName) {
  const blocks = collectNamedBlocks(source, blockName);
  return blocks.length > 0 ? optionalStringAttribute(blocks[0], attributeName) : null;
}

function defaultReplicaCount(componentName) {
  if (componentName === "platform-bootstrap") {
    return 1;
  }
  return 1;
}

function envToken(contextName) {
  return contextName.replaceAll("-", "_").toUpperCase();
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
