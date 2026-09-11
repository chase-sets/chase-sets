import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { batchE2eSuiteIds } from "./e2e-suites.mjs";

export const CI_GATE_PLAN_SCHEMA_VERSION = "ci-gate-plan/v1";
export const CI_GATE_MODES = Object.freeze(["pull-request", "merge-group"]);
export const CI_GATE_PROVENANCE = Object.freeze(["same-repository", "fork"]);
export const CI_GATE_SELECTIONS = Object.freeze(["REQUIRED", "NOT_REQUIRED", "UNDECIDABLE"]);
export const CI_GATE_EXECUTABILITY = Object.freeze(["REPOSITORY_LOCAL", "HOSTED_ONLY"]);
export const CI_GATE_CATEGORIES = Object.freeze([
  "always-required",
  "scope-gated",
  "targeted-heavy",
  "full-battery-only",
  "pr-complement",
  "aggregation",
]);
export const FULL_BATTERY_LABELS = Object.freeze(["ci-circuit-repair", "full-ci", "preview"]);

const hostedOnlyReasons = Object.freeze({
  "known-failure-guard": "Requires the hosted merge-group payload and live GitHub issue authority",
  "docker-image": "Requires hosted DigitalOcean registry authentication and credentials",
  "workflow-lint": "Uses GitHub Actions container steps and a hosted Docker daemon",
  "terraform-preview-plan": "Requires the Terraform toolchain provisioned by GitHub Actions",
  "terraform-production-plan": "Requires the Terraform toolchain provisioned by GitHub Actions",
  "terraform-staging-plan": "Requires the Terraform toolchain provisioned by GitHub Actions",
  "terraform-observability-plan": "Requires the hosted Terraform toolchain and artifact store",
  "preview-deploy-smoke": "Requires the hosted preview environment and provider credentials",
  "compose-preview-smoke": "Requires the hosted reusable workflow and synthetic pull-request merge commit",
  "pr-required": "Aggregates hosted job conclusions from the GitHub Actions needs graph",
});

export const CI_GATE_DEFINITIONS = Object.freeze([
  gate("known-failure-guard", "Known Failure Guard", "always-required", "HOSTED_ONLY"),
  gate("change-scope", "Change Scope", "always-required", "REPOSITORY_LOCAL"),
  gate("static", "Static Checks", "scope-gated", "REPOSITORY_LOCAL", "localChecksRequired"),
  gate("typecheck", "Typecheck", "always-required", "REPOSITORY_LOCAL"),
  gate("unit-tests", "Unit Tests", "scope-gated", "REPOSITORY_LOCAL", "unitTestsRequired"),
  gate("db-tests", "DB Profile Tests", "scope-gated", "REPOSITORY_LOCAL", "dbTestsRequired"),
  gate("e2e-tests", "E2E Tests", "targeted-heavy", "REPOSITORY_LOCAL", "e2eTestsRequired"),
  gate("build", "Build", "full-battery-only", "REPOSITORY_LOCAL", "buildRequired"),
  gate("docker-image", "Docker Image Build", "full-battery-only", "HOSTED_ONLY", "dockerImageRequired"),
  gate("workflow-lint", "Workflow Lint", "scope-gated", "HOSTED_ONLY", "workflowLintRequired"),
  gate("terraform-preview-plan", "Terraform Preview Plan", "full-battery-only", "HOSTED_ONLY", "terraformRequired"),
  gate("terraform-staging-plan", "Terraform Staging Plan", "full-battery-only", "HOSTED_ONLY", "terraformRequired"),
  gate(
    "terraform-production-plan",
    "Terraform Production Plan",
    "full-battery-only",
    "HOSTED_ONLY",
    "terraformRequired",
  ),
  gate(
    "terraform-observability-plan",
    "Terraform Observability Plan",
    "scope-gated",
    "HOSTED_ONLY",
    "terraformRequired",
  ),
  gate("preview-deploy-smoke", "Deploy Preview and Smoke", "pr-complement", "HOSTED_ONLY"),
  gate("compose-preview-smoke", "Compose Boot Smoke", "pr-complement", "HOSTED_ONLY"),
  gate("pr-required", "PR Required", "aggregation", "HOSTED_ONLY"),
]);

function gate(id, name, category, executability, capability = null) {
  return Object.freeze({
    id,
    name,
    category,
    executability,
    capability,
    hostedOnlyReason: hostedOnlyReasons[id] ?? null,
  });
}

function assertExactKeys(value, keys, pathName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${pathName} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${pathName} has unexpected keys: ${actual.join(", ")}`);
  }
}

function assertStringArray(value, pathName) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${pathName} must be an array of strings`);
  }
}

export function normalizeCiGateLabels(labels) {
  if (labels === undefined || labels === null) return [];
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string" || label.trim() !== label || !label)) {
    throw new Error("MALFORMED_LABELS: labels must be a JSON array of non-empty trimmed strings");
  }
  return [...new Set(labels.filter((label) => FULL_BATTERY_LABELS.includes(label)))].sort();
}

export function validateCiGateScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("MALFORMED_SCOPE: classifier result must be an object");
  }
  const booleans = [
    "localChecksRequired",
    "unitTestsRequired",
    "dbTestsRequired",
    "e2eTestsRequired",
    "integrationRiskRequired",
    "buildRequired",
    "dockerImageRequired",
    "terraformRequired",
    "workflowLintRequired",
    "clusterPreviewRequired",
    "composeSmokeRequired",
  ];
  for (const key of booleans) {
    if (typeof scope[key] !== "boolean") throw new Error(`MALFORMED_SCOPE: ${key} must be boolean`);
  }
  assertStringArray(scope.affectedWorkspaces, "scope.affectedWorkspaces");
  assertStringArray(scope.changedFiles, "scope.changedFiles");
  assertStringArray(scope.e2eSuiteIds, "scope.e2eSuiteIds");
  if (typeof scope.integrationRiskReason !== "string" || !scope.integrationRiskReason) {
    throw new Error("MALFORMED_SCOPE: integrationRiskReason must be a non-empty string");
  }
  return scope;
}

function laneState(mode, labels, scope) {
  if (mode === "merge-group") {
    return {
      fullBatteryRequired: true,
      fullBatteryReason: "merge-group",
      targetedHeavyRequired: true,
      targetedHeavyReason: "merge-group",
    };
  }
  if (labels.length > 0) {
    return {
      fullBatteryRequired: true,
      fullBatteryReason: "label",
      targetedHeavyRequired: true,
      targetedHeavyReason: "label",
    };
  }
  if (scope.integrationRiskRequired) {
    return {
      fullBatteryRequired: false,
      fullBatteryReason: "pr-fast-lane",
      targetedHeavyRequired: true,
      targetedHeavyReason: `integration-risk: ${scope.integrationRiskReason}`,
    };
  }
  return {
    fullBatteryRequired: false,
    fullBatteryReason: "pr-fast-lane",
    targetedHeavyRequired: false,
    targetedHeavyReason: "pr-fast-lane",
  };
}

function standardSelection(definition, scope, lane) {
  if (definition.category === "always-required" || definition.category === "aggregation") {
    return { selection: "REQUIRED", reason: "always" };
  }
  const affected = scope[definition.capability];
  if (!affected) return { selection: "NOT_REQUIRED", reason: "not-affected" };
  if (definition.category === "scope-gated") return { selection: "REQUIRED", reason: "scope" };
  if (definition.category === "targeted-heavy") {
    return lane.targetedHeavyRequired
      ? { selection: "REQUIRED", reason: lane.targetedHeavyReason }
      : { selection: "NOT_REQUIRED", reason: "pr-fast-lane" };
  }
  if (definition.category === "full-battery-only") {
    return lane.fullBatteryRequired
      ? { selection: "REQUIRED", reason: lane.fullBatteryReason }
      : { selection: "NOT_REQUIRED", reason: "pr-fast-lane" };
  }
  throw new Error(`UNKNOWN_GATE_CATEGORY: ${definition.category}`);
}

function complementSelection(definition, { mode, labels, provenance, scope }) {
  if (mode === "merge-group") return { selection: "NOT_REQUIRED", reason: "merge-group" };
  const previewLabel = labels.includes("preview");
  if (definition.id === "preview-deploy-smoke") {
    if (provenance === null) return { selection: "UNDECIDABLE", reason: "missing-provenance" };
    if (provenance === "fork") return { selection: "NOT_REQUIRED", reason: "fork" };
    if (previewLabel) return { selection: "REQUIRED", reason: "preview-label" };
    return scope.clusterPreviewRequired
      ? { selection: "REQUIRED", reason: "scope" }
      : { selection: "NOT_REQUIRED", reason: "not-affected" };
  }
  if (definition.id === "compose-preview-smoke") {
    if (previewLabel) return { selection: "NOT_REQUIRED", reason: "preview-label" };
    return scope.composeSmokeRequired
      ? { selection: "REQUIRED", reason: "scope" }
      : { selection: "NOT_REQUIRED", reason: "not-affected" };
  }
  throw new Error(`UNKNOWN_GATE_ID: ${definition.id}`);
}

export function createCiGatePlan({ mode, labels = [], provenance, scope, definitions = CI_GATE_DEFINITIONS }) {
  if (!CI_GATE_MODES.includes(mode)) throw new Error(`MALFORMED_MODE: ${String(mode)}`);
  const normalizedLabels = normalizeCiGateLabels(labels);
  if (provenance !== undefined && provenance !== null && !CI_GATE_PROVENANCE.includes(provenance)) {
    throw new Error(`MALFORMED_PROVENANCE: ${String(provenance)}`);
  }
  const normalizedProvenance = mode === "merge-group" ? null : (provenance ?? null);
  validateCiGateScope(scope);
  const lane = laneState(mode, normalizedLabels, scope);
  const e2eBatches = batchE2eSuiteIds(scope.e2eSuiteIds);
  const gates = definitions.map((definition) => {
    const decision =
      definition.category === "pr-complement"
        ? complementSelection(definition, {
            mode,
            labels: normalizedLabels,
            provenance: normalizedProvenance,
            scope,
          })
        : standardSelection(definition, scope, lane);
    return {
      id: definition.id,
      name: definition.name,
      category: definition.category,
      selection: decision.selection,
      executability: definition.executability,
      reason: decision.reason,
      hostedOnlyReason: definition.hostedOnlyReason,
      affectedWorkspaces: [...scope.affectedWorkspaces],
      e2eBatches: definition.id === "e2e-tests" ? [...e2eBatches] : [],
    };
  });
  const plan = {
    schemaVersion: CI_GATE_PLAN_SCHEMA_VERSION,
    mode,
    labels: normalizedLabels,
    provenance: normalizedProvenance,
    fullBatteryRequired: lane.fullBatteryRequired,
    fullBatteryReason: lane.fullBatteryReason,
    targetedHeavyRequired: lane.targetedHeavyRequired,
    targetedHeavyReason: lane.targetedHeavyReason,
    gates,
  };
  validateCiGatePlan(plan);
  return plan;
}

const planKeys = [
  "schemaVersion",
  "mode",
  "labels",
  "provenance",
  "fullBatteryRequired",
  "fullBatteryReason",
  "targetedHeavyRequired",
  "targetedHeavyReason",
  "gates",
];
const gateKeys = [
  "id",
  "name",
  "category",
  "selection",
  "executability",
  "reason",
  "hostedOnlyReason",
  "affectedWorkspaces",
  "e2eBatches",
];

export function validateCiGatePlan(plan) {
  assertExactKeys(plan, planKeys, "plan");
  if (plan.schemaVersion !== CI_GATE_PLAN_SCHEMA_VERSION) throw new Error("UNKNOWN_PLAN_SCHEMA");
  if (!CI_GATE_MODES.includes(plan.mode)) throw new Error("UNKNOWN_PLAN_MODE");
  assertStringArray(plan.labels, "plan.labels");
  if (JSON.stringify(plan.labels) !== JSON.stringify(normalizeCiGateLabels(plan.labels))) {
    throw new Error("PLAN_LABELS_NOT_NORMALIZED");
  }
  if (plan.provenance !== null && !CI_GATE_PROVENANCE.includes(plan.provenance)) {
    throw new Error("UNKNOWN_PLAN_PROVENANCE");
  }
  if (plan.mode === "merge-group" && plan.provenance !== null) throw new Error("MERGE_GROUP_CONSULTS_PROVENANCE");
  for (const key of ["fullBatteryRequired", "targetedHeavyRequired"]) {
    if (typeof plan[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  for (const key of ["fullBatteryReason", "targetedHeavyReason"]) {
    if (typeof plan[key] !== "string" || !plan[key]) throw new Error(`${key} must be a non-empty string`);
  }
  if (!Array.isArray(plan.gates)) throw new Error("plan.gates must be an array");
  const expectedIds = CI_GATE_DEFINITIONS.map(({ id }) => id);
  const actualIds = plan.gates.map((entry) => entry?.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`UNKNOWN_OR_MISSING_GATE_IDS: ${actualIds.join(",")}`);
  }
  for (const [index, entry] of plan.gates.entries()) {
    assertExactKeys(entry, gateKeys, `plan.gates[${index}]`);
    const definition = CI_GATE_DEFINITIONS[index];
    if (entry.name !== definition.name) throw new Error(`GATE_NAME_MISMATCH: ${entry.id}`);
    if (!CI_GATE_CATEGORIES.includes(entry.category) || entry.category !== definition.category) {
      throw new Error(`GATE_CATEGORY_MISMATCH: ${entry.id}`);
    }
    if (!CI_GATE_SELECTIONS.includes(entry.selection)) throw new Error(`UNKNOWN_GATE_SELECTION: ${entry.id}`);
    if (!CI_GATE_EXECUTABILITY.includes(entry.executability) || entry.executability !== definition.executability) {
      throw new Error(`GATE_EXECUTABILITY_MISMATCH: ${entry.id}`);
    }
    if (typeof entry.reason !== "string" || !entry.reason) throw new Error(`MISSING_GATE_REASON: ${entry.id}`);
    if (entry.executability === "HOSTED_ONLY") {
      if (typeof entry.hostedOnlyReason !== "string" || !entry.hostedOnlyReason) {
        throw new Error(`MISSING_HOSTED_ONLY_REASON: ${entry.id}`);
      }
    } else if (entry.hostedOnlyReason !== null) {
      throw new Error(`LOCAL_GATE_HAS_HOSTED_REASON: ${entry.id}`);
    }
    assertStringArray(entry.affectedWorkspaces, `plan.gates[${index}].affectedWorkspaces`);
    assertStringArray(entry.e2eBatches, `plan.gates[${index}].e2eBatches`);
  }
  return plan;
}

export function ciGatePlanOutputMap(plan) {
  validateCiGatePlan(plan);
  const outputs = {
    plan_json: JSON.stringify(plan),
    full_battery_required: String(plan.fullBatteryRequired),
    full_battery_reason: plan.fullBatteryReason,
    targeted_heavy_required: String(plan.targetedHeavyRequired),
    targeted_heavy_reason: plan.targetedHeavyReason,
  };
  for (const entry of plan.gates)
    outputs[`${entry.id.replaceAll("-", "_")}_required`] = String(entry.selection === "REQUIRED");
  return outputs;
}

function parseEnvironment(env) {
  let labels;
  let scope;
  try {
    labels = JSON.parse(env.CI_GATE_PLAN_LABELS_JSON ?? "[]");
  } catch {
    throw new Error("MALFORMED_LABELS: CI_GATE_PLAN_LABELS_JSON is not JSON");
  }
  try {
    scope = JSON.parse(env.CI_GATE_PLAN_SCOPE_JSON ?? "");
  } catch {
    throw new Error("MALFORMED_SCOPE: CI_GATE_PLAN_SCOPE_JSON is not JSON");
  }
  return {
    mode: env.CI_GATE_PLAN_MODE,
    labels,
    provenance: env.CI_GATE_PLAN_PROVENANCE || undefined,
    scope,
  };
}

function main() {
  const command = process.argv[2];
  if (command !== "github-output" && command !== "json") {
    throw new Error("Usage: node ./scripts/ci-gate-plan.mjs <json|github-output>");
  }
  const plan = createCiGatePlan(parseEnvironment(process.env));
  if (command === "json") {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required for github-output");
  const content = Object.entries(ciGatePlanOutputMap(plan))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  appendFileSync(process.env.GITHUB_OUTPUT, `${content}\n`, "utf8");
  console.log(JSON.stringify(ciGatePlanOutputMap(plan), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
