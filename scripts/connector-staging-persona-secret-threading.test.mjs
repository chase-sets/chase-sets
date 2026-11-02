import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildPlatformSecretBundle, collectPlatformSecretKeys } from "./platform-kubernetes-secret.mjs";
import { buildPlatformHelmValues } from "./render-platform-helm-values.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("connector staging persona verifier threading", () => {
  it("keeps the dedicated verifier in staging inventory and runtime wiring only", () => {
    const workflow = read(".github/workflows/platform-production.yml");
    const helm = read("infrastructure/helm/platform/values.staging.yaml");
    const values = JSON.parse(read("infrastructure/helm/platform/runtime-values.json"));
    const inventory = JSON.parse(read(".github/credential-inventory.json"));
    const verifier = "CONNECTOR_STAGING_PERSONA_MAGIC_LINK_VERIFIER_SHA256";

    expect(workflow).toContain(verifier);
    expect(helm).toContain(verifier);
    expect(values.stagingApiEnv).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: verifier, secret: true })]),
    );
    expect(inventory.secrets).not.toContainEqual(
      expect.objectContaining({ name: verifier, scope: expect.arrayContaining(["production"]) }),
    );
    expect(workflow.match(new RegExp(verifier, "g"))).toHaveLength(2);
    const jobs = parse(workflow).jobs;
    const stagingSteps = jobs["deploy-staging"].steps;
    expect(stagingSteps.find((step) => step.name === "Deploy staging Kubernetes release")).toBeDefined();
    expect(
      JSON.stringify(stagingSteps.find((step) => step.name === "Deploy staging Kubernetes release")),
    ).not.toContain(verifier);
    expect(workflow).toContain(`${verifier}: \${{ secrets.${verifier} || '' }}`);
    for (const [job, value] of Object.entries(jobs))
      if (job !== "deploy-staging") expect(JSON.stringify(value)).not.toContain(verifier);
    const keyringBindings = stagingSteps.flatMap((step) =>
      step.env?.CHANNELS_CREDENTIAL_KEYRING_JSON ? [step.env.CHANNELS_CREDENTIAL_KEYRING_JSON] : [],
    );
    expect(keyringBindings.length).toBeGreaterThan(0);
    for (const value of keyringBindings) expect(value).not.toContain(verifier);
    for (const component of ["platform-worker", "platform-bootstrap"]) {
      expect(
        JSON.stringify(
          buildPlatformHelmValues({ repoRoot: process.cwd(), deploymentEnvironment: "staging" }).components[component],
        ),
      ).not.toContain(verifier);
    }
    expect(
      JSON.stringify(buildPlatformHelmValues({ repoRoot: process.cwd(), deploymentEnvironment: "production" })),
    ).not.toContain(verifier);
    const raw = "CONNECTOR_STAGING_PERSONA_MAGIC_LINK_SECRET";
    expect(workflow).not.toContain(raw);
    expect(JSON.stringify(values)).not.toContain(raw);
    expect(inventory.secrets.find((entry) => entry.name === raw)).toEqual({
      name: raw,
      scope: ["staging"],
      kind: "credential",
      rotation: "assisted",
      maxAgeDays: 365,
      providerExpiryDays: null,
      liveness: null,
      pairedWith: [],
      proofWorkflows: [],
    });
    expect(inventory.agentTier.keys).toContainEqual({ name: raw, testPrefixes: ["cs_stg_persona_"] });
    expect(inventory.agentTier.keys.some((entry) => entry.name === verifier)).toBe(false);
    const env = Object.fromEntries(
      collectPlatformSecretKeys(undefined, { deploymentEnvironment: "staging" }).map((key) => [key, ""]),
    );
    const bundle = buildPlatformSecretBundle({ deploymentEnvironment: "staging", env, observabilityEnabled: false });
    expect(bundle.runtimeSecret.data[verifier]).toBe("");
  });
});
