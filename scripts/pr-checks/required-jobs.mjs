import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const requiredJobs = [
  ["known-failure-guard", "Known Failure Guard", "known_failure_guard_required"],
  ["change-scope", "Change Scope", "change_scope_required"],
  ["static", "Static Checks", "static_required"],
  ["typecheck", "Typecheck", "typecheck_required"],
  ["unit-tests", "Unit Tests", "unit_tests_required"],
  ["db-tests", "DB Profile Tests", "db_tests_required"],
  ["e2e-tests", "E2E Tests", "e2e_tests_required"],
  ["capture-hermetic-chromium", "Capture Hermetic Chromium", null],
  ["build", "Build", "build_required"],
  ["docker-image", "Docker Image Build", "docker_image_required"],
  ["workflow-lint", "Workflow Lint", "workflow_lint_required"],
  ["terraform-preview-plan", "Terraform Preview Plan", "terraform_preview_plan_required"],
  ["terraform-staging-plan", "Terraform Staging Plan", "terraform_staging_plan_required"],
  ["terraform-production-plan", "Terraform Production Plan", "terraform_production_plan_required"],
  ["terraform-observability-plan", "Terraform Observability Plan", "terraform_observability_plan_required"],
  ["preview-deploy-smoke", "Deploy Preview and Smoke", "preview_deploy_smoke_required"],
  ["compose-preview-smoke", "Compose Boot Smoke", "compose_preview_smoke_required"],
];

export function requireJob(name, result, required) {
  if (required !== "true" && required !== "false") {
    throw new Error(`${name} has unknown or missing gate-plan requirement '${required}'.`);
  }
  if (required === "true") {
    if (result !== "success") throw new Error(`${name} was required but finished with result '${result}'.`);
    return;
  }
  if (result !== "skipped" && result !== "success") {
    throw new Error(`${name} was not required but finished with unexpected result '${result}'.`);
  }
}

export function captureRequired(required, suitesJson) {
  let suites;
  try {
    suites = JSON.parse(suitesJson);
  } catch {
    throw new Error("Capture Hermetic Chromium has unknown or missing selection");
  }
  if (
    !["true", "false"].includes(required) ||
    !Array.isArray(suites) ||
    suites.some((suite) => typeof suite !== "string" || suite.length === 0)
  ) {
    throw new Error("Capture Hermetic Chromium has unknown or missing selection");
  }
  return String(required === "true" && suites.includes("tcgplayer_connector_extension"));
}

export function verifyRequiredJobs(needs, e2eRequired, e2eSuitesJson) {
  const outputs = needs?.["change-scope"]?.outputs ?? {};
  for (const [id, name, requirement] of requiredJobs) {
    const required = requirement === null ? captureRequired(e2eRequired, e2eSuitesJson) : (outputs[requirement] ?? "");
    requireJob(name, needs?.[id]?.result ?? "", required);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyRequiredJobs(
      JSON.parse(process.env.PR_REQUIRED_NEEDS_JSON),
      process.env.AC4_E2E_REQUIRED,
      process.env.AC4_E2E_SUITES_JSON,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
