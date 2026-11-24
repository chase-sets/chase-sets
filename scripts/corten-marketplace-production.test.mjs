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
  resolveMarketplaceApp,
  resolveProductionMarketplaceApp,
} from "./render-platform-helm-values.mjs";
import {
  buildDeploymentEvidence,
  buildHelmUpgradeArgs,
  deployPlatformToKubernetes,
  platformKubernetesWorkloads,
  recordDeployedCortenMarketplaceImage,
  recordMarketplaceApp,
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
const marketplaceCorten = { PRODUCTION_MARKETPLACE_APP: "marketplace-corten" };
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

describe("production marketplace app switch", () => {
  it("defaults to marketplace-web, takes marketplace-corten only by name, and refuses anything else", () => {
    expect(resolveProductionMarketplaceApp({})).toEqual({ app: "marketplace", source: "default" });
    expect(resolveProductionMarketplaceApp({ PRODUCTION_MARKETPLACE_APP: " marketplace-corten " })).toEqual({
      app: "marketplace-corten",
      source: "variable",
    });
    expect(resolveMarketplaceApp({}, "production").variable).toBe("PRODUCTION_MARKETPLACE_APP");
    expect(resolveMarketplaceApp({}, "preview")).toBeNull();
    // The staging variable never moves production.
    expect(resolveProductionMarketplaceApp({ STAGING_MARKETPLACE_APP: "marketplace-corten" }).app).toBe("marketplace");
    for (const value of ["marketplace-web", "MARKETPLACE-CORTEN", "marketplace,marketplace-corten"]) {
      expect(() => buildHelmUpgradeArgs(production({ PRODUCTION_MARKETPLACE_APP: value }))).toThrow(
        "PRODUCTION_MARKETPLACE_APP must be one of",
      );
    }
  });

  it("does not deploy marketplace-corten while marketplace-web serves marketplace.chasesets.com, with or without an image or PROXIES", () => {
    for (const overrides of [{}, { cortenMarketplaceImage: undefined }]) {
      for (const env of [{}, { PRODUCTION_MARKETPLACE_APP: "marketplace" }]) {
        const args = buildHelmUpgradeArgs(production(env, overrides));
        expect(pilotArgs(args)).toEqual(["components.marketplace-corten.enabled=false"]);
        expect(args[args.indexOf("components.marketplace-corten.enabled=false") - 1]).toBe("--set");
        expect(hostRoot(args, "marketplace.chasesets.com")).toBe("marketplace");
        expect(withheldCortenPilots(production(env))).toContain("marketplace-corten");
      }
    }
    const withoutProxies = production(
      {},
      { envOverrides: { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false" } },
    );
    expect(pilotArgs(buildHelmUpgradeArgs(withoutProxies))).toEqual(["components.marketplace-corten.enabled=false"]);
  });

  it("serves marketplace.chasesets.com from marketplace-corten with the staged image, and nothing else changes host", () => {
    const args = buildHelmUpgradeArgs(production(marketplaceCorten));
    expect(pilotArgs(args)).toEqual([`components.marketplace-corten.image=${image}`]);
    expect(args[args.indexOf(`components.marketplace-corten.image=${image}`) - 1]).toBe("--set-string");
    expect(hostRoot(args, "marketplace.chasesets.com")).toBe("marketplace-corten");
    // The apex and www stay public-web and admin stays admin-web.
    expect(hostRoot(args, "chasesets.com")).toBe("public-web");
    expect(hostRoot(args, "www.chasesets.com")).toBe("public-web");
    expect(hostRoot(args, "admin.chasesets.com")).toBe("admin-web");
    expect(args).toContain(`global.envOverrides.PROXIES=${proxies.replace(",", "\\,")}`);
    expect(withheldCortenPilots(production(marketplaceCorten))).not.toContain("marketplace-corten");
    expect(platformKubernetesWorkloads(production(marketplaceCorten)).deployments).toContain(pilotWorkload);
    // The certificate covers the same names either way: no new host or DNS record.
    const names = (env) =>
      buildDoksIngressValues({ environment: "production", env: production(env).env }).tls.certificate.dnsNames;
    expect(names(marketplaceCorten)).toEqual(names({}));
  });

  it("refuses before Helm, saying how to recover, when marketplace-corten has no staged image", () => {
    const refusal = () => buildHelmUpgradeArgs(production(marketplaceCorten, { cortenMarketplaceImage: undefined }));
    expect(refusal).toThrow(
      "corten-marketplace-image is required on production while PRODUCTION_MARKETPLACE_APP=marketplace-corten",
    );
    expect(refusal).toThrow("No production change was made.");
    expect(refusal).toThrow(
      "set PRODUCTION_MARKETPLACE_APP=marketplace (or delete it) in the production environment and re-run",
    );
    expect(refusal).toThrow("return staging to the Corten marketplace and deploy again");
  });

  it("refuses before Helm, saying how to recover, when marketplace-corten has no PROXIES", () => {
    const envOverrides = { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false" };
    const refusal = () => buildHelmUpgradeArgs(production(marketplaceCorten, { envOverrides }));
    expect(refusal).toThrow("PROXIES is required on production while PRODUCTION_MARKETPLACE_APP=marketplace-corten");
    expect(refusal).toThrow("No production change was made.");
    expect(refusal).toThrow(
      "set PRODUCTION_MARKETPLACE_APP=marketplace (or delete it) in the production environment and re-run",
    );
  });

  it("keeps the admin pilot's switch independent of the marketplace's", () => {
    const admin = image.replace("corten-marketplace", "corten-admin");
    const both = { ...marketplaceCorten, PRODUCTION_ADMIN_APP: "admin-corten" };
    const args = buildHelmUpgradeArgs(production(both, { cortenAdminImage: admin }));
    expect(args).toContain(`components.admin-corten.image=${admin}`);
    expect(args).toContain(`components.marketplace-corten.image=${image}`);
    expect(withheldCortenPilots(production(marketplaceCorten))).toEqual(["admin-corten", "public-corten"]);
    // The public pilot stays withheld while public-web serves the apex and www, image or not.
    const publicImage = image.replace("corten-marketplace", "corten-public");
    expect(
      buildHelmUpgradeArgs(production(marketplaceCorten, { cortenPublicImage: publicImage })).filter((arg) =>
        String(arg).startsWith("components.public-corten."),
      ),
    ).toEqual(["components.public-corten.enabled=false"]);
  });

  it("does not wait for marketplace-corten under marketplace-web and waits for it under marketplace-corten", async () => {
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
      "Warning: marketplace-corten is not deployed because marketplace-web serves marketplace.chasesets.com (PRODUCTION_MARKETPLACE_APP=marketplace).",
    );
    const corten = await deploy(marketplaceCorten);
    expect(corten.waited.filter((args) => args.includes(pilotWorkload))).toHaveLength(1);
    expect(corten.warnings.filter((message) => message.includes("marketplace-corten"))).toEqual([]);
  });

  it("says which app served the marketplace in the summary, the step output and the deploy record", () => {
    const dir = mkdtempSync(join(tmpdir(), "production-marketplace-app-"));
    try {
      const record = (env, name) => {
        const githubSummaryPath = join(dir, `${name}.md`);
        const githubOutputPath = join(dir, `${name}.txt`);
        const result = recordMarketplaceApp({ env, githubSummaryPath, githubOutputPath }, "production");
        return { result, summary: read(githubSummaryPath), output: read(githubOutputPath) };
      };
      const web = record({}, "web");
      expect(web.result).toEqual({ app: "marketplace", source: "default", marketplaceCorten: "not-deployed" });
      expect(web.summary).toBe(
        "### Production marketplace app\n\n" +
          "marketplace.chasesets.com is served by marketplace (PRODUCTION_MARKETPLACE_APP is unset, so the default applies).\n\n" +
          "marketplace-corten is not deployed while marketplace-web serves marketplace.chasesets.com.\n\n",
      );
      expect(web.output).toBe("marketplace_app=marketplace\nmarketplace_app_source=default\n");
      const corten = record(marketplaceCorten, "corten");
      expect(corten.summary).toBe(
        "### Production marketplace app\n\n" +
          "marketplace.chasesets.com is served by marketplace-corten (PRODUCTION_MARKETPLACE_APP=marketplace-corten).\n\n",
      );
      expect(corten.output).toBe("marketplace_app=marketplace-corten\nmarketplace_app_source=variable\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const evidence = (env) => buildDeploymentEvidence({ ...production(env), workloads: {} });
    expect(evidence({}).productionMarketplaceApp).toEqual({
      app: "marketplace",
      source: "default",
      marketplaceCorten: "not-deployed",
    });
    expect(evidence(marketplaceCorten).productionMarketplaceApp).toEqual({
      app: "marketplace-corten",
      source: "variable",
      marketplaceCorten: "deployed",
    });
    expect(evidence({})).not.toHaveProperty("stagingMarketplaceApp");
  });

  it("hands production only the image staging deployed, and only when staging deployed it", () => {
    const dir = mkdtempSync(join(tmpdir(), "staged-corten-marketplace-"));
    try {
      const staging = (env, name) => {
        const githubOutputPath = join(dir, `${name}.txt`);
        const options = {
          cortenMarketplaceImage: image,
          envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
          env,
          githubOutputPath,
        };
        const marketplaceApp = recordMarketplaceApp({ ...options, githubOutputPath: undefined }, "staging");
        const written = recordDeployedCortenMarketplaceImage(options, marketplaceApp);
        let output = "";
        try {
          output = read(githubOutputPath);
        } catch {
          output = "";
        }
        return { written, output };
      };
      expect(staging({}, "serving")).toEqual({ written: image, output: `corten_marketplace_image=${image}\n` });
      expect(staging({ STAGING_MARKETPLACE_APP: "marketplace" }, "withheld")).toEqual({ written: null, output: "" });
      expect(
        recordDeployedCortenMarketplaceImage(production(marketplaceCorten), { marketplaceCorten: "deployed" }),
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

describe("Deploy Production wiring for the marketplace switch", () => {
  const job = workflow.jobs["deploy-production"];
  const deploy = job.steps.find(({ id }) => id === "production_kubernetes_deploy");

  it("keeps Deploy Production's needs and if exactly as they were", () => {
    expect(job.needs).toEqual(["resolve-release", "deploy-staging"]);
    expect(job.if).toBe("needs.deploy-staging.outputs.deployed == 'true'");
  });

  it("reads PRODUCTION_MARKETPLACE_APP from the production environment and the image from Deploy Staging", () => {
    expect(job.environment).toBe("production");
    expect(job.env.PRODUCTION_MARKETPLACE_APP).toBe("${{ vars.PRODUCTION_MARKETPLACE_APP || '' }}");
    expect(job.outputs.marketplace_app).toBe("${{ steps.production_kubernetes_deploy.outputs.marketplace_app }}");
    expect(workflow.jobs["deploy-staging"].outputs.corten_marketplace_image).toBe(
      "${{ steps.staging_kubernetes_deploy.outputs.corten_marketplace_image }}",
    );
    expect(deploy.env.CORTEN_MARKETPLACE_IMAGE).toBe("${{ needs.deploy-staging.outputs.corten_marketplace_image }}");
    expect(deploy.run).toContain(
      'if [ -n "${CORTEN_MARKETPLACE_IMAGE:-}" ]; then\n  corten_image_args+=(--corten-marketplace-image "$CORTEN_MARKETPLACE_IMAGE")\nfi',
    );
    // Only the deploy script reads the variable, so one resolution decides the ingress and the pilot.
    for (const step of job.steps) expect(String(step.run ?? "")).not.toMatch(/\$\{?PRODUCTION_MARKETPLACE_APP/);
  });

  it("smokes marketplace.chasesets.com signed in only while marketplace-corten serves it", () => {
    const smoke = job.steps.find(({ name }) => name === "Smoke check");
    expect(smoke.env).toMatchObject({
      MARKETPLACE_APP: "${{ steps.production_kubernetes_deploy.outputs.marketplace_app }}",
      SMOKE_REQUIRE_ADMIN: "true",
      PLATFORM_ADMIN_EMAIL: "${{ secrets.PLATFORM_ADMIN_EMAIL }}",
      PLATFORM_ADMIN_PASSWORD: "${{ secrets.PLATFORM_ADMIN_PASSWORD }}",
    });
    expect(smoke.env).not.toHaveProperty("SMOKE_REQUIRE_MARKETPLACE_SIGNED_IN");
    expect(smoke.run).toMatch(
      /smoke_urls\+=\("https:\/\/\$\{marketplace_domain\}"\)\n[\s\S]*?if \[ "\$MARKETPLACE_APP" = "marketplace-corten" \]; then\n\s*export SMOKE_REQUIRE_MARKETPLACE_SIGNED_IN="true"\n\s*fi/,
    );
  });

  it("probes only paths the Corten marketplace answers, so a switched production is smoked as staging is", () => {
    const steps = Object.fromEntries(job.steps.map((step) => [step.name, String(step.run ?? "")]));
    // The ingress wait reads /health/ready, which both apps answer; the canary and domain waits read the root.
    expect(steps["Verify production DOKS live hosts and certificate"]).toContain(
      'live_urls+=(--url "https://${marketplace_domain}/health/ready")',
    );
    expect(steps["Stage 1 production canary"]).toContain('canary_urls+=("https://${marketplace_domain}")');
    // The served-marketplace gate reads the root's robots tag, the registration API and the invitation route;
    // the pilot renders the tag while CHASE_SETS_MARKETPLACE_INDEXING is off and passes the API through.
    expect(steps["Smoke served marketplace invitation gate"]).toContain('content="noindex,nofollow"');
    // Neither app answers a bare /health at the marketplace host's root: no production step reads one.
    for (const run of Object.values(steps)) expect(run).not.toMatch(/marketplace_domain\}\/health(["' ]|$)/m);
    expect(read("scripts/platform-smoke.mjs")).toContain("`${origin}/api/health/ready`");
    expect(read("scripts/stripe-money-smoke-test.mjs")).toContain("/api/health");
  });

  it("writes the switch, its gates, the failed-switch response and both recoveries into the runbook", () => {
    const runbook = read("docs/runbooks/production-marketplace-app.md");
    for (const line of [
      "gh variable set PRODUCTION_MARKETPLACE_APP --repo chase-sets/chase-sets --env production --body marketplace-corten",
      "gh variable delete PRODUCTION_MARKETPLACE_APP --repo chase-sets/chase-sets --env production",
      "A failed switch shows as a red Deploy Production that rolled back to marketplace-web. The response is to fix forward on staging, not to retry production.",
      '"corten-marketplace-image is required on production"',
      '"PROXIES is required on production"',
      "service.name=marketplace-corten",
      "settled card checkout",
      "3-D Secure",
    ]) {
      expect(runbook).toContain(line);
    }
    expect(read("docs/README.md")).toContain("(./runbooks/production-marketplace-app.md)");
  });
});
