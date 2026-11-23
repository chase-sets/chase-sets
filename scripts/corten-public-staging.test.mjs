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
  recordStagingPublicPilot,
  withheldCortenPilots,
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
  // admin-corten serves admin.staging, so a staging deploy needs its image too.
  cortenAdminImage: `registry.digitalocean.com/chase-sets/chase-sets-corten-admin@${digest}`,
  envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging", OBSERVABILITY_ENABLED: "false" },
  env: { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" },
  managedPostgresCaSha256: "b".repeat(64),
};
const workload = "chase-sets-platform-chase-sets-platform-public-corten";

// The first slice built the public pilot's image and named its staging host. The second enables the staging
// workload, has Deploy Staging pass the image, and walks the public routes on it advisorily. With no image the
// deploy drops it.
describe("Corten public staging, first slice", () => {
  it("preserves every production job byte-for-byte", () => {
    const expected = {
      "reconcile-production-marker": "6e7171774b3d654c0dcd81d993140ebcfb0bf8436d05c7a5809c7137b5f2c317",
      "reconcile-managed-postgres-ca-production": "2a089333675961592792931dc522f4a8725e1f4b2f8688a0a7ecbb5a3246f389",
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
      "values.yaml": "fc374d3d46b6998cf31a553f16edbdbfd10e1c194f5e0c9e8e3ba1871dccbf6c",
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

  it("keeps the pilot out of base, production and preview values and production ingress", () => {
    expect(buildPlatformHelmValues().components).not.toHaveProperty("public-corten");
    expect(buildPlatformHelmProductionValues().components).not.toHaveProperty("public-corten");
    expect(read("infrastructure/helm/platform/values.preview.yaml")).not.toContain("public-corten");
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
      HOSTS: "public-corten.staging.chasesets.com",
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
    // With no image the advisory pilot is deployed disabled, so the release neither runs nor waits for it.
    const withoutImage = { ...options, cortenPublicImage: undefined };
    expect(droppedAdvisoryCortenPilots(withoutImage)).toContain("public-corten");
    expect(buildHelmUpgradeArgs(withoutImage)).toContain("components.public-corten.enabled=false");
  });

  it("pins the pilot image only on staging and refuses mutable or wrong-repository references", () => {
    expect(buildHelmUpgradeArgs(options)).toContain(`components.public-corten.image=${image}`);
    expect(parseArgs(["deploy", "--corten-public-image", image], {}).cortenPublicImage).toBe(image);
    for (const environment of ["production", "preview"]) {
      const elsewhere = {
        ...options,
        cortenAdminImage: undefined,
        envOverrides: { DEPLOYMENT_ENVIRONMENT: environment },
      };
      expect(() => buildHelmUpgradeArgs(elsewhere)).toThrow("corten-public-image is staging-only.");
    }
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
      'if [ -n "${CORTEN_PUBLIC_IMAGE:-}" ]; then\n  corten_image_args+=(--corten-public-image "$CORTEN_PUBLIC_IMAGE")\nfi',
    );
    expect(JSON.stringify(workflow.jobs["deploy-production"])).not.toContain("corten_public_image");
    expect(JSON.stringify(workflow.jobs["deploy-production"])).not.toContain("corten-public");
  });

  it("walks the public routes on the pilot after the other pilot smokes, never failing Deploy Staging", () => {
    const steps = workflow.jobs["deploy-staging"].steps;
    const index = steps.findIndex(({ name }) => name === "Advisory Corten public smoke");
    const smoke = steps[index];
    expect(steps[index - 1].name).toBe("Advisory Corten marketplace smoke");
    expect(smoke["continue-on-error"]).toBe(true);
    expect(smoke["timeout-minutes"]).toBe(15);
    expect(smoke.if).toBe(steps.find(({ name }) => name === "Smoke check").if);
    // It reads no secret at all.
    expect(smoke.env).toEqual({
      CORTEN_PUBLIC_IMAGE: "${{ needs.build-corten-pilot-images.outputs.corten_public_image }}",
      PUBLIC_PILOT: "${{ steps.staging_kubernetes_deploy.outputs.public_pilot }}",
    });
    expect(JSON.stringify(smoke)).not.toContain("secrets.");
    expect(smoke.run).not.toContain("set -x");
    // With no image the pilot was dropped, so there is nothing to smoke.
    expect(smoke.run).toMatch(/if \[ -z "\$\{CORTEN_PUBLIC_IMAGE:-\}" \]; then\n[^\n]*\n\s*exit 0\n\s*fi/);
    expect(smoke.run).toContain('--url "https://public-corten.staging.chasesets.com/health/ready"');
    // The same derived route walk and mode the Smoke check runs against public-web.
    expect(smoke.run).toContain(
      'pnpm run smoke:public-web-routes -- \\\n  --base-url "https://public-corten.staging.chasesets.com" \\\n  --mode healthy',
    );
  });

  it("withholds the pilot with STAGING_PUBLIC_PILOT, whether or not its image was given", () => {
    const withPilot = (base, STAGING_PUBLIC_PILOT) => ({ ...base, env: { ...base.env, STAGING_PUBLIC_PILOT } });
    const withoutImage = { ...options, cortenPublicImage: undefined };
    for (const value of [undefined, "", "deployed"]) {
      expect(withheldCortenPilots(withPilot(options, value))).not.toContain("public-corten");
      const args = buildHelmUpgradeArgs(withPilot(options, value));
      expect(args).toContain(`components.public-corten.image=${image}`);
      expect(args).not.toContain("components.public-corten.enabled=false");
    }
    for (const base of [options, withoutImage]) {
      expect(withheldCortenPilots(withPilot(base, "withheld"))).toContain("public-corten");
      const args = buildHelmUpgradeArgs(withPilot(base, "withheld"));
      expect(args.filter((arg) => String(arg).startsWith("components.public-corten."))).toEqual([
        "components.public-corten.enabled=false",
      ]);
    }
    for (const value of ["withhold", "Withheld", "disabled", "deployed,withheld"]) {
      expect(() => buildHelmUpgradeArgs(withPilot(options, value))).toThrow("STAGING_PUBLIC_PILOT must be one of");
    }
    // Each pilot answers only to its own variable.
    expect(withheldCortenPilots(withPilot(options, "withheld"))).not.toContain("marketplace-corten");
    expect(
      withheldCortenPilots({ ...options, env: { ...options.env, STAGING_MARKETPLACE_PILOT: "withheld" } }),
    ).not.toContain("public-corten");
    expect(
      withheldCortenPilots({
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "production" },
        env: { STAGING_PUBLIC_PILOT: "withheld" },
      }),
    ).not.toContain("public-corten");
  });

  it("says whether the pilot was deployed, in the summary, the step output and the deploy record", () => {
    const dir = mkdtempSync(join(tmpdir(), "staging-public-pilot-"));
    try {
      const record = (env) => {
        const summary = join(dir, `summary-${env.STAGING_PUBLIC_PILOT ?? "unset"}.md`);
        const output = join(dir, `output-${env.STAGING_PUBLIC_PILOT ?? "unset"}.txt`);
        const result = recordStagingPublicPilot({ env, githubSummaryPath: summary, githubOutputPath: output });
        return { result, summary: read(summary), output: read(output) };
      };
      const unset = record({});
      expect(unset.result).toEqual({ state: "deployed", source: "default" });
      expect(unset.output).toBe("public_pilot=deployed\n");
      const withheld = record({ STAGING_PUBLIC_PILOT: "withheld" });
      expect(withheld.result).toEqual({ state: "withheld", source: "variable" });
      expect(withheld.summary).toBe(
        "### Staging public pilot\n\n" +
          "public-corten is not deployed on staging (STAGING_PUBLIC_PILOT=withheld).\n\n",
      );
      expect(withheld.output).toBe("public_pilot=withheld\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const evidence = (env) => buildDeploymentEvidence({ ...options, env, workloads: {} }).stagingPublicPilot;
    expect(evidence({})).toEqual({ state: "deployed", source: "default" });
    expect(evidence({ STAGING_PUBLIC_PILOT: "withheld" })).toEqual({ state: "withheld", source: "variable" });
  });

  it("reads the variable once, in Deploy Staging only, and skips the smoke while the pilot is withheld", () => {
    const job = workflow.jobs["deploy-staging"];
    expect(job.env.STAGING_PUBLIC_PILOT).toBe("${{ vars.STAGING_PUBLIC_PILOT || '' }}");
    for (const step of job.steps) expect(String(step.run ?? "")).not.toMatch(/\$\{?STAGING_PUBLIC_PILOT/);
    expect(JSON.stringify(workflow.jobs["deploy-production"])).not.toContain("STAGING_PUBLIC_PILOT");
    const smoke = job.steps.find(({ name }) => name === "Advisory Corten public smoke");
    expect(smoke.env.PUBLIC_PILOT).toBe("${{ steps.staging_kubernetes_deploy.outputs.public_pilot }}");
    expect(smoke.run).toMatch(/if \[ "\$PUBLIC_PILOT" = "withheld" \]; then\n[^\n]*\n\s*exit 0\n\s*fi/);
    expect(read("docs/runbooks/staging-public-pilot.md")).toContain(
      "gh variable set STAGING_PUBLIC_PILOT --repo chase-sets/chase-sets --env staging --body withheld",
    );
  });
});
