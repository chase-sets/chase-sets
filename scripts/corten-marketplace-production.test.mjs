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
  marketplaceApp,
} from "./render-platform-helm-values.mjs";
import {
  buildDeploymentEvidence,
  buildHelmUpgradeArgs,
  deployPlatformToKubernetes,
  platformKubernetesWorkloads,
  recordDeployedCortenMarketplaceImage,
  withheldCortenPilots,
} from "./platform-kubernetes-deployment.mjs";

const read = (file) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const workflowText = read(".github/workflows/platform-production.yml");
const workflow = parse(workflowText);
const digest = "sha256:" + "a".repeat(64);
const image = `registry.digitalocean.com/chase-sets/chase-sets-corten-marketplace@${digest}`;
const proxies = "10.244.0.0/25,10.244.1.0/25";
const production = (env = {}, overrides = {}) => ({
  image: `registry.digitalocean.com/chase-sets/chase-sets-platform:release@${digest}`,
  cortenMarketplaceImage: image,
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
// A variable left behind after the switch, until it is deleted from the environment.
const leftover = { PRODUCTION_MARKETPLACE_APP: "marketplace" };
const pilotArgs = (args) => args.filter((arg) => String(arg).startsWith("components.marketplace-corten."));
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
const pilotWorkload = "chase-sets-platform-chase-sets-platform-marketplace-corten";
const webWorkload = "chase-sets-platform-chase-sets-platform-marketplace";

describe("production marketplace app", () => {
  it("serves marketplace.chasesets.com from marketplace-corten with the staged image, whatever a leftover variable says", () => {
    expect(marketplaceApp).toBe("marketplace-corten");
    for (const env of [{}, leftover]) {
      const args = buildHelmUpgradeArgs(production(env));
      expect(pilotArgs(args)).toEqual([`components.marketplace-corten.image=${image}`]);
      expect(args[args.indexOf(`components.marketplace-corten.image=${image}`) - 1]).toBe("--set-string");
      expect(hostRoot(args, "marketplace.chasesets.com")).toBe("marketplace-corten");
      // The apex and www stay public-web and admin stays admin-web.
      expect(hostRoot(args, "chasesets.com")).toBe("public-web");
      expect(hostRoot(args, "www.chasesets.com")).toBe("public-web");
      expect(hostRoot(args, "admin.chasesets.com")).toBe("admin-web");
      expect(args).toContain(`global.envOverrides.PROXIES=${proxies.replace(",", "\\,")}`);
      expect(withheldCortenPilots(production(env))).not.toContain("marketplace-corten");
    }
    const { deployments } = platformKubernetesWorkloads(production());
    expect(deployments).toContain(pilotWorkload);
    expect(deployments).not.toContain(webWorkload);
  });

  it("no longer deploys marketplace-web in production", () => {
    expect(buildPlatformHelmProductionValues().components).not.toHaveProperty("marketplace");
    expect(read("infrastructure/helm/platform/values.production.yaml")).not.toMatch(/\n {2}marketplace:\n/);
    const routes = JSON.stringify(
      buildDoksIngressValues({ environment: "production", env: production().env }).hosts.flatMap(({ paths }) => paths),
    );
    expect(routes).not.toContain('"service":"marketplace"');
  });

  it("refuses before Helm, saying how to recover, when there is no staged image", () => {
    for (const env of [{}, leftover]) {
      const refusal = () => buildHelmUpgradeArgs(production(env, { cortenMarketplaceImage: undefined }));
      expect(refusal).toThrow(
        "corten-marketplace-image is required on production: marketplace-corten serves marketplace.chasesets.com",
      );
      expect(refusal).toThrow("No production change was made, and production keeps serving the last release.");
      expect(refusal).toThrow("To recover, fix the Corten marketplace image build and deploy again");
    }
  });

  it("refuses before Helm, saying how to recover, when there is no PROXIES", () => {
    const envOverrides = { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false" };
    const refusal = () => buildHelmUpgradeArgs(production({}, { envOverrides }));
    expect(refusal).toThrow("PROXIES is required on production: the ingress pod CIDRs could not be read");
    expect(refusal).toThrow("No production change was made, and production keeps serving the last release.");
    expect(refusal).toThrow("To recover, fix the ingress pod CIDR discovery and deploy again");
  });

  it("keeps the admin and public pilots' switches independent of the marketplace", () => {
    const admin = image.replace("corten-marketplace", "corten-admin");
    const args = buildHelmUpgradeArgs(
      production({ PRODUCTION_ADMIN_APP: "admin-corten" }, { cortenAdminImage: admin }),
    );
    expect(args).toContain(`components.admin-corten.image=${admin}`);
    expect(args).toContain(`components.marketplace-corten.image=${image}`);
    expect(withheldCortenPilots(production())).toEqual(["admin-corten", "public-corten"]);
    // The public pilot stays withheld while public-web serves the apex and www, image or not.
    const publicImage = image.replace("corten-marketplace", "corten-public");
    expect(
      buildHelmUpgradeArgs(production({}, { cortenPublicImage: publicImage })).filter((arg) =>
        String(arg).startsWith("components.public-corten."),
      ),
    ).toEqual(["components.public-corten.enabled=false"]);
  });

  it("waits for marketplace-corten on every production deploy and warns about nothing marketplace", async () => {
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
      expect(waited.filter((args) => args.includes(pilotWorkload))).toHaveLength(1);
      expect(waited.filter((args) => args.includes(`/${webWorkload} `))).toEqual([]);
      expect(error.mock.calls.flat().filter((message) => String(message).includes("marketplace"))).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it("keeps no marketplace app in the deploy record", () => {
    for (const DEPLOYMENT_ENVIRONMENT of ["staging", "production"]) {
      const evidence = buildDeploymentEvidence({
        ...production(leftover),
        envOverrides: { ...production().envOverrides, DEPLOYMENT_ENVIRONMENT },
        workloads: {},
      });
      expect(evidence).not.toHaveProperty("productionMarketplaceApp");
      expect(evidence).not.toHaveProperty("stagingMarketplaceApp");
    }
  });

  it("hands production the image every staging deploy deployed, and never writes it from production", () => {
    const dir = mkdtempSync(join(tmpdir(), "staged-corten-marketplace-"));
    try {
      for (const env of [{}, { STAGING_MARKETPLACE_APP: "marketplace" }]) {
        const githubOutputPath = join(dir, `${Object.keys(env).length}.txt`);
        const written = recordDeployedCortenMarketplaceImage({
          cortenMarketplaceImage: image,
          envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
          env,
          githubOutputPath,
        });
        expect(written).toBe(image);
        expect(read(githubOutputPath)).toBe(`corten_marketplace_image=${image}\n`);
      }
      expect(
        recordDeployedCortenMarketplaceImage(production()),
        "a production deploy never writes the staging output",
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("declares the production runtime contract on marketplace.chasesets.com as staging does, with production values", () => {
    const component = buildPlatformHelmProductionValues().components["marketplace-corten"];
    const stagingComponent = buildPlatformHelmStagingValues().components["marketplace-corten"];
    expect(component).toMatchObject({
      enabled: true,
      kind: "service",
      replicas: 1,
      image: "",
      port: 8080,
      healthPath: "/health/ready",
      livenessPath: "/health/live",
      command: "exec /usr/local/bin/corten-pilot-marketplace",
    });
    const env = Object.fromEntries(component.env.map(({ name, value }) => [name, value]));
    expect(env).toMatchObject({
      HOSTS: "marketplace.chasesets.com",
      PUBLIC_PROTO: "https",
      PROXIES: "",
      NODE_ENV: "production",
      DEPLOYMENT_ENVIRONMENT: "production",
      MARKETPLACE_WEB_ORIGIN: "https://marketplace.chasesets.com",
      // The same as marketplace-web's production value, so both answer crawlers alike.
      CHASE_SETS_MARKETPLACE_INDEXING: "false",
      OTEL_SERVICE_NAME: "marketplace-corten",
    });
    expect(JSON.stringify(component)).not.toContain("staging");
    // The same variables and secrets as the staging pilot, so production adds no new secret.
    expect(component.env.map(({ name }) => name)).toEqual(stagingComponent.env.map(({ name }) => name));
    expect(component.env.filter(({ secret }) => secret)).toEqual(stagingComponent.env.filter(({ secret }) => secret));
    expect(read("infrastructure/helm/platform/values.production.yaml")).toContain("  marketplace-corten:\n");
  });
});

describe("Deploy Production wiring for the marketplace", () => {
  const job = workflow.jobs["deploy-production"];
  const deploy = job.steps.find(({ id }) => id === "production_kubernetes_deploy");

  it("keeps Deploy Production's needs and if exactly as they were", () => {
    expect(job.needs).toEqual(["resolve-release", "deploy-staging"]);
    expect(job.if).toBe("needs.deploy-staging.outputs.deployed == 'true'");
  });

  it("reads no marketplace app variable and takes the image from Deploy Staging", () => {
    expect(workflowText).not.toMatch(/(STAGING|PRODUCTION)_MARKETPLACE_APP/);
    expect(job.outputs).not.toHaveProperty("marketplace_app");
    expect(workflow.jobs["deploy-staging"].outputs.corten_marketplace_image).toBe(
      "${{ steps.staging_kubernetes_deploy.outputs.corten_marketplace_image }}",
    );
    expect(deploy.env.CORTEN_MARKETPLACE_IMAGE).toBe("${{ needs.deploy-staging.outputs.corten_marketplace_image }}");
    expect(deploy.run).toContain(
      'if [ -n "${CORTEN_MARKETPLACE_IMAGE:-}" ]; then\n  corten_image_args+=(--corten-marketplace-image "$CORTEN_MARKETPLACE_IMAGE")\nfi',
    );
  });

  it("smokes marketplace.chasesets.com signed in whenever production serves a marketplace", () => {
    const smoke = job.steps.find(({ name }) => name === "Smoke check");
    expect(smoke.env).toMatchObject({
      SMOKE_REQUIRE_ADMIN: "true",
      PLATFORM_ADMIN_EMAIL: "${{ secrets.PLATFORM_ADMIN_EMAIL }}",
      PLATFORM_ADMIN_PASSWORD: "${{ secrets.PLATFORM_ADMIN_PASSWORD }}",
    });
    expect(smoke.env).not.toHaveProperty("MARKETPLACE_APP");
    expect(smoke.env).not.toHaveProperty("SMOKE_REQUIRE_MARKETPLACE_SIGNED_IN");
    expect(smoke.run).toMatch(
      /if \[ -n "\$marketplace_domain" \]; then\n[\s\S]*?smoke_urls\+=\("https:\/\/\$\{marketplace_domain\}"\)\n[\s\S]*?export SMOKE_REQUIRE_MARKETPLACE_SIGNED_IN="true"\nelse\n/,
    );
  });

  it("probes only paths the Corten marketplace answers", () => {
    const steps = Object.fromEntries(job.steps.map((step) => [step.name, String(step.run ?? "")]));
    // The ingress wait reads /health/ready; the canary and domain waits read the root.
    expect(steps["Verify production DOKS live hosts and certificate"]).toContain(
      'live_urls+=(--url "https://${marketplace_domain}/health/ready")',
    );
    expect(steps["Stage 1 production canary"]).toContain('canary_urls+=("https://${marketplace_domain}")');
    // The served-marketplace gate reads the root's robots tag, the registration API and the invitation route;
    // the pilot renders the tag while CHASE_SETS_MARKETPLACE_INDEXING is off and passes the API through.
    expect(steps["Smoke served marketplace invitation gate"]).toContain('content="noindex,nofollow"');
    // The marketplace host's root answers no bare /health: no production step reads one.
    for (const run of Object.values(steps)) expect(run).not.toMatch(/marketplace_domain\}\/health(["' ]|$)/m);
    expect(read("scripts/platform-smoke.mjs")).toContain("`${origin}/api/health/ready`");
    expect(read("scripts/stripe-money-smoke-test.mjs")).toContain("/api/health");
  });

  it("writes the rollback and both refusal recoveries into the runbook", () => {
    const runbook = read("docs/runbooks/production-marketplace-app.md");
    for (const line of [
      "Rollback is reverting to an earlier release",
      "There is no switch back to marketplace-web.",
      "The response is to fix forward on staging, not to retry production.",
      '"corten-marketplace-image is required on production"',
      '"PROXIES is required on production"',
    ]) {
      expect(runbook).toContain(line);
    }
    expect(runbook).not.toContain("gh variable");
    expect(read("docs/README.md")).toContain("(./runbooks/production-marketplace-app.md)");
  });
});
