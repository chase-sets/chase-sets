import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyChanges } from "./change-scope.mjs";
import {
  CI_GATE_CATEGORIES,
  CI_GATE_DEFINITIONS,
  CI_GATE_EXECUTABILITY,
  CI_GATE_SELECTIONS,
  FULL_BATTERY_LABELS,
  createCiGatePlan,
  validateCiGatePlan,
} from "./ci-gate-plan.mjs";
import { batchE2eSuiteIds } from "./e2e-suites.mjs";

const mergeBase = execFileSync("git", ["merge-base", "origin/main", "HEAD"], { encoding: "utf8" }).trim();
const baseWorkflow = execFileSync("git", ["show", `${mergeBase}:.github/workflows/platform-pr.yml`], {
  encoding: "utf8",
});
const headWorkflow = readFileSync(".github/workflows/platform-pr.yml", "utf8");

function workflowJobs(source) {
  const matches = [...source.matchAll(/^  ([a-z0-9-]+):\n(?=    name:)/gm)];
  return matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? source.length;
    const text = source.slice(match.index, end);
    const name = text.match(/^    name:\s+(.+)$/m)?.[1].replace(/ \(.+$/, "");
    return { id: match[1], name, text };
  });
}

function workflowJob(source, id) {
  const job = workflowJobs(source).find((entry) => entry.id === id);
  if (!job) throw new Error(`Missing workflow job ${id}`);
  return job;
}

function workflowCondition(source, id) {
  const lines = workflowJob(source, id).text.replaceAll("\r\n", "\n").split("\n");
  const index = lines.findIndex((line) => line.startsWith("    if: "));
  if (index === -1) return null;
  if (lines[index] !== "    if: >") return lines[index].slice("    if: ".length).trim();
  const parts = [];
  for (const line of lines.slice(index + 1)) {
    if (/^    \S/.test(line)) break;
    if (line.trim()) parts.push(line.trim());
  }
  return parts.join(" ");
}

function requiredNeeds(source) {
  const job = workflowJob(source, "pr-required").text;
  const block = job.match(/    needs:\n((?:      - [a-z0-9-]+\n)+)/)?.[1];
  if (!block) throw new Error("Missing pr-required needs list");
  return [...block.matchAll(/- ([a-z0-9-]+)/g)].map((match) => match[1]);
}

function requiredCalls(source) {
  return [
    ...workflowJob(source, "pr-required").text.matchAll(
      /^\s+(require(?:_targeted_heavy|_heavy)?_job) "([A-Z][^"]+)" "([^"]+)" "([^"]+)"$/gm,
    ),
  ].map((match) => ({ helper: match[1], name: match[2], result: match[3], required: match[4] }));
}

function derivedCategories(source) {
  const jobs = workflowJobs(source);
  const idsByName = new Map(jobs.map(({ id, name }) => [name, id]));
  const categories = new Map();
  for (const call of requiredCalls(source)) {
    const id = idsByName.get(call.name);
    if (!id) throw new Error(`Required call has no job: ${call.name}`);
    const category =
      call.helper === "require_targeted_heavy_job"
        ? "targeted-heavy"
        : call.helper === "require_heavy_job"
          ? "full-battery-only"
          : call.required === "true"
            ? "always-required"
            : "scope-gated";
    categories.set(id, category);
  }
  for (const id of requiredNeeds(source)) if (!categories.has(id)) categories.set(id, "pr-complement");
  categories.set("pr-required", "aggregation");
  return new Map([...requiredNeeds(source), "pr-required"].map((id) => [id, categories.get(id)]));
}

function scopeOutputs(scope) {
  return {
    local_checks: scope.localChecksRequired,
    unit_tests: scope.unitTestsRequired,
    db_tests: scope.dbTestsRequired,
    e2e_tests: scope.e2eTestsRequired,
    integration_risk_required: scope.integrationRiskRequired,
    build: scope.buildRequired,
    docker_image: scope.dockerImageRequired,
    workflow_lint: scope.workflowLintRequired,
    terraform: scope.terraformRequired,
    cluster_preview: scope.clusterPreviewRequired,
    compose_smoke: scope.composeSmokeRequired,
  };
}

function fullBattery(mode, labels) {
  return mode === "merge-group" || labels.some((label) => FULL_BATTERY_LABELS.includes(label));
}

function evaluateBaseExpression(expression, { mode, labels, provenance, scope }) {
  let value = expression;
  for (const label of FULL_BATTERY_LABELS) {
    value = value.replaceAll(
      `contains(github.event.pull_request.labels.*.name, '${label}')`,
      JSON.stringify(labels.includes(label)),
    );
  }
  value = value
    .replaceAll(
      "github.event.pull_request.head.repo.full_name == github.repository",
      JSON.stringify(provenance === "same-repository"),
    )
    .replaceAll("github.event_name", JSON.stringify(mode === "pull-request" ? "pull_request" : "merge_group"));
  const outputs = {
    ...scopeOutputs(scope),
    full_battery_required: fullBattery(mode, labels),
  };
  for (const [key, output] of Object.entries(outputs)) {
    value = value.replaceAll(`needs['change-scope'].outputs.${key}`, JSON.stringify(String(output)));
  }
  if (/\b(?:github|needs|contains)\b/.test(value)) throw new Error(`Unresolved workflow expression: ${value}`);
  if (!/^[\s()!&|='"a-z_-]+$/.test(value)) throw new Error(`Unsafe workflow expression: ${value}`);
  return Function(`"use strict"; return Boolean(${value});`)();
}

function baseComplementExpression(source, variable) {
  const match = workflowJob(source, "pr-required").text.match(
    new RegExp(`^\\s+${variable}=\"\\$\\{\\{ (.+) \\}\\}\"$`, "m"),
  );
  if (!match) throw new Error(`Missing ${variable} expression`);
  return match[1];
}

function baseSelection(id, inputs) {
  if (["known-failure-guard", "change-scope", "typecheck", "pr-required"].includes(id)) return true;
  if (id === "preview-deploy-smoke") {
    return evaluateBaseExpression(baseComplementExpression(baseWorkflow, "preview_required"), inputs);
  }
  if (id === "compose-preview-smoke") {
    return evaluateBaseExpression(baseComplementExpression(baseWorkflow, "compose_required"), inputs);
  }
  return evaluateBaseExpression(workflowCondition(baseWorkflow, id), inputs);
}

function expectedReason(id, category, required, { mode, labels, scope, provenance }) {
  if (category === "always-required" || category === "aggregation") return "always";
  if (category === "pr-complement") {
    if (mode === "merge-group") return "merge-group";
    if (id === "preview-deploy-smoke") {
      if (provenance === "fork") return "fork";
      if (labels.includes("preview")) return "preview-label";
      return required ? "scope" : "not-affected";
    }
    if (labels.includes("preview")) return "preview-label";
    return required ? "scope" : "not-affected";
  }
  const capability = CI_GATE_DEFINITIONS.find((entry) => entry.id === id).capability;
  if (!scope[capability]) return "not-affected";
  if (category === "scope-gated") return "scope";
  if (!required) return "pr-fast-lane";
  if (mode === "merge-group") return "merge-group";
  if (labels.length > 0) return "label";
  return `integration-risk: ${scope.integrationRiskReason}`;
}

const corpus = [
  { name: "modified documentation", changedFiles: ["README.md"] },
  {
    name: "added test-only provider path",
    changedFiles: ["bounded-contexts/payments/tests/stripe-release-channel.test.ts"],
  },
  {
    name: "modified real provider runtime",
    changedFiles: ["bounded-contexts/payments/features/payments/api/provider-webhook-paths.ts"],
  },
  { name: "integration-risk metadata", changedFiles: ["bounded-contexts/payments/context.json"] },
  { name: "deleted infrastructure path", changedFiles: ["infrastructure/digitalocean/platform/main.tf"] },
  {
    name: "renamed provider path",
    changedFiles: [
      "bounded-contexts/payments/features/payments/api/provider-webhook-paths.ts",
      "bounded-contexts/settlement/features/payouts/api/provider-webhook-paths.ts",
    ],
  },
];

const scenarios = [
  ...[[], ...FULL_BATTERY_LABELS.map((label) => [label])].flatMap((labels) =>
    ["same-repository", "fork"].map((provenance) => ({ mode: "pull-request", labels, provenance })),
  ),
  { mode: "merge-group", labels: [], provenance: undefined },
];

describe("shared CI gate plan", () => {
  it("matches the base workflow over the full parity corpus", () => {
    const baseCategories = derivedCategories(baseWorkflow);
    const deltas = [];
    for (const testCase of corpus) {
      const scope = classifyChanges({ changedFiles: testCase.changedFiles });
      for (const scenario of scenarios) {
        const plan = createCiGatePlan({ ...scenario, scope });
        for (const gate of plan.gates) {
          const expectedRequired = baseSelection(gate.id, { ...scenario, scope });
          const expected = expectedRequired ? "REQUIRED" : "NOT_REQUIRED";
          const reason = expectedReason(gate.id, baseCategories.get(gate.id), expectedRequired, { ...scenario, scope });
          if (gate.selection !== expected || gate.reason !== reason) {
            deltas.push({ case: testCase.name, scenario, gate: gate.id, expected, actual: gate.selection, reason });
          }
          expect(gate.category).toBe(baseCategories.get(gate.id));
          expect(gate.affectedWorkspaces).toEqual(scope.affectedWorkspaces);
          expect(gate.e2eBatches).toEqual(gate.id === "e2e-tests" ? batchE2eSuiteIds(scope.e2eSuiteIds) : []);
        }
      }
    }
    expect(deltas).toEqual([]);
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);
  });

  it("derives six disjoint categories over the closed required-check universe", () => {
    const needs = requiredNeeds(baseWorkflow);
    const categories = derivedCategories(baseWorkflow);
    const universe = [...needs, "pr-required"];
    expect([...categories.keys()]).toEqual(universe);
    expect(new Set(categories.values())).toEqual(new Set(CI_GATE_CATEGORIES));
    expect(categories.get("db-tests")).toBe("scope-gated");
    expect(categories.get("terraform-observability-plan")).toBe("scope-gated");
    expect(categories.get("e2e-tests")).toBe("targeted-heavy");
    expect(categories.get("preview-deploy-smoke")).toBe("pr-complement");
    expect(categories.get("compose-preview-smoke")).toBe("pr-complement");
    const outside = workflowJobs(baseWorkflow)
      .map(({ id }) => id)
      .filter((id) => !universe.includes(id));
    expect(outside).toEqual(["release-status", "release-qualification-scope-advisory"]);

    const forcePreviewIntoScopeGated = new Map(categories).set("preview-deploy-smoke", "scope-gated");
    expect(forcePreviewIntoScopeGated).not.toEqual(categories);
    const omitComplementCategory = new Map(categories);
    omitComplementCategory.delete("compose-preview-smoke");
    expect([...omitComplementCategory.keys()]).not.toEqual(universe);
  });

  it("closes executability over exactly the same seventeen gates", () => {
    const universe = [...requiredNeeds(baseWorkflow), "pr-required"];
    expect(CI_GATE_DEFINITIONS.map(({ id }) => id)).toEqual(universe);
    expect(CI_GATE_DEFINITIONS.every(({ executability }) => CI_GATE_EXECUTABILITY.includes(executability))).toBe(true);
    expect(
      CI_GATE_DEFINITIONS.filter(({ executability }) => executability === "REPOSITORY_LOCAL").map(({ id }) => id),
    ).toEqual(["change-scope", "static", "typecheck", "unit-tests", "db-tests", "e2e-tests", "build"]);
    expect(
      CI_GATE_DEFINITIONS.filter(({ executability, hostedOnlyReason }) =>
        executability === "HOSTED_ONLY"
          ? typeof hostedOnlyReason === "string" && hostedOnlyReason.length > 0
          : hostedOnlyReason === null,
      ),
    ).toHaveLength(17);

    const scope = classifyChanges({ changedFiles: ["README.md"] });
    const plan = createCiGatePlan({ mode: "merge-group", scope });
    expect(() => validateCiGatePlan({ ...plan, gates: plan.gates.slice(1) })).toThrow("UNKNOWN_OR_MISSING_GATE_IDS");
    const hostedIndex = plan.gates.findIndex(({ executability }) => executability === "HOSTED_ONLY");
    const executeHostedOnlyGate = structuredClone(plan);
    executeHostedOnlyGate.gates[hostedIndex].executability = "REPOSITORY_LOCAL";
    expect(() => validateCiGatePlan(executeHostedOnlyGate)).toThrow("GATE_EXECUTABILITY_MISMATCH");
  });

  it("keeps DB scope-gated while E2E remains targeted-heavy on the same diff", () => {
    const scope = classifyChanges({ changedFiles: ["bounded-contexts/checkout/features/cart/ui/cart-page.tsx"] });
    expect(scope.dbTestsRequired).toBe(true);
    expect(scope.e2eTestsRequired).toBe(true);
    const arms = [
      { mode: "pull-request", labels: [], provenance: "same-repository" },
      {
        mode: "pull-request",
        labels: [],
        provenance: "same-repository",
        scope: { ...scope, integrationRiskRequired: true },
      },
      ...FULL_BATTERY_LABELS.map((label) => ({ mode: "pull-request", labels: [label], provenance: "same-repository" })),
      { mode: "merge-group", labels: [] },
    ];
    for (const arm of arms) {
      const plan = createCiGatePlan({ ...arm, scope: arm.scope ?? scope });
      expect(plan.gates.find(({ id }) => id === "db-tests")).toMatchObject({ selection: "REQUIRED", reason: "scope" });
    }
    const fast = createCiGatePlan({ mode: "pull-request", labels: [], provenance: "same-repository", scope });
    expect(fast.gates.find(({ id }) => id === "e2e-tests")).toMatchObject({
      selection: "NOT_REQUIRED",
      reason: "pr-fast-lane",
    });
    const mergeGroup = createCiGatePlan({ mode: "merge-group", scope });
    expect(mergeGroup.gates.find(({ id }) => id === "e2e-tests").selection).toBe("REQUIRED");

    const bypassDbWithHeavyLane = fast.fullBatteryRequired || fast.targetedHeavyRequired;
    expect(bypassDbWithHeavyLane && scope.dbTestsRequired).toBe(false);
    expect(fast.gates.find(({ id }) => id === "db-tests").selection).toBe("REQUIRED");
  });

  it("keeps provenance explicit and affects only the preview complement", () => {
    const scope = { ...classifyChanges({ changedFiles: ["README.md"] }), clusterPreviewRequired: false };
    const same = createCiGatePlan({ mode: "pull-request", labels: ["preview"], provenance: "same-repository", scope });
    const fork = createCiGatePlan({ mode: "pull-request", labels: ["preview"], provenance: "fork", scope });
    const changed = same.gates
      .filter((gate, index) => gate.selection !== fork.gates[index].selection)
      .map(({ id }) => id);
    expect(changed).toEqual(["preview-deploy-smoke"]);
    expect(same.gates.find(({ id }) => id === "preview-deploy-smoke").selection).toBe("REQUIRED");
    expect(fork.gates.find(({ id }) => id === "preview-deploy-smoke").selection).toBe("NOT_REQUIRED");
    expect(same.gates.find(({ id }) => id === "compose-preview-smoke").selection).toBe("NOT_REQUIRED");

    const missing = createCiGatePlan({ mode: "pull-request", labels: ["preview"], scope });
    expect(missing.gates.find(({ id }) => id === "preview-deploy-smoke")).toMatchObject({
      selection: "UNDECIDABLE",
      reason: "missing-provenance",
    });
    const omitSameRepositoryInput = scope.clusterPreviewRequired || same.labels.includes("preview");
    expect(omitSameRepositoryInput).toBe(true);
    expect(
      baseSelection("preview-deploy-smoke", { mode: "pull-request", labels: ["preview"], provenance: "fork", scope }),
    ).toBe(false);
    const mergeGroup = createCiGatePlan({
      mode: "merge-group",
      labels: ["preview"],
      provenance: "same-repository",
      scope,
    });
    expect(mergeGroup.provenance).toBeNull();
    expect(
      mergeGroup.gates
        .filter(({ category }) => category === "pr-complement")
        .every(({ selection }) => selection === "NOT_REQUIRED"),
    ).toBe(true);
  });

  it("rejects unknown gates and every token outside the closed plan enums", () => {
    const plan = createCiGatePlan({
      mode: "merge-group",
      scope: classifyChanges({ changedFiles: ["README.md"] }),
    });
    const unknown = structuredClone(plan);
    unknown.gates[0].id = "unknown-gate";
    expect(() => validateCiGatePlan(unknown)).toThrow("UNKNOWN_OR_MISSING_GATE_IDS");
    for (const [field, token, message] of [
      ["selection", "INDETERMINATE", "UNKNOWN_GATE_SELECTION"],
      ["executability", "MAYBE_LOCAL", "GATE_EXECUTABILITY_MISMATCH"],
      ["category", "misc", "GATE_CATEGORY_MISMATCH"],
    ]) {
      const mutant = structuredClone(plan);
      mutant.gates[0][field] = token;
      expect(() => validateCiGatePlan(mutant)).toThrow(message);
    }
    expect(CI_GATE_SELECTIONS).toEqual(["REQUIRED", "NOT_REQUIRED", "UNDECIDABLE"]);
  });

  it("proves the head workflow consumes the shared plan without selection copies", () => {
    expect(headWorkflow).toContain("node ./scripts/ci-gate-plan.mjs github-output");
    expect(headWorkflow).not.toContain("Resolve full battery lane");
    expect(headWorkflow).not.toContain("require_heavy_job()");
    expect(headWorkflow).not.toContain("require_targeted_heavy_job()");
    for (const definition of CI_GATE_DEFINITIONS.filter(({ id }) => id !== "pr-required")) {
      expect(headWorkflow).toContain(`outputs.${definition.id.replaceAll("-", "_")}_required`);
    }
  });
});
