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
  buildPlatformHelmValues,
  publicApp,
} from "./render-platform-helm-values.mjs";
import {
  buildDeploymentEvidence,
  buildHelmUpgradeArgs,
  deployPlatformToKubernetes,
  platformKubernetesWorkloads,
  recordDeployedCortenPublicImage,
} from "./platform-kubernetes-deployment.mjs";

const read = (file) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const workflowText = read(".github/workflows/platform-production.yml");
const workflow = parse(workflowText);
const digest = "sha256:" + "a".repeat(64);
const image = `registry.digitalocean.com/chase-sets/chase-sets-corten-public@${digest}`;
const adminImage = image.replace("corten-public", "corten-admin");
const marketplaceImage = image.replace("corten-public", "corten-marketplace");
const proxies = "10.244.0.0/25,10.244.1.0/25";
const production = (env = {}, overrides = {}) => ({
  image: `registry.digitalocean.com/chase-sets/chase-sets-platform:release@${digest}`,
  cortenPublicImage: image,
  // admin-corten and marketplace-corten serve admin.chasesets.com and marketplace.chasesets.com, so every production
  // deploy carries their staged images.
  cortenAdminImage: adminImage,
  cortenMarketplaceImage: marketplaceImage,
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
// A variable left behind after public-web was retired, until it is deleted from the environment.
const leftover = { PRODUCTION_PUBLIC_APP: "public-web" };
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
const webWorkload = "chase-sets-platform-chase-sets-platform-public-web";

describe("production public app", () => {
  it("serves chasesets.com and www.chasesets.com from public-corten with the staged image, whatever a leftover variable says", () => {
    expect(publicApp).toBe("public-corten");
    for (const env of [{}, leftover, { PRODUCTION_PUBLIC_APP: "not-an-app" }]) {
      const args = buildHelmUpgradeArgs(production(env));
      expect(pilotArgs(args)).toEqual([`components.public-corten.image=${image}`]);
      expect(args[args.indexOf(`components.public-corten.image=${image}`) - 1]).toBe("--set-string");
      expect(hostRoot(args, "chasesets.com")).toBe("public-corten");
      expect(hostRoot(args, "www.chasesets.com")).toBe("public-corten");
      // The marketplace and admin hosts stay with the Corten marketplace and admin.
      expect(hostRoot(args, "marketplace.chasesets.com")).toBe("marketplace-corten");
      expect(hostRoot(args, "admin.chasesets.com")).toBe("admin-corten");
      expect(args).toContain(`global.envOverrides.PROXIES=${proxies.replace(",", "\\,")}`);
    }
    // /api and the other platform paths stay on platform-api on both public hosts.
    const ingress = buildDoksIngressValues({ environment: "production", env: production().env });
    for (const name of ["chasesets.com", "www.chasesets.com"]) {
      const paths = ingress.hosts.find(({ host }) => host === name).paths;
      expect(paths.find(({ path }) => path === "/api").service).toBe("platform-api");
      expect(paths.filter(({ service }) => service === "public-corten").map(({ path }) => path)).toEqual(["/"]);
    }
    const { deployments } = platformKubernetesWorkloads(production());
    expect(deployments).toContain(pilotWorkload);
    expect(deployments).not.toContain(webWorkload);
    // The certificate covers the same names as before: no new host or DNS record.
    const names = (env) =>
      buildDoksIngressValues({ environment: "production", env: production(env).env }).tls.certificate.dnsNames;
    expect(names(leftover)).toEqual(names({}));
  });

  it("no longer deploys public-web in production", () => {
    // The base values carry no public-web component, so production has nothing to disable.
    expect(buildPlatformHelmValues().components).not.toHaveProperty("public-web");
    expect(buildPlatformHelmProductionValues().components).not.toHaveProperty("public-web");
    for (const file of ["values.yaml", "values.production.yaml"]) {
      expect(read(`infrastructure/helm/platform/${file}`)).not.toMatch(/\n {2}public-web:\n/);
    }
    const routes = JSON.stringify(
      buildDoksIngressValues({ environment: "production", env: production().env }).hosts.flatMap(({ paths }) => paths),
    );
    expect(routes).not.toContain('"service":"public-web"');
  });

  it("refuses before Helm, saying how to recover, when there is no staged image", () => {
    for (const env of [{}, leftover]) {
      const refusal = () => buildHelmUpgradeArgs(production(env, { cortenPublicImage: undefined }));
      expect(refusal).toThrow(
        "corten-public-image is required on production: public-corten serves chasesets.com and www.chasesets.com",
      );
      expect(refusal).toThrow("No production change was made, and production keeps serving the last release.");
      expect(refusal).toThrow("To recover, fix the Corten public image build and deploy again");
    }
  });

  it("refuses before Helm, saying how to recover, when there is no PROXIES", () => {
    const envOverrides = { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false" };
    const refusal = () => buildHelmUpgradeArgs(production({}, { envOverrides }));
    // The admin's refusal is raised first; it names the same fix, the ingress pod CIDR discovery.
    expect(refusal).toThrow("PROXIES is required on production: the ingress pod CIDRs could not be read");
    expect(refusal).toThrow("No production change was made, and production keeps serving the last release.");
    expect(refusal).toThrow("To recover, fix the ingress pod CIDR discovery and deploy again");
  });

  it("serves the admin and the marketplace from their Corten apps beside the public app", () => {
    const args = buildHelmUpgradeArgs(production());
    expect(args).toContain(`components.admin-corten.image=${adminImage}`);
    expect(args).toContain(`components.marketplace-corten.image=${marketplaceImage}`);
  });

  it("waits for public-corten on every production deploy and warns about nothing public", async () => {
    const calls = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await deployPlatformToKubernetes({
        ...production(leftover, {
          release: "chase-sets-platform",
          namespace: "chase-sets-platform",
          timeout: "30s",
          rolloutsEnabled: false,
        }),
        spawn: (command, args) => {
          calls.push({ command, args });
          const child = new EventEmitter();
          child.stdin = { end: () => {} };
          queueMicrotask(() => child.emit("close", 0));
          return child;
        },
      });
      const waited = calls.filter(({ command }) => command === "kubectl").map(({ args }) => args.join(" "));
      expect(waited.some((args) => args.includes("platform-api"))).toBe(true);
      expect(waited.filter((args) => args.includes(pilotWorkload))).toHaveLength(1);
      expect(waited.filter((args) => args.includes(`/${webWorkload} `))).toEqual([]);
      expect(error.mock.calls.flat().filter((message) => String(message).includes("public"))).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it("keeps no public app in the deploy record", () => {
    for (const env of [{}, leftover]) {
      const evidence = buildDeploymentEvidence({ ...production(env), workloads: {} });
      expect(evidence).not.toHaveProperty("productionPublicApp");
      expect(evidence).not.toHaveProperty("stagingPublicApp");
    }
  });

  it("hands production only the image staging deployed, and only from a staging deploy", () => {
    const dir = mkdtempSync(join(tmpdir(), "staged-corten-public-"));
    try {
      const githubOutputPath = join(dir, "staging.txt");
      const staging = {
        cortenPublicImage: image,
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
        env: { STAGING_PUBLIC_APP: "public-web" },
        githubOutputPath,
      };
      // A leftover STAGING_PUBLIC_APP no longer withholds the handoff.
      expect(recordDeployedCortenPublicImage(staging)).toBe(image);
      expect(read(githubOutputPath)).toBe(`corten_public_image=${image}\n`);
      expect(
        recordDeployedCortenPublicImage(production()),
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
      // The same as the production global override, so crawlers see the public site indexed.
      CHASE_SETS_PUBLIC_INDEXING: "true",
      CHASE_SETS_M86_DEVELOPER_PORTAL_READY: "false",
    });
    expect(values.global.envOverrides.CHASE_SETS_PUBLIC_INDEXING).toBe(env.CHASE_SETS_PUBLIC_INDEXING);
    expect(JSON.stringify(component)).not.toContain("staging");
    // The same variables and secrets as the staging app, so production adds no new secret.
    expect(component.env.map(({ name }) => name)).toEqual(stagingComponent.env.map(({ name }) => name));
    expect(component.env.filter(({ secret }) => secret)).toEqual(stagingComponent.env.filter(({ secret }) => secret));
    expect(read("infrastructure/helm/platform/values.production.yaml")).toContain("  public-corten:\n");
  });
});

describe("Deploy Production wiring for the Corten public app", () => {
  const job = workflow.jobs["deploy-production"];
  const deploy = job.steps.find(({ id }) => id === "production_kubernetes_deploy");

  it("keeps Deploy Production's needs and if exactly as they were", () => {
    expect(job.needs).toEqual(["resolve-release", "deploy-staging"]);
    expect(job.if).toBe("needs.deploy-staging.outputs.deployed == 'true'");
  });

  it("reads no public app variable and takes the image from Deploy Staging", () => {
    expect(job.environment).toBe("production");
    expect(job.env).not.toHaveProperty("PRODUCTION_PUBLIC_APP");
    expect(job.outputs).not.toHaveProperty("public_app");
    expect(workflow.jobs["deploy-staging"].env).not.toHaveProperty("STAGING_PUBLIC_APP");
    expect(workflow.jobs["deploy-staging"].outputs).not.toHaveProperty("public_app");
    expect(workflowText).not.toMatch(/PUBLIC_APP|public_app/);
    expect(workflow.jobs["deploy-staging"].outputs.corten_public_image).toBe(
      "${{ steps.staging_kubernetes_deploy.outputs.corten_public_image }}",
    );
    expect(deploy.env.CORTEN_PUBLIC_IMAGE).toBe("${{ needs.deploy-staging.outputs.corten_public_image }}");
    expect(deploy.run).toContain(
      'if [ -n "${CORTEN_PUBLIC_IMAGE:-}" ]; then\n  corten_image_args+=(--corten-public-image "$CORTEN_PUBLIC_IMAGE")\nfi',
    );
  });

  it("smokes and probes the public hosts", () => {
    const steps = Object.fromEntries(job.steps.map((step) => [step.name, String(step.run ?? "")]));
    // The live-host wait, the canary and the Smoke check read the apex (and www) root.
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

  it("writes the refusals, their recoveries and rollback by earlier release into the runbook", () => {
    const runbook = read("docs/runbooks/production-public-app.md");
    for (const line of [
      "public-corten serves chasesets.com and www.chasesets.com on every production deploy.",
      "To roll back, deploy an earlier release_ref.",
      '"corten-public-image is required on production"',
      '"PROXIES is required on production"',
      "robots.txt",
    ]) {
      expect(runbook).toContain(line);
    }
    expect(runbook).not.toContain("gh variable set PRODUCTION_PUBLIC_APP");
    expect(read("docs/README.md")).toContain("(./runbooks/production-public-app.md)");
  });
});
