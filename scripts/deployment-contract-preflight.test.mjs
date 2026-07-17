import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDeploymentContract, renderWorkflowDeploymentContract } from "./deployment-contract-preflight.mjs";
import { readPlatformSources } from "./render-platform-helm-values.mjs";

const fixtureRoot = resolve("scripts/fixtures/deployment-contract-preflight");
const workflowPath = resolve(".github/workflows/platform-production.yml");

function fixture(name) {
  return JSON.parse(readFileSync(resolve(fixtureRoot, name), "utf8"));
}

describe("deployment contract preflight", () => {
  it("accepts valid DOKS-owned and App-Platform-owned contracts", () => {
    const doks = renderDeploymentContract(fixture("valid-doks.json"));
    const appPlatform = renderDeploymentContract(fixture("valid-app-platform.json"));

    expect(doks).toMatchObject({
      environment: "production",
      runtimeOwner: "doks",
      bootstrapOwner: "doks",
      pass: true,
      errors: [],
    });
    expect(doks.controlPlanes["app-platform"].activeComponents).not.toContain("platform-worker");
    expect(doks.controlPlanes["app-platform"].activeComponents).not.toContain("marketplace");
    expect(appPlatform).toMatchObject({
      environment: "staging",
      runtimeOwner: "app-platform",
      bootstrapOwner: "app-platform",
      pass: true,
      errors: [],
    });
  });

  it("rejects the production owner omission with an actionable remediation", () => {
    const contract = renderDeploymentContract(fixture("production-owner-omission.json"));

    expect(contract.pass).toBe(false);
    expect(contract.errors).toContain(
      "Production bootstrap ownership fell back to Terraform's 'app-platform' default while the DOKS bootstrap is active. Set TF_VAR_platform_bootstrap_owner explicitly to 'doks' in the deploy-production job so App Platform bootstrap is a no-op.",
    );
    expect(contract.errors.join("\n")).toContain("DATABASE_URL_SETTLEMENT");
  });

  it("renders staging and production independently from the workflow and Terraform sources", () => {
    const staging = renderWorkflowDeploymentContract({ environment: "staging" });
    const production = renderWorkflowDeploymentContract({ environment: "production" });

    expect(staging).toMatchObject({
      environment: "staging",
      runtimeProfile: "public",
      runtimeOwner: "doks",
      bootstrapOwner: "doks",
      imageIdentity: {
        tagSource: "release-commit",
        digestSource: "build-release-image-digest",
      },
      pass: true,
    });
    expect(production).toMatchObject({
      environment: "production",
      runtimeProfile: "landing",
      runtimeOwner: "doks",
      bootstrapOwner: "doks",
      imageIdentity: {
        tagSource: "release-commit",
        digestSource: "staging-verified-image-digest",
      },
      pass: true,
    });
    expect(staging.databaseUrlKeys.required).toEqual(production.databaseUrlKeys.required);
    expect(production.databaseUrlKeys.runtimeRequired).toContain("DATABASE_URL_MARKETPLACE");
    expect(production.databaseUrlKeys["app-platform-runtime"]).toContainEqual({
      name: "DATABASE_URL_MARKETPLACE",
      status: "configured",
    });
  });

  it("rejects Terraform landing wiring that omits a manifest-selected platform-api source context", () => {
    const { contextName } = fixture("landing-database-wiring-omission.json");
    const sources = readPlatformSources();
    const landingList = /landing_context_names\s*=\s*\[([\s\S]*?)\n  \]/;
    sources.locals = sources.locals.replace(landingList, (block) =>
      block.replace(new RegExp(`\\s+"${contextName}",`), ""),
    );

    const contract = renderDeploymentContract(fixture("valid-doks.json"), { sources });

    expect(contract.pass).toBe(false);
    expect(contract.databaseUrlKeys.runtimeRequired).toContain("DATABASE_URL_MARKETPLACE");
    expect(contract.databaseUrlKeys["app-platform-runtime"]).toContainEqual({
      name: "DATABASE_URL_MARKETPLACE",
      status: "missing",
    });
    expect(contract.errors.join("\n")).toContain(
      "App Platform platform-api is missing manifest-required database URL keys",
    );
    expect(contract.errors.join("\n")).toContain("DATABASE_URL_MARKETPLACE");
  });

  it("uses strict workflow fallbacks when environment contract variables are absent", () => {
    const emptyEnvironmentVariables = {
      bootstrapOwnerOverride: "",
      productionRuntimeProfileOverride: "",
      productionMarketplacePublicEnabled: "",
      argoRolloutsEnabled: "",
      appPlatformLane: "",
    };
    const staging = renderWorkflowDeploymentContract({
      ...emptyEnvironmentVariables,
      environment: "staging",
    });
    const production = renderWorkflowDeploymentContract({
      ...emptyEnvironmentVariables,
      environment: "production",
    });

    expect(staging).toMatchObject({
      bootstrapOwner: "doks",
      bootstrapOwnerSource: "workflow-fallback",
      rolloutMode: "doks-helm",
      pass: true,
    });
    expect(production).toMatchObject({
      runtimeProfile: "landing",
      bootstrapOwner: "doks",
      bootstrapOwnerSource: "workflow-fallback",
      rolloutMode: "doks-helm",
      pass: true,
    });
  });

  it("detects a removed production owner mapping before deployment", () => {
    const ownerMapping = "      TF_VAR_platform_bootstrap_owner: ${{ vars.PLATFORM_BOOTSTRAP_OWNER || 'doks' }}\n";
    const originalWorkflow = readFileSync(workflowPath, "utf8");
    const productionOwnerIndex = originalWorkflow.lastIndexOf(ownerMapping);
    const workflow =
      originalWorkflow.slice(0, productionOwnerIndex) +
      originalWorkflow.slice(productionOwnerIndex + ownerMapping.length);
    const production = renderWorkflowDeploymentContract({ environment: "production" }, { workflowSource: workflow });

    expect(production.pass).toBe(false);
    expect(production.bootstrapOwnerSource).toBe("terraform-default");
    expect(production.errors.join("\n")).toContain("deploy-production");
  });

  it("blocks contradictory activation and image identity mismatches", () => {
    const contradictory = renderDeploymentContract({
      ...fixture("valid-doks.json"),
      paths: {
        "app-platform": { runtimeMode: "primary", bootstrapMode: "active" },
        doks: { runtimeMode: "primary", bootstrapMode: "active" },
      },
    });
    const workflow = readFileSync(workflowPath, "utf8").replace(
      "      TF_VAR_platform_image_digest: ${{ needs.deploy-staging.outputs.platform_image_digest }}",
      "      TF_VAR_platform_image_digest: ''",
    );
    const imageMismatch = renderWorkflowDeploymentContract({ environment: "production" }, { workflowSource: workflow });

    expect(contradictory.pass).toBe(false);
    expect(contradictory.errors.join("\n")).toContain("exactly one primary runtime path");
    expect(contradictory.errors.join("\n")).toContain("exactly one bootstrap path");
    expect(imageMismatch.pass).toBe(false);
    expect(imageMismatch.errors.join("\n")).toContain("image tag and digest sources must both be explicit");
  });

  it("emits only database key names and status without connection values", () => {
    const serialized = JSON.stringify(renderDeploymentContract(fixture("valid-doks.json")));

    expect(serialized).toContain('"name":"DATABASE_URL_MARKETPLACE"');
    expect(serialized).toContain('"status":"configured"');
    expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//i);
    expect(serialized).not.toContain("password=");
  });

  it("completes both effective environment renders within the preflight budget", () => {
    const startedAt = performance.now();
    renderWorkflowDeploymentContract({ environment: "staging" });
    renderWorkflowDeploymentContract({ environment: "production" });

    expect(performance.now() - startedAt).toBeLessThan(60_000);
  });

  it("runs both effective preflights with native environment variables before build or staging mutation", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const resolveRelease = workflowJob(workflow, "resolve-release");
    const preflight = workflowJob(workflow, "deployment-contract-preflight");
    const buildImage = workflowJob(workflow, "build-image");
    const incidentNotifier = workflowJob(workflow, "notify-production-deploy-incident");
    const buildImageIndex = workflow.indexOf("  build-image:");
    const stagingMutationIndex = workflow.indexOf("- name: Terraform apply staging environment DNS");

    expect(resolveRelease).not.toContain("/actions/variables");
    expect(preflight).toContain("if: needs.resolve-release.outputs.deployment_required == 'true'");
    expect(preflight).toContain("environment: ${{ matrix.environment }}");
    expect(preflight).toContain("environment: staging");
    expect(preflight).toContain("environment: production");
    expect(preflight).toContain("ARGO_ROLLOUTS_ENABLED: ${{ vars[matrix.argo_rollouts_variable] || '' }}");
    expect(preflight).toContain("PLATFORM_BOOTSTRAP_OWNER: ${{ vars.PLATFORM_BOOTSTRAP_OWNER || '' }}");
    expect(preflight).toContain('git show "${{ needs.resolve-release.outputs.release_commit }}:${source_path}"');
    expect(preflight).toContain('--root-dir "${{ steps.deployment_contract_inputs.outputs.contract_root }}"');
    expect(preflight).toContain('--environment "${{ matrix.environment }}"');
    expect(preflight).toContain('--github-summary "$GITHUB_STEP_SUMMARY"');
    expect(preflight).toContain("Enforce deployment contract preflight");
    expect(preflight).not.toContain("gh api");
    expect(preflight).not.toContain("secrets.");
    expect(buildImage).toContain("- deployment-contract-preflight");
    expect(incidentNotifier).toContain("- deployment-contract-preflight");
    expect(workflow.indexOf("  deployment-contract-preflight:")).toBeLessThan(buildImageIndex);
    expect(buildImageIndex).toBeLessThan(stagingMutationIndex);
  });
});

function workflowJob(source, jobName) {
  const marker = `  ${jobName}:`;
  const start = source.indexOf(marker);
  expect(start).not.toBe(-1);
  const remaining = source.slice(start + marker.length);
  const nextOffset = remaining.search(/\n  [a-zA-Z0-9_-]+:\r?\n/);
  return nextOffset === -1 ? source.slice(start) : source.slice(start, start + marker.length + nextOffset);
}
