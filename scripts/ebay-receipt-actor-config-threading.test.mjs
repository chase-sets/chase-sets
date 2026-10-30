import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPlatformHelmStagingValues, buildPlatformHelmValues } from "./render-platform-helm-values.mjs";
import {
  buildPlatformSecretBundle,
  collectPlatformSecretKeys,
  summarizePlatformSecret,
} from "./platform-kubernetes-secret.mjs";
import { buildHelmUpgradeArgs } from "./platform-kubernetes-deployment.mjs";

const repoRoot = process.cwd();
const actorKey = "EBAY_RECEIPT_LOOKUP_STAGING_ACTOR_JSON";
const managedPostgresCaSha256 = "a".repeat(64);

describe("staging eBay receipt actor configuration threading", () => {
  it("keeps the staging workflow and authority grant on the same key", () => {
    const workflow = readFileSync(".github/workflows/platform-production.yml", "utf8");
    const authority = JSON.parse(readFileSync(".github/authority/platform-production/deploy-staging.json", "utf8"));
    expect(workflow).toContain(`${actorKey}: \${{ secrets.${actorKey} || '' }}`);
    expect(authority.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          secretName: actorKey,
          jobId: "deploy-staging",
          purpose: "application-runtime",
        }),
      ]),
    );
  });

  it("threads staging through the renderer, Secret collector, bundle, and summary", () => {
    const base = buildPlatformHelmValues({ repoRoot });
    const staging = buildPlatformHelmValues({ repoRoot, deploymentEnvironment: "staging" });
    const stagingOverlay = buildPlatformHelmStagingValues({ repoRoot });
    const baseApiEnv = base.components["platform-api"].env;
    const stagingApiEnv = staging.components["platform-api"].env;
    expect(stagingApiEnv).toEqual([...baseApiEnv, { name: actorKey, secret: true, secretKey: actorKey }]);
    expect(stagingOverlay.components["platform-api"].env).toEqual(stagingApiEnv);
    expect(staging.components["platform-worker"].env.some((entry) => entry.name === actorKey)).toBe(false);
    expect(staging.components["platform-bootstrap"].env.some((entry) => entry.name === actorKey)).toBe(false);
    expect(
      buildPlatformHelmValues({ repoRoot, deploymentEnvironment: "production" }).components["platform-api"].env,
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: actorKey })]));

    const keys = collectPlatformSecretKeys(undefined, { deploymentEnvironment: "staging" });
    expect(keys).toContain(actorKey);
    const env = Object.fromEntries(keys.map((key) => [key, ""]));
    const defaultBundle = buildPlatformSecretBundle({
      deploymentEnvironment: "staging",
      env,
      observabilityEnabled: false,
    });
    expect(defaultBundle.runtimeSecret.data[actorKey]).toBe("");
    expect(
      summarizePlatformSecret({ deploymentEnvironment: "staging", env, observabilityEnabled: false }).keys,
    ).toContain(actorKey);
    const bundle = buildPlatformSecretBundle({
      values: staging,
      deploymentEnvironment: "staging",
      env,
      observabilityEnabled: false,
    });
    expect(bundle.runtimeSecret.data[actorKey]).toBe("");
    expect(
      summarizePlatformSecret({ values: staging, deploymentEnvironment: "staging", env, observabilityEnabled: false })
        .keys,
    ).toContain(actorKey);
    const productionKeys = collectPlatformSecretKeys(undefined, { deploymentEnvironment: "production" });
    expect(productionKeys).not.toContain(actorKey);
    const productionEnv = Object.fromEntries(productionKeys.map((key) => [key, ""]));
    expect(
      buildPlatformSecretBundle({
        deploymentEnvironment: "production",
        env: productionEnv,
        observabilityEnabled: false,
      }).runtimeSecret.data,
    ).not.toHaveProperty(actorKey);
    expect(
      summarizePlatformSecret({ deploymentEnvironment: "production", env: productionEnv, observabilityEnabled: false })
        .keys,
    ).not.toContain(actorKey);
    expect(collectPlatformSecretKeys(undefined, { deploymentEnvironment: "preview" })).not.toContain(actorKey);
    expect(collectPlatformSecretKeys(undefined)).not.toContain(actorKey);
  });

  it("requires a non-optional staging pod replacement revision", () => {
    const stagingArgs = buildHelmUpgradeArgs({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      timeout: "10m",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:proof",
      managedPostgresCaSha256,
      envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
      env: { GITHUB_RUN_ID: "107110001", GITHUB_RUN_ATTEMPT: "2" },
    });
    expect(stagingArgs).toContain(
      "components.platform-api.podAnnotations.chase-sets\\.com/staging-runtime-revision=107110001-2",
    );
    const productionArgs = buildHelmUpgradeArgs({
      release: "chase-sets-platform",
      namespace: "chase-sets-platform",
      timeout: "10m",
      image: "registry.digitalocean.com/chase-sets/chase-sets-platform:proof",
      managedPostgresCaSha256,
      envOverrides: { DEPLOYMENT_ENVIRONMENT: "production" },
      env: { GITHUB_RUN_ID: "107110001", GITHUB_RUN_ATTEMPT: "2" },
    });
    expect(productionArgs.join(" ")).not.toContain("staging-runtime-revision");
    expect(() =>
      buildHelmUpgradeArgs({
        release: "chase-sets-platform",
        namespace: "chase-sets-platform",
        timeout: "10m",
        image: "registry.digitalocean.com/chase-sets/chase-sets-platform:proof",
        managedPostgresCaSha256,
        envOverrides: { DEPLOYMENT_ENVIRONMENT: "staging" },
        env: { GITHUB_RUN_ID: "0", GITHUB_RUN_ATTEMPT: "2" },
      }),
    ).toThrow("GITHUB_RUN_ID");
  });
});
