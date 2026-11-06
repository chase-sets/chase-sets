import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { requiredJobCalls, stageRun } from "./fixtures/workflow-composition/harness.mjs";
import { requiredJobs, verifyRequiredJobs } from "./pr-checks/required-jobs.mjs";
import { ciGatePlanOutputMap, createCiGatePlan } from "./ci-gate-plan.mjs";

const fixture = JSON.parse(readFileSync("scripts/fixtures/workflow-composition/platform-pr.json", "utf8"));
const before = fixture.workflow;
const after = parse(readFileSync(".github/workflows/platform-pr.yml", "utf8"));
const integratedMain = parse(
  execFileSync("git", ["show", "abb4857e8a034f0fb083244aa9dec5518a0b6102:.github/workflows/platform-pr.yml"], {
    encoding: "utf8",
  }),
);
const bash =
  process.platform === "win32"
    ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe")
    : "bash";
const step = (workflow, id, name) => workflow.jobs[id].steps.find((entry) => entry.name === name);
const requirements = ["true", "false", "", "unknown"];
const results = ["success", "failure", "cancelled", "skipped", "", "unknown"];
const policyCases = requiredJobs
  .filter(([, , field]) => field)
  .flatMap(([id, name, key]) =>
    requirements.flatMap((requirement) => results.map((result) => [id, key, requirement, result, name])),
  );
const baselineResults = new Map();
const bootstrapPreload = `
import { isBuiltin, registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isBuiltin(specifier) && !/^(?:\\.{1,2}\\/|file:|\\/|[A-Za-z]:[\\\\/])/.test(specifier))
      throw new Error('BOOTSTRAP_PACKAGE_DENIED: ' + specifier);
    const resolved = nextResolve(specifier, context);
    if (/(?:^|[\\\\/])node_modules(?:[\\\\/]|$)/.test(decodeURIComponent(resolved.url)))
      throw new Error('BOOTSTRAP_NODE_MODULES_DENIED: ' + specifier);
    return resolved;
  },
  load(url, context, nextLoad) {
    if (process.env.BOOTSTRAP_STOPPED_SOURCE === '1' && url.endsWith('/scripts/change-scope.mjs'))
      return { format: 'module', shortCircuit: true, source: execFileSync('git', ['show', 'fa3ba2b350509b57ac8587a1985a7e1018cdf696:scripts/change-scope.mjs'], { encoding: 'utf8' }) };
    if (process.env.BOOTSTRAP_MAIN_SOURCE === '1' && url.endsWith('/scripts/change-scope.mjs'))
      return { format: 'module', shortCircuit: true, source: execFileSync('git', ['show', 'origin/main:scripts/change-scope.mjs'], { encoding: 'utf8' }) };
    return nextLoad(url, context);
  }
});`;
const bootstrapNodeOptions = `--import=data:text/javascript,${encodeURIComponent(bootstrapPreload)}`;

beforeAll(() => {
  const original = step(before, "pr-required", "Verify required jobs").run;
  const policy = original.match(/^require_job\(\) \{\n[\s\S]+?^\}/m)?.[0];
  expect(policy).toBeTruthy();
  const names = requiredJobs
    .filter(([, , field]) => field)
    .map(([, name]) => JSON.stringify(name))
    .join(" ");
  const command = `${policy}\nset +e\nfor name in ${names}; do
    for requirement in ${requirements.map(JSON.stringify).join(" ")}; do
      for result in ${results.map(JSON.stringify).join(" ")}; do
        message="$(require_job "$name" "$result" "$requirement" 2>&1)"
        status="$?"
        printf '%s\\0%s\\0' "$status" "$message"
      done
    done
  done`;
  const execution = runBash(command);
  expect(execution.status, execution.error).toBe(0);
  const fields = execution.output.split("\0");
  expect(fields.pop()).toBe("");
  expect(fields).toHaveLength(policyCases.length * 2);
  policyCases.forEach((row, index) =>
    baselineResults.set(JSON.stringify(row), {
      status: Number(fields[index * 2]),
      error: fields[index * 2 + 1],
    }),
  );
});
const scopeInputs = {
  PR_SCOPE_EVENT_NAME: "${{ github.event_name }}",
  PR_SCOPE_PR_BASE: "${{ github.event.pull_request.base.sha }}",
  PR_SCOPE_MERGE_BASE: "${{ github.event.merge_group.base_sha }}",
  PR_SCOPE_MERGE_HEAD: "${{ github.event.merge_group.head_sha }}",
  PR_SCOPE_BEFORE: "${{ github.event.before }}",
  PR_SCOPE_SHA: "${{ github.sha }}",
};
const operations = [
  ["change-scope", "Resolve changed surface", "bash scripts/pr-checks/change-scope.sh", scopeInputs],
  ["static", "Installed-boundary controls", "bash scripts/pr-checks/static-checks.sh controls", {}],
  ["static", "Require full source checks", "bash scripts/pr-checks/static-checks.sh require-source", {}],
  [
    "unit-tests",
    "Run non-DB tests",
    "bash scripts/pr-checks/unit-tests.sh",
    {
      UNIT_TEST_WORKSPACES: "${{ needs['change-scope'].outputs.unit_test_workspaces }}",
      UNIT_TEST_SHARD: "${{ matrix.shard }}",
    },
  ],
  ["db-tests", "Raise PostgreSQL lock table capacity for DB Profile", "bash scripts/pr-checks/db-tests.sh prepare", {}],
  [
    "db-tests",
    "Select platform API evidence before running tests",
    "bash scripts/pr-checks/db-tests.sh select",
    { DB_WORKSPACE_GROUP: "${{ matrix.db-workspace-group }}" },
  ],
  ["db-tests", "Capture post-failure PostgreSQL state", "bash scripts/pr-checks/db-tests.sh diagnostics", {}],
  [
    "capture-hermetic-chromium",
    "Install Playwright Chromium",
    "bash scripts/pr-checks/capture-hermetic-chromium.sh install",
    {},
  ],
  [
    "capture-hermetic-chromium",
    "Prove three synthetic Chromium capture cases",
    "bash scripts/pr-checks/capture-hermetic-chromium.sh prove",
    {},
  ],
  ["e2e-tests", "Capture responsive evidence checkout identity", "bash scripts/pr-checks/e2e-tests.sh checkout", {}],
  ["e2e-tests", "Resolve Playwright Chromium cache", "bash scripts/pr-checks/e2e-tests.sh cache", {}],
  [
    "e2e-tests",
    "Run marketplace e2e suites",
    "bash scripts/pr-checks/e2e-tests.sh run",
    { E2E_SUITE_BATCH: "${{ matrix.suite_batch }}" },
  ],
  [
    "pr-required",
    "Verify required jobs",
    "node scripts/pr-checks/required-jobs.mjs",
    { PR_REQUIRED_NEEDS_JSON: "${{ toJSON(needs) }}" },
  ],
  ["release-status", "Add status to job summary", "node ./scripts/pr-release-status.mjs summary", {}],
  [
    "release-status",
    "Update PR release status comment",
    "node ./scripts/pr-release-status.mjs comment",
    { PR_NUMBER: "${{ github.event.pull_request.number }}" },
  ],
];

function runBash(run, env = {}) {
  const result = spawnSync(bash, ["-e", "-c", run], { encoding: "utf8", env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout, error: result.stderr };
}

function needsFixture(required = "true") {
  const needs = Object.fromEntries(requiredJobs.map(([id]) => [id, { result: "success" }]));
  needs["change-scope"].outputs = Object.fromEntries(
    requiredJobs.filter(([, , key]) => key).map(([, , key]) => [key, required]),
  );
  needs["change-scope"].outputs.e2e_tests_required = "true";
  return needs;
}

function oldRequiredRun(needs) {
  return step(before, "pr-required", "Verify required jobs").run.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
    const match = expression.match(/^needs(?:\['([^']+)'\]|\.([a-z-]+))\.(?:outputs\.([a-z0-9_]+)|(result))$/);
    if (!match) throw new Error(`Unresolved baseline expression: ${expression}`);
    const job = needs[match[1] ?? match[2]];
    return match[4] ? (job?.result ?? "") : (job?.outputs?.[match[3]] ?? "");
  });
}

describe("workflow composition contract inventory", () => {
  it("executes the real pre-install PR and merge-group callers with every package resolution denied", () => {
    const outputDir = mkdtempSync(resolve(tmpdir(), "workflow-bootstrap-"));
    const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
    const head = git("rev-parse", "HEAD");
    const parents = git("show", "-s", "--format=%P", head).split(" ");
    expect([1, 2]).toContain(parents.length);
    const base = parents.length === 2 ? parents[0] : git("rev-parse", "origin/main");
    // A hosted checkout is base-first. A local candidate is an ordinary commit
    // over the retained sync merge, never that branch-first sync merge itself.
    expect(git("merge-base", base, "origin/main")).toBe(base);
    const mergeBase = git("merge-base", base, head);
    const changedFiles = git("diff", "--no-renames", "--name-only", `${mergeBase}...${head}`).split(/\r?\n/);
    expect(changedFiles).toContain("scripts/pr-checks/db-tests.sh");
    expect(git("diff", "--name-only", head, "--", ...changedFiles)).toBe("");
    const tree = git("rev-parse", `${head}^{tree}`);
    expect(tree).toMatch(/^[a-f0-9]{40}$/);
    const outputMap = (text) =>
      Object.fromEntries(
        text
          .trimEnd()
          .split("\n")
          .map((line) => {
            const split = line.indexOf("=");
            return [line.slice(0, split), line.slice(split + 1)];
          }),
      );
    try {
      const outputs = [];
      for (const event of ["pull_request", "merge_group"]) {
        const output = resolve(outputDir, event);
        const result = runBash("bash scripts/pr-checks/change-scope.sh", {
          NODE_OPTIONS: bootstrapNodeOptions,
          BOOTSTRAP_STOPPED_SOURCE: "0",
          PR_SCOPE_EVENT_NAME: event,
          PR_SCOPE_PR_BASE: base,
          PR_SCOPE_SHA: head,
          PR_SCOPE_MERGE_BASE: base,
          PR_SCOPE_MERGE_HEAD: head,
          GITHUB_OUTPUT: output,
        });
        expect(result.status, result.error).toBe(0);
        expect(result.error).not.toContain("Change-scope derivation fallback:");
        const text = readFileSync(output, "utf8");
        const scope = outputMap(text);
        expect(JSON.parse(scope.changed_files_json)).toEqual(changedFiles);
        expect(JSON.parse(scope.scope_json).changedFiles).toEqual(changedFiles);
        outputs.push(text);
        const mode = event === "pull_request" ? "pull-request" : "merge-group";
        const planOutput = resolve(outputDir, `${event}-plan`);
        const plan = runBash("node scripts/ci-gate-plan.mjs github-output", {
          NODE_OPTIONS: bootstrapNodeOptions,
          BOOTSTRAP_STOPPED_SOURCE: "0",
          CI_GATE_PLAN_SCOPE_JSON: scope.scope_json,
          CI_GATE_PLAN_MODE: mode,
          CI_GATE_PLAN_PROVENANCE: mode === "pull-request" ? "same-repository" : "",
          CI_GATE_PLAN_LABELS_JSON: "[]",
          GITHUB_OUTPUT: planOutput,
        });
        expect(plan.status, plan.error).toBe(0);
        const expectedPlan = ciGatePlanOutputMap(
          createCiGatePlan({
            mode,
            provenance: mode === "pull-request" ? "same-repository" : undefined,
            labels: [],
            scope: JSON.parse(scope.scope_json),
          }),
        );
        expect(readFileSync(planOutput, "utf8")).toBe(
          Object.entries(expectedPlan)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(""),
        );
        expect(outputMap(readFileSync(planOutput, "utf8"))).toMatchObject({
          unit_tests_required: "true",
          db_tests_required: "true",
        });
      }
      expect(outputs[0]).toBe(outputs[1]);
      expect(outputs[0]).toContain("db_tests=true\n");
      expect(outputs[0]).toContain("@chase-sets/app-platform-api");
      expect(outputs[0]).toContain("unit_test_workspaces=");
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("loads the complete bootstrap runtime closure and classifies owner-only deltas without packages, rejecting the stopped source", () => {
    const entries = [
      "change-scope.mjs",
      "ci-gate-plan.mjs",
      "pr-checks/required-jobs.mjs",
      "pr-release-status.mjs",
      "release-qualification-scope.mjs",
      "merge-qualification.mjs",
      "release-deployment-scope.mjs",
      "release-health-github-metadata.mjs",
      "release-health-delivery-health.mjs",
    ];
    const classifier = pathToFileURL(resolve("scripts/change-scope.mjs")).href;
    const program = `
      import assert from 'node:assert/strict';
      for (const entry of ${JSON.stringify(entries.map((entry) => pathToFileURL(resolve("scripts", entry)).href))}) await import(entry);
      const {classifyChanges, toOutputMap} = await import(${JSON.stringify(classifier)});
      const {listWorkspacePackages} = await import(${JSON.stringify(pathToFileURL(resolve("scripts/lib/repo.mjs")).href)});
      const workspaces = listWorkspacePackages({roots:['bounded-contexts','contracts','infrastructure','packages','deployables'],assertRootCoverage:false});
      const scope = classifyChanges({baseDir:process.cwd(),workspaces,changedFiles:['scripts/pr-checks/db-tests.sh']});
      assert(scope.unitTestWorkspaces.includes('@chase-sets/app-platform-api'));
      assert.equal(scope.dbTestsRequired,true);
      assert.equal(toOutputMap(scope).build,'false');
      const fs = await import('node:fs');
      const {syncBuiltinESMExports} = await import('node:module');
      const originalRead = fs.default.readFileSync;
      const workflow = originalRead('.github/workflows/platform-pr.yml','utf8');
      const owner = originalRead('scripts/pr-checks/db-tests.sh','utf8');
      for (const [file, source] of [
        ['.github/workflows/platform-pr.yml',workflow.replace('db-tests.sh prepare','db-tests.sh other')],
        ['.github/workflows/platform-pr.yml',workflow.replace('run: bash scripts/pr-checks/db-tests.sh prepare','if: false\\n        run: bash scripts/pr-checks/db-tests.sh prepare')],
        ['scripts/pr-checks/db-tests.sh',owner.replace('target_max_connections=300','target_max_connections=bad')],
        ['scripts/pr-checks/db-tests.sh',null],
      ]) {
        fs.default.readFileSync = (name,...args) => {
          if (String(name).replaceAll('\\\\','/').endsWith('/'+file)) {
            if (source === null) throw new Error('owner unavailable');
            return source;
          }
          return originalRead(name,...args);
        };
        syncBuiltinESMExports();
        try { assert.throws(() => classifyChanges({baseDir:process.cwd(),workspaces,changedFiles:['scripts/pr-checks/db-tests.sh']}),/db-tests/); }
        finally { fs.default.readFileSync = originalRead; syncBuiltinESMExports(); }
      }
      console.log('BOOTSTRAP_CLOSURE_AND_OWNER_OK');`;
    const run = (stopped) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", program], {
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: bootstrapNodeOptions, BOOTSTRAP_STOPPED_SOURCE: stopped },
      });
    const negative = run("1");
    expect(negative.status).not.toBe(0);
    expect(negative.stderr).toContain("BOOTSTRAP_PACKAGE_DENIED: yaml");
    const candidate = run("0");
    expect(candidate.status, candidate.stderr).toBe(0);
    expect(candidate.stdout).toContain("BOOTSTRAP_CLOSURE_AND_OWNER_OK");
    const parityProgram = `
      const {classifyChanges,toOutputMap} = await import(${JSON.stringify(classifier)});
      const {unit_test_workspaces,...outputs} = toOutputMap(classifyChanges({changedFiles:['README.md']}));
      console.log(JSON.stringify(outputs));`;
    const parity = (main) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", parityProgram], {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: bootstrapNodeOptions,
          BOOTSTRAP_STOPPED_SOURCE: "0",
          BOOTSTRAP_MAIN_SOURCE: main,
        },
      });
    const original = parity("1");
    const unrelated = parity("0");
    expect(original.status, original.stderr).toBe(0);
    expect(unrelated.status, unrelated.stderr).toBe(0);
    expect(unrelated.stdout).toBe(original.stdout);
  });

  it("binds the parsed before fixture to immutable workflow history", () => {
    const source = execFileSync("git", ["show", `${fixture.sourceHead}:.github/workflows/platform-pr.yml`], {
      encoding: "utf8",
    });
    const baseline = parse(source.replace(/ \(#\d+\)/g, ""));
    expect(before).toEqual({
      ...baseline,
      jobs: Object.fromEntries(Object.keys(before.jobs).map((id) => [id, baseline.jobs[id]])),
    });
  });

  it("pins parsed authority, outputs, secrets, artifacts and consumers at every touched owner", () => {
    expect(fixture.sourceHead).toMatch(/^[a-f0-9]{40}$/);
    for (const key of ["name", "on", "permissions", "concurrency"]) expect(after[key], key).toEqual(before[key]);
    for (const [id, original] of Object.entries(before.jobs)) {
      const current = structuredClone(after.jobs[id]);
      expect(current, id).toBeDefined();
      if (id === "e2e-tests") {
        const additions = integratedMain.jobs[id].steps.filter(
          (entry) => !original.steps.some((old) => old.name === entry.name),
        );
        expect(additions.map((entry) => entry.name)).toEqual(["Prepare journey package", "Upload journey package"]);
        for (const addition of additions) {
          expect(current.steps.filter((entry) => entry.name === addition.name)).toHaveLength(1);
          const index = current.steps.findIndex((entry) => entry.name === addition.name);
          expect(index).toBe(integratedMain.jobs[id].steps.findIndex((entry) => entry.name === addition.name));
          expect(current.steps[index]).toEqual(addition);
        }
        current.steps = current.steps.filter((entry) => !additions.some((addition) => addition.name === entry.name));
      }
      expect(current.steps).toHaveLength(original.steps.length);
      for (let index = 0; index < original.steps.length; index++) {
        const oldStep = original.steps[index];
        const newStep = current.steps[index];
        const operation = operations.find(([job, name]) => id === job && oldStep.name === name);
        if (operation) {
          expect(newStep.run, `${id}/${oldStep.name}`).toBe(operation[2]);
          const extra = operation[3];
          if (Object.keys(extra).length) {
            expect(newStep.env).toEqual({ ...oldStep.env, ...extra });
            for (const key of Object.keys(extra)) delete newStep.env[key];
            if (!oldStep.env) delete newStep.env;
          }
          newStep.run = oldStep.run;
        }
        expect(newStep, `${id}/${oldStep.name ?? oldStep.uses}`).toEqual(oldStep);
      }
      expect(current, id).toEqual(original);
    }
    expect(after.jobs["canonical-proof-sets"]).toEqual(before.jobs["canonical-proof-sets"]);
    expect(step(after, "pr-required", "Verify canonical proof sets")).toEqual(
      step(before, "pr-required", "Verify canonical proof sets"),
    );
  });

  it.each(operations.filter(([, , call]) => call.startsWith("bash ")))(
    "moves the complete behavior without a second inline owner: %s / %s",
    (id, name, call, inputs) => {
      const current = step(after, id, name);
      let expected = step(before, id, name).run;
      if (!expected.endsWith("\n")) expected += "\n";
      for (const [key, value] of Object.entries(inputs)) expected = expected.replaceAll(value, `$${key}`);
      if (name === "Prove three synthetic Chromium capture cases") {
        expected = expected.replace(
          /node --input-type=module -e '\n[\s\S]+?\n' "\$RUNNER_TEMP\/ac4-chromium.json"/,
          'node scripts/pr-checks/hermetic-chromium-receipt.mjs "$RUNNER_TEMP/ac4-chromium.json"',
        );
      }
      const actual = stageRun(current);
      expect(actual, call).toBe(id === "unit-tests" ? "set -euo pipefail\n" + expected : expected);
      expect(current.run).not.toMatch(/\n|require_job|if |case /);
    },
  );

  it("retains every required-policy row and the isolated canonical proof owner", () => {
    const calls = [
      ...step(before, "pr-required", "Verify required jobs").run.matchAll(
        /^\s*require_job "([^"]+)" "([^"]+)" "([^"]+)"$/gm,
      ),
    ].map(([, name, resultArgument, requiredArgument]) => ({
      name,
      helper: "require_job",
      resultArgument,
      requiredArgument,
      line: `require_job "${name}" "${resultArgument}" "${requiredArgument}"`,
    }));
    expect(requiredJobCalls(step(after, "pr-required", "Verify required jobs"))).toEqual(calls);
    expect(after.jobs["pr-required"].needs).toContain("canonical-proof-sets");
    expect(step(after, "canonical-proof-sets", "Execute exact canonical proof paths").env).toEqual({
      REQUIRED_PROOF_PATHS_JSON: "${{ needs['change-scope'].outputs.required_proof_paths_json }}",
      CHANGED_FILES_JSON: "${{ needs['change-scope'].outputs.changed_files_json }}",
      REQUIRED_PROOF_SELECTION_MODE: "${{ needs['change-scope'].outputs.required_proof_selection_mode }}",
    });
  });
});

describe("workflow extraction authority parity", () => {
  it.each(["pull_request", "merge_group", "push"])(
    "consumes identical ranges and first-parent options for %s",
    (event) => {
      for (const missing of [false, true]) {
        const env = {
          PR_SCOPE_EVENT_NAME: event,
          PR_SCOPE_PR_BASE: missing ? "" : "pr-base",
          PR_SCOPE_MERGE_BASE: missing ? "" : "merge-base",
          PR_SCOPE_MERGE_HEAD: missing ? "" : "merge-head",
          PR_SCOPE_BEFORE: missing ? "" : "before",
          PR_SCOPE_SHA: "checkout-sha",
        };
        let original = step(before, "change-scope", "Resolve changed surface").run;
        for (const [key, expression] of Object.entries(scopeInputs))
          original = original.replaceAll(expression, env[key]);
        const stubs =
          'git() { if [ "$1" = rev-parse ]; then echo origin-main; else echo root-commit; fi; }; node() { printf "<%s>\\n" "$@"; };\n';
        const expected = runBash(stubs + original, env);
        const actual = runBash(stubs + ". scripts/pr-checks/change-scope.sh", env);
        expect(actual).toEqual(expected);
        expect(actual.status).toBe(0);
        expect(actual.output.includes("<--first-parent>")).toBe(event !== "push");
      }
    },
  );

  it("retains zero-base root resolution and passes unit-only selection as one argument", () => {
    const env = {
      PR_SCOPE_EVENT_NAME: "pull_request",
      PR_SCOPE_PR_BASE: "000000",
      PR_SCOPE_SHA: "head",
      PR_SCOPE_MERGE_BASE: "",
      PR_SCOPE_MERGE_HEAD: "",
      PR_SCOPE_BEFORE: "",
    };
    const result = runBash(
      'git() { echo root-commit; }; node() { printf "<%s>\\n" "$@"; }; . scripts/pr-checks/change-scope.sh',
      env,
    );
    expect(result.status).toBe(0);
    expect(result.output).toContain("<--base=root-commit>");
    const unit = runBash('node() { printf "<%s>\\n" "$@"; }; . scripts/pr-checks/unit-tests.sh', {
      UNIT_TEST_WORKSPACES: "@test/one,@test/two",
      UNIT_TEST_SHARD: "2",
    });
    expect(unit.status).toBe(0);
    expect(unit.output.match(/<--workspace-list=@test\/one,@test\/two>/g)).toHaveLength(2);
    expect(unit.output.match(/<--shard=2\/2>/g)).toHaveLength(2);
  });

  it.each(policyCases)(
    "matches the original required-result policy: %s / %s / %s / %s",
    (id, key, requirement, result, name) => {
      const needs = needsFixture();
      needs[id].result = result;
      needs["change-scope"].outputs[key] = requirement;
      const original = baselineResults.get(JSON.stringify([id, key, requirement, result, name]));
      let error;
      try {
        verifyRequiredJobs(needs, "true", '["tcgplayer_connector_extension"]');
      } catch (caught) {
        error = caught;
      }
      expect(error ? 1 : 0, `${id}/${result}: ${original.error}`).toBe(original.status);
      if (error) expect(original.error.trim()).toBe(error.message);
    },
  );

  it("retains full aggregate execution parity beyond the isolated policy function", () => {
    for (const result of ["success", "skipped", "failure"]) {
      const needs = needsFixture();
      needs["compose-preview-smoke"].result = result;
      const original = runBash(oldRequiredRun(needs), {
        AC4_E2E_REQUIRED: "true",
        AC4_E2E_SUITES_JSON: '["tcgplayer_connector_extension"]',
      });
      let error;
      try {
        verifyRequiredJobs(needs, "true", '["tcgplayer_connector_extension"]');
      } catch (caught) {
        error = caught;
      }
      expect(error ? 1 : 0).toBe(original.status);
      if (error) expect(original.error.trim()).toBe(error.message);
    }
  });

  it("does not grant advisory failure or withheld credentials required-check authority", () => {
    const advisory = after.jobs["release-qualification-scope-advisory"];
    expect(advisory["continue-on-error"]).toBe(true);
    expect(advisory.if).toBe("github.event_name == 'merge_group'");
    expect(advisory.permissions).toEqual({ contents: "read", actions: "read" });
    expect(JSON.stringify(advisory)).not.toContain("secrets.");
    for (const result of ["failure", "cancelled", "skipped", "success"]) {
      const needs = { ...needsFixture(), "release-qualification-scope-advisory": { result } };
      expect(() => verifyRequiredJobs(needs, "true", '["tcgplayer_connector_extension"]')).not.toThrow();
      expect(after.jobs["pr-required"].needs).not.toContain("release-qualification-scope-advisory");
    }
    expect(step(after, "release-status", "Update PR release status comment").if).toBe(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(step(after, "release-status", "Update PR release status comment").env.GH_TOKEN).toBe("${{ github.token }}");
    expect(after.jobs["pr-required"].if).toBe("always()");
    expect(after.concurrency).toEqual(before.concurrency);
    expect(after.jobs["release-status"].if).toBe(before.jobs["release-status"].if);
    expect(after.jobs["known-failure-guard"]).toEqual(before.jobs["known-failure-guard"]);
  });

  it("executes the actual JSON consumer and fails closed with missing or malformed needs", () => {
    for (const raw of ["", "null", "{}", "not-json"]) {
      const result = spawnSync(process.execPath, ["scripts/pr-checks/required-jobs.mjs"], {
        encoding: "utf8",
        env: { ...process.env, PR_REQUIRED_NEEDS_JSON: raw, AC4_E2E_REQUIRED: "true", AC4_E2E_SUITES_JSON: "[]" },
      });
      expect(result.status).toBe(1);
    }
    const result = spawnSync(process.execPath, ["scripts/pr-checks/required-jobs.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PR_REQUIRED_NEEDS_JSON: JSON.stringify(needsFixture()),
        AC4_E2E_REQUIRED: "true",
        AC4_E2E_SUITES_JSON: '["tcgplayer_connector_extension"]',
      },
    });
    expect(result.status, result.stderr).toBe(0);
  });
});
