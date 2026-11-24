import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  buildDoksIngressValues,
  buildPlatformHelmProductionValues,
  buildPlatformHelmStagingValues,
  buildPlatformHelmValues,
} from "./render-platform-helm-values.mjs";
import {
  buildDeploymentEvidence,
  buildHelmUpgradeArgs,
  droppedAdvisoryCortenPilots,
  parseArgs,
  platformKubernetesWorkloads,
  recordStagingMarketplaceApp,
  withheldCortenPilots,
} from "./platform-kubernetes-deployment.mjs";
import { classifyChanges } from "./change-scope.mjs";

const read = (file) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const workflowText = read(".github/workflows/platform-production.yml");
const workflow = parse(workflowText);
const digest = "sha256:" + "a".repeat(64);
const image = `registry.digitalocean.com/chase-sets/chase-sets-corten-marketplace@${digest}`;
const options = {
  image: `registry.digitalocean.com/chase-sets/chase-sets-platform:release@${digest}`,
  cortenMarketplaceImage: image,
  // public-corten serves www.staging, so a staging deploy needs its image too.
  cortenPublicImage: `registry.digitalocean.com/chase-sets/chase-sets-corten-public@${digest}`,
  envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging", OBSERVABILITY_ENABLED: "false" },
  // admin-web serving admin.staging withholds the admin pilot, so these marketplace cases may omit its image.
  env: { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", STAGING_ADMIN_APP: "admin-web" },
  managedPostgresCaSha256: "b".repeat(64),
};
const workload = "chase-sets-platform-chase-sets-platform-marketplace-corten";

// The first slice built the marketplace pilot's image and named its staging host. The second enables the staging
// workload, has Deploy Staging pass the image, and smokes the pilot advisorily. With no image the deploy drops it.
describe("Corten marketplace staging, first slice", () => {
  it("preserves every production job byte-for-byte", () => {
    const expected = {
      "reconcile-production-marker": "6e7171774b3d654c0dcd81d993140ebcfb0bf8436d05c7a5809c7137b5f2c317",
      "reconcile-managed-postgres-ca-production": "2a089333675961592792931dc522f4a8725e1f4b2f8688a0a7ecbb5a3246f389",
      // Moved for the production admin switch: PRODUCTION_ADMIN_APP, the staged Corten admin image, best-effort PROXIES.
      "deploy-production": "1839392f04347528f1c5cedc10be1258157b6340772cc35c7802c674d846f3a4",
      "notify-production-deploy-incident": "45ba7ca357af41620cb066784a2ef94c80741725d98aa98a6520f3b049166262",
      "notify-production-rollback-incident": "6620994b81902ec45da29e5b3f049a1e49b2e9a2483d1b6acf6663584272710e",
    };
    const headings = [...workflowText.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)];
    expect(
      Object.keys(workflow.jobs)
        .filter((name) => name.includes("production"))
        .sort(),
    ).toEqual(Object.keys(expected).sort());
    for (const [index, heading] of headings.entries()) {
      if (!(heading[1] in expected)) continue;
      const bytes = workflowText.slice(heading.index, headings[index + 1]?.index);
      expect(createHash("sha256").update(bytes).digest("hex"), heading[1]).toBe(expected[heading[1]]);
    }
  });

  it("preserves the production values", () => {
    for (const [file, sha] of Object.entries({
      "values.yaml": "deabfa12c21bfed16326e58432c13a4aecf3a1f1f852768320a311e3916baadc",
      "values.production.yaml": "653442bfb787b2701df3afccdc816f912f3bb658f063ba9b1a24d2627d59f37c",
    })) {
      expect(
        createHash("sha256")
          .update(read(`infrastructure/helm/platform/${file}`))
          .digest("hex"),
      ).toBe(sha);
    }
  });

  it("adds the DNS name only to staging and leaves production's names and hosts as they were", () => {
    const dns = read("infrastructure/digitalocean/platform/locals.tf");
    const start = dns.indexOf("  app_serving_record_names = ");
    const set = dns.slice(start, dns.indexOf("toset([])", start) + "toset([])".length);
    expect(set).toBe(
      [
        "  app_serving_record_names = local.is_staging ? toset([",
        '    "admin-corten",',
        '    "admin",',
        '    "marketplace-corten",',
        '    "marketplace",',
        '    "public-corten",',
        '    "www",',
        "    ]) : local.is_production ? toset(concat(",
        '    ["admin", "www"],',
        '    local.marketplace_served ? ["marketplace"] : [],',
        "  )) : toset([])",
      ].join("\n"),
    );

    const hosts = JSON.parse(read("scripts/environment-hosts.json")).hosts;
    expect(hosts.filter(({ host }) => host.startsWith("marketplace-corten."))).toEqual([
      {
        host: "marketplace-corten.staging.chasesets.com",
        status: "current",
        environment: "staging",
        class: "application",
        templated: false,
        authorityAnchor: "A3",
      },
    ]);
    // The production entries are pinned by digest so this file names no diagnostic host.
    const production = hosts.filter(({ environment }) => environment === "production");
    expect(production).toHaveLength(12);
    expect(createHash("sha256").update(JSON.stringify(production)).digest("hex")).toBe(
      "8a59d1c636fc97f665c2452cfb104a80fb4368e557e7b76cd7f3b518cfc45749",
    );
  });

  it.each(["Dockerfile.corten-marketplace", "Dockerfile.corten-marketplace.dockerignore"])(
    "selects Platform Deploy for the image's own input: %s",
    (file) => {
      expect(classifyChanges({ changedFiles: [file], workspaces: [] }).deployRequired).toBe(true);
    },
  );

  it("keeps the pilot out of base, production and preview values and production ingress", () => {
    expect(buildPlatformHelmValues().components).not.toHaveProperty("marketplace-corten");
    expect(buildPlatformHelmProductionValues().components).not.toHaveProperty("marketplace-corten");
    expect(read("infrastructure/helm/platform/values.preview.yaml")).not.toContain("marketplace-corten");
    for (const environment of ["production", "preview"]) {
      expect(
        platformKubernetesWorkloads({ envOverrides: { DEPLOYMENT_ENVIRONMENT: environment } }).deployments,
      ).not.toContain(workload);
    }
    expect(
      buildDoksIngressValues({
        environment: "production",
        env: { PRODUCTION_DOKS_INGRESS_TARGET: "192.0.2.1" },
      }).hosts.some(({ host }) => host.includes("corten")),
    ).toBe(false);
  });

  it("enables the staging workload with existing secrets only, and waits for it only when the deploy passes its image", () => {
    const component = buildPlatformHelmStagingValues().components["marketplace-corten"];
    expect(component).toMatchObject({
      enabled: true,
      kind: "service",
      replicas: 1,
      image: "",
      port: 8080,
      service: { port: 8080 },
      healthPath: "/health/ready",
      livenessPath: "/health/live",
      readinessProbe: { timeoutSeconds: 2 },
      command: "exec /usr/local/bin/corten-pilot-marketplace",
    });
    const env = Object.fromEntries(
      component.env.filter(({ secret }) => !secret).map(({ name, value }) => [name, value]),
    );
    expect(env).toMatchObject({
      HOST: "0.0.0.0",
      PORT: "8080",
      HOSTS: "marketplace-corten.staging.chasesets.com,marketplace.staging.chasesets.com,staging.chasesets.com",
      PUBLIC_PROTO: "https",
      PROXIES: "",
      CHASE_SETS_INTERNAL_API_ORIGIN: "",
      PLATFORM_API_ORIGIN: "",
      MARKETPLACE_WEB_ORIGIN: "https://marketplace.staging.chasesets.com",
      CHASE_SETS_MARKETPLACE_INDEXING: "false",
      DEPLOYMENT_ENVIRONMENT: "staging",
    });
    expect(env).not.toHaveProperty("CHASE_SETS_TRUST_FORWARDED_HEADERS");
    // Every secret it reads is one a deployed web host already reads from the same key.
    const secrets = component.env.filter(({ secret }) => secret);
    expect(secrets.map(({ name }) => name).sort()).toEqual(
      ["OTEL_EXPORTER_OTLP_HEADERS", "PLATFORM_INTERNAL_AUTH_SECRET", "STRIPE_PUBLISHABLE_KEY"].sort(),
    );
    const existing = new Set(
      [
        ...Object.values(buildPlatformHelmValues().components),
        buildPlatformHelmStagingValues().components["admin-corten"],
      ].flatMap((other) => (other.env ?? []).filter(({ secret }) => secret).map(({ secretKey }) => secretKey)),
    );
    for (const { name, secretKey } of secrets) {
      expect(secretKey).toBe(name);
      expect(existing.has(secretKey), secretKey).toBe(true);
    }
    expect(platformKubernetesWorkloads(options).deployments).toContain(workload);
    expect(droppedAdvisoryCortenPilots(options)).not.toContain("marketplace-corten");
    // It serves marketplace.staging, so it is no longer advisory: with no image the deploy refuses instead of
    // removing what serves the host.
    const withoutImage = { ...options, cortenMarketplaceImage: undefined };
    expect(droppedAdvisoryCortenPilots(withoutImage)).not.toContain("marketplace-corten");
    expect(() => buildHelmUpgradeArgs(withoutImage)).toThrow(
      "corten-marketplace-image is required on staging: marketplace-corten is not an advisory pilot.",
    );
  });

  it("pins the pilot image only on staging and refuses mutable or wrong-repository references", () => {
    expect(buildHelmUpgradeArgs(options)).toContain(`components.marketplace-corten.image=${image}`);
    expect(parseArgs(["deploy", "--corten-marketplace-image", image], {}).cortenMarketplaceImage).toBe(image);
    for (const environment of ["production", "preview"]) {
      expect(() => buildHelmUpgradeArgs({ ...options, envOverrides: { DEPLOYMENT_ENVIRONMENT: environment } })).toThrow(
        "corten-marketplace-image is staging-only.",
      );
    }
    expect(() =>
      buildHelmUpgradeArgs({ ...options, cortenMarketplaceImage: image.split("@")[0] + ":latest" }),
    ).toThrow();
    for (const repository of ["chase-sets-platform", "chase-sets-corten-admin"]) {
      expect(() =>
        buildHelmUpgradeArgs({
          ...options,
          cortenMarketplaceImage: image.replace("chase-sets-corten-marketplace", repository),
        }),
      ).toThrow("chase-sets-corten-marketplace repository");
    }
    // Both pilots pinned while admin-corten serves admin.staging (STAGING_ADMIN_APP unset).
    const both = buildHelmUpgradeArgs({
      ...options,
      env: { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" },
      cortenAdminImage: image.replace("corten-marketplace", "corten-admin"),
    });
    expect(both).toContain(`components.admin-corten.image=${image.replace("corten-marketplace", "corten-admin")}`);
    expect(both).toContain(`components.marketplace-corten.image=${image}`);
  });

  it("builds exported assets before the locked marketplace binary from pinned existing mirrors", () => {
    const dockerfile = read("Dockerfile.corten-marketplace");
    const mirrors = JSON.parse(read("scripts/ci-image-sources.json")).sources;
    for (const reference of [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1])) {
      expect(mirrors.some(({ mirror, tag, digest: pinned }) => reference === `${mirror}:${tag}@${pinned}`)).toBe(true);
    }
    expect(dockerfile.indexOf("pnpm run deps:install")).toBeLessThan(
      dockerfile.indexOf("node --import tsx deployables/corten-pilot/scripts/export.mjs"),
    );
    expect(dockerfile.indexOf("scripts/export.mjs")).toBeLessThan(
      dockerfile.indexOf("cargo build --release --locked -p corten-pilot-marketplace"),
    );
    expect(dockerfile).toContain(
      "COPY --from=build /app/deployables/corten-pilot/target/release/corten-pilot-marketplace /usr/local/bin/corten-pilot-marketplace",
    );
    expect(dockerfile).toContain("USER node");
    expect(read(".dockerignore")).toContain("\ndeployables/corten-pilot\n");
    expect(read("Dockerfile.corten-marketplace.dockerignore")).not.toContain("\ndeployables/corten-pilot\n");
  });

  it("builds the image in the pilot images job with the same writer admission, and only Deploy Staging reads it", () => {
    const build = workflow.jobs["build-corten-pilot-images"];
    const gate = build.steps.find(({ id }) => id === "corten_pilot_gate");
    const push = build.steps.find(({ id }) => id === "corten_pilot_push");
    expect(build.strategy.matrix.pilot).toContain("marketplace");
    expect(gate.run).toContain("digitalocean-registry-gc-gate.mjs assert-writable");
    expect(gate.run).toContain("/chase-sets-corten-${PILOT}:");
    expect(push.if).toBe("steps.corten_pilot_gate.outcome == 'success'");
    expect(push.run).toContain('--file "Dockerfile.corten-${PILOT}"');
    expect(push.run).toContain('--cache-to "type=gha,scope=corten-${PILOT}-image,mode=max"');
    expect(build.steps.find(({ id }) => id === "corten_pilot_image").run).toContain(
      'echo "corten_${PILOT}_image=${IMAGE_REF}"',
    );
    expect(build.outputs.corten_marketplace_image).toBe(
      "${{ steps.corten_pilot_image.outputs.corten_marketplace_image }}",
    );
    expect(JSON.stringify(workflow.jobs["build-image"])).not.toContain("corten");
    const deploy = workflow.jobs["deploy-staging"].steps.find(({ id }) => id === "staging_kubernetes_deploy");
    expect(deploy.env.CORTEN_MARKETPLACE_IMAGE).toBe(
      "${{ needs.build-corten-pilot-images.outputs.corten_marketplace_image }}",
    );
    expect(deploy.run).toContain(
      'if [ -n "${CORTEN_MARKETPLACE_IMAGE:-}" ]; then\n  corten_image_args+=(--corten-marketplace-image "$CORTEN_MARKETPLACE_IMAGE")\nelse\n',
    );
    expect(JSON.stringify(workflow.jobs["deploy-production"])).not.toContain("corten_marketplace_image");
    expect(JSON.stringify(workflow.jobs["deploy-production"])).not.toContain("corten-marketplace");
  });

  it("only reports from the advisory step, which never fails Deploy Staging or signs in", () => {
    const steps = workflow.jobs["deploy-staging"].steps;
    const index = steps.findIndex(({ name }) => name === "Advisory Corten marketplace smoke");
    const smoke = steps[index];
    expect(steps[index - 1].name).toBe("Advisory Corten admin smoke");
    expect(smoke["continue-on-error"]).toBe(true);
    expect(smoke.if).toBe(steps.find(({ name }) => name === "Smoke check").if);
    expect(JSON.stringify(smoke)).not.toMatch(/PLATFORM_ADMIN_(EMAIL|PASSWORD)/);
    const smokeCheckSecrets = new Set(
      JSON.stringify(steps.find(({ name }) => name === "Smoke check")).match(/secrets\.[A-Z_]+/g),
    );
    for (const secret of JSON.stringify(smoke).match(/secrets\.[A-Z_]+/g) ?? []) {
      expect(smokeCheckSecrets.has(secret), secret).toBe(true);
    }
    expect(smoke.env.MARKETPLACE_APP).toBe("${{ steps.staging_kubernetes_deploy.outputs.marketplace_app }}");
    expect(smoke.run).toMatch(/if \[ "\$MARKETPLACE_APP" != "marketplace" \]; then\n[^\n]*\n\s*exit 0\n\s*fi/);
    expect(smoke.run).not.toContain("smoke:");
    expect(smoke.run).not.toContain("platform-ingress-wait");
  });

  it("serves marketplace.staging and the staging root from STAGING_MARKETPLACE_APP, the Corten marketplace by default", () => {
    const withApp = (base, STAGING_MARKETPLACE_APP) => ({
      ...base,
      env: { ...base.env, STAGING_MARKETPLACE_APP },
    });
    const ingress = (env) =>
      Object.fromEntries(
        buildDoksIngressValues({ environment: "staging", env: { DOKS_INGRESS_TARGET: "192.0.2.1", ...env } }).hosts.map(
          ({ host, paths }) => [host, paths.find(({ path }) => path === "/").service],
        ),
      );
    for (const value of [undefined, "", "marketplace-corten"]) {
      const hosts = ingress({ STAGING_MARKETPLACE_APP: value });
      expect(hosts["marketplace.staging.chasesets.com"]).toBe("marketplace-corten");
      expect(hosts["staging.chasesets.com"]).toBe("marketplace-corten");
      expect(hosts["marketplace-corten.staging.chasesets.com"]).toBe("marketplace-corten");
      expect(withheldCortenPilots(withApp(options, value))).not.toContain("marketplace-corten");
      const args = buildHelmUpgradeArgs(withApp(options, value));
      expect(args).toContain(`components.marketplace-corten.image=${image}`);
      expect(args).not.toContain("components.marketplace-corten.enabled=false");
      // Serving the host, a missing image refuses the deploy.
      expect(() => buildHelmUpgradeArgs(withApp({ ...options, cortenMarketplaceImage: undefined }, value))).toThrow(
        "corten-marketplace-image is required on staging",
      );
    }
    // Rolled back: marketplace-web serves both hosts, and the pilot is not deployed, image or not.
    const rolledBack = ingress({ STAGING_MARKETPLACE_APP: "marketplace" });
    expect(rolledBack["marketplace.staging.chasesets.com"]).toBe("marketplace");
    expect(rolledBack["staging.chasesets.com"]).toBe("marketplace");
    for (const base of [options, { ...options, cortenMarketplaceImage: undefined }]) {
      expect(withheldCortenPilots(withApp(base, "marketplace"))).toContain("marketplace-corten");
      const args = buildHelmUpgradeArgs(withApp(base, "marketplace"));
      expect(args.filter((arg) => String(arg).startsWith("components.marketplace-corten."))).toEqual([
        "components.marketplace-corten.enabled=false",
      ]);
    }
    for (const value of ["marketplace-web", "Marketplace", "corten", "marketplace,marketplace-corten"]) {
      expect(() => buildHelmUpgradeArgs(withApp(options, value))).toThrow("STAGING_MARKETPLACE_APP must be one of");
    }
    // Production never reads it.
    expect(
      withheldCortenPilots({
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "production" },
        env: { STAGING_MARKETPLACE_APP: "marketplace" },
      }),
    ).not.toContain("marketplace-corten");
  });

  it("says which app served the marketplace, in the summary, the step output and the deploy record", () => {
    const dir = mkdtempSync(join(tmpdir(), "staging-marketplace-app-"));
    try {
      const record = (env) => {
        const summary = join(dir, `summary-${env.STAGING_MARKETPLACE_APP ?? "unset"}.md`);
        const output = join(dir, `output-${env.STAGING_MARKETPLACE_APP ?? "unset"}.txt`);
        const result = recordStagingMarketplaceApp({ env, githubSummaryPath: summary, githubOutputPath: output });
        return { result, summary: read(summary), output: read(output) };
      };
      const unset = record({});
      expect(unset.result).toEqual({ app: "marketplace-corten", source: "default", marketplaceCorten: "deployed" });
      expect(unset.summary).toBe(
        "### Staging marketplace app\n\n" +
          "marketplace.staging is served by marketplace-corten (STAGING_MARKETPLACE_APP is unset, so the default applies).\n\n",
      );
      expect(unset.output).toBe("marketplace_app=marketplace-corten\nmarketplace_app_source=default\n");
      const rolledBack = record({ STAGING_MARKETPLACE_APP: "marketplace" });
      expect(rolledBack.result).toEqual({ app: "marketplace", source: "variable", marketplaceCorten: "not-deployed" });
      expect(rolledBack.summary).toBe(
        "### Staging marketplace app\n\n" +
          "marketplace.staging is served by marketplace (STAGING_MARKETPLACE_APP=marketplace).\n\n" +
          "marketplace-corten is not deployed while marketplace-web serves marketplace.staging.\n\n",
      );
      expect(rolledBack.output).toBe("marketplace_app=marketplace\nmarketplace_app_source=variable\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const evidence = (env) => buildDeploymentEvidence({ ...options, env, workloads: {} }).stagingMarketplaceApp;
    expect(evidence({})).toEqual({ app: "marketplace-corten", source: "default", marketplaceCorten: "deployed" });
    expect(evidence({ STAGING_MARKETPLACE_APP: "marketplace" })).toEqual({
      app: "marketplace",
      source: "variable",
      marketplaceCorten: "not-deployed",
    });
  });

  it("reads the variable once, in Deploy Staging only, and smokes a signed-in page on whichever app serves", () => {
    const job = workflow.jobs["deploy-staging"];
    expect(job.env.STAGING_MARKETPLACE_APP).toBe("${{ vars.STAGING_MARKETPLACE_APP || '' }}");
    expect(job.env).not.toHaveProperty("STAGING_MARKETPLACE_PILOT");
    for (const step of job.steps) expect(String(step.run ?? "")).not.toMatch(/\$\{?STAGING_MARKETPLACE_APP/);
    expect(JSON.stringify(workflow.jobs["deploy-production"])).not.toContain("STAGING_MARKETPLACE_APP");
    const wait = job.steps.find(({ name }) => name === "Wait for staging ingress URLs");
    const smoke = job.steps.find(({ name }) => name === "Smoke check");
    for (const step of [wait, smoke]) {
      expect(step.env.MARKETPLACE_APP).toBe("${{ steps.staging_kubernetes_deploy.outputs.marketplace_app }}");
      expect(step.run).toMatch(
        /if \[ "\$MARKETPLACE_APP" != "marketplace" \]; then\n[\s\S]*?https:\/\/marketplace-corten\.staging\.chasesets\.com\/health\/ready[\s\S]*?\n\s*fi/,
      );
    }
    expect(smoke.env.SMOKE_REQUIRE_MARKETPLACE_SIGNED_IN).toBe("true");
    expect(smoke.env.PLATFORM_ADMIN_EMAIL).toBe("${{ secrets.PLATFORM_ADMIN_EMAIL }}");
    expect(smoke.run).toContain('"https://${marketplace_domain}"');
    // The production Smoke check is unchanged and does not sign in on the marketplace.
    expect(JSON.stringify(workflow.jobs["deploy-production"])).not.toContain("SMOKE_REQUIRE_MARKETPLACE_SIGNED_IN");
    const platformSmoke = read("scripts/platform-smoke.mjs");
    expect(platformSmoke).toContain('readBooleanEnv("SMOKE_REQUIRE_MARKETPLACE_SIGNED_IN", false)');
    expect(platformSmoke).toContain("`${marketplaceOrigin}/account`");
    const runbook = read("docs/runbooks/staging-marketplace-app.md");
    expect(runbook).toContain(
      "gh variable set STAGING_MARKETPLACE_APP --repo chase-sets/chase-sets --env staging --body marketplace",
    );
    expect(runbook).toContain("gh variable delete STAGING_MARKETPLACE_APP --repo chase-sets/chase-sets --env staging");
  });
});
