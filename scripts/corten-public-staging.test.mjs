import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
const image = `registry.digitalocean.com/chase-sets/chase-sets-corten-public@${digest}`;
const options = {
  image: `registry.digitalocean.com/chase-sets/chase-sets-platform:release@${digest}`,
  cortenPublicImage: image,
  // admin-corten and marketplace-corten serve admin.staging and marketplace.staging, so a staging deploy needs
  // their images too.
  cortenAdminImage: `registry.digitalocean.com/chase-sets/chase-sets-corten-admin@${digest}`,
  cortenMarketplaceImage: `registry.digitalocean.com/chase-sets/chase-sets-corten-marketplace@${digest}`,
  envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging", OBSERVABILITY_ENABLED: "false" },
  env: { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" },
  managedPostgresCaSha256: "b".repeat(64),
};
const workload = "chase-sets-platform-chase-sets-platform-public-corten";

// The first slice built the public pilot's image and named its staging host. The second enabled the staging
// workload, had Deploy Staging pass the image, and walked the public routes on it advisorily. The switch has it
// serve www.staging, with public-web one variable (STAGING_PUBLIC_APP) away, so a missing image now fails the deploy.
describe("Corten public staging, first slice", () => {
  it("preserves every production job byte-for-byte", () => {
    const expected = {
      "reconcile-production-marker": "6e7171774b3d654c0dcd81d993140ebcfb0bf8436d05c7a5809c7137b5f2c317",
      "reconcile-managed-postgres-ca-production": "2a089333675961592792931dc522f4a8725e1f4b2f8688a0a7ecbb5a3246f389",
      // Moved for the production public switch (PRODUCTION_PUBLIC_APP, the staged Corten public image, best-effort PROXIES),
      // then for retiring marketplace-web (no PRODUCTION_MARKETPLACE_APP).
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
      // Moved for retiring marketplace-web: the base values no longer carry the marketplace component,
      // and production no longer disables it.
      "values.yaml": "46cd205dd42a7275dbfff08c78df949a68cf8cb9b42f737d635ba7c89a6af5c3",
      // Then for retiring admin-web: production keeps no admin-web resources and disables it.
      // Then for retiring public-web: production keeps no public-web resources and disables it.
      "values.production.yaml": "79b7079f9bf88824a1cd41b1c3376cb009f26f5d7cfe7fd98df3dfeafe404af3",
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
    expect(hosts.filter(({ host }) => host.startsWith("public-corten."))).toEqual([
      {
        host: "public-corten.staging.chasesets.com",
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

  it.each(["Dockerfile.corten-public", "Dockerfile.corten-public.dockerignore"])(
    "selects Platform Deploy for the image's own input: %s",
    (file) => {
      expect(classifyChanges({ changedFiles: [file], workspaces: [] }).deployRequired).toBe(true);
    },
  );

  it("keeps the pilot out of base and preview values and preview workloads, and adds no production ingress host", () => {
    expect(buildPlatformHelmValues().components).not.toHaveProperty("public-corten");
    // Production declares it too (corten-public-production.test.mjs).
    expect(buildPlatformHelmProductionValues().components).toHaveProperty("public-corten");
    expect(read("infrastructure/helm/platform/values.preview.yaml")).not.toContain("public-corten");
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
    const component = buildPlatformHelmStagingValues().components["public-corten"];
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
      command: "exec /usr/local/bin/corten-pilot-public",
    });
    const env = Object.fromEntries(
      component.env.filter(({ secret }) => !secret).map(({ name, value }) => [name, value]),
    );
    expect(env).toMatchObject({
      HOST: "0.0.0.0",
      PORT: "8080",
      HOSTS: "public-corten.staging.chasesets.com,www.staging.chasesets.com",
      PUBLIC_PROTO: "https",
      PROXIES: "",
      CHASE_SETS_INTERNAL_API_ORIGIN: "",
      PLATFORM_API_ORIGIN: "",
      CHASE_SETS_PUBLIC_ORIGIN: "https://staging.chasesets.com",
      PUBLIC_WEB_ORIGIN: "https://staging.chasesets.com",
      CHASE_SETS_MARKETPLACE_ORIGIN: "https://marketplace.staging.chasesets.com",
      CHASE_SETS_PUBLIC_INDEXING: "false",
      CHASE_SETS_M86_DEVELOPER_PORTAL_READY: "false",
      DEPLOYMENT_ENVIRONMENT: "staging",
    });
    expect(env).not.toHaveProperty("CHASE_SETS_TRUST_FORWARDED_HEADERS");
    // Every secret it reads is one a deployed web host already reads from the same key.
    const secrets = component.env.filter(({ secret }) => secret);
    expect(secrets.map(({ name }) => name)).toEqual(["CHASE_SETS_DISCORD_INVITE_URL"]);
    const existing = new Set(
      [
        ...Object.values(buildPlatformHelmValues().components),
        buildPlatformHelmStagingValues().components["admin-corten"],
        buildPlatformHelmStagingValues().components["marketplace-corten"],
      ].flatMap((other) => (other.env ?? []).filter(({ secret }) => secret).map(({ secretKey }) => secretKey)),
    );
    for (const { name, secretKey } of secrets) {
      expect(secretKey).toBe(name);
      expect(existing.has(secretKey), secretKey).toBe(true);
    }
    expect(platformKubernetesWorkloads(options).deployments).toContain(workload);
    expect(droppedAdvisoryCortenPilots(options)).not.toContain("public-corten");
    // It serves www.staging, so it is no longer advisory: with no image the deploy refuses instead of removing
    // what serves the host.
    const withoutImage = { ...options, cortenPublicImage: undefined };
    expect(droppedAdvisoryCortenPilots(withoutImage)).not.toContain("public-corten");
    expect(() => buildHelmUpgradeArgs(withoutImage)).toThrow(
      "corten-public-image is required on staging: public-corten is not an advisory pilot.",
    );
  });

  it("pins the pilot image only on staging and refuses mutable or wrong-repository references", () => {
    expect(buildHelmUpgradeArgs(options)).toContain(`components.public-corten.image=${image}`);
    expect(parseArgs(["deploy", "--corten-public-image", image], {}).cortenPublicImage).toBe(image);
    const preview = {
      ...options,
      cortenAdminImage: undefined,
      cortenMarketplaceImage: undefined,
      envOverrides: { DEPLOYMENT_ENVIRONMENT: "preview" },
    };
    expect(() => buildHelmUpgradeArgs(preview)).toThrow("corten-public-image is staging and production only.");
    expect(() => buildHelmUpgradeArgs({ ...options, cortenPublicImage: image.split("@")[0] + ":latest" })).toThrow();
    for (const repository of ["chase-sets-platform", "chase-sets-corten-admin", "chase-sets-corten-marketplace"]) {
      expect(() =>
        buildHelmUpgradeArgs({
          ...options,
          cortenPublicImage: image.replace("chase-sets-corten-public", repository),
        }),
      ).toThrow("chase-sets-corten-public repository");
    }
    const both = buildHelmUpgradeArgs({
      ...options,
      cortenAdminImage: image.replace("corten-public", "corten-admin"),
    });
    expect(both).toContain(`components.admin-corten.image=${image.replace("corten-public", "corten-admin")}`);
    expect(both).toContain(`components.public-corten.image=${image}`);
  });

  it("builds exported assets before the locked public binary from pinned existing mirrors", () => {
    const dockerfile = read("Dockerfile.corten-public");
    const mirrors = JSON.parse(read("scripts/ci-image-sources.json")).sources;
    for (const reference of [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1])) {
      expect(mirrors.some(({ mirror, tag, digest: pinned }) => reference === `${mirror}:${tag}@${pinned}`)).toBe(true);
    }
    expect(dockerfile.indexOf("pnpm run deps:install")).toBeLessThan(
      dockerfile.indexOf("node --import tsx deployables/corten-pilot/scripts/export.mjs"),
    );
    expect(dockerfile.indexOf("scripts/export.mjs")).toBeLessThan(
      dockerfile.indexOf("cargo build --release --locked -p corten-pilot-public"),
    );
    expect(dockerfile).toContain(
      "COPY --from=build /app/deployables/corten-pilot/target/release/corten-pilot-public /usr/local/bin/corten-pilot-public",
    );
    expect(dockerfile).toContain("USER node");
    expect(read(".dockerignore")).toContain("\ndeployables/corten-pilot\n");
    expect(read("Dockerfile.corten-public.dockerignore")).not.toContain("\ndeployables/corten-pilot\n");
  });

  it("builds the image in the pilot images job with the same writer admission, and only Deploy Staging reads it", () => {
    const build = workflow.jobs["build-corten-pilot-images"];
    const gate = build.steps.find(({ id }) => id === "corten_pilot_gate");
    const push = build.steps.find(({ id }) => id === "corten_pilot_push");
    expect(build.strategy.matrix.pilot).toContain("public");
    expect(gate.run).toContain("digitalocean-registry-gc-gate.mjs assert-writable");
    expect(gate.run).toContain("/chase-sets-corten-${PILOT}:");
    expect(push.if).toBe("steps.corten_pilot_gate.outcome == 'success'");
    expect(push.run).toContain('--file "Dockerfile.corten-${PILOT}"');
    expect(push.run).toContain('--cache-to "type=gha,scope=corten-${PILOT}-image,mode=max"');
    expect(build.steps.find(({ id }) => id === "corten_pilot_image").run).toContain(
      'echo "corten_${PILOT}_image=${IMAGE_REF}"',
    );
    expect(build.outputs.corten_public_image).toBe("${{ steps.corten_pilot_image.outputs.corten_public_image }}");
    expect(JSON.stringify(workflow.jobs["build-image"])).not.toContain("corten");
    const deploy = workflow.jobs["deploy-staging"].steps.find(({ id }) => id === "staging_kubernetes_deploy");
    expect(deploy.env.CORTEN_PUBLIC_IMAGE).toBe("${{ needs.build-corten-pilot-images.outputs.corten_public_image }}");
    expect(deploy.run).toContain(
      'if [ -n "${CORTEN_PUBLIC_IMAGE:-}" ]; then\n  corten_image_args+=(--corten-public-image "$CORTEN_PUBLIC_IMAGE")\nelse\n',
    );
    // Production takes only the image Deploy Staging deployed (corten-public-production.test.mjs), never the build's.
    expect(JSON.stringify(workflow.jobs["deploy-production"])).not.toContain("build-corten-pilot-images");
  });

  it("requires pilot readiness in both the staging ingress wait and the Smoke check, with no advisory public step", () => {
    const steps = workflow.jobs["deploy-staging"].steps;
    const url = "https://public-corten.staging.chasesets.com/health/ready";
    const wait = steps.find(({ name }) => name === "Wait for staging ingress URLs");
    const smoke = steps.find(({ name }) => name === "Smoke check");
    // public-corten serves www.staging on every deploy, so neither check is gated.
    expect(wait.run).toContain(`  "${url}"\n`);
    expect(wait.run.split(url)).toHaveLength(2);
    expect(smoke.run).toContain(
      `node ./scripts/platform-ingress-wait.mjs \\\n  --attempts 1 \\\n  --expect-status 200 \\\n  --url "${url}"\n`,
    );
    expect(smoke.run.split(url)).toHaveLength(2);
    for (const step of [wait, smoke]) {
      expect(step.env ?? {}).not.toHaveProperty("PUBLIC_APP");
      expect(step.run).not.toMatch(/PUBLIC_APP/);
    }
    // The advisory step only reported which app served www.staging, so it is gone with public-web.
    expect(steps.map(({ name }) => name)).not.toContain("Advisory Corten public smoke");
  });

  it("serves www.staging from the Corten public app, whatever a leftover variable says", () => {
    const withLeftover = (base, STAGING_PUBLIC_APP) => ({ ...base, env: { ...base.env, STAGING_PUBLIC_APP } });
    const ingress = (env) =>
      Object.fromEntries(
        buildDoksIngressValues({ environment: "staging", env: { DOKS_INGRESS_TARGET: "192.0.2.1", ...env } }).hosts.map(
          ({ host, paths }) => [host, paths.find(({ path }) => path === "/").service],
        ),
      );
    const routedToApi = (env) =>
      buildDoksIngressValues({ environment: "staging", env: { DOKS_INGRESS_TARGET: "192.0.2.1", ...env } })
        .hosts.find(({ host }) => host === "www.staging.chasesets.com")
        .paths.filter(({ service }) => service === "platform-api")
        .map(({ path }) => path);
    for (const value of [undefined, "", "public-corten", "public-web", "not-an-app"]) {
      const hosts = ingress({ STAGING_PUBLIC_APP: value });
      expect(hosts["www.staging.chasesets.com"]).toBe("public-corten");
      expect(hosts["public-corten.staging.chasesets.com"]).toBe("public-corten");
      // The staging root stays with the marketplace.
      expect(hosts["staging.chasesets.com"]).toBe("marketplace-corten");
      const args = buildHelmUpgradeArgs(withLeftover(options, value));
      expect(args.filter((arg) => String(arg).startsWith("components.public-corten."))).toEqual([
        `components.public-corten.image=${image}`,
      ]);
      // Serving the host, a missing image refuses the deploy.
      expect(() => buildHelmUpgradeArgs(withLeftover({ ...options, cortenPublicImage: undefined }, value))).toThrow(
        "corten-public-image is required on staging",
      );
      expect(routedToApi({ STAGING_PUBLIC_APP: value })).toEqual(routedToApi({}));
    }
    expect(routedToApi({})).toEqual(expect.arrayContaining(["/mcp", "/ucp", "/.well-known", "/api"]));
  });

  it("no longer deploys public-web on staging or routes to it", () => {
    expect(buildPlatformHelmStagingValues().components["public-web"]).toEqual({ enabled: false });
    expect(read("infrastructure/helm/platform/values.staging.yaml")).toContain("  public-web:\n    enabled: false\n");
    const routes = JSON.stringify(
      buildDoksIngressValues({ environment: "staging", env: { DOKS_INGRESS_TARGET: "192.0.2.1" } }).hosts.flatMap(
        ({ paths }) => paths,
      ),
    );
    expect(routes).not.toContain('"service":"public-web"');
    expect(platformKubernetesWorkloads(options).deployments).not.toContain(
      "chase-sets-platform-chase-sets-platform-public-web",
    );
  });

  it("keeps no public app in the deploy record", () => {
    for (const env of [{}, { STAGING_PUBLIC_APP: "public-web" }]) {
      const evidence = buildDeploymentEvidence({ ...options, env, workloads: {} });
      expect(evidence).not.toHaveProperty("stagingPublicApp");
      expect(evidence).not.toHaveProperty("productionPublicApp");
    }
  });

  it("reads no public app variable in Deploy Staging and walks the public routes on www.staging", () => {
    const job = workflow.jobs["deploy-staging"];
    expect(job.environment).toBe("staging");
    expect(job.env).not.toHaveProperty("STAGING_PUBLIC_APP");
    expect(job.outputs).not.toHaveProperty("public_app");
    expect(workflowText).not.toMatch(/STAGING_PUBLIC_APP|STAGING_PUBLIC_PILOT/);
    const smoke = job.steps.find(({ name }) => name === "Smoke check");
    // The enforcing Smoke check walks the derived public routes on landing_domain (www.staging) in healthy mode.
    expect(smoke.run).toContain('landing_domain="$(terraform output -raw landing_domain)"');
    expect(smoke.run).toContain('"https://${landing_domain}"');
    expect(smoke.env).not.toHaveProperty("SMOKE_REQUIRE_LANDING");
    const platformSmoke = read("scripts/platform-smoke.mjs");
    expect(platformSmoke).toContain('readBooleanEnv("SMOKE_REQUIRE_LANDING", true)');
    expect(platformSmoke).toMatch(/smokePublicWebRoutes\(\{\s*baseUrl: landingUrl,\s*mode: "healthy",/);
    expect(read("infrastructure/digitalocean/platform/locals.tf")).toContain(
      'local.is_staging ? "www.${var.environment}.${var.root_domain}"',
    );
    const runbook = read("docs/runbooks/staging-public-app.md");
    expect(runbook).toContain("public-corten serves www.staging on every staging deploy.");
    expect(runbook).toContain("To roll back, deploy an earlier release_ref.");
    expect(runbook).not.toContain("gh variable set STAGING_PUBLIC_APP");
  });
});
