import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  buildDoksIngressValues,
  buildPlatformHelmProductionValues,
  buildPlatformHelmStagingValues,
  resolveProductionPublicApp,
  resolvePublicApp,
} from "./render-platform-helm-values.mjs";
import {
  buildDeploymentEvidence,
  buildHelmUpgradeArgs,
  deployPlatformToKubernetes,
  platformKubernetesWorkloads,
  recordDeployedCortenPublicImage,
  recordPublicApp,
  withheldCortenPilots,
} from "./platform-kubernetes-deployment.mjs";

const read = (file) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const workflowText = read(".github/workflows/platform-production.yml");
const workflow = parse(workflowText);
const digest = "sha256:" + "a".repeat(64);
const image = `registry.digitalocean.com/chase-sets/chase-sets-corten-public@${digest}`;
const proxies = "10.244.0.0/25,10.244.1.0/25";
const production = (env = {}, overrides = {}) => ({
  image: `registry.digitalocean.com/chase-sets/chase-sets-platform:release@${digest}`,
  cortenPublicImage: image,
  // admin-corten and marketplace-corten serve admin.chasesets.com and marketplace.chasesets.com, so every production
  // deploy carries their staged images.
  cortenAdminImage: image.replace("corten-public", "corten-admin"),
  cortenMarketplaceImage: image.replace("corten-public", "corten-marketplace"),
  envOverrides: { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false", PROXIES: proxies },
  env: {
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    PRODUCTION_DOKS_INGRESS_TARGET: "192.0.2.1",
    PRODUCTION_MARKETPLACE_SERVED: "true",
    ...env,
  },
  managedPostgresCaSha256: "b".repeat(64),
  ...overrides,
});
const publicCorten = { PRODUCTION_PUBLIC_APP: "public-corten" };
const pilotArgs = (args) => args.filter((arg) => String(arg).startsWith("components.public-corten."));
const hostRoot = (args, name) => {
  const hostArg = args.find(
    (arg) => String(arg).startsWith("doksIngress.hosts[") && String(arg).endsWith(`].host=${name}`),
  );
  if (!hostArg) return null;
  const host = hostArg.slice("doksIngress.hosts[".length, hostArg.indexOf("]"));
  return args
    .filter((arg) => arg.startsWith(`doksIngress.hosts[${host}].paths[`) && arg.includes(".service="))
    .at(-1)
    .split("=")[1];
};
const pilotWorkload = "chase-sets-platform-chase-sets-platform-public-corten";

describe("production public app switch", () => {
  it("defaults to public-web, takes public-corten only by name, and refuses anything else", () => {
    expect(resolveProductionPublicApp({})).toEqual({ app: "public-web", source: "default" });
    expect(resolveProductionPublicApp({ PRODUCTION_PUBLIC_APP: " public-corten " })).toEqual({
      app: "public-corten",
      source: "variable",
    });
    expect(resolvePublicApp({}, "production").variable).toBe("PRODUCTION_PUBLIC_APP");
    expect(resolvePublicApp({}, "staging").variable).toBe("STAGING_PUBLIC_APP");
    expect(resolvePublicApp({}, "preview")).toBeNull();
    // The staging variable never moves production.
    expect(resolveProductionPublicApp({ STAGING_PUBLIC_APP: "public-corten" }).app).toBe("public-web");
    for (const value of ["public", "PUBLIC-CORTEN", "public-web,public-corten"]) {
      expect(() => buildHelmUpgradeArgs(production({ PRODUCTION_PUBLIC_APP: value }))).toThrow(
        "PRODUCTION_PUBLIC_APP must be one of",
      );
    }
  });

  it("does not deploy public-corten while public-web serves the apex and www, with or without an image or PROXIES", () => {
    for (const overrides of [{}, { cortenPublicImage: undefined }]) {
      for (const env of [{}, { PRODUCTION_PUBLIC_APP: "public-web" }]) {
        const args = buildHelmUpgradeArgs(production(env, overrides));
        expect(pilotArgs(args)).toEqual(["components.public-corten.enabled=false"]);
        expect(args[args.indexOf("components.public-corten.enabled=false") - 1]).toBe("--set");
        expect(hostRoot(args, "chasesets.com")).toBe("public-web");
        expect(hostRoot(args, "www.chasesets.com")).toBe("public-web");
        expect(withheldCortenPilots(production(env))).toContain("public-corten");
      }
    }
    const withoutProxies = production(
      {},
      { envOverrides: { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false" } },
    );
    // Without PROXIES the deploy refuses for the Corten admin, which always serves its host and is checked first,
    // not for the withheld public pilot.
    expect(() => buildHelmUpgradeArgs(withoutProxies)).toThrow(
      "PROXIES is required on production: the ingress pod CIDRs could not be read, and the Corten admin",
    );
  });

  it("leaves the default production ingress exactly as it was", () => {
    const hosts = (env) => buildDoksIngressValues({ environment: "production", env: production(env).env }).hosts;
    // public-web keeps both public hosts, and nothing else routes differently, with or without the marketplace host,
    // which the Corten marketplace serves.
    for (const served of ["true", "false"]) {
      const env = { PRODUCTION_MARKETPLACE_SERVED: served };
      const roots = Object.fromEntries(hosts(env).map(({ host, paths }) => [host, paths.at(-1).service]));
      expect(roots).toEqual({
        "chasesets.com": "public-web",
        "www.chasesets.com": "public-web",
        ...(served === "true" ? { "marketplace.chasesets.com": "marketplace-corten" } : {}),
        "admin.chasesets.com": "admin-corten",
      });
      expect(hosts({ ...env, PRODUCTION_PUBLIC_APP: "public-web" })).toEqual(hosts(env));
    }
  });

  it("serves chasesets.com and www.chasesets.com from public-corten with the staged image, and nothing else changes host", () => {
    const args = buildHelmUpgradeArgs(production(publicCorten));
    expect(pilotArgs(args)).toEqual([`components.public-corten.image=${image}`]);
    expect(args[args.indexOf(`components.public-corten.image=${image}`) - 1]).toBe("--set-string");
    expect(hostRoot(args, "chasesets.com")).toBe("public-corten");
    expect(hostRoot(args, "www.chasesets.com")).toBe("public-corten");
    // The marketplace and admin hosts stay with the Corten marketplace and admin.
    expect(hostRoot(args, "marketplace.chasesets.com")).toBe("marketplace-corten");
    expect(hostRoot(args, "admin.chasesets.com")).toBe("admin-corten");
    // /api and the other platform paths stay on platform-api on both public hosts.
    const ingress = buildDoksIngressValues({ environment: "production", env: production(publicCorten).env });
    for (const name of ["chasesets.com", "www.chasesets.com"]) {
      const paths = ingress.hosts.find(({ host }) => host === name).paths;
      expect(paths.find(({ path }) => path === "/api").service).toBe("platform-api");
      expect(paths.filter(({ service }) => service === "public-corten").map(({ path }) => path)).toEqual(["/"]);
    }
    expect(args).toContain(`global.envOverrides.PROXIES=${proxies.replace(",", "\\,")}`);
    expect(withheldCortenPilots(production(publicCorten))).not.toContain("public-corten");
    expect(platformKubernetesWorkloads(production(publicCorten)).deployments).toContain(pilotWorkload);
    // The certificate covers the same names either way: no new host or DNS record.
    const names = (env) =>
      buildDoksIngressValues({ environment: "production", env: production(env).env }).tls.certificate.dnsNames;
    expect(names(publicCorten)).toEqual(names({}));
  });

  it("refuses before Helm, saying how to recover, when public-corten has no staged image", () => {
    const refusal = () => buildHelmUpgradeArgs(production(publicCorten, { cortenPublicImage: undefined }));
    expect(refusal).toThrow("corten-public-image is required on production while PRODUCTION_PUBLIC_APP=public-corten");
    expect(refusal).toThrow("No production change was made.");
    expect(refusal).toThrow("set PRODUCTION_PUBLIC_APP=public-web (or delete it) in the production environment and");
    expect(refusal).toThrow("return staging to the Corten public app and deploy again");
  });

  it("refuses before Helm when public-corten has no PROXIES, with the marketplace's refusal that comes first", () => {
    const envOverrides = { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false" };
    const refusal = () => buildHelmUpgradeArgs(production(publicCorten, { envOverrides }));
    // marketplace-corten always serves marketplace.chasesets.com and needs PROXIES too, so its refusal is the one
    // raised; it names the same fix, the ingress pod CIDR discovery.
    expect(refusal).toThrow("PROXIES is required on production: the ingress pod CIDRs could not be read");
    expect(refusal).toThrow("No production change was made, and production keeps serving the last release.");
    expect(refusal).toThrow("To recover, fix the ingress pod CIDR discovery and deploy again");
  });

  it("keeps the admin and the marketplace independent of the public switch", () => {
    const admin = image.replace("corten-public", "corten-admin");
    const marketplace = image.replace("corten-public", "corten-marketplace");
    for (const env of [{}, publicCorten]) {
      const args = buildHelmUpgradeArgs(production(env));
      expect(args).toContain(`components.admin-corten.image=${admin}`);
      expect(args).toContain(`components.marketplace-corten.image=${marketplace}`);
    }
    expect(buildHelmUpgradeArgs(production(publicCorten))).toContain(`components.public-corten.image=${image}`);
    expect(withheldCortenPilots(production(publicCorten))).toEqual([]);
    expect(withheldCortenPilots(production())).toEqual(["public-corten"]);
  });

  it("does not wait for public-corten under public-web and waits for it under public-corten", async () => {
    const deploy = async (env) => {
      const calls = [];
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const options = production(env, {
          release: "chase-sets-platform",
          namespace: "chase-sets-platform",
          timeout: "30s",
          rolloutsEnabled: false,
        });
        await deployPlatformToKubernetes({
          ...options,
          spawn: (command, args) => {
            calls.push({ command, args });
            const child = new EventEmitter();
            child.stdin = { end: () => {} };
            queueMicrotask(() => child.emit("close", 0));
            return child;
          },
        });
        return {
          waited: calls.filter(({ command }) => command === "kubectl").map(({ args }) => args.join(" ")),
          warnings: error.mock.calls.flat(),
        };
      } finally {
        error.mockRestore();
      }
    };
    const web = await deploy({});
    expect(web.waited.some((args) => args.includes("platform-api"))).toBe(true);
    expect(web.waited.filter((args) => args.includes(pilotWorkload))).toEqual([]);
    expect(web.warnings).toContain(
      "Warning: public-corten is not deployed because public-web serves chasesets.com and www.chasesets.com (PRODUCTION_PUBLIC_APP=public-web).",
    );
    const corten = await deploy(publicCorten);
    expect(corten.waited.filter((args) => args.includes(pilotWorkload))).toHaveLength(1);
    expect(corten.warnings.filter((message) => message.includes("public-corten"))).toEqual([]);
  });

  it("says which app served the public hosts in the summary, the step output and the deploy record", () => {
    const dir = mkdtempSync(join(tmpdir(), "production-public-app-"));
    try {
      const record = (env, name) => {
        const githubSummaryPath = join(dir, `${name}.md`);
        const githubOutputPath = join(dir, `${name}.txt`);
        const result = recordPublicApp({ env, githubSummaryPath, githubOutputPath }, "production");
        return { result, summary: read(githubSummaryPath), output: read(githubOutputPath) };
      };
      const web = record({}, "web");
      expect(web.result).toEqual({ app: "public-web", source: "default", publicCorten: "not-deployed" });
      expect(web.summary).toBe(
        "### Production public app\n\n" +
          "chasesets.com and www.chasesets.com are served by public-web (PRODUCTION_PUBLIC_APP is unset, so the default applies).\n\n" +
          "public-corten is not deployed while public-web serves chasesets.com and www.chasesets.com.\n\n",
      );
      expect(web.output).toBe("public_app=public-web\npublic_app_source=default\n");
      const corten = record(publicCorten, "corten");
      expect(corten.summary).toBe(
        "### Production public app\n\n" +
          "chasesets.com and www.chasesets.com are served by public-corten (PRODUCTION_PUBLIC_APP=public-corten).\n\n",
      );
      expect(corten.output).toBe("public_app=public-corten\npublic_app_source=variable\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const evidence = (env) => buildDeploymentEvidence({ ...production(env), workloads: {} });
    expect(evidence({}).productionPublicApp).toEqual({
      app: "public-web",
      source: "default",
      publicCorten: "not-deployed",
    });
    expect(evidence(publicCorten).productionPublicApp).toEqual({
      app: "public-corten",
      source: "variable",
      publicCorten: "deployed",
    });
    expect(evidence({})).not.toHaveProperty("stagingPublicApp");
  });

  it("hands production only the image staging deployed, and only when staging deployed it", () => {
    const dir = mkdtempSync(join(tmpdir(), "staged-corten-public-"));
    try {
      const staging = (env, name) => {
        const githubOutputPath = join(dir, `${name}.txt`);
        const options = {
          cortenPublicImage: image,
          envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
          env,
          githubOutputPath,
        };
        const publicApp = recordPublicApp({ ...options, githubOutputPath: undefined }, "staging");
        const written = recordDeployedCortenPublicImage(options, publicApp);
        let output = "";
        try {
          output = read(githubOutputPath);
        } catch {
          output = "";
        }
        return { written, output };
      };
      expect(staging({}, "serving")).toEqual({ written: image, output: `corten_public_image=${image}\n` });
      expect(staging({ STAGING_PUBLIC_APP: "public-web" }, "withheld")).toEqual({ written: null, output: "" });
      expect(
        recordDeployedCortenPublicImage(production(publicCorten), { publicCorten: "deployed" }),
        "a production deploy never writes the staging output",
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declares the production runtime contract on the apex and www as staging does, with production values", () => {
    const values = buildPlatformHelmProductionValues();
    const component = values.components["public-corten"];
    const stagingComponent = buildPlatformHelmStagingValues().components["public-corten"];
    expect(component).toMatchObject({
      enabled: true,
      kind: "service",
      replicas: 1,
      image: "",
      port: 8080,
      healthPath: "/health/ready",
      livenessPath: "/health/live",
      command: "exec /usr/local/bin/corten-pilot-public",
    });
    const env = Object.fromEntries(component.env.map(({ name, value }) => [name, value]));
    expect(env).toMatchObject({
      HOSTS: "chasesets.com,www.chasesets.com",
      PUBLIC_PROTO: "https",
      PROXIES: "",
      NODE_ENV: "production",
      DEPLOYMENT_ENVIRONMENT: "production",
      CHASE_SETS_PUBLIC_ORIGIN: "https://chasesets.com",
      PUBLIC_WEB_ORIGIN: "https://chasesets.com",
      CHASE_SETS_MARKETPLACE_ORIGIN: "https://marketplace.chasesets.com",
      // The same as public-web's production value (the global override), so both answer crawlers alike.
      CHASE_SETS_PUBLIC_INDEXING: "true",
      CHASE_SETS_M86_DEVELOPER_PORTAL_READY: "false",
    });
    expect(values.global.envOverrides.CHASE_SETS_PUBLIC_INDEXING).toBe(env.CHASE_SETS_PUBLIC_INDEXING);
    expect(JSON.stringify(component)).not.toContain("staging");
    // The same variables and secrets as the staging pilot, so production adds no new secret.
    expect(component.env.map(({ name }) => name)).toEqual(stagingComponent.env.map(({ name }) => name));
    expect(component.env.filter(({ secret }) => secret)).toEqual(stagingComponent.env.filter(({ secret }) => secret));
    expect(read("infrastructure/helm/platform/values.production.yaml")).toContain("  public-corten:\n");
  });
});

describe("Deploy Production wiring for the public switch", () => {
  const job = workflow.jobs["deploy-production"];
  const deploy = job.steps.find(({ id }) => id === "production_kubernetes_deploy");

  it("keeps Deploy Production's needs and if exactly as they were", () => {
    expect(job.needs).toEqual(["resolve-release", "deploy-staging"]);
    expect(job.if).toBe("needs.deploy-staging.outputs.deployed == 'true'");
  });

  it("reads PRODUCTION_PUBLIC_APP from the production environment and the image from Deploy Staging", () => {
    expect(job.environment).toBe("production");
    expect(job.env.PRODUCTION_PUBLIC_APP).toBe("${{ vars.PRODUCTION_PUBLIC_APP || '' }}");
    expect(job.outputs.public_app).toBe("${{ steps.production_kubernetes_deploy.outputs.public_app }}");
    expect(workflow.jobs["deploy-staging"].outputs.corten_public_image).toBe(
      "${{ steps.staging_kubernetes_deploy.outputs.corten_public_image }}",
    );
    expect(deploy.env.CORTEN_PUBLIC_IMAGE).toBe("${{ needs.deploy-staging.outputs.corten_public_image }}");
    expect(deploy.run).toContain(
      'if [ -n "${CORTEN_PUBLIC_IMAGE:-}" ]; then\n  corten_image_args+=(--corten-public-image "$CORTEN_PUBLIC_IMAGE")\nfi',
    );
    // Only the deploy script reads the variable, so one resolution decides the ingress and the pilot.
    for (const step of job.steps) expect(String(step.run ?? "")).not.toMatch(/\$\{?PRODUCTION_PUBLIC_APP/);
  });

  it("smokes and probes the public hosts whichever app serves them", () => {
    const steps = Object.fromEntries(job.steps.map((step) => [step.name, String(step.run ?? "")]));
    // The live-host wait, the canary and the Smoke check read the apex (and www) root, which both apps answer.
    expect(steps["Verify production DOKS live hosts and certificate"]).toContain("--url https://chasesets.com/");
    expect(steps["Verify production DOKS live hosts and certificate"]).toContain("--url https://www.chasesets.com/");
    expect(steps["Stage 1 production canary"]).toContain('canary_urls=("https://${public_domain}"');
    expect(steps["Smoke check"]).toContain('smoke_urls=("https://${public_domain}"');
    // The Smoke check's landing smoke walks the derived public routes on the apex, as staging's does on www.staging.
    const platformSmoke = read("scripts/platform-smoke.mjs");
    expect(platformSmoke).toContain('readBooleanEnv("SMOKE_REQUIRE_LANDING", true)');
    expect(platformSmoke).toMatch(/smokePublicWebRoutes\(\{\s*baseUrl: landingUrl,\s*mode: "healthy",/);
    const smoke = job.steps.find(({ name }) => name === "Smoke check");
    expect(smoke.env).not.toHaveProperty("SMOKE_REQUIRE_LANDING");
  });

  it("writes the switch, its gates, the failed-switch response and both recoveries into the runbook", () => {
    const runbook = read("docs/runbooks/production-public-app.md");
    for (const line of [
      "gh variable set PRODUCTION_PUBLIC_APP --repo chase-sets/chase-sets --env production --body public-corten",
      "gh variable delete PRODUCTION_PUBLIC_APP --repo chase-sets/chase-sets --env production",
      "A failed switch shows as a red Deploy Production that rolled back to public-web. The response is to fix forward on staging, not to retry production.",
      '"corten-public-image is required on production"',
      '"PROXIES is required on production"',
      "production already serves admin from the Corten admin and marketplace from the Corten marketplace",
      "admin waitlist",
      "robots.txt",
    ]) {
      expect(runbook).toContain(line);
    }
    expect(read("docs/README.md")).toContain("(./runbooks/production-public-app.md)");
  });
});
