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
import { buildHelmUpgradeArgs, parseArgs, platformKubernetesWorkloads } from "./platform-kubernetes-deployment.mjs";
import { classifyChanges } from "./change-scope.mjs";

const read = (file) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");
const workflowText = read(".github/workflows/platform-production.yml");
const workflow = parse(workflowText);
const digest = "sha256:" + "a".repeat(64);
const image = `registry.digitalocean.com/chase-sets/chase-sets-corten-marketplace@${digest}`;
const options = {
  image: `registry.digitalocean.com/chase-sets/chase-sets-platform:release@${digest}`,
  cortenMarketplaceImage: image,
  envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging", OBSERVABILITY_ENABLED: "false" },
  env: { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" },
  managedPostgresCaSha256: "b".repeat(64),
};
const workload = "chase-sets-platform-chase-sets-platform-marketplace-corten";

// The first slice builds the marketplace pilot's image and declares its staging workload disabled and its DNS name.
// Deploy Staging does not pass the image yet, so nothing runs on staging until the workload is enabled with it.
describe("Corten marketplace staging, first slice", () => {
  it("preserves every production job byte-for-byte", () => {
    const expected = {
      "reconcile-production-marker": "6e7171774b3d654c0dcd81d993140ebcfb0bf8436d05c7a5809c7137b5f2c317",
      "reconcile-managed-postgres-ca-production": "2a089333675961592792931dc522f4a8725e1f4b2f8688a0a7ecbb5a3246f389",
      "deploy-production": "b2cff7ebb9ea3b5d64c01681b05d304c7b1df7c40f7a7984edc18cf5f01fb884",
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
      "values.yaml": "fc374d3d46b6998cf31a553f16edbdbfd10e1c194f5e0c9e8e3ba1871dccbf6c",
      "values.production.yaml": "71515689eabc8c257834810ef7fbb65b4f69cc71e054055c9005a08c6dffb81e",
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
    const current = (host, className, authorityAnchor) => ({
      host,
      status: "current",
      environment: "production",
      class: className,
      templated: false,
      authorityAnchor,
    });
    expect(hosts.filter(({ environment }) => environment === "production")).toEqual([
      current("admin.chasesets.com", "application", "A3"),
      current("admin.doks.chasesets.com", "diagnostic", "A6"),
      current("chasesets.com", "application", "A4"),
      current("doks.chasesets.com", "diagnostic", "A6"),
      current("grafana.chasesets.com", "service", "A10"),
      current("marketplace.chasesets.com", "application", "A3"),
      current("marketplace.doks.chasesets.com", "diagnostic", "A6"),
      current("otel.chasesets.com", "service", "A10"),
      current("prometheus.chasesets.com", "service", "A10"),
      current("www.chasesets.com", "application", "A3"),
      current("www.doks.chasesets.com", "diagnostic", "A6"),
      {
        host: "api.chasesets.com",
        status: "reserved",
        environment: "production",
        class: "application",
        templated: false,
        reservedFor:
          "Future public API and provider callbacks; docs/architecture/environment-domain-names.md#api-hosts",
      },
    ]);
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

  it("declares the staging workload disabled, with existing secrets only, until the deploy passes its image", () => {
    const component = buildPlatformHelmStagingValues().components["marketplace-corten"];
    expect(component).toMatchObject({
      enabled: false,
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
      HOSTS: "marketplace-corten.staging.chasesets.com",
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
    expect(platformKubernetesWorkloads(options).deployments).not.toContain(workload);
    expect(platformKubernetesWorkloads(options).deployments).toContain(
      "chase-sets-platform-chase-sets-platform-admin-corten",
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
    const both = buildHelmUpgradeArgs({
      ...options,
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

  it("builds the image after the admin pilot's with the same writer admission, and no deploy reads it yet", () => {
    const build = workflow.jobs["build-image"];
    const names = build.steps.map(({ name }) => name);
    const step = build.steps.find(({ id }) => id === "corten_marketplace_image");
    expect(names.indexOf("Build and push Corten marketplace image")).toBe(
      names.indexOf("Build and push Corten admin image") + 1,
    );
    expect(Object.keys(step.env).sort()).toEqual(["DIGITALOCEAN_ACCESS_TOKEN", "RELEASE_IMAGE"]);
    expect(step.run).toContain("digitalocean-registry-gc-gate.mjs assert-writable");
    expect(step.run.indexOf("assert-writable")).toBeLessThan(step.run.indexOf("--push --tag"));
    expect(step.run).toContain("--file Dockerfile.corten-marketplace");
    expect(step.run).toContain("/chase-sets-corten-marketplace:");
    expect(step.run).toContain("image=${image}@${digest}");
    expect(build.outputs.corten_marketplace_image).toBe("${{ steps.corten_marketplace_image.outputs.image }}");
    expect(JSON.stringify(workflow.jobs["deploy-staging"])).not.toContain("corten_marketplace_image");
    expect(JSON.stringify(workflow.jobs["deploy-staging"])).not.toContain("corten-marketplace");
  });
});
