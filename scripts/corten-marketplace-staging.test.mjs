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
  // admin-corten and public-corten serve admin.staging and www.staging, so a staging deploy needs their images too.
  cortenAdminImage: image.replace("corten-marketplace", "corten-admin"),
  cortenPublicImage: `registry.digitalocean.com/chase-sets/chase-sets-corten-public@${digest}`,
  envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging", OBSERVABILITY_ENABLED: "false" },
  env: { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" },
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
      // Moved for the production admin and public switches (PRODUCTION_ADMIN_APP, PRODUCTION_PUBLIC_APP), the staged Corten
      // images and best-effort PROXIES, then for retiring marketplace-web: no PRODUCTION_MARKETPLACE_APP, and the
      // marketplace signed-in smoke runs whenever production serves a marketplace.
      // Then for retiring admin-web: no PRODUCTION_ADMIN_APP, and admin-corten is always readied and smoked.
      // Then for retiring public-web: no PRODUCTION_PUBLIC_APP, and public-corten is always deployed.
      "deploy-production": "0034948c6b90b335f808e6ed2e551295e3ca47aa3f74b5acaa857769b2d5ce05",
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
      // Moved for retiring marketplace-web: the chart has no marketplace component.
      // Then for retiring public-web: the base values no longer carry the public-web component.
      "values.yaml": "a89b9bf980f0f88d66a328159214ffe66e674b390eb6f978d5afdb2afbb8851d",
      // Then for retiring admin-web: production keeps no admin-web resources and disables it.
      // Then for retiring public-web: production keeps no public-web resources and disables it.
      // Then for removing public-web from the base values: production no longer needs to disable it.
      "values.production.yaml": "ffad93ff3250226b95a9c41b9df3d532d9adeb0dfb981b301978c793be311f63",
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

  it("keeps the pilot out of base and preview values and preview workloads, and adds no production ingress host", () => {
    expect(buildPlatformHelmValues().components).not.toHaveProperty("marketplace-corten");
    // Production declares and serves it (corten-marketplace-production.test.mjs).
    expect(buildPlatformHelmProductionValues().components).toHaveProperty("marketplace-corten");
    expect(read("infrastructure/helm/platform/values.preview.yaml")).not.toContain("marketplace-corten");
    expect(
      platformKubernetesWorkloads({ envOverrides: { DEPLOYMENT_ENVIRONMENT: "preview" } }).deployments,
    ).not.toContain(workload);
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
    expect(() =>
      buildHelmUpgradeArgs({
        ...options,
        cortenAdminImage: undefined,
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "preview" },
      }),
    ).toThrow("corten-marketplace-image is staging and production only.");
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
    // Both pilots pinned: admin-corten serves admin.staging.
    const both = buildHelmUpgradeArgs(options);
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
    // Production takes only the image Deploy Staging deployed (corten-marketplace-production.test.mjs), never the build's.
    expect(JSON.stringify(workflow.jobs["deploy-production"])).not.toContain("build-corten-pilot-images");
  });

  it("has no advisory marketplace step: the enforcing checks cover the pilot that serves marketplace.staging", () => {
    const steps = workflow.jobs["deploy-staging"].steps.map(({ name }) => name);
    expect(steps).not.toContain("Advisory Corten marketplace smoke");
    expect(steps).not.toContain("Advisory Corten admin smoke");
    expect(steps).not.toContain("Advisory Corten public smoke");
    expect(JSON.parse(read("package.json")).scripts).not.toHaveProperty("smoke:corten-marketplace");
  });

  it("serves marketplace.staging and the staging root from the Corten marketplace, whatever a leftover variable says", () => {
    const ingress = (env) =>
      Object.fromEntries(
        buildDoksIngressValues({ environment: "staging", env: { DOKS_INGRESS_TARGET: "192.0.2.1", ...env } }).hosts.map(
          ({ host, paths }) => [host, paths.find(({ path }) => path === "/").service],
        ),
      );
    for (const STAGING_MARKETPLACE_APP of [undefined, "marketplace"]) {
      const hosts = ingress({ STAGING_MARKETPLACE_APP });
      expect(hosts["marketplace.staging.chasesets.com"]).toBe("marketplace-corten");
      expect(hosts["staging.chasesets.com"]).toBe("marketplace-corten");
      expect(hosts["marketplace-corten.staging.chasesets.com"]).toBe("marketplace-corten");
      const withEnv = { ...options, env: { ...options.env, STAGING_MARKETPLACE_APP } };
      const args = buildHelmUpgradeArgs(withEnv);
      expect(args.filter((arg) => String(arg).startsWith("components.marketplace-corten."))).toEqual([
        `components.marketplace-corten.image=${image}`,
      ]);
      expect(() => buildHelmUpgradeArgs({ ...withEnv, cortenMarketplaceImage: undefined })).toThrow(
        "corten-marketplace-image is required on staging",
      );
    }
    // marketplace-web is no longer deployed on staging, and no ingress path reaches it.
    expect(buildPlatformHelmStagingValues().components).not.toHaveProperty("marketplace");
    expect(Object.values(ingress({}))).not.toContain("marketplace");
    const { deployments, rollouts } = platformKubernetesWorkloads(options);
    expect([...deployments, ...rollouts]).not.toContain("chase-sets-platform-chase-sets-platform-marketplace");
  });

  it("keeps no marketplace app in the staging deploy record", () => {
    const evidence = buildDeploymentEvidence({
      ...options,
      env: { ...options.env, STAGING_MARKETPLACE_APP: "marketplace" },
      workloads: {},
    });
    expect(evidence).not.toHaveProperty("stagingMarketplaceApp");
  });

  it("reads no marketplace variable, and always waits for and smokes the Corten marketplace signed in", () => {
    const job = workflow.jobs["deploy-staging"];
    expect(workflowText).not.toMatch(/STAGING_MARKETPLACE_(APP|PILOT)/);
    expect(job.outputs).not.toHaveProperty("marketplace_app");
    const wait = job.steps.find(({ name }) => name === "Wait for staging ingress URLs");
    const smoke = job.steps.find(({ name }) => name === "Smoke check");
    for (const step of [wait, smoke]) {
      expect(step.env).not.toHaveProperty("MARKETPLACE_APP");
      expect(step.run).toContain("https://marketplace-corten.staging.chasesets.com/health/ready");
      expect(step.run).not.toContain('"$MARKETPLACE_APP"');
    }
    expect(smoke.env.SMOKE_REQUIRE_MARKETPLACE_SIGNED_IN).toBe("true");
    expect(smoke.env.PLATFORM_ADMIN_EMAIL).toBe("${{ secrets.PLATFORM_ADMIN_EMAIL }}");
    expect(smoke.run).toContain('"https://${marketplace_domain}"');
    const platformSmoke = read("scripts/platform-smoke.mjs");
    expect(platformSmoke).toContain('readBooleanEnv("SMOKE_REQUIRE_MARKETPLACE_SIGNED_IN", false)');
    expect(platformSmoke).toContain("`${marketplaceOrigin}/account`");
    const runbook = read("docs/runbooks/staging-marketplace-app.md");
    expect(runbook).toContain("Rollback is reverting to an earlier release");
    expect(runbook).not.toContain("gh variable");
  });
});
