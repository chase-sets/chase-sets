import { execFileSync, spawnSync } from "node:child_process";
import { GIT_LISTING_MAX_BUFFER } from "./lib/git-listing.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { classifyChanges, listChangedFiles, toOutputMap } from "./change-scope.mjs";
import {
  CI_GATE_CATEGORIES,
  CI_GATE_DEFINITIONS,
  CI_GATE_EXECUTABILITY,
  CI_GATE_SELECTIONS,
  FULL_BATTERY_LABELS,
  ciGatePlanOutputMap,
  createCiGatePlan,
  validateCiGatePlan,
} from "./ci-gate-plan.mjs";
import { batchBrowserE2eSuiteIds, batchE2eSuiteIds, e2eSuites } from "./e2e-suites.mjs";
import { renderedCopyTuples } from "../infrastructure/playwright-evidence/rendered-copy.ts";
import { listWorkspacePackages } from "./lib/repo.mjs";
import { ALWAYS_RUN, VERIFY_STATIC_SURFACES } from "./verify-static-surfaces.mjs";
import { prepareHostedResponsiveEvidenceArtifact } from "./validate-responsive-evidence-artifacts.mjs";

const REPOSITORY_SCAN_TEST_TIMEOUT_MS = 120_000;
const selectionFixture = JSON.parse(readFileSync("scripts/fixtures/ci-e2e-selection.json", "utf8"));
const E2E_SELECTION_BASE_SHA = "6dd05a038a8863a1b28a96d68ccdb7906a16bed4";
const priorPlannerSource = execFileSync("git", ["show", `${E2E_SELECTION_BASE_SHA}:scripts/ci-gate-plan.mjs`], {
  encoding: "utf8",
}).replace('"./e2e-suites.mjs"', JSON.stringify(pathToFileURL(path.resolve("scripts/e2e-suites.mjs")).href));
const priorDirectory = mkdtempSync(path.join(os.tmpdir(), "ci-e2e-baseline-"));
let priorPlanner;
try {
  const priorFile = path.join(priorDirectory, "ci-gate-plan.mjs");
  writeFileSync(priorFile, priorPlannerSource);
  priorPlanner = await import(pathToFileURL(priorFile).href);
} finally {
  rmSync(priorDirectory, { recursive: true, force: true });
}
const { createCiGatePlan: priorCreateCiGatePlan, ciGatePlanOutputMap: priorOutputMap } = priorPlanner;
const workspaces = listWorkspacePackages();

describe("hosted bootstrap oracle memo gate", () => {
  it("selects memo check only for generator changes", () => {
    const prefix = "deployables/platform-api/";
    const selected = [
      `${prefix}__tests__/fixtures/bootstrap-db-oracle-schedule-memo.json`,
      `${prefix}__tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs`,
      `${prefix}__tests__/fixtures/bootstrap-db-schedule-before-subset-reuse.mjs`,
      `${prefix}scripts/check-bootstrap-db-enrollment.mjs`,
    ];
    for (const mode of ["pull-request", "merge-group"]) {
      for (const file of [...selected, "README.md", "scripts/bootstrap-db-oracle-memo-artifact.mjs"]) {
        const scope = classifyChanges({ changedFiles: [file], workspaces });
        const plan = createCiGatePlan({ mode, scope, provenance: "same-repository", labels: ["full-ci"] });
        expect(
          plan.gates.find(({ id }) => id === "bootstrap-db-oracle-memo-check"),
          file,
        ).toMatchObject({
          selection: selected.includes(file) ? "REQUIRED" : "NOT_REQUIRED",
          executability: "HOSTED_ONLY",
        });
      }
    }
  });

  it("PR Required fails missing memo check", () => {
    const workflow = parseYaml(readFileSync(".github/workflows/platform-pr.yml", "utf8"));
    expect(workflow.jobs["pr-required"].needs).toContain("bootstrap-db-oracle-memo-check");
    const run = workflow.jobs["pr-required"].steps.find(({ name }) => name === "Verify required jobs").run;
    expect(run).toContain(
      'require_job "Bootstrap DB Oracle Memo Check" "${{ needs[\'bootstrap-db-oracle-memo-check\'].result }}" "${{ needs[\'change-scope\'].outputs.bootstrap_db_oracle_memo_check_required }}"',
    );
    const scope = classifyChanges({
      changedFiles: ["deployables/platform-api/__tests__/fixtures/bootstrap-db-oracle-schedule-memo.json"],
      workspaces,
    });
    const outputs = ciGatePlanOutputMap(
      createCiGatePlan({ mode: "pull-request", provenance: "same-repository", scope }),
    );
    const bash =
      process.platform === "win32"
        ? path.resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe")
        : "bash";
    for (const result of ["success", "failure", "skipped", ""]) {
      const script = run.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
        if (expression === "needs['bootstrap-db-oracle-memo-check'].result") return result;
        if (expression.endsWith(".result")) return "success";
        const key = expression.match(/^needs\['change-scope'\]\.outputs\.(\w+)$/)?.[1];
        if (key && key in outputs) return outputs[key];
        throw new Error(`Unexpected Required expression: ${expression}`);
      });
      const execution = spawnSync(bash, ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          AC4_E2E_REQUIRED: outputs.e2e_tests_required,
          AC4_E2E_SUITES_JSON: toOutputMap(scope).e2e_suites_json,
        },
      });
      if (execution.error) throw execution.error;
      expect(execution.status, execution.stdout + execution.stderr).toBe(result === "success" ? 0 : 1);
      if (result !== "success") expect(execution.stderr).toContain("Bootstrap DB Oracle Memo Check was required");
    }
    const job = workflow.jobs["bootstrap-db-oracle-memo-check"];
    expect(job["timeout-minutes"]).toBe(30);
    expect(job.steps.filter(({ run }) => run?.includes("bootstrap-db-oracle-schedule-memo.mjs"))).toEqual([
      expect.objectContaining({
        run: "node deployables/platform-api/__tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs --check",
      }),
    ]);
    expect(
      job.steps.find(({ name }) => name === "Check memo against raw pinned oracle")["working-directory"],
    ).toBeUndefined();
  });
});
const scopedCases = selectionFixture.cases.map((entry) => ({
  ...entry,
  scope: classifyChanges({ changedFiles: entry.changedFiles, workspaces }),
}));

function expectedRenderedCopyBatches(ordinaryBatches) {
  const owners = new Set(renderedCopyTuples.map((tuple) => tuple.suite));
  return [
    ...ordinaryBatches,
    ...(ordinaryBatches.some((batch) => batch.split(",").some((id) => owners.has(id))) ? ["rendered_copy"] : []),
  ];
}

describe("rendered-copy construction and event contract", () => {
  it(
    "enumerates every current browser subset through both real matrix producers",
    { timeout: REPOSITORY_SCAN_TEST_TIMEOUT_MS },
    () => {
      const browser = e2eSuites.filter((suite) => !suite.command);
      const owners = new Set(renderedCopyTuples.map((tuple) => tuple.suite));
      const empty = classifyChanges({ changedFiles: [], workspaces });
      const subsets = 2 ** browser.length;
      console.log(`RENDERED_COPY_SUBSETS browserRegistry=${browser.length} subsets=${subsets}`);
      for (let mask = 0; mask < subsets; mask++) {
        const ids = browser.filter((_, index) => (mask & (2 ** index)) !== 0).map((suite) => suite.id);
        const scope = { ...empty, e2eSuiteIds: ids, e2eTestsRequired: ids.length > 0 };
        const ordinary = batchE2eSuiteIds(ids.filter((id) => id !== "rendered_copy"));
        const expected = expectedRenderedCopyBatches(ordinary);
        if (ids.includes("rendered_copy") && !expected.includes("rendered_copy")) expected.push("rendered_copy");
        const output = JSON.parse(toOutputMap(scope).e2e_suite_batches_json);
        expect(output, `subset ${mask}`).toEqual(expected);
        expect(output.filter((batch) => batch.split(",").includes("rendered_copy"))).toEqual(
          ids.includes("rendered_copy") || ids.some((id) => owners.has(id)) ? ["rendered_copy"] : [],
        );
        for (const mode of ["pull-request", "merge-group"]) {
          expect(
            createCiGatePlan({ mode, provenance: "same-repository", scope }).gates.find(
              (gate) => gate.id === "e2e-tests",
            ).e2eBatches,
          ).toEqual(expected);
        }
      }
      expect(batchBrowserE2eSuiteIds(["rendered_copy"])).toEqual(["rendered_copy"]);
    },
  );

  it("uploads the validated dedicated part only on pull_request, never merge_group", () => {
    const source = readFileSync(".github/workflows/platform-pr.yml", "utf8");
    const upload = source.slice(
      source.indexOf("      - name: Upload rendered-copy observation part"),
      source.indexOf("      - name: Prepare sanitized operator extension evidence"),
    );
    expect(upload).toContain("github.event_name == 'pull_request'");
    expect(upload).toContain("matrix.suite_batch == 'rendered_copy'");
    expect(upload).toContain("steps.e2e-producer.outputs.rendered-copy-part != ''");
    expect(upload).toContain("if-no-files-found: error");
    expect(upload).toContain("include-hidden-files: true");
    for (const event of ["pull_request", "merge_group"]) {
      for (const batch of ["rendered_copy", "admin_access", "rendered_copy,admin_access"]) {
        for (const part of ["", "synthetic-part"]) {
          const condition = upload
            .match(/        if: \$\{\{ (.+) \}\}/)[1]
            .replaceAll("github.event_name", JSON.stringify(event))
            .replaceAll("matrix.suite_batch", JSON.stringify(batch))
            .replaceAll("steps.e2e-producer.outputs.rendered-copy-part", JSON.stringify(part));
          expect(runInNewContext(condition)).toBe(event === "pull_request" && batch === "rendered_copy" && part !== "");
        }
      }
    }
  });
});

function executedSuiteIds(plan, outputMap = ciGatePlanOutputMap) {
  const gate = plan.gates.find(({ id }) => id === "e2e-tests");
  return outputMap(plan).e2e_tests_required === "true"
    ? gate.e2eBatches.flatMap((batch) => batch.split(",")).sort()
    : [];
}

function assertExecutableParity(planner = createCiGatePlan) {
  for (const entry of scopedCases) {
    const group = executedSuiteIds(planner({ mode: "merge-group", scope: entry.scope }));
    for (const scenario of scenarios.filter(({ mode }) => mode === "pull-request")) {
      expect(
        executedSuiteIds(planner({ ...scenario, scope: entry.scope })),
        JSON.stringify(entry.changedFiles),
      ).toEqual(group);
    }
  }
}

function assertPreservedSelection(planner = createCiGatePlan) {
  for (const entry of scopedCases) {
    expect(entry.scope.e2eSuiteIds).toEqual(entry.suiteIds);
    for (const scenario of scenarios) {
      const inputs = { ...scenario, scope: entry.scope };
      const prior = priorCreateCiGatePlan(inputs);
      const candidate = planner(inputs);
      const expected = structuredClone(prior);
      const e2e = expected.gates.find(({ id }) => id === "e2e-tests");
      expect(e2e.e2eBatches).toEqual(entry.batches);
      e2e.e2eBatches = expectedRenderedCopyBatches(entry.batches);
      e2e.category = "scope-gated";
      e2e.selection = entry.suiteIds.length > 0 ? "REQUIRED" : "NOT_REQUIRED";
      e2e.reason = entry.suiteIds.length > 0 ? "scope" : "not-affected";
      expect(
        { ...candidate, gates: candidate.gates.filter(({ id }) => id !== "bootstrap-db-oracle-memo-check") },
        `${JSON.stringify(entry.changedFiles)} ${JSON.stringify(scenario)}`,
      ).toEqual(expected);
      expect(executedSuiteIds(candidate)).toEqual(
        expectedRenderedCopyBatches(entry.batches)
          .flatMap((batch) => batch.split(","))
          .sort(),
      );
    }
  }
}

const IMPLEMENTATION_BASE_SHA = "0b4bf3adde0adda5bae2060dd898443cb4dcdb21";
execFileSync("git", ["cat-file", "-e", `${IMPLEMENTATION_BASE_SHA}^{commit}`], { stdio: "ignore" });
const baseWorkflow = execFileSync("git", ["show", `${IMPLEMENTATION_BASE_SHA}:.github/workflows/platform-pr.yml`], {
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
  { name: "workflow-only change", changedFiles: [".github/workflows/platform-pr.yml"] },
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

describe("shared E2E setup regression and enforcement", () => {
  const baseSha = "4e22cd5906069f661bc129e7e15f4b43b3cdf780";
  const workflowPath = ".github/workflows/platform-pr.yml";
  const helperPath = "scripts/playwright-chromium-install.mjs";
  const acquisitionRows = [
    "M\t.github/workflows/platform-pr.yml",
    "D\t.github/workflows/playwright-chromium-install-diagnostics.yml",
    "M\tscripts/check-github-actions-runtime.mjs",
    "M\tscripts/check-github-actions-runtime.test.mjs",
    "D\tscripts/check-structure/playwright-chromium-install-diagnostics.test.mjs",
    "D\tscripts/playwright-chromium-install-diagnostics.mjs",
    "D\tscripts/playwright-chromium-install-diagnostics.test.mjs",
    "M\tscripts/playwright-chromium-install.mjs",
    "M\tscripts/playwright-chromium-install.test.mjs",
    "M\tscripts/provider-browser-install-timeout.mjs",
    "M\tscripts/provider-browser-install-timeout.test.mjs",
    "M\tscripts/release-qualification-scope.mjs",
  ];

  it("turns the head-bound installation and revert regressions from unselected into required Chromium", async () => {
    const historical = [
      { sha: "6ffb36ec1cf50544038869348542157ad256f721", status: "A" },
      { sha: "909dd142ae54a67f97be0b411ce7698b0b45a1b0", status: "D" },
    ].map(({ sha, status }) => {
      const rows = execFileSync(
        "git",
        ["diff-tree", "--no-commit-id", "--no-renames", "--name-status", "-r", `${sha}^`, sha],
        { encoding: "utf8" },
      )
        .trim()
        .split(/\r?\n/);
      expect(rows).toEqual([
        `M\t${workflowPath}`,
        `${status}\tscripts/install-playwright-chromium.sh`,
        `${status}\tscripts/install-playwright-chromium.test.mjs`,
      ]);
      return { head: sha, rows };
    });
    // The acquisition head is squash-prone: retain its independently captured rows, not a Git-object dependency.
    expect(
      createHash("sha256")
        .update(`${acquisitionRows.join("\n")}\n`)
        .digest("hex"),
    ).toBe("8a526750040eb9cd9046f0d3f532b848e44d8bd25aacf4dd89158a330c8cba74");
    const directory = mkdtempSync(path.join(os.tmpdir(), "setup-e2e-regression-"));
    try {
      const selectorFile = path.join(directory, "e2e-suites.mjs");
      const classifierFile = path.join(directory, "change-scope.mjs");
      writeFileSync(
        selectorFile,
        execFileSync("git", ["show", `${baseSha}:scripts/e2e-suites.mjs`], { encoding: "utf8" }).replace(
          '"./lib/risk-policy-v1.mjs"',
          JSON.stringify(pathToFileURL(path.resolve("scripts/lib/risk-policy-v1.mjs")).href),
        ),
      );
      let source = execFileSync("git", ["show", `${baseSha}:scripts/change-scope.mjs`], { encoding: "utf8" });
      for (const specifier of ["./lib/repo.mjs", "./lib/risk-policy-v1.mjs", "./lib/context-proof-sets.mjs"]) {
        source = source.replace(
          JSON.stringify(specifier),
          JSON.stringify(pathToFileURL(path.resolve("scripts", specifier)).href),
        );
      }
      source = source.replace(
        'const rootDir = fileURLToPath(new URL("../", import.meta.url));',
        `const rootDir = ${JSON.stringify(process.cwd())};`,
      );
      writeFileSync(
        classifierFile,
        source.replace('"./e2e-suites.mjs"', JSON.stringify(pathToFileURL(selectorFile).href)),
      );
      const baseline = await import(pathToFileURL(classifierFile).href);
      const regressions = [...historical, { head: "31a3165b1c9ef49a1a0a903930a7a60f1b0314b9", rows: acquisitionRows }];
      for (const { head, rows } of regressions) {
        expect(
          rows.every((row) => /^[AMD]\t[^\r\n]+$/.test(row)),
          head,
        ).toBe(true);
        const files = rows.map((row) => row.split("\t")[1]);
        for (const changedFiles of [files, [workflowPath]]) {
          const previous = baseline.classifyChanges({ changedFiles, workspaces });
          const scope = classifyChanges({ changedFiles, workspaces });
          expect(previous.e2eSuiteIds, head).toEqual([]);
          expect(baseline.toOutputMap(previous).e2e_suite_batches_json).toBe("[]");
          expect(scope).toEqual({ ...previous, e2eSuiteIds: ["admin_auth"], e2eTestsRequired: true });
          for (const mode of ["pull-request", "merge-group"]) {
            const inputs = { mode, labels: [], provenance: "same-repository" };
            expect(
              createCiGatePlan({ ...inputs, scope: previous }).gates.find(({ id }) => id === "e2e-tests"),
            ).toMatchObject({ selection: "NOT_REQUIRED", e2eBatches: [] });
            const plan = createCiGatePlan({ ...inputs, scope });
            expect(plan.gates.find(({ id }) => id === "e2e-tests")).toMatchObject({
              selection: "REQUIRED",
              e2eBatches: ["admin_auth"],
            });
            expect(ciGatePlanOutputMap(plan).e2e_tests_required).toBe("true");
            expect(executedSuiteIds(plan)).toEqual(["admin_auth"]);
          }
        }
      }
      for (const changedFiles of [
        ["scripts/install-playwright-chromium.sh", "scripts/install-playwright-chromium.test.mjs"],
        [helperPath],
      ]) {
        expect(classifyChanges({ changedFiles }).e2eSuiteIds).toEqual(
          changedFiles.includes(helperPath) ? ["admin_auth"] : [],
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(
    [[workflowPath], [helperPath], [workflowPath, helperPath], ["README.md"]].flatMap((changedFiles) =>
      ["pull-request", "merge-group"].map((mode) => ({ changedFiles, mode })),
    ),
  )(
    "enforces actual Required bash for $changedFiles in $mode, with unselected skip neutral",
    ({ changedFiles, mode }) => {
      const workflow = parseYaml(headWorkflow);
      const gate = workflow.jobs["pr-required"].steps.find(({ name }) => name === "Verify required jobs");
      const bash =
        process.platform === "win32"
          ? path.resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe")
          : "bash";
      const scope = classifyChanges({ changedFiles, workspaces });
      const outputs = ciGatePlanOutputMap(createCiGatePlan({ mode, labels: [], provenance: "same-repository", scope }));
      const selected = changedFiles.includes(workflowPath) || changedFiles.includes(helperPath);
      expect(outputs.e2e_tests_required).toBe(String(selected));
      for (const result of ["success", "failure", "skipped"]) {
        const run = gate.run.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
          if (expression === "needs['e2e-tests'].result") return result;
          if (expression.endsWith(".result")) return "success";
          const key = expression.match(/^needs\['change-scope'\]\.outputs\.(\w+)$/)?.[1];
          if (key && key in outputs) return outputs[key];
          throw new Error(`Unexpected Required expression: ${expression}`);
        });
        const execution = spawnSync(bash, ["-c", run], {
          encoding: "utf8",
          env: {
            ...process.env,
            AC4_E2E_REQUIRED: outputs.e2e_tests_required,
            AC4_E2E_SUITES_JSON: toOutputMap(scope).e2e_suites_json,
          },
        });
        if (execution.error) throw execution.error;
        expect(execution.status, execution.stdout + execution.stderr).toBe(
          result === "success" || (!selected && result === "skipped") ? 0 : 1,
        );
        if (selected && result !== "success")
          expect(execution.stderr).toContain(`E2E Tests was required but finished with result '${result}'`);
      }
    },
  );

  it("preserves matrix, budgets, retries and success-only publication wiring", () => {
    const workflow = parseYaml(headWorkflow);
    const job = workflow.jobs["e2e-tests"];
    expect(job.name).toBe("E2E Tests (${{ matrix.suite_batch }})");
    expect(job["timeout-minutes"]).toBe(25);
    expect(job.strategy).toEqual({
      "fail-fast": false,
      matrix: { suite_batch: "${{ fromJson(needs['change-scope'].outputs.e2e_suite_batches_json) }}" },
    });
    expect(job.steps.find(({ id }) => id === "e2e-producer")["continue-on-error"]).toBeUndefined();
    expect(job.steps.find(({ name }) => name === "Upload successful responsive evidence").if).toBe(
      "steps.responsive-evidence.outputs.publish == 'true'",
    );

    const pinned = {
      landing: "ff0d9dba9bec81852185bf0a76caac58e2eeb102",
      parent: "8f227bbda3c2a3379c694d41f3c2a6b4286a7193",
      baseline: baseSha,
    };
    for (const [role, sha] of Object.entries(pinned)) {
      expect(sha, `E2E_NEUTRALITY_PINNED_ROLE_INVALID: ${role}`).toMatch(/^[a-f0-9]{40}$/);
      expect(
        spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { encoding: "utf8" }).status,
        `E2E_NEUTRALITY_OBJECT_MISSING: ${role}`,
      ).toBe(0);
    }
    const parents = execFileSync("git", ["show", "-s", "--format=%P", pinned.landing], { encoding: "utf8" })
      .trim()
      .split(" ");
    expect(parents, "E2E_NEUTRALITY_PARENTAGE_MISMATCH").toEqual([pinned.parent]);
    const rows = execFileSync("git", ["diff", "--no-renames", "--name-status", pinned.parent, pinned.landing], {
      encoding: "utf8",
      maxBuffer: GIT_LISTING_MAX_BUFFER,
    })
      .trim()
      .split(/\r?\n/);
    expect(rows, "E2E_NEUTRALITY_CHANGED_ROWS_MISMATCH").toEqual([
      "M\tscripts/change-scope.test.mjs",
      "M\tscripts/ci-gate-plan.test.mjs",
      "M\tscripts/e2e-suites.mjs",
      "M\tscripts/fixtures/ci-e2e-selection.json",
    ]);
    for (const [role, sha] of Object.entries(pinned)) {
      const blob = execFileSync("git", ["rev-parse", `${sha}:${workflowPath}`], { encoding: "utf8" }).trim();
      expect(blob, `E2E_NEUTRALITY_WORKFLOW_BLOB_MISMATCH: ${role}`).toBe("849088b6d52a1dd508985ec337c4a83ff19988ae");
    }
  });

  it.each(["failure", "skipped"])("publishes no responsive evidence for a selected %s producer", async (outcome) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "setup-e2e-publication-"));
    const sha = "a".repeat(40);
    try {
      const result = await prepareHostedResponsiveEvidenceArtifact({
        repoRoot: directory,
        selectedGreps: ["@admin-auth"],
        outputRoot: "synthetic-hosted-output",
        producer: {
          outcome,
          repository: "synthetic/example",
          workflow: "Synthetic PR",
          workflowRef: "synthetic/ref",
          eventName: "pull_request",
          job: "e2e-tests",
          suiteBatch: "admin_auth",
          runId: 1,
          runAttempt: 1,
          jobIndex: 0,
          workflowSha: sha,
          checkoutSha: sha,
          checkoutTreeSha: sha,
          checkoutParentShas: [sha, sha],
          executedBaseSha: sha,
          executedBaseTreeSha: sha,
          sourceHeadSha: sha,
          sourceHeadTreeSha: sha,
          eventBaseSha: sha,
        },
        gitIdentity: {
          checkoutCommit: sha,
          checkoutTree: sha,
          checkoutParents: [sha, sha],
          executedBase: sha,
          executedBaseTree: sha,
          sourceHead: sha,
          sourceHeadTree: sha,
          shallow: false,
        },
      });
      expect(result).toEqual({
        publish: false,
        violations: [`responsive evidence producer outcome must be 'success', got '${outcome}'.`],
        expectedClaimIds: [],
        files: [],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("shared CI gate plan", () => {
  it("incident #8493 executes the complete 29-path suite set before merge queue admission", () => {
    expect(selectionFixture.incidentHead).toBe("6ad07d20f93f9e6fa5baef975583b71d9b4a1aac");
    // Bound to the verified historical diff, without depending on retention of
    // a squashed PR's branch in future CI checkouts.
    expect(
      createHash("sha256")
        .update(`${selectionFixture.incident.join("\n")}\n`)
        .digest("hex"),
    ).toBe("2c6566fc3de548289721f453200a2e5cf04414ef1a94d9352bfe1b1dc860f3d7");
    expect(selectionFixture.incident).toHaveLength(25);
    const scope = classifyChanges({ changedFiles: selectionFixture.incident, workspaces });
    expect(scope.integrationRiskRequired).toBe(false);
    expect(scope.e2eSuiteIds).toEqual(["marketplace_browse", "catalog_admin_integrations"]);
    const inputs = { mode: "pull-request", provenance: "same-repository", labels: [], scope };
    const baseline = priorCreateCiGatePlan(inputs);
    expect(baseline.gates.find(({ id }) => id === "e2e-tests")).toMatchObject({
      selection: "NOT_REQUIRED",
      reason: "pr-fast-lane",
      e2eBatches: ["marketplace_browse,catalog_admin_integrations"],
    });
    expect(executedSuiteIds(baseline, priorOutputMap)).toEqual([]);
    for (const mode of ["pull-request", "merge-group"]) {
      const plan = createCiGatePlan({ ...inputs, mode });
      expect(plan.gates.find(({ id }) => id === "e2e-tests").selection).toBe("REQUIRED");
      expect(executedSuiteIds(plan)).toEqual(["catalog_admin_integrations", "marketplace_browse", "rendered_copy"]);
    }
  });

  it("plans the observed account, seller and connector extension selection with the extension alone", () => {
    // Suite-selecting paths of the settlement change whose account/extension job hit the 25-minute limit.
    const scope = classifyChanges({
      changedFiles: [
        "bounded-contexts/channels/features/connector-client/tests/coordinator-test-support.ts",
        "bounded-contexts/channels/features/outbound-sync/api/runtime.ts",
        "bounded-contexts/channels/features/tcgplayer-csv/api/runtime.ts",
        "deployables/tcgplayer-connector-extension/__tests__/harness/executors.harness.ts",
      ],
      workspaces,
    });
    const batches = ["marketplace_account,marketplace_seller", "tcgplayer_connector_extension", "rendered_copy"];
    expect(scope.e2eSuiteIds).toEqual(["marketplace_account", "marketplace_seller", "tcgplayer_connector_extension"]);
    expect(JSON.parse(toOutputMap(scope).e2e_suite_batches_json)).toEqual(batches);
    for (const scenario of scenarios) {
      const plan = createCiGatePlan({ ...scenario, scope });
      expect(
        plan.gates.find(({ id }) => id === "e2e-tests"),
        JSON.stringify(scenario),
      ).toMatchObject({
        selection: "REQUIRED",
        reason: "scope",
        e2eBatches: batches,
      });
      expect(ciGatePlanOutputMap(plan).e2e_tests_required).toBe("true");
      expect(executedSuiteIds(plan)).toEqual([
        "marketplace_account",
        "marketplace_seller",
        "rendered_copy",
        "tcgplayer_connector_extension",
      ]);
    }
  });

  it("enumerates every canonical mapping shape and its real executable territory", () => {
    const source = readFileSync("scripts/e2e-suites.mjs", "utf8");
    const names = [
      "browserRuntimePatterns",
      "contextSuiteOwnership",
      "marketplaceContextRouteSuiteOwnership",
      "adminContextRouteSuiteOwnership",
      "e2eSpecSuiteOwnership",
      "e2eNoSuiteExclusions",
      "marketplaceRouteSuiteOwnership",
      "boundedContextRouteSuiteOwnership",
    ];
    // Inspect ownership data only; the real classifier remains the sole selector.
    const inventory = runInNewContext(
      source
        .slice(source.indexOf("const suiteOrder"), source.indexOf("function normalizeFilePath"))
        .replaceAll("export const", "const") + `\n({${names.join(",")}})`,
      { e2eSuites },
    );
    const families = Object.entries(inventory).flatMap(([name, entries]) =>
      [...entries].map((entry, index) => {
        if (Array.isArray(entry)) {
          const suffix =
            name === "contextSuiteOwnership"
              ? "features/[^/]+/(?:api|ui)/"
              : name === "marketplaceContextRouteSuiteOwnership"
                ? "routes/marketplace/"
                : "routes/(?:admin|access-admin|catalog-admin)/";
          return {
            family: `${name}:${entry[0]}`,
            pattern: String(new RegExp(`^bounded-contexts/${entry[0]}/${suffix}`)),
            suites: entry[1],
          };
        }
        return { family: `${name}:${index}`, pattern: String(entry.pattern ?? entry), suites: entry.suites ?? null };
      }),
    );
    expect(families).toEqual(
      selectionFixture.families.map(({ family, pattern, suites }) => ({ family, pattern, suites })),
    );
    const tracked = new Set(
      execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: GIT_LISTING_MAX_BUFFER }).split("\0"),
    );
    for (const family of selectionFixture.families) {
      const pattern = new RegExp(family.pattern.slice(1, -1));
      expect(pattern.test(family.path), family.family).toBe(true);
      expect(selectionFixture.cases.some(({ changedFiles }) => changedFiles.includes(family.path))).toBe(true);
      if (!family.synthetic) expect(tracked.has(family.path), family.family).toBe(true);
    }
    // The registered SDK suite has no path ownership in the production selector.
    // This change preserves that mapping rather than inventing a new one.
    expect(new Set(scopedCases.flatMap(({ suiteIds }) => suiteIds))).toEqual(
      new Set(e2eSuites.filter(({ id }) => !["platform_mcp_sdk", "rendered_copy"].includes(id)).map(({ id }) => id)),
    );
    const prefixes = [...source.matchAll(/normalized\.startsWith\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(prefixes).toEqual([
      "deployables/tcgplayer-operator-extension/",
      "bounded-contexts/catalog/features/operator-session/domain/extension/",
      "bounded-contexts/catalog/features/operator-session/ui/extension-popup/",
      "bounded-contexts/catalog/features/operator-session/tests/extension/",
      "deployables/tcgplayer-connector-extension/",
      "bounded-contexts/channels/features/connector-client/",
      "deployables/marketplace/",
      "deployables/admin-web/",
      "deployables/platform-api/",
      "packages/design-system/",
    ]);
    for (const prefix of prefixes)
      expect(scopedCases.some(({ changedFiles }) => changedFiles.some((file) => file.startsWith(prefix)))).toBe(true);
    const exactPaths = [...source.matchAll(/normalized === "([^"]+)"/g)].map((match) => match[1]);
    for (const file of exactPaths) {
      expect(tracked.has(file), file).toBe(true);
      expect(
        scopedCases.some(({ changedFiles }) => changedFiles.includes(file)),
        file,
      ).toBe(true);
    }
    expect(selectionFixture.families.filter(({ synthetic }) => synthetic)).toHaveLength(6);
  });

  it("selects identical executable E2E sets across modes, provenance and labels", () => {
    assertExecutableParity();
  });

  it(
    "feeds real modified, added, deleted and both renamed paths through the classifier and output consumers",
    { timeout: REPOSITORY_SCAN_TEST_TIMEOUT_MS },
    () => {
      const temporary = mkdtempSync(path.join(os.tmpdir(), "ci-e2e-path-operations-"));
      const git = (args) =>
        execFileSync("git", args, { cwd: temporary, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      const paths = scopedCases
        .filter(({ changedFiles }) => changedFiles.length === 1)
        .map(({ changedFiles }) => changedFiles[0]);
      const writePaths = (content) => {
        for (const file of paths) {
          const target = path.join(temporary, file);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, content);
        }
      };
      const commit = () => {
        git(["add", "--all"]);
        git([
          "-c",
          "user.name=CI selection fixture",
          "-c",
          "user.email=ci-selection@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--quiet",
          "-m",
          "Synthetic path operation",
        ]);
        return git(["rev-parse", "HEAD"]);
      };
      const check = (base, head, expectedPaths) => {
        const changedFiles = listChangedFiles(base, head, { cwd: temporary });
        expect(changedFiles).toEqual([...expectedPaths].sort());
        for (const files of [changedFiles, ...changedFiles.map((file) => [file])]) {
          const scope = classifyChanges({ changedFiles: files, workspaces });
          const batches = JSON.parse(toOutputMap(scope).e2e_suite_batches_json);
          const group = createCiGatePlan({ mode: "merge-group", scope });
          const priorGroup = priorCreateCiGatePlan({ mode: "merge-group", scope });
          expect(executedSuiteIds(group)).toEqual(
            expectedRenderedCopyBatches(priorGroup.gates.find((gate) => gate.id === "e2e-tests").e2eBatches)
              .flatMap((batch) => batch.split(","))
              .sort(),
          );
          expect(group.gates.find(({ id }) => id === "e2e-tests").e2eBatches).toEqual(batches);
          for (const scenario of scenarios.filter(({ mode }) => mode === "pull-request")) {
            expect(executedSuiteIds(createCiGatePlan({ ...scenario, scope }))).toEqual(executedSuiteIds(group));
          }
        }
      };
      try {
        git(["init", "--quiet"]);
        writePaths("Synthetic fixture baseline\n");
        let base = commit();
        writePaths("Synthetic fixture modified\n");
        let head = commit();
        check(base, head, paths);
        base = head;
        for (const file of paths) rmSync(path.join(temporary, file));
        head = commit();
        check(base, head, paths);
        base = head;
        writePaths("Synthetic fixture added\n");
        head = commit();
        check(base, head, paths);
        base = head;
        const renameCase = scopedCases.find(
          ({ changedFiles }) =>
            changedFiles.length === 2 &&
            changedFiles[0] === "bounded-contexts/catalog/features/operator-session/api/route.ts" &&
            changedFiles[1] === "bounded-contexts/inventory/features/listings/ui/listing.tsx",
        );
        expect(renameCase, "Catalog-provider/Inventory-listing rename fixture must be present").toBeDefined();
        const rename = renameCase.changedFiles;
        mkdirSync(path.dirname(path.join(temporary, rename[1])), { recursive: true });
        git(["mv", rename[0], rename[1]]);
        head = commit();
        check(base, head, rename);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );

  it("locks baseline-versus-candidate selection with only enumerated E2E deltas", () => {
    expect(selectionFixture.baseSha).toBe(E2E_SELECTION_BASE_SHA);
    assertPreservedSelection();
  });

  it(
    "kills arbitrary-path merge-group-only mapping, blanket-all-suites and group-shard-removal mutants independently",
    { timeout: REPOSITORY_SCAN_TEST_TIMEOUT_MS },
    () => {
      const mutate = (change) => (inputs) => {
        const plan = createCiGatePlan(inputs);
        change(plan, inputs);
        return plan;
      };
      const groupOnlyMapping = mutate((plan, inputs) => {
        if (inputs.mode === "merge-group" && inputs.scope.changedFiles.includes("scripts/ci-gate-plan.mjs")) {
          const gate = plan.gates.find(({ id }) => id === "e2e-tests");
          gate.selection = "REQUIRED";
          gate.e2eBatches = ["admin_access"];
        }
      });
      expect(() => assertExecutableParity(groupOnlyMapping)).toThrow();
      const blanketAllSuites = mutate((plan) => {
        const gate = plan.gates.find(({ id }) => id === "e2e-tests");
        gate.selection = "REQUIRED";
        gate.e2eBatches = batchE2eSuiteIds(e2eSuites.map(({ id }) => id));
      });
      expect(() => assertPreservedSelection(blanketAllSuites)).toThrow();
      const removeGroupShard = mutate((plan, inputs) => {
        if (inputs.mode === "merge-group") plan.gates.find(({ id }) => id === "e2e-tests").e2eBatches.pop();
      });
      expect(() => assertPreservedSelection(removeGroupShard)).toThrow();
      assertExecutableParity();
      assertPreservedSelection();
    },
  );

  it("binds real PR github-output CLI admission to hosted E2E condition and scope batch wiring", () => {
    const scope = classifyChanges({ changedFiles: selectionFixture.incident, workspaces });
    const temporary = mkdtempSync(path.join(os.tmpdir(), "ci-e2e-output-"));
    const outputFile = path.join(temporary, "github-output");
    try {
      execFileSync(process.execPath, ["scripts/ci-gate-plan.mjs", "github-output"], {
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputFile,
          CI_GATE_PLAN_MODE: "pull-request",
          CI_GATE_PLAN_LABELS_JSON: "[]",
          CI_GATE_PLAN_PROVENANCE: "same-repository",
          CI_GATE_PLAN_SCOPE_JSON: JSON.stringify(scope),
        },
        stdio: "pipe",
      });
      const outputs = Object.fromEntries(
        readFileSync(outputFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const delimiter = line.indexOf("=");
            return [line.slice(0, delimiter), line.slice(delimiter + 1)];
          }),
      );
      expect(outputs.e2e_tests_required).toBe("true");
      expect(outputs.full_battery_required).toBe("false");
      expect(outputs.targeted_heavy_required).toBe("false");
      expect(executedSuiteIds(JSON.parse(outputs.plan_json))).toEqual([
        "catalog_admin_integrations",
        "marketplace_browse",
        "rendered_copy",
      ]);
      expect(workflowCondition(headWorkflow, "e2e-tests")).toBe(
        "needs['change-scope'].outputs.e2e_tests_required == 'true'",
      );
      expect(workflowJob(headWorkflow, "e2e-tests").text).toContain(
        "suite_batch: ${{ fromJson(needs['change-scope'].outputs.e2e_suite_batches_json) }}",
      );
      expect(workflowJob(headWorkflow, "change-scope").text).toContain(
        "e2e_tests_required: ${{ steps.gate-plan.outputs.e2e_tests_required }}",
      );
      expect(workflowJob(headWorkflow, "change-scope").text).toContain(
        "e2e_suite_batches_json: ${{ steps.scope.outputs.e2e_suite_batches_json }}",
      );
      expect(workflowJob(headWorkflow, "change-scope").text).toContain(
        "CI_GATE_PLAN_SCOPE_JSON: ${{ steps.scope.outputs.scope_json }}",
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it.each(["pull-request", "merge-group"])(
    "requires Public Presence unit coverage for every nonempty diff in %s plans",
    (mode) => {
      const membership = (changedFiles) => {
        const scope = classifyChanges({ changedFiles });
        const plan = createCiGatePlan({ mode, provenance: "same-repository", labels: [], scope });
        const unitGate = plan.gates.find(({ id }) => id === "unit-tests");
        return {
          selection: unitGate.selection,
          publicPresence: unitGate.affectedWorkspaces.filter((name) => name === "@chase-sets/public-presence").length,
        };
      };
      for (const file of [
        "bounded-contexts/public-presence/features/policies/domain/authenticity-service-terms.ts",
        "bounded-contexts/public-presence/features/policies/domain/privacy-policy.ts",
        "bounded-contexts/public-presence/features/policies/domain/authenticity-service-terms.test.ts",
        "scripts/verify-static-surfaces.mjs",
        "bounded-contexts/identity/api.ts",
        "bounded-contexts/pricing/features/repricing-engine/api/runtime.ts",
        "bounded-contexts/identity/GLOSSARY.md",
        "bounded-contexts/authenticity/README.md",
        "bounded-contexts/marketplace/features/listings/api/runtime.test.ts",
        "scripts/clean-logs.mjs",
        "README.md",
      ]) {
        expect(membership([file]), file).toEqual({ selection: "REQUIRED", publicPresence: 1 });
      }
      // Controls: an empty diff selects nothing, and the platform-pr workflow's
      // all-DB sweep keeps its empty workspace list.
      expect(membership([])).toEqual({ selection: "NOT_REQUIRED", publicPresence: 0 });
      expect(membership([".github/workflows/platform-pr.yml"])).toEqual({
        selection: "REQUIRED",
        publicPresence: 0,
      });
    },
  );

  it("requires DB tests for platform-pr workflow alone without narrowing the all-DB workspace list", () => {
    const scope = classifyChanges({ changedFiles: [".github/workflows/platform-pr.yml"] });
    const plan = createCiGatePlan({ mode: "pull-request", provenance: "same-repository", labels: [], scope });
    expect(scope.affectedWorkspaces).toEqual([]);
    expect(scope.dbTestsRequired).toBe(true);
    expect(plan.gates.find(({ id }) => id === "db-tests")).toMatchObject({
      selection: "REQUIRED",
      reason: "scope",
      affectedWorkspaces: [],
    });
  });

  it("matches the base workflow over the full parity corpus", () => {
    const baseCategories = derivedCategories(baseWorkflow);
    const deltas = [];
    for (const testCase of corpus) {
      const scope = classifyChanges({ changedFiles: testCase.changedFiles });
      for (const scenario of scenarios) {
        const plan = createCiGatePlan({ ...scenario, scope });
        for (const gate of plan.gates) {
          const memo = gate.id === "bootstrap-db-oracle-memo-check";
          const expectedRequired = memo
            ? scope.changedFiles.some((file) =>
                [
                  "deployables/platform-api/__tests__/fixtures/bootstrap-db-oracle-schedule-memo.json",
                  "deployables/platform-api/__tests__/fixtures/bootstrap-db-oracle-schedule-memo.mjs",
                  "deployables/platform-api/__tests__/fixtures/bootstrap-db-schedule-before-subset-reuse.mjs",
                  "deployables/platform-api/scripts/check-bootstrap-db-enrollment.mjs",
                ].includes(file),
              )
            : baseSelection(gate.id, { ...scenario, scope });
          const category = gate.id === "e2e-tests" || memo ? "scope-gated" : baseCategories.get(gate.id);
          const required = gate.id === "e2e-tests" ? scope.e2eTestsRequired : expectedRequired;
          const expected = required ? "REQUIRED" : "NOT_REQUIRED";
          const reason = expectedReason(gate.id, category, required, { ...scenario, scope });
          if (gate.selection !== expected || gate.reason !== reason) {
            deltas.push({ case: testCase.name, scenario, gate: gate.id, expected, actual: gate.selection, reason });
          }
          expect(gate.category).toBe(category);
          expect(gate.affectedWorkspaces).toEqual(scope.affectedWorkspaces);
          expect(gate.e2eBatches).toEqual(
            gate.id === "e2e-tests" ? expectedRenderedCopyBatches(batchE2eSuiteIds(scope.e2eSuiteIds)) : [],
          );
        }
      }
    }
    expect(deltas).toEqual([]);
    expect(IMPLEMENTATION_BASE_SHA).toMatch(/^[0-9a-f]{40}$/);
  });

  it("anchors the parity oracle to the immutable implementation base", () => {
    expect(IMPLEMENTATION_BASE_SHA).toBe("0b4bf3adde0adda5bae2060dd898443cb4dcdb21");
    expect(baseWorkflow).not.toBe(headWorkflow);
    expect(baseWorkflow).toContain("require_heavy_job()");
    expect(baseWorkflow).toContain("preview_required=");
    expect(new Set(derivedCategories(baseWorkflow).values())).toEqual(new Set(CI_GATE_CATEGORIES));
    const scope = classifyChanges({ changedFiles: ["README.md"] });
    expect(
      baseSelection("static", { mode: "pull-request", labels: [], provenance: "same-repository", scope }),
    ).toBeTypeOf("boolean");
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
    expect(CI_GATE_DEFINITIONS.find(({ id }) => id === "e2e-tests").category).toBe("scope-gated");
    expect(new Set(CI_GATE_DEFINITIONS.map(({ category }) => category))).toEqual(
      new Set(CI_GATE_CATEGORIES.filter((category) => category !== "targeted-heavy")),
    );
    expect(categories.get("preview-deploy-smoke")).toBe("pr-complement");
    expect(categories.get("compose-preview-smoke")).toBe("pr-complement");
    const outside = workflowJobs(baseWorkflow)
      .map(({ id }) => id)
      .filter((id) => !universe.includes(id));
    expect(outside).toEqual(["release-status", "release-qualification-scope-advisory"]);

    const scope = classifyChanges({ changedFiles: ["README.md"] });
    const forcePreviewIntoScopeGated = CI_GATE_DEFINITIONS.map((definition) =>
      definition.id === "preview-deploy-smoke"
        ? { ...definition, category: "scope-gated", capability: "clusterPreviewRequired" }
        : definition,
    );
    expect(() =>
      createCiGatePlan({
        mode: "pull-request",
        provenance: "same-repository",
        scope,
        definitions: forcePreviewIntoScopeGated,
      }),
    ).toThrow("GATE_CATEGORY_MISMATCH: preview-deploy-smoke");
    const omitComplementCategory = CI_GATE_DEFINITIONS.filter(({ id }) => id !== "compose-preview-smoke");
    expect(() =>
      createCiGatePlan({
        mode: "pull-request",
        provenance: "same-repository",
        scope,
        definitions: omitComplementCategory,
      }),
    ).toThrow("UNKNOWN_OR_MISSING_GATE_IDS");
  });

  it("adds only the hosted memo gate to the historical seventeen gates", () => {
    const universe = [...requiredNeeds(baseWorkflow), "pr-required"];
    universe.splice(universe.indexOf("unit-tests") + 1, 0, "bootstrap-db-oracle-memo-check");
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
    ).toHaveLength(18);

    const scope = classifyChanges({ changedFiles: ["README.md"] });
    const plan = createCiGatePlan({ mode: "merge-group", scope });
    expect(() => validateCiGatePlan({ ...plan, gates: plan.gates.slice(1) })).toThrow("UNKNOWN_OR_MISSING_GATE_IDS");
    const hostedIndex = plan.gates.findIndex(({ executability }) => executability === "HOSTED_ONLY");
    const executeHostedOnlyGate = structuredClone(plan);
    executeHostedOnlyGate.gates[hostedIndex].executability = "REPOSITORY_LOCAL";
    expect(() => validateCiGatePlan(executeHostedOnlyGate)).toThrow("GATE_EXECUTABILITY_MISMATCH");
  });

  it("keeps DB and E2E scope-gated without broadening the targeted-heavy lane", () => {
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
      selection: "REQUIRED",
      reason: "scope",
    });
    const mergeGroup = createCiGatePlan({ mode: "merge-group", scope });
    expect(mergeGroup.gates.find(({ id }) => id === "e2e-tests").selection).toBe("REQUIRED");

    const shippedDbSelection = fast.gates.find(({ id }) => id === "db-tests").selection;
    const bypassDbWithHeavyLane = fast.targetedHeavyRequired && scope.dbTestsRequired ? "REQUIRED" : "NOT_REQUIRED";
    expect(bypassDbWithHeavyLane).not.toBe(shippedDbSelection);
    expect(shippedDbSelection).toBe("REQUIRED");
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
    const forkInputs = { mode: "pull-request", labels: ["preview"], provenance: "fork", scope };
    const previewExpression = baseComplementExpression(baseWorkflow, "preview_required");
    const omitSameRepositoryInput = previewExpression.replace(
      "github.event.pull_request.head.repo.full_name == github.repository && ",
      "",
    );
    expect(omitSameRepositoryInput).not.toBe(previewExpression);
    expect(evaluateBaseExpression(omitSameRepositoryInput, forkInputs)).toBe(true);
    expect(fork.gates.find(({ id }) => id === "preview-deploy-smoke").selection).toBe("NOT_REQUIRED");
    expect(baseSelection("preview-deploy-smoke", forkInputs)).toBe(false);
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

  it("runs the TCGplayer boundary guard in static checks before preview deployment", () => {
    const staticSource = workflowJob(headWorkflow, "static-source").text;
    const preview = workflowJob(headWorkflow, "preview-deploy-smoke").text;
    const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
    const structureEntrypoint = readFileSync("scripts/check-structure.mjs", "utf8");
    const structureRun = readFileSync("scripts/check-structure/run.mjs", "utf8");
    expect(staticSource).toContain("run: pnpm run verify:static");
    expect(staticSource).toContain("Run static checks");
    expect(preview).toContain("needs.static.result == 'success'");
    expect(headWorkflow.indexOf("  static-source:")).toBeLessThan(headWorkflow.indexOf("  preview-deploy-smoke:"));
    expect(rootPackage.scripts["verify:static"]).toContain("pnpm run check:structure");
    expect(rootPackage.scripts["check:structure"]).toMatch(/^node \.\/scripts\/check-structure\.mjs/);
    expect(structureEntrypoint).toContain("runStructureCheck");
    expect(structureRun).toContain("await scanTcgplayerHostCredentialPolicy({ repoRoot })");
    expect(structureRun).toContain("violations.push(...tcgplayerHostCredentialGuard.violations)");
    const runStart = structureRun.indexOf("export async function runStructureCheck(");
    const reset = structureRun.indexOf("violations.length = 0;", runStart);
    expect(runStart).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(runStart);
    expect(structureRun.indexOf("await scanTcgplayerHostCredentialPolicy({ repoRoot })")).toBeGreaterThan(reset);
    expect(VERIFY_STATIC_SURFACES["check:structure"].scopedSteps).toContainEqual(
      expect.objectContaining({ name: "aggregate", classification: ALWAYS_RUN }),
    );
  });
});
