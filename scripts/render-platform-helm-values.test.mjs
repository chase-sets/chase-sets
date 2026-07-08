import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeTopologyBaselines } from "./digitalocean-runtime-topology.mjs";
import {
  buildDoksIngressValues,
  buildPlatformHelmValues,
  buildPlatformHelmStagingValues,
  chartValuesRelativePath,
  doksStagingWorkerEnvOverrides,
  extractDigitalOceanPlatformComponents,
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

function expectedHelmEnvKeys(terraformComponent) {
  const keys = componentEnvKeys(terraformComponent);
  if (terraformComponent.name === "platform-bootstrap") {
    return keys.filter((key) => key !== "PLATFORM_BOOTSTRAP_OWNER");
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

    expect(envValue("DATABASE_POOL_MAX")).toBe("9");
    expect(envValue("WORKER_WAKE_MAX_CONCURRENT_RUNNERS")).toBe("3");
    expect(envValue("WORKER_WAKE_STANDARD_LANE_RUNNER_COUNT")).toBe("2");
    expect(totalRunnerConcurrency).toBe(9);
    expect(totalRunnerConcurrency).toBeLessThanOrEqual(Number(envValue("DATABASE_POOL_MAX")));
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

  it("wires the worker startup/liveness/readiness probes in the deployment template", () => {
    const [helperTemplate] = readChartFiles(["templates/_helpers.tpl"]);

    expect(helperTemplate).toContain("readinessProbe:");
    expect(helperTemplate).toContain("startupProbe:");
    expect(helperTemplate).toContain("livenessProbe:");
    expect(helperTemplate).toContain("if $component.startupPath");
    expect(helperTemplate).toContain("failureThreshold: 30");
    expect(helperTemplate).toContain("$componentEnvOverrides");
    expect(helperTemplate).toContain("hasKey $componentEnvOverrides .name");
  });

  it("scaffolds Rollouts only for public buyer web components and keeps them disabled by default", () => {
    const values = buildPlatformHelmValues({ repoRoot });

    expect(values.components["public-web"].rollout).toMatchObject({
      enabled: false,
      canary: {
        canaryServiceSuffix: "canary",
        trafficRouting: {
          nginx: {
            enabled: false,
            stableIngress: "",
          },
        },
        steps: [{ setWeight: 10 }, { pause: {} }],
      },
    });
    expect(values.components.marketplace.rollout).toEqual(values.components["public-web"].rollout);

    expect(values.components["admin-web"].rollout).toBeUndefined();
    expect(values.components["platform-api"].rollout).toBeUndefined();
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
      "platform-api": 82,
      "platform-bootstrap": 51,
      "platform-worker": 112,
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
      "templates/certificate.yaml",
      "templates/deployment.yaml",
      "templates/ingress.yaml",
      "templates/job.yaml",
      "templates/rbac.yaml",
      "templates/rollout.yaml",
      "templates/service.yaml",
      "templates/serviceaccount.yaml",
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
    expect(chartText).toContain("kind: Certificate");
    expect(chartText).not.toContain("ExternalSecret");
    expect(chartText).not.toContain("SecretProviderClass");
    expect(rolloutStates).toEqual([false, false]);
    expect(chartText).toContain("helm.sh/hook");
    expect(chartText).toContain("activeDeadlineSeconds");
    expect(chartText).toContain("bootstrap-quiesce.mjs");
    expect(chartText).toContain("deployments/scale");
    expect(chartText).toContain("global.imagePullSecrets");
    expect(chartText).toContain("imagePullSecrets:");
    expect(chartText).toContain("global.envOverrides");
    expect(chartText).toContain("hasKey $envOverrides .name");
  });

  it("models the opt-in Argo Rollout contract for public-web and marketplace", () => {
    const [helperTemplate, deploymentTemplate, rolloutTemplate, serviceTemplate] = readChartFiles([
      "templates/_helpers.tpl",
      "templates/deployment.yaml",
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
