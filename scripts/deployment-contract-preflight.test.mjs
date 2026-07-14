import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderDeploymentContract, renderWorkflowDeploymentContract } from "./deployment-contract-preflight.mjs";

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
    expect(contract.errors.join("\n")).toContain("DATABASE_URL_MARKETPLACE");
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

  it("runs both effective preflights in Resolve Release before build or staging mutation", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const resolveRelease = workflowJob(workflow, "resolve-release");
    const buildImageIndex = workflow.indexOf("  build-image:");
    const stagingMutationIndex = workflow.indexOf("- name: Terraform apply staging environment DNS");
    const stagingPreflightIndex = workflow.indexOf("- name: Preflight staging deployment contract");
    const productionPreflightIndex = workflow.indexOf("- name: Preflight production deployment contract");

    expect(resolveRelease).toContain("repos/${{ github.repository }}/environments/staging/variables?per_page=100");
    expect(resolveRelease).toContain("repos/${{ github.repository }}/environments/production/variables?per_page=100");
    expect(resolveRelease).toContain('git show "${{ steps.release.outputs.release_commit }}:${source_path}"');
    expect(resolveRelease).toContain('--root-dir "${{ steps.deployment_contract_inputs.outputs.contract_root }}"');
    expect(resolveRelease).toContain("--environment staging");
    expect(resolveRelease).toContain("--environment production");
    expect(resolveRelease).toContain('--github-summary "$GITHUB_STEP_SUMMARY"');
    expect(resolveRelease).toContain("name: deployment-contract-preflight");
    expect(resolveRelease).toContain("Enforce deployment contract preflight");
    expect(resolveRelease).not.toContain("secrets.");
    expect(stagingPreflightIndex).toBeGreaterThan(-1);
    expect(productionPreflightIndex).toBeGreaterThan(stagingPreflightIndex);
    expect(productionPreflightIndex).toBeLessThan(buildImageIndex);
    expect(productionPreflightIndex).toBeLessThan(stagingMutationIndex);
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
