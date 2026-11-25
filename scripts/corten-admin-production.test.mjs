import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  buildDoksIngressValues,
  buildPlatformHelmProductionValues,
  resolveProductionAdminApp,
} from "./render-platform-helm-values.mjs";
import {
  buildDeploymentEvidence,
  buildHelmUpgradeArgs,
  deployPlatformToKubernetes,
  platformKubernetesWorkloads,
  recordAdminApp,
  recordDeployedCortenAdminImage,
  withheldCortenPilots,
} from "./platform-kubernetes-deployment.mjs";

const read = (file) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const workflowText = read(".github/workflows/platform-production.yml");
const workflow = parse(workflowText);
const digest = "sha256:" + "a".repeat(64);
const image = `registry.digitalocean.com/chase-sets/chase-sets-corten-admin@${digest}`;
const proxies = "10.244.0.0/25,10.244.1.0/25";
const production = (env = {}, overrides = {}) => ({
  image: `registry.digitalocean.com/chase-sets/chase-sets-platform:release@${digest}`,
  cortenAdminImage: image,
  envOverrides: { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false", PROXIES: proxies },
  env: { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", PRODUCTION_DOKS_INGRESS_TARGET: "192.0.2.1", ...env },
  managedPostgresCaSha256: "b".repeat(64),
  ...overrides,
});
const adminCorten = { PRODUCTION_ADMIN_APP: "admin-corten" };
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

describe("production admin app switch", () => {
  it("defaults to admin-web, takes admin-corten only by name, and refuses anything else", () => {
    expect(resolveProductionAdminApp({})).toEqual({ app: "admin-web", source: "default" });
    expect(resolveProductionAdminApp({ PRODUCTION_ADMIN_APP: " admin-corten " })).toEqual({
      app: "admin-corten",
      source: "variable",
    });
    // The staging variable never moves production.
    expect(resolveProductionAdminApp({ STAGING_ADMIN_APP: "admin-corten" }).app).toBe("admin-web");
    for (const value of ["admin", "ADMIN-CORTEN", "admin-corten,admin-web"]) {
      expect(() => buildHelmUpgradeArgs(production({ PRODUCTION_ADMIN_APP: value }))).toThrow(
        "PRODUCTION_ADMIN_APP must be one of",
      );
    }
  });

  it("does not deploy admin-corten while admin-web serves admin.chasesets.com, with or without an image or PROXIES", () => {
    for (const overrides of [{}, { cortenAdminImage: undefined }]) {
      for (const env of [{}, { PRODUCTION_ADMIN_APP: "admin-web" }]) {
        const args = buildHelmUpgradeArgs(production(env, overrides));
        expect(pilotArgs(args)).toEqual(["components.admin-corten.enabled=false"]);
        expect(args[args.indexOf("components.admin-corten.enabled=false") - 1]).toBe("--set");
        expect(adminRoot(args)).toBe("admin-web");
        expect(withheldCortenPilots(production(env))).toEqual(["admin-corten", "marketplace-corten", "public-corten"]);
      }
    }
    const withoutProxies = production(
      {},
      {
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false" },
      },
    );
    expect(pilotArgs(buildHelmUpgradeArgs(withoutProxies))).toEqual(["components.admin-corten.enabled=false"]);
  });

  it("serves admin.chasesets.com from admin-corten with the staged image under admin-corten", () => {
    const args = buildHelmUpgradeArgs(production(adminCorten));
    expect(pilotArgs(args)).toEqual([`components.admin-corten.image=${image}`]);
    expect(args[args.indexOf(`components.admin-corten.image=${image}`) - 1]).toBe("--set-string");
    expect(adminRoot(args)).toBe("admin-corten");
    expect(args).toContain(`global.envOverrides.PROXIES=${proxies.replace(",", "\\,")}`);
    expect(withheldCortenPilots(production(adminCorten))).toEqual(["marketplace-corten", "public-corten"]);
    expect(platformKubernetesWorkloads(production(adminCorten)).deployments).toContain(pilotWorkload);
    // The certificate covers the same names either way: no new host or DNS record.
    const names = (env) =>
      buildDoksIngressValues({ environment: "production", env: production(env).env }).tls.certificate.dnsNames;
    expect(names(adminCorten)).toEqual(names({}));
  });

  it("refuses before Helm, saying how to recover, when admin-corten has no staged image", () => {
    const refusal = () => buildHelmUpgradeArgs(production(adminCorten, { cortenAdminImage: undefined }));
    expect(refusal).toThrow("corten-admin-image is required on production while PRODUCTION_ADMIN_APP=admin-corten");
    expect(refusal).toThrow("No production change was made.");
    expect(refusal).toThrow(
      "set PRODUCTION_ADMIN_APP=admin-web (or delete it) in the production environment and re-run",
    );
    expect(refusal).toThrow("return staging to the Corten admin and deploy again");
  });

  it("refuses before Helm, saying how to recover, when admin-corten has no PROXIES", () => {
    const envOverrides = { DEPLOYMENT_ENVIRONMENT: "production", OBSERVABILITY_ENABLED: "false" };
    const refusal = () => buildHelmUpgradeArgs(production(adminCorten, { envOverrides }));
    expect(refusal).toThrow("PROXIES is required on production while PRODUCTION_ADMIN_APP=admin-corten");
    expect(refusal).toThrow("No production change was made.");
    expect(refusal).toThrow(
      "set PRODUCTION_ADMIN_APP=admin-web (or delete it) in the production environment and re-run",
    );
    // An empty value never gets this far: every runtime env override must be non-empty.
    for (const PROXIES of ["", " "]) {
      expect(() =>
        buildHelmUpgradeArgs(production(adminCorten, { envOverrides: { ...envOverrides, PROXIES } })),
      ).toThrow("PROXIES is required");
    }
  });

  it("leaves the marketplace pilot withheld while marketplace-web serves marketplace.chasesets.com", () => {
    const marketplace = image.replace("corten-admin", "corten-marketplace");
    for (const overrides of [{}, { cortenMarketplaceImage: marketplace }]) {
      const args = buildHelmUpgradeArgs(production(adminCorten, overrides));
      expect(args.filter((arg) => String(arg).startsWith("components.marketplace-corten."))).toEqual([
        "components.marketplace-corten.enabled=false",
      ]);
    }
  });

  it("does not wait for admin-corten under admin-web and waits for it under admin-corten", async () => {
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
      "Warning: admin-corten is not deployed because admin-web serves admin.chasesets.com (PRODUCTION_ADMIN_APP=admin-web).",
    );
    const corten = await deploy(adminCorten);
    expect(corten.waited.filter((args) => args.includes(pilotWorkload))).toHaveLength(1);
    expect(corten.warnings.filter((message) => message.includes("admin-corten"))).toEqual([]);
  });

  it("says which app served admin in the summary, the step output and the deploy record", () => {
    const dir = mkdtempSync(join(tmpdir(), "production-admin-app-"));
    try {
      const record = (env, name) => {
        const githubSummaryPath = join(dir, `${name}.md`);
        const githubOutputPath = join(dir, `${name}.txt`);
        const result = recordAdminApp({ env, githubSummaryPath, githubOutputPath }, "production");
        return { result, summary: read(githubSummaryPath), output: read(githubOutputPath) };
      };
      const web = record({}, "web");
      expect(web.result).toEqual({ app: "admin-web", source: "default", adminCorten: "not-deployed" });
      expect(web.summary).toBe(
        "### Production admin app\n\n" +
          "admin.chasesets.com is served by admin-web (PRODUCTION_ADMIN_APP is unset, so the default applies).\n\n" +
          "admin-corten is not deployed while admin-web serves admin.chasesets.com.\n\n",
      );
      expect(web.output).toBe("admin_app=admin-web\nadmin_app_source=default\n");
      const corten = record(adminCorten, "corten");
      expect(corten.summary).toBe(
        "### Production admin app\n\nadmin.chasesets.com is served by admin-corten (PRODUCTION_ADMIN_APP=admin-corten).\n\n",
      );
      expect(corten.output).toBe("admin_app=admin-corten\nadmin_app_source=variable\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const evidence = (env) => buildDeploymentEvidence({ ...production(env), workloads: {} });
    expect(evidence({}).productionAdminApp).toEqual({
      app: "admin-web",
      source: "default",
      adminCorten: "not-deployed",
    });
    expect(evidence(adminCorten).productionAdminApp).toEqual({
      app: "admin-corten",
      source: "variable",
      adminCorten: "deployed",
    });
    expect(evidence({})).not.toHaveProperty("stagingAdminApp");
  });

  it("hands production only the image staging deployed, and only when staging deployed it", () => {
    const dir = mkdtempSync(join(tmpdir(), "staged-corten-admin-"));
    try {
      const staging = (env, name) => {
        const githubOutputPath = join(dir, `${name}.txt`);
        const options = {
          cortenAdminImage: image,
          envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
          env,
          githubOutputPath,
        };
        const adminApp = recordAdminApp({ ...options, githubOutputPath: undefined }, "staging");
        const written = recordDeployedCortenAdminImage(options, adminApp);
        let output = "";
        try {
          output = read(githubOutputPath);
        } catch {
          output = "";
        }
        return { written, output };
      };
      expect(staging({}, "serving")).toEqual({ written: image, output: `corten_admin_image=${image}\n` });
      expect(staging({ STAGING_ADMIN_APP: "admin-web" }, "withheld")).toEqual({ written: null, output: "" });
      expect(
        recordDeployedCortenAdminImage(production(adminCorten), { adminCorten: "deployed" }),
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

describe("Deploy Production wiring for the admin switch", () => {
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

  it("reads PRODUCTION_ADMIN_APP from the production environment and the image from Deploy Staging", () => {
    expect(job.environment).toBe("production");
    expect(job.env.PRODUCTION_ADMIN_APP).toBe("${{ vars.PRODUCTION_ADMIN_APP || '' }}");
    expect(job.outputs.admin_app).toBe("${{ steps.production_kubernetes_deploy.outputs.admin_app }}");
    expect(workflow.jobs["deploy-staging"].outputs.corten_admin_image).toBe(
      "${{ steps.staging_kubernetes_deploy.outputs.corten_admin_image }}",
    );
    expect(deploy.env.CORTEN_ADMIN_IMAGE).toBe("${{ needs.deploy-staging.outputs.corten_admin_image }}");
    expect(deploy.run).toContain(
      'if [ -n "$CORTEN_ADMIN_IMAGE" ]; then\n  corten_image_args+=(--corten-admin-image "$CORTEN_ADMIN_IMAGE")\nfi',
    );
    expect(deploy.run).toContain('  "${corten_image_args[@]}" \\\n  --github-summary "$GITHUB_STEP_SUMMARY" \\\n');
    // Only the deploy script reads the variable, so one resolution decides the ingress and the pilot.
    for (const step of job.steps) expect(String(step.run ?? "")).not.toMatch(/\$\{?PRODUCTION_ADMIN_APP/);
  });

  it("discovers PROXIES best-effort with staging's exact query, so a failure cannot hold an admin-web release", () => {
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

  it("smokes admin.chasesets.com with the authenticated admin smoke whichever app serves it", () => {
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

  it("writes the switch, the failed-switch response and both recoveries into the runbook", () => {
    const runbook = read("docs/runbooks/production-admin-app.md");
    for (const line of [
      "gh variable set PRODUCTION_ADMIN_APP --repo chase-sets/chase-sets --env production --body admin-corten",
      "gh variable delete PRODUCTION_ADMIN_APP --repo chase-sets/chase-sets --env production",
      "A failed switch shows as a red Deploy Production that rolled back to admin-web. The response is to fix forward on staging, not to retry production.",
      '"corten-admin-image is required on production"',
      '"PROXIES is required on production"',
    ]) {
      expect(runbook).toContain(line);
    }
    expect(read("docs/README.md")).toContain("(./runbooks/production-admin-app.md)");
  });
});
