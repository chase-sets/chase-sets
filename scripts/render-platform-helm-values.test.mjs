import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeTopologyBaselines } from "./digitalocean-runtime-topology.mjs";
import {
  buildDoksIngressValues,
  buildPlatformHelmValues,
  buildPlatformHelmStagingValues,
  buildPreviewDoksIngressValues,
  chartValuesRelativePath,
  doksStagingApiOverrides,
  doksStagingWorkerAutoscaling,
  doksStagingWorkerEnvOverrides,
  extractDigitalOceanPlatformComponents,
  platformHelmComponentName,
  platformHelmFullname,
  previewWildcardTlsSecretName,
  readPlatformSources,
  syncPlatformHelmValues,
} from "./render-platform-helm-values.mjs";

const repoRoot = path.resolve(".");
const sources = readPlatformSources(repoRoot);

function componentNames(collections) {
  return [...collections.services, ...collections.workers, ...collections.jobs]
    .map((component) => component.name)
    .sort();
}

function componentEnvKeys(component) {
  return component.env.map((entry) => entry.name).sort();
}

function componentEnvValue(component, name) {
  return component.env.find((entry) => entry.name === name)?.value;
}

function expectedHelmEnvKeys(terraformComponent) {
  const keys = componentEnvKeys(terraformComponent);
  if (terraformComponent.name === "platform-bootstrap") {
    return [...keys.filter((key) => key !== "PLATFORM_BOOTSTRAP_OWNER"), "PLATFORM_PREVIEW_POSTGRES_ADMIN_URL"].sort();
  }

  return keys;
}

function readChartFiles(relativePaths) {
  return relativePaths.map((relativePath) =>
    readFileSync(path.join(repoRoot, "infrastructure", "helm", "platform", relativePath), "utf8"),
  );
}

describe("render platform Helm values", () => {
  it("keeps generated values current", () => {
    expect(() => syncPlatformHelmValues({ repoRoot, check: true })).not.toThrow();
  });

  it("keeps schema bootstrap on dedicated direct database secret keys", () => {
    const values = buildPlatformHelmValues({ repoRoot });
    const bootstrapEnv = new Map(values.components["platform-bootstrap"].env.map((entry) => [entry.name, entry]));
    const apiEnv = new Map(values.components["platform-api"].env.map((entry) => [entry.name, entry]));

    expect(bootstrapEnv.get("DATABASE_URL_CATALOG")?.secretKey).toBe("BOOTSTRAP_DATABASE_URL_CATALOG");
    expect(bootstrapEnv.get("PLATFORM_CONTROL_DATABASE_URL")?.secretKey).toBe(
      "BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL",
    );
    expect(apiEnv.get("DATABASE_URL_CATALOG")?.secretKey).toBe("DATABASE_URL_CATALOG");
    expect(apiEnv.get("PLATFORM_CONTROL_DATABASE_URL")?.secretKey).toBe("PLATFORM_CONTROL_DATABASE_URL");
  });

  it("scaffolds the six current full-platform App Platform components", () => {
    const values = buildPlatformHelmValues({ repoRoot });
    const expectedNames = componentNames(runtimeTopologyBaselines.staging.expectedComponents);

    expect(Object.keys(values.components).sort()).toEqual(expectedNames);
    expect(Object.values(values.components).filter((component) => component.kind === "service")).toHaveLength(4);
    expect(Object.values(values.components).filter((component) => component.kind === "worker")).toHaveLength(1);
    expect(Object.values(values.components).filter((component) => component.kind === "job")).toHaveLength(1);
    expect(values.doksIngress).toMatchObject({
      enabled: false,
      className: "nginx",
      clusterIssuer: "",
      annotations: {},
      tls: {
        enabled: true,
        secretName: "chase-sets-platform-tls",
      },
      hosts: [],
    });
    expect(values.previewPostgres).toMatchObject({
      enabled: false,
      // Must match local dev and CI DB-test containers: the discovery schema
      // bootstrap requires the pgvector extension, which postgres:*-alpine
      // images do not ship.
      image: { repository: "pgvector/pgvector", tag: "pg16" },
      service: { port: 5432 },
      secretName: "chase-sets-preview-postgres",
      storage: { emptyDir: {} },
    });
    expect(values.global.imagePullSecrets).toEqual([]);
    expect(values.global.envOverrides).toEqual({});
  });

  it("derives commands, ports, and source count expressions from the DigitalOcean app spec", () => {
    const terraformComponents = extractDigitalOceanPlatformComponents(sources);
    const values = buildPlatformHelmValues({ repoRoot });

    for (const terraformComponent of terraformComponents) {
      const helmComponent = values.components[terraformComponent.name];
      if (terraformComponent.name === "platform-bootstrap") {
        expect(helmComponent.command).toBe("pnpm --filter @chase-sets/app-platform-api run bootstrap:production");
      } else {
        expect(helmComponent.command).toBe(terraformComponent.command);
      }
      // The worker declares no App Platform http_port but gets a DOKS-only
      // health port injected for its liveness/readiness probes (#4620), so it
      // is exempt from the App-Platform port-parity check.
      if (terraformComponent.name !== "platform-worker") {
        expect(helmComponent.port ?? null).toBe(terraformComponent.port ?? null);
      }
      if (terraformComponent.name === "platform-worker") {
        expect(helmComponent.source.instanceCountExpression).toBe("local.worker_instances");
      } else {
        expect(helmComponent.source.instanceCountExpression).toBe(terraformComponent.instanceCountExpression);
      }
    }

    expect(values.components["public-web"].source.instanceCountExpression).toBe("local.public_web_instances");
    expect(values.components.marketplace.source.instanceCountExpression).toBe("local.marketplace_web_instances");
    expect(values.components["platform-api"].source.instanceCountExpression).toBe("local.api_instances");
    expect(values.components["platform-worker"].source.instanceCountExpression).toBe("local.worker_instances");
    expect(values.components["platform-bootstrap"].source.instanceCountExpression).toBe("1");
    expect(values.components["platform-bootstrap"].command).toBe(
      "pnpm --filter @chase-sets/app-platform-api run bootstrap:production",
    );
  });

  it("derives the in-cluster platform-api origin from the Helm service name", () => {
    const values = buildPlatformHelmValues({ repoRoot });

    expect(platformHelmFullname()).toBe("chase-sets-platform-chase-sets-platform");
    expect(platformHelmComponentName("platform-api")).toBe("chase-sets-platform-chase-sets-platform-platform-api");
    expect(componentEnvValue(values.components["admin-web"], "CHASE_SETS_INTERNAL_API_ORIGIN")).toBe(
      "http://chase-sets-platform-chase-sets-platform-platform-api:8080",
    );
    expect(componentEnvValue(values.components.marketplace, "CHASE_SETS_INTERNAL_API_ORIGIN")).toBe(
      "http://chase-sets-platform-chase-sets-platform-platform-api:8080",
    );
    expect(componentEnvValue(values.components["public-web"], "CHASE_SETS_INTERNAL_API_ORIGIN")).toBe(
      "http://chase-sets-platform-chase-sets-platform-platform-api:8080",
    );
  });

  it("keeps the baseline worker small and fits every runner group in its pool budget", () => {
    const values = buildPlatformHelmValues({ repoRoot });
    const worker = values.components["platform-worker"];

    // #4620: the worker serves /health/live + /health/ready from an in-process
    // server that only binds after full boot, so probing it makes a
    // boot-crashing worker fail the rollout. Readiness gates the rollout; the
    // startup probe holds liveness off until boot completes.
    expect(worker.port).toBe(8080);
    expect(worker.healthPath).toBe("/health/ready");
    expect(worker.startupPath).toBe("/health/live");
    // #4765: liveness itself must test process life, not DB readiness, with a
    // tolerant ~60s failure window (periodSeconds * failureThreshold).
    expect(worker.livenessPath).toBe("/health/live");
    expect(worker.livenessProbe).toEqual({
      periodSeconds: 10,
      timeoutSeconds: 5,
      failureThreshold: 6,
    });
    // No in-cluster consumer, so no ClusterIP Service is minted for the worker.
    expect(worker.service).toBeUndefined();

    const envValue = (name) => worker.env.find((entry) => entry.name === name)?.value;
    // Every runner group summed by the runtime capacity guard, mapped to its
    // rendered env knob. Operations defaults to the same code default the
    // runtime uses when the env is absent.
    const runnerGroupEnvNames = [
      "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS",
      "WORKER_PROJECTION_OPERATION_RUNNER_COUNT",
      "WORKER_JOB_MAX_CONCURRENT_RUNNERS",
      "INVENTORY_IMPORT_BATCH_JOB_MAX_CONCURRENT_RUNNERS",
      "WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS",
      "WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS",
      "WORKER_WAKE_MAX_CONCURRENT_RUNNERS",
    ];
    const totalRunnerConcurrency = runnerGroupEnvNames.reduce((total, name) => {
      const value = envValue(name);
      expect(value, `${name} must be rendered explicitly for the worker`).toBeDefined();
      return total + Number(value);
    }, 0);
    const poolMax = Number(envValue("DATABASE_POOL_MAX"));

    expect(totalRunnerConcurrency).toBe(8);
    expect(totalRunnerConcurrency).toBeLessThanOrEqual(poolMax);
    expect(envValue("WORKER_WAKE_MAX_CONCURRENT_RUNNERS")).toBe("2");
    expect(envValue("WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT")).toBe("1");
    // #4762 widens projection concurrency for the DOKS staging overlay only;
    // the base/preview worker keeps the conservative single projection slot.
    expect(envValue("WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS")).toBe("1");
  });

  it("pins staging worker autoscaling to eligible wake-signal depth", () => {
    const baselineValues = buildPlatformHelmValues({ repoRoot });
    const stagingValues = buildPlatformHelmStagingValues();
    const baselineAutoscaling = baselineValues.components["platform-worker"].autoscaling;
    const stagingAutoscaling = stagingValues.components["platform-worker"].autoscaling;
    const scaledObjectTemplate = readChartFiles(["templates/scaledobject.yaml"])[0];

    expect(baselineAutoscaling).toEqual(doksStagingWorkerAutoscaling);
    expect(baselineAutoscaling.enabled).toBe(false);
    expect(stagingAutoscaling).toEqual({ ...doksStagingWorkerAutoscaling, enabled: true });
    expect(stagingAutoscaling.minReplicaCount).toBe(1);
    expect(stagingAutoscaling.maxReplicaCount).toBe(4);
    expect(stagingAutoscaling.pollingInterval).toBe(15);
    expect(stagingAutoscaling.cooldownPeriod).toBe(300);
    expect(stagingAutoscaling.triggers[0]).toEqual({
      type: "postgresql",
      metadata: {
        connectionFromEnv: "PLATFORM_WORK_SIGNAL_DATABASE_URL",
        query: expect.stringContaining("platform_projection_wake_intents"),
        targetQueryValue: "1",
        activationTargetQueryValue: "0",
      },
    });
    expect(stagingAutoscaling.triggers[0].metadata.query).toContain("state IN ('queued', 'failed')");
    expect(stagingAutoscaling.triggers[0].metadata.query).toContain("next_eligible_at <= now()");
    expect(stagingAutoscaling.triggers[0].metadata.query).toContain("expires_at > now()");

    expect(scaledObjectTemplate).toContain("apiVersion: keda.sh/v1alpha1");
    expect(scaledObjectTemplate).toContain("kind: ScaledObject");
    expect(scaledObjectTemplate).toContain("scaleTargetRef:");
    expect(scaledObjectTemplate).toContain("toYaml $trigger.metadata");
  });

  it("renders a staging-only DOKS worker overlay with representative wake headroom", () => {
    const baselineValues = buildPlatformHelmValues({ repoRoot });
    const stagingValues = buildPlatformHelmStagingValues();
    const worker = baselineValues.components["platform-worker"];
    const workerOverrides = stagingValues.components["platform-worker"].envOverrides;

    expect(workerOverrides).toEqual(doksStagingWorkerEnvOverrides);

    const envValue = (name) => workerOverrides[name] ?? worker.env.find((entry) => entry.name === name)?.value;
    const totalRunnerConcurrency = [
      "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS",
      "WORKER_PROJECTION_OPERATION_RUNNER_COUNT",
      "WORKER_JOB_MAX_CONCURRENT_RUNNERS",
      "INVENTORY_IMPORT_BATCH_JOB_MAX_CONCURRENT_RUNNERS",
      "WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS",
      "WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS",
      "WORKER_WAKE_MAX_CONCURRENT_RUNNERS",
    ].reduce((total, name) => total + Number(envValue(name)), 0);

    // #4762: the projection runner group is widened to 4 so the small starved
    // projection groups drain alongside the 2 large discovery cascade groups,
    // and DATABASE_POOL_MAX rises 9 -> 12 one-for-one with the +3 slots.
    expect(envValue("WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS")).toBe("4");
    expect(envValue("DATABASE_POOL_MAX")).toBe("12");
    expect(envValue("WORKER_WAKE_MAX_CONCURRENT_RUNNERS")).toBe("3");
    expect(envValue("WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT")).toBe("2");
    expect(totalRunnerConcurrency).toBe(12);
    expect(totalRunnerConcurrency).toBeLessThanOrEqual(Number(envValue("DATABASE_POOL_MAX")));
  });

  it("scales and resources only the staging DOKS API, inheriting base-chart tolerant process liveness", () => {
    const baselineValues = buildPlatformHelmValues({ repoRoot });
    const stagingValues = buildPlatformHelmStagingValues();

    // #4765 widened scope: tolerant liveness (startupPath/livenessPath/
    // livenessProbe) is now a BASE-chart default for platform-api, so every
    // environment gets it -- not just staging. The staging overlay stays
    // scoped to what is genuinely staging-only: replica count, resources,
    // and the staged Argo Rollout activation.
    expect(stagingValues.components["platform-api"]).toEqual(doksStagingApiOverrides);
    expect(stagingValues.components["platform-api"]).toMatchObject({
      replicas: 2,
      resources: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "1", memory: "1Gi" },
      },
      rollout: { enabled: true, canary: { trafficRouting: { nginx: { enabled: true } } } },
    });
    expect(stagingValues.components["platform-api"].startupPath).toBeUndefined();
    expect(stagingValues.components["platform-api"].livenessPath).toBeUndefined();
    expect(stagingValues.components["platform-api"].livenessProbe).toBeUndefined();

    // Base (production and preview render this without any overlay).
    const baselineApi = baselineValues.components["platform-api"];
    expect(baselineApi.replicas).toBe(1);
    expect(baselineApi.resources).toEqual({});
    // Readiness stays strict and DB-aware; traffic gating is unchanged (#4765).
    expect(baselineApi.healthPath).toBe("/health/ready");
    // Liveness tests process life instead, with a tolerant ~60s window
    // (periodSeconds * failureThreshold), so DB slowness or a briefly-busy
    // event loop no longer kills the pod (proven live in preview
    // chase-sets-pr-4766: Exit Code 137 / "failed liveness probe .../health/ready").
    expect(baselineApi.startupPath).toBe("/health/live");
    expect(baselineApi.livenessPath).toBe("/health/live");
    expect(baselineApi.livenessProbe).toEqual({
      periodSeconds: 10,
      timeoutSeconds: 5,
      failureThreshold: 6,
    });
  });

  it("merges base + staging platform-api values into the same tolerant-liveness/strict-readiness shape Helm would render", () => {
    // Simulates Helm's `-f values.yaml -f values.staging.yaml` shallow merge
    // per top-level component key (values.staging.yaml never sets
    // startupPath/livenessPath/livenessProbe for platform-api, so the base
    // values must survive the merge unchanged).
    const baselineApi = buildPlatformHelmValues({ repoRoot }).components["platform-api"];
    const stagingApi = buildPlatformHelmStagingValues().components["platform-api"];
    const merged = { ...baselineApi, ...stagingApi };

    expect(merged).toMatchObject({
      replicas: 2,
      resources: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "1", memory: "1Gi" },
      },
      healthPath: "/health/ready",
      startupPath: "/health/live",
      livenessPath: "/health/live",
      livenessProbe: {
        periodSeconds: 10,
        timeoutSeconds: 5,
        failureThreshold: 6,
      },
    });
  });

  it("gives preview and production the tolerant liveness fix from the base chart alone (no --values overlay)", () => {
    // scripts/platform-kubernetes-deployment.mjs's platformValuesPathForEnvironment
    // only supplies `--values values.staging.yaml` for DEPLOYMENT_ENVIRONMENT
    // "staging"; preview and production `helm upgrade` calls pass no
    // environment values file at all, so they render values.yaml alone. The
    // live preview evidence for #4765 (namespace chase-sets-pr-4766) was hit
    // on exactly this base-only path, which is why the fix must live in the
    // base chart rather than only in the staging overlay.
    const previewAndProductionApi = buildPlatformHelmValues({ repoRoot }).components["platform-api"];

    expect(previewAndProductionApi.healthPath).toBe("/health/ready");
    expect(previewAndProductionApi.livenessPath).toBe("/health/live");
    expect(previewAndProductionApi.livenessProbe).toEqual({
      periodSeconds: 10,
      timeoutSeconds: 5,
      failureThreshold: 6,
    });
    // Preview/production get no replica/resource overlay -- only staging does.
    expect(previewAndProductionApi.replicas).toBe(1);
    expect(previewAndProductionApi.resources).toEqual({});
  });

  it("gives the web deployables tolerant liveness now that each serves /health/live", () => {
    // #4767: admin-web, marketplace, and public-web each register a
    // `health/live` route (deployables/<name>/app/routes.ts ->
    // routes/health-live.ts using createWebLiveLoader) that returns
    // { status: "ok" } with no database or upstream call, alongside their
    // existing `health/ready` route (-> routes/health-ready.ts using
    // createWebReadyLoader). They now opt into the same tolerant
    // livenessPath/livenessProbe as platform-api (createHealthRoutes in
    // infrastructure/platform-runtime/health.ts, mounted at /health) and
    // platform-worker (deployables/platform-worker/src/main.ts) got in #4765.
    const values = buildPlatformHelmValues({ repoRoot });
    const tolerantLivenessProbe = {
      periodSeconds: 10,
      timeoutSeconds: 5,
      failureThreshold: 6,
    };

    for (const name of ["admin-web", "marketplace", "public-web"]) {
      const component = values.components[name];
      expect(component.livenessPath, `${name} should get the tolerant /health/live livenessPath`).toBe("/health/live");
      expect(component.livenessProbe, `${name} should get the tolerant livenessProbe timings`).toEqual(
        tolerantLivenessProbe,
      );
      // startupPath stays scoped to platform-api/platform-worker's heavier
      // boot sequence; the web deployables never get a startup grace probe.
      expect(component.startupPath, `${name} should not get a startupPath`).toBeUndefined();
    }

    // Readiness stays strict and unchanged: traffic gating and rollout
    // behavior are not touched by the liveness fix (public-web's DigitalOcean
    // health_check http_path is "/" today, predating this change; the other
    // two use their own `health/ready` route).
    expect(values.components["public-web"].healthPath).toBe("/");
    expect(values.components.marketplace.healthPath).toBe("/health/ready");
    expect(values.components["admin-web"].healthPath).toBe("/health/ready");
  });

  it("gives the staging DOKS worker relay ownership now that the App Platform worker is omitted", () => {
    // Invariant for issue #4743: #4739 removes the App Platform worker
    // component when DOKS owns the estate, and that worker was the only
    // relay-enabled process. The estate's sole remaining worker MUST run the
    // projection wake relay — with the base Helm value left at "false"
    // (previews have no listener URLs by design), the staging overlay is the
    // only thing standing between a DOKS-owned estate and a fleet-wide dead
    // relay (expired `projection-wake-relay:active` lease under the removed
    // worker, empty wake ledger, authenticated read-after-write timeouts).
    const baselineValues = buildPlatformHelmValues({ repoRoot });
    const stagingValues = buildPlatformHelmStagingValues();
    const worker = baselineValues.components["platform-worker"];
    const workerOverrides = stagingValues.components["platform-worker"].envOverrides;

    // Base stays relay-off for previews...
    expect(worker.env.find((entry) => entry.name === "WORKER_PROJECTION_WAKE_RELAY_ENABLED")?.value).toBe("false");
    // ...and the staging overlay flips the sole worker to relay owner.
    expect(workerOverrides.WORKER_PROJECTION_WAKE_RELAY_ENABLED).toBe("true");

    // The relay's live-listen prerequisites must already be wired into the
    // worker env (direct listener URLs; LISTEN is PgBouncer-incompatible).
    const workerEnvNames = new Set(worker.env.map((entry) => entry.name));
    for (const contextKey of [
      "WORKER_LISTENER_DATABASE_URL_CHECKOUT",
      "WORKER_LISTENER_DATABASE_URL_IDENTITY",
      "WORKER_LISTENER_DATABASE_URL_INVENTORY",
      "WORKER_LISTENER_DATABASE_URL_MARKETPLACE",
      "WORKER_LISTENER_DATABASE_URL_ORDERING",
      "WORKER_LISTENER_DATABASE_URL_PAYMENTS",
      "WORKER_LISTENER_DATABASE_URL_PUBLIC_PRESENCE",
    ]) {
      expect(workerEnvNames.has(contextKey)).toBe(true);
    }
  });

  it("keeps DOKS ingress off by default in the staging overlay", () => {
    const stagingValues = buildPlatformHelmStagingValues();

    expect(stagingValues.doksIngress).toEqual({
      enabled: false,
      className: "nginx",
      clusterIssuer: "letsencrypt-production",
      annotations: {},
      tls: {
        enabled: true,
        secretName: "chase-sets-platform-doks-tls",
      },
      hosts: [],
    });
  });

  it("renders DOKS shadow ingress hosts while App Platform serves live staging traffic", () => {
    const doksIngress = buildDoksIngressValues({
      env: {
        DOKS_INGRESS_TARGET: "203.0.113.10",
        STAGING_APP_SERVING: "app-platform",
      },
    });

    expect(doksIngress.enabled).toBe(true);
    expect(doksIngress.className).toBe("nginx");
    expect(doksIngress.clusterIssuer).toBe("letsencrypt-production");
    expect(doksIngress.hosts.map((host) => host.host)).toEqual([
      "doks.staging.chasesets.com",
      "www.doks.staging.chasesets.com",
      "marketplace.doks.staging.chasesets.com",
      "admin.doks.staging.chasesets.com",
    ]);
    expect(Object.fromEntries(doksIngress.hosts.map((host) => [host.host, host.paths.at(-1)]))).toEqual({
      "doks.staging.chasesets.com": { path: "/", service: "marketplace" },
      "www.doks.staging.chasesets.com": { path: "/", service: "public-web" },
      "marketplace.doks.staging.chasesets.com": { path: "/", service: "marketplace" },
      "admin.doks.staging.chasesets.com": { path: "/", service: "admin-web" },
    });
    expect(doksIngress.hosts[0].paths.map((route) => route.path)).toEqual([
      "/.well-known",
      "/ucp",
      "/mcp",
      "/api/payments/provider/webhooks",
      "/api/settlement/provider/money-movement/webhooks",
      "/api/notifications/provider/email/webhooks",
      "/api/fulfillment/provider/postage/webhooks",
      "/api",
      "/",
    ]);
    expect(doksIngress.hosts[0].paths.slice(0, -1).every((route) => route.service === "platform-api")).toBe(true);
  });

  it("renders DOKS live ingress hosts after the staging serving flag flips", () => {
    const stagingValues = buildPlatformHelmStagingValues({
      env: {
        DOKS_INGRESS_TARGET: "203.0.113.10",
        STAGING_APP_SERVING: "doks",
      },
    });

    expect(stagingValues.doksIngress.enabled).toBe(true);
    expect(stagingValues.doksIngress.hosts.map((host) => host.host)).toEqual([
      "staging.chasesets.com",
      "www.staging.chasesets.com",
      "marketplace.staging.chasesets.com",
      "admin.staging.chasesets.com",
    ]);
  });

  it("renders DOKS preview ingress hosts for a preview identifier", () => {
    const previewIngress = buildPreviewDoksIngressValues({ previewIdentifier: "pr-123" });

    // #4857: single-label preview hosts so the ONE shared
    // *.preview.chasesets.com wildcard certificate covers all of them, and no
    // cert-manager cluster-issuer annotation belongs on a preview Ingress
    // (previews reference the shared, pre-copied secret instead of asking
    // for their own certificate).
    expect(previewIngress.enabled).toBe(true);
    expect(previewIngress.clusterIssuer).toBe("");
    expect(previewIngress.tls.secretName).toBe("preview-wildcard-tls");
    expect(previewIngress.hosts.map((host) => host.host)).toEqual([
      "pr-123.preview.chasesets.com",
      "pr-123-marketplace.preview.chasesets.com",
      "pr-123-admin.preview.chasesets.com",
    ]);
    expect(Object.fromEntries(previewIngress.hosts.map((host) => [host.host, host.paths.at(-1)]))).toEqual({
      "pr-123.preview.chasesets.com": { path: "/", service: "public-web" },
      "pr-123-marketplace.preview.chasesets.com": { path: "/", service: "marketplace" },
      "pr-123-admin.preview.chasesets.com": { path: "/", service: "admin-web" },
    });
  });

  it("every preview namespace references the same shared wildcard TLS secret name (#4857)", () => {
    const first = buildPreviewDoksIngressValues({ previewIdentifier: "pr-1" });
    const second = buildPreviewDoksIngressValues({ previewIdentifier: "pr-999999" });

    expect(first.tls.secretName).toBe(second.tls.secretName);
    expect(first.tls.secretName).toBe(previewWildcardTlsSecretName);
  });

  it("omits the cert-manager cluster-issuer annotation entirely when doksIngress.clusterIssuer is empty (#4857)", () => {
    // Verified against a live `helm template` render for both shapes: a
    // preview-shaped values set (clusterIssuer="") renders no `annotations:`
    // block at all, and a staging-shaped set (clusterIssuer="letsencrypt-production")
    // renders `cert-manager.io/cluster-issuer: "letsencrypt-production"`. This
    // pins the template conditional that makes that possible so a preview
    // deploy never accidentally re-triggers ACME issuance.
    const [ingressTemplate] = readChartFiles(["templates/ingress.yaml"]);
    expect(ingressTemplate).toContain("{{- if or $ingress.clusterIssuer $ingress.annotations }}");
    expect(ingressTemplate).toContain("cert-manager.io/cluster-issuer: {{ $ingress.clusterIssuer | quote }}");
  });

  it("wires the startup/liveness/readiness probes in the deployment template with one liveness-path source of truth", () => {
    const [helperTemplate] = readChartFiles(["templates/_helpers.tpl"]);

    expect(helperTemplate).toContain("readinessProbe:");
    expect(helperTemplate).toContain("startupProbe:");
    expect(helperTemplate).toContain("livenessProbe:");
    expect(helperTemplate).toContain("if $component.startupPath");
    expect(helperTemplate).toContain("failureThreshold: 30");
    expect(helperTemplate).toContain("with $component.livenessProbe");
    expect(helperTemplate).toContain("$componentEnvOverrides");
    expect(helperTemplate).toContain("hasKey $componentEnvOverrides .name");

    // #4765: livenessPath (falling back to healthPath) is the sole source of
    // truth for which path liveness probes, decoupled from startupPath (which
    // now only controls whether a startup probe exists at all). Readiness
    // always uses healthPath, unconditionally, and no longer shares a `path:`
    // expression with liveness (pre-#4765 both used $component.startupPath).
    expect(helperTemplate).toContain("path: {{ default $component.healthPath $component.livenessPath | quote }}");
    expect(helperTemplate).toContain("path: {{ $component.healthPath | quote }}");
    expect(helperTemplate).toContain("path: {{ $component.startupPath | quote }}");
    const pathExpressionLines = helperTemplate.split("\n").filter((line) => line.includes("path: {{"));
    // readinessProbe (healthPath), startupProbe (startupPath), livenessProbe
    // (default-fallback expression) -- exactly one `path:` line each, no
    // duplicate/coupled path expressions.
    expect(pathExpressionLines).toHaveLength(3);
  });

  it("relaxes the platform-api readiness probe timeout while keeping it strict enough to eject a broken pod (#4768)", () => {
    const baselineApi = buildPlatformHelmValues({ repoRoot }).components["platform-api"];
    const stagingApi = buildPlatformHelmStagingValues().components["platform-api"];

    // Readiness stays on the DB-aware /health/ready path (traffic gating
    // unchanged) but gets a realistic per-probe budget: 3s timeout so pool
    // contention under battery load no longer flaps the pod out of endpoints,
    // with period 10s x failureThreshold 3 = a genuinely-down DB still goes
    // NotReady within ~30s.
    expect(baselineApi.healthPath).toBe("/health/ready");
    expect(baselineApi.readinessProbe).toEqual({
      timeoutSeconds: 3,
      periodSeconds: 10,
      failureThreshold: 3,
    });

    // Base-chart default (like the #4766 liveness fix), so preview and
    // production inherit it too; the staging overlay stays scoped to replicas
    // and resources and never re-specifies the probe.
    expect(stagingApi.readinessProbe).toBeUndefined();
    const merged = { ...baselineApi, ...stagingApi };
    expect(merged.readinessProbe).toEqual({
      timeoutSeconds: 3,
      periodSeconds: 10,
      failureThreshold: 3,
    });

    // Liveness is deliberately untouched (correct on /health/live per #4766).
    expect(baselineApi.livenessPath).toBe("/health/live");
    expect(baselineApi.livenessProbe).toEqual({
      periodSeconds: 10,
      timeoutSeconds: 5,
      failureThreshold: 6,
    });

    // Scoped to platform-api: the worker's readiness only gates its rollout,
    // and other components keep the Kubernetes default readiness timing.
    const values = buildPlatformHelmValues({ repoRoot });
    for (const name of ["platform-worker", "admin-web", "marketplace", "public-web", "platform-bootstrap"]) {
      expect(
        values.components[name].readinessProbe,
        `${name} should not get a readinessProbe override`,
      ).toBeUndefined();
    }
  });

  it("renders the platform-api readiness probe timing override in the deployment template (#4768)", () => {
    const [helperTemplate] = readChartFiles(["templates/_helpers.tpl"]);

    // The readinessProbe timing override is merged in under httpGet via
    // `with $component.readinessProbe`, mirroring the livenessProbe wiring.
    expect(helperTemplate).toContain("with $component.readinessProbe");
    // Still exactly one path expression per probe (readiness/startup/liveness).
    const pathExpressionLines = helperTemplate.split("\n").filter((line) => line.includes("path: {{"));
    expect(pathExpressionLines).toHaveLength(3);
  });

  it("scaffolds Rollouts for public traffic owners and keeps them disabled by default", () => {
    const values = buildPlatformHelmValues({ repoRoot });

    expect(values.components["public-web"].rollout).toMatchObject({
      enabled: false,
      canary: {
        canaryServiceSuffix: "canary",
        trafficRouting: {
          nginx: {
            enabled: false,
          },
        },
        weights: [10, 25, 50, 100],
        pauseAfterWeight: 10,
      },
      analysis: { path: "/health/ready", count: 5, failureLimit: 2 },
    });
    expect(values.components.marketplace.rollout).toEqual(values.components["public-web"].rollout);
    expect(values.components["platform-api"].rollout).toEqual(values.components["public-web"].rollout);

    expect(values.components["admin-web"].rollout).toBeUndefined();
    expect(values.components["platform-worker"].rollout).toBeUndefined();
    expect(values.components["platform-bootstrap"].rollout).toBeUndefined();
  });

  it("keeps Helm env keys and counts aligned with DigitalOcean component env", () => {
    const terraformComponents = extractDigitalOceanPlatformComponents(sources);
    const values = buildPlatformHelmValues({ repoRoot });

    for (const terraformComponent of terraformComponents) {
      expect(componentEnvKeys(values.components[terraformComponent.name])).toEqual(
        expectedHelmEnvKeys(terraformComponent),
      );
    }

    expect(
      Object.fromEntries(Object.entries(values.components).map(([name, component]) => [name, component.env.length])),
    ).toEqual({
      "admin-web": 5,
      marketplace: 13,
      "platform-api": 89,
      "platform-bootstrap": 53,
      "platform-worker": 117,
      "public-web": 12,
    });
    expect(componentEnvKeys(values.components["platform-api"])).toContain("CHASE_SETS_RATE_LIMIT_AUTH_REGISTER_IP_MAX");
    expect(componentEnvKeys(values.components["platform-api"])).toContain("DATABASE_URL_COMMERCIAL_TERMS");
    expect(componentEnvKeys(values.components["platform-api"])).toContain("DATABASE_URL_INVENTORY_WAITER");
    expect(componentEnvKeys(values.components["platform-worker"])).toContain(
      "WORKER_LISTENER_DATABASE_URL_PUBLIC_PRESENCE",
    );
    expect(
      values.components["platform-worker"].env.find((entry) => entry.name === "NOTIFICATION_EMAIL_PROVIDER"),
    ).toMatchObject({ value: "noop" });
  });

  it("keeps live deploy wiring out of the scaffold", () => {
    const chartFiles = [
      "templates/_helpers.tpl",
      "templates/analysis-template.yaml",
      "templates/deployment.yaml",
      "templates/ingress.yaml",
      "templates/job.yaml",
      "templates/preview-postgres.yaml",
      "templates/rbac.yaml",
      "templates/rollout.yaml",
      "templates/service.yaml",
      "templates/serviceaccount.yaml",
      "templates/scaledobject.yaml",
    ];
    const chartText = `${readFileSync(path.join(repoRoot, chartValuesRelativePath), "utf8")}\n${readChartFiles(
      chartFiles,
    ).join("\n")}`;
    const values = buildPlatformHelmValues({ repoRoot });
    const rolloutStates = Object.values(values.components)
      .map((component) => component.rollout?.enabled)
      .filter((enabled) => enabled != null);

    expect(chartText).not.toMatch(/^kind: Secret$/m);
    expect(readFileSync(path.join(repoRoot, chartValuesRelativePath), "utf8")).toContain("doksIngress:");
    expect(chartText).toContain(".Values.doksIngress");
    expect(chartText).not.toContain("ExternalSecret");
    expect(chartText).not.toContain("SecretProviderClass");
    expect(rolloutStates).toEqual([false, false, false]);
    expect(chartText).toContain("helm.sh/hook");
    expect(chartText).toContain("activeDeadlineSeconds");
    expect(chartText).toContain("bootstrap-quiesce.mjs");
    expect(chartText).toContain("deployments/scale");
    expect(chartText).toContain("global.imagePullSecrets");
    expect(chartText).toContain("imagePullSecrets:");
    expect(chartText).toContain("global.envOverrides");
    expect(chartText).toContain("hasKey $envOverrides .name");
    expect(chartText).toContain("previewPostgres:");
    expect(chartText).toContain("preview-postgres");
  });

  it("models proportional Argo Rollouts with isolated nginx routes and readiness analysis", () => {
    const [helperTemplate, analysisTemplate, deploymentTemplate, ingressTemplate, rolloutTemplate, serviceTemplate] =
      readChartFiles([
        "templates/_helpers.tpl",
        "templates/analysis-template.yaml",
        "templates/deployment.yaml",
        "templates/ingress.yaml",
        "templates/rollout.yaml",
        "templates/service.yaml",
      ]);

    expect(deploymentTemplate).toContain("(not $rolloutEnabled)");
    expect(rolloutTemplate).toContain("apiVersion: argoproj.io/v1alpha1");
    expect(rolloutTemplate).toContain("kind: Rollout");
    expect(rolloutTemplate).toContain("stableService:");
    expect(rolloutTemplate).toContain("canaryService:");
    expect(rolloutTemplate).toContain("trafficRouting:");
    expect(rolloutTemplate).toContain("stableIngress:");
    expect(rolloutTemplate).toContain("rollbackWindow:");
    expect(rolloutTemplate).toContain("pauseAfterWeight");
    expect(analysisTemplate).toContain("kind: AnalysisTemplate");
    expect(analysisTemplate).toContain("successCondition: result.ok == true");
    expect(analysisTemplate).toContain("canaryServiceName");
    expect(analysisTemplate).toContain("$.Release.Namespace");
    expect(analysisTemplate).toContain("svc.cluster.local");
    expect(ingressTemplate).toContain("rolloutIngressName");
    expect(ingressTemplate).toContain("$basePaths");
    expect(ingressTemplate).toContain("$matchingPaths");
    expect(serviceTemplate).toContain("chase-sets-platform.canaryServiceName");
    expect(serviceTemplate).toContain("chase-sets.com/traffic-role: canary");
    expect(helperTemplate).toContain("chase-sets-platform.canaryServiceName");
  });

  it("models bootstrap as a pre-rollout quiesce hook that restores workers on failure", () => {
    const values = buildPlatformHelmValues({ repoRoot });
    const bootstrap = values.components["platform-bootstrap"];

    expect(bootstrap.job).toMatchObject({
      suspend: false,
      backoffLimit: 0,
      activeDeadlineSeconds: 890,
      hook: {
        enabled: true,
        events: ["pre-install", "pre-upgrade"],
        weight: -20,
        deletePolicy: ["before-hook-creation", "hook-succeeded"],
      },
      quiesce: {
        enabled: true,
        targetComponents: ["platform-worker"],
        timeoutSeconds: 45,
        commandTimeoutSeconds: 780,
        pollIntervalMs: 2000,
        restoreOnFailure: true,
        ignoreMissingDeployments: true,
      },
    });
  });
});
