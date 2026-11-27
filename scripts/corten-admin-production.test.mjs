import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { adminApp, buildDoksIngressValues, buildPlatformHelmProductionValues } from "./render-platform-helm-values.mjs";
import {
  buildDeploymentEvidence,
  buildHelmUpgradeArgs,
  deployPlatformToKubernetes,
  platformKubernetesWorkloads,
  recordDeployedCortenAdminImage,
} from "./platform-kubernetes-deployment.mjs";

const read = (file) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const workflowText = read(".github/workflows/platform-production.yml");
const workflow = parse(workflowText);
const digest = "sha256:" + "a".repeat(64);
const image = `registry.digitalocean.com/chase-sets/chase-sets-corten-admin@${digest}`;
const marketplaceImage = image.replace("corten-admin", "corten-marketplace");
const publicImage = image.replace("corten-admin", "corten-public");
const proxies = "10.244.0.0/25,10.244.1.0/25";
const production = (env = {}, overrides = {}) => ({
  image: `registry.digitalocean.com/chase-sets/chase-sets-platform:release@${digest}`,
  cortenAdminImage: image,
  cortenMarketplaceImage: marketplaceImage,
  cortenPublicImage: publicImage,
  envOverrides: { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false", PROXIES: proxies },
  env: { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", PRODUCTION_DOKS_INGRESS_TARGET: "192.0.2.1", ...env },
  managedPostgresCaSha256: "b".repeat(64),
  ...overrides,
});
// A variable left behind after admin-web was retired, until it is deleted from the environment.
const leftover = { PRODUCTION_ADMIN_APP: "admin-web" };
const pilotArgs = (args) => args.filter((arg) => String(arg).startsWith("components.admin-corten."));
const adminRoot = (args) => {
  const hostArg = args.find((arg) => /^doksIngress\.hosts\[\d+\]\.host=admin\.chasesets\.com$/.test(arg));
  const host = hostArg.match(/hosts\[(\d+)\]/)[1];
  return args
    .filter((arg) => arg.startsWith(`doksIngress.hosts[${host}].paths[`) && arg.includes(".service="))
    .at(-1)
    .split("=")[1];
};
const pilotWorkload = "chase-sets-platform-chase-sets-platform-admin-corten";
const webWorkload = "chase-sets-platform-chase-sets-platform-admin-web";

describe("production admin app", () => {
  it("serves admin.chasesets.com from admin-corten with the staged image, whatever a leftover variable says", () => {
    expect(adminApp).toBe("admin-corten");
    for (const env of [{}, leftover, { PRODUCTION_ADMIN_APP: "not-an-app" }]) {
      const args = buildHelmUpgradeArgs(production(env));
      expect(pilotArgs(args)).toEqual([`components.admin-corten.image=${image}`]);
      expect(args[args.indexOf(`components.admin-corten.image=${image}`) - 1]).toBe("--set-string");
      expect(adminRoot(args)).toBe("admin-corten");
      expect(args).toContain(`global.envOverrides.PROXIES=${proxies.replace(",", "\\,")}`);
    }
    const { deployments } = platformKubernetesWorkloads(production());
    expect(deployments).toContain(pilotWorkload);
    expect(deployments).not.toContain(webWorkload);
    // The certificate covers the same names as before: no new host or DNS record.
    const names = (env) =>
      buildDoksIngressValues({ environment: "production", env: production(env).env }).tls.certificate.dnsNames;
    expect(names(leftover)).toEqual(names({}));
  });

  it("no longer deploys admin-web in production", () => {
    expect(buildPlatformHelmProductionValues().components["admin-web"]).toEqual({ enabled: false });
    const values = read("infrastructure/helm/platform/values.production.yaml");
    expect(values).toContain("  admin-web:\n    enabled: false\n");
    expect(values).not.toMatch(/\n {2}admin-web:\n {4}resources:/);
    const routes = JSON.stringify(
      buildDoksIngressValues({ environment: "production", env: production().env }).hosts.flatMap(({ paths }) => paths),
    );
    expect(routes).not.toContain('"service":"admin-web"');
  });

  it("refuses before Helm, saying how to recover, when there is no staged image", () => {
    for (const env of [{}, leftover]) {
      const refusal = () => buildHelmUpgradeArgs(production(env, { cortenAdminImage: undefined }));
      expect(refusal).toThrow("corten-admin-image is required on production: admin-corten serves admin.chasesets.com");
      expect(refusal).toThrow("No production change was made, and production keeps serving the last release.");
      expect(refusal).toThrow("To recover, fix the Corten admin image build and deploy again");
    }
  });

  it("refuses before Helm, saying how to recover, when there is no PROXIES", () => {
    const envOverrides = { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false" };
    const refusal = () => buildHelmUpgradeArgs(production({}, { envOverrides }));
    expect(refusal).toThrow(
      "PROXIES is required on production: the ingress pod CIDRs could not be read, and the Corten admin",
    );
    expect(refusal).toThrow("No production change was made, and production keeps serving the last release.");
    expect(refusal).toThrow("To recover, fix the ingress pod CIDR discovery and deploy again");
    // An empty value never gets this far: every runtime env override must be non-empty.
    for (const PROXIES of ["", " "]) {
      expect(() => buildHelmUpgradeArgs(production({}, { envOverrides: { ...envOverrides, PROXIES } }))).toThrow(
        "PROXIES is required",
      );
    }
  });

  it("serves the marketplace and the public hosts from their Corten apps beside the admin", () => {
    const args = buildHelmUpgradeArgs(production());
    expect(args.filter((arg) => String(arg).startsWith("components.marketplace-corten."))).toEqual([
      `components.marketplace-corten.image=${marketplaceImage}`,
    ]);
    expect(args.filter((arg) => String(arg).startsWith("components.public-corten."))).toEqual([
      `components.public-corten.image=${publicImage}`,
    ]);
  });

  it("waits for admin-corten on every production deploy and warns about nothing admin", async () => {
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
      expect(error.mock.calls.flat().filter((message) => String(message).includes("admin"))).toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it("keeps no admin app in the deploy record", () => {
    for (const env of [{}, leftover]) {
      const evidence = buildDeploymentEvidence({ ...production(env), workloads: {} });
      expect(evidence).not.toHaveProperty("productionAdminApp");
      expect(evidence).not.toHaveProperty("stagingAdminApp");
    }
  });

  it("hands production only the image staging deployed, and only from a staging deploy", () => {
    const dir = mkdtempSync(join(tmpdir(), "staged-corten-admin-"));
    try {
      const githubOutputPath = join(dir, "staging.txt");
      const staging = {
        cortenAdminImage: image,
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
        env: { STAGING_ADMIN_APP: "admin-web" },
        githubOutputPath,
      };
      // A leftover STAGING_ADMIN_APP no longer withholds the handoff.
      expect(recordDeployedCortenAdminImage(staging)).toBe(image);
      expect(read(githubOutputPath)).toBe(`corten_admin_image=${image}\n`);
      expect(
        recordDeployedCortenAdminImage(production()),
        "a production deploy never writes the staging output",
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declares the production runtime contract on admin.chasesets.com with the staging runtime's secret only", () => {
    const component = buildPlatformHelmProductionValues().components["admin-corten"];
    expect(component).toMatchObject({
      enabled: true,
      kind: "service",
      replicas: 1,
      image: "",
      port: 8080,
      healthPath: "/health/ready",
      livenessPath: "/health/live",
      command: "exec /usr/local/bin/corten-pilot-admin",
    });
    const env = Object.fromEntries(component.env.map(({ name, value }) => [name, value]));
    expect(env).toMatchObject({
      HOSTS: "admin.chasesets.com",
      PUBLIC_PROTO: "https",
      PROXIES: "",
      ADMIN_WEB_ORIGIN: "https://admin.chasesets.com",
      CHASE_SETS_MARKETPLACE_ORIGIN: "",
    });
    expect(JSON.stringify(component)).not.toContain("staging");
    expect(component.env.filter(({ secret }) => secret)).toEqual([
      { name: "PLATFORM_INTERNAL_AUTH_SECRET", secret: true, secretKey: "PLATFORM_INTERNAL_AUTH_SECRET" },
    ]);
    expect(read("infrastructure/helm/platform/values.production.yaml")).toContain("  admin-corten:\n");
  });
});

describe("Deploy Production wiring for the Corten admin", () => {
  const job = workflow.jobs["deploy-production"];
  const deploy = job.steps.find(({ id }) => id === "production_kubernetes_deploy");

  it("keeps Deploy Production's needs and if exactly as they were", () => {
    expect(job.needs).toEqual(["resolve-release", "deploy-staging"]);
    expect(job.if).toBe("needs.deploy-staging.outputs.deployed == 'true'");
    const block = workflowText.slice(workflowText.indexOf("  deploy-production:\n"));
    expect(block.slice(0, block.indexOf("    environment: production\n"))).toBe(
      [
        "  deploy-production:",
        "    name: Deploy Production",
        "    runs-on: ubuntu-latest",
        "    timeout-minutes: 180",
        "    needs:",
        "      - resolve-release",
        "      - deploy-staging",
        "    if: needs.deploy-staging.outputs.deployed == 'true'",
        "",
      ].join("\n"),
    );
  });

  it("reads no admin app variable and takes the image from Deploy Staging", () => {
    expect(job.environment).toBe("production");
    expect(job.env).not.toHaveProperty("PRODUCTION_ADMIN_APP");
    expect(job.outputs).not.toHaveProperty("admin_app");
    expect(workflow.jobs["deploy-staging"].env).not.toHaveProperty("STAGING_ADMIN_APP");
    expect(workflow.jobs["deploy-staging"].outputs).not.toHaveProperty("admin_app");
    expect(workflowText).not.toMatch(/ADMIN_APP|admin_app/);
    expect(workflow.jobs["deploy-staging"].outputs.corten_admin_image).toBe(
      "${{ steps.staging_kubernetes_deploy.outputs.corten_admin_image }}",
    );
    expect(deploy.env.CORTEN_ADMIN_IMAGE).toBe("${{ needs.deploy-staging.outputs.corten_admin_image }}");
    expect(deploy.run).toContain(
      'if [ -n "$CORTEN_ADMIN_IMAGE" ]; then\n  corten_image_args+=(--corten-admin-image "$CORTEN_ADMIN_IMAGE")\nfi',
    );
    expect(deploy.run).toContain('  "${corten_image_args[@]}" \\\n  --github-summary "$GITHUB_STEP_SUMMARY" \\\n');
  });

  it("discovers PROXIES with staging's exact query and leaves a failure to the deploy script's refusal", () => {
    const query = (run) => run.slice(run.indexOf("'.items as $items"), run.indexOf('join(",")\'') + 10);
    const staging = workflow.jobs["deploy-staging"].steps.find(({ id }) => id === "staging_kubernetes_deploy");
    expect(query(deploy.run)).toBe(query(staging.run));
    expect(query(deploy.run).length).toBeGreaterThan(200);
    expect(deploy.run).toContain('ingress_pod_cidrs=""\nif ingress_nodes="$(kubectl');
    expect(deploy.run).toContain(
      'else\n  ingress_pod_cidrs=""\n  echo "::warning title=Corten admin PROXIES::The ingress pod CIDRs could not be read; PROXIES is not set."\nfi\nadd_optional_runtime_env "PROXIES" "$ingress_pod_cidrs"',
    );
    expect(deploy.run).not.toContain('--runtime-env "PROXIES=');
  });

  it("smokes admin.chasesets.com with the authenticated admin smoke", () => {
    const smoke = job.steps.find(({ name }) => name === "Smoke check");
    expect(smoke.env).toMatchObject({
      SMOKE_REQUIRE_ADMIN: "true",
      PLATFORM_ADMIN_EMAIL: "${{ secrets.PLATFORM_ADMIN_EMAIL }}",
      PLATFORM_ADMIN_PASSWORD: "${{ secrets.PLATFORM_ADMIN_PASSWORD }}",
    });
    expect(smoke.run).toContain('smoke_urls=("https://${public_domain}" "https://${admin_domain}")');
    const canary = job.steps.find(({ name }) => name === "Stage 1 production canary");
    expect(canary.run).toContain('canary_urls=("https://${public_domain}" "https://${admin_domain}")');
  });

  it("writes the refusals, their recoveries and rollback by earlier release into the runbook", () => {
    const runbook = read("docs/runbooks/production-admin-app.md");
    for (const line of [
      "admin-corten serves admin.chasesets.com on every production deploy.",
      "To roll back, deploy an earlier release_ref.",
      '"corten-admin-image is required on production"',
      '"PROXIES is required on production"',
    ]) {
      expect(runbook).toContain(line);
    }
    expect(runbook).not.toContain("gh variable set PRODUCTION_ADMIN_APP");
    expect(read("docs/README.md")).toContain("(./runbooks/production-admin-app.md)");
  });
});
