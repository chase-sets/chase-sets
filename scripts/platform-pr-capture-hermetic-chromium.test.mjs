import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { classifyChanges, toGithubOutputMap } from "./change-scope.mjs";
import { ciGatePlanOutputMap, createCiGatePlan } from "./ci-gate-plan.mjs";

const workflow = parse(readFileSync(resolve(".github/workflows/platform-pr.yml"), "utf8"));
const job = workflow.jobs["capture-hermetic-chromium"];
const gate = workflow.jobs["pr-required"].steps.find((step) => step.name === "Verify required jobs");
const condition =
  "needs['change-scope'].outputs.e2e_tests_required == 'true' && contains(fromJson(needs['change-scope'].outputs.e2e_suites_json), 'tcgplayer_connector_extension')";
const bash =
  process.platform === "win32"
    ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe")
    : "bash";

function runGate(required, suites, result) {
  const run = gate.run.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expression) => {
    if (expression === "needs['capture-hermetic-chromium'].result") return result;
    if (expression === "needs['change-scope'].outputs.e2e_tests_required") return required;
    if (expression.endsWith(".result")) return "success";
    if (expression.endsWith("_required")) return "true";
    throw new Error(`Unexpected gate expression: ${expression}`);
  });
  const execution = spawnSync(bash, ["-c", run], {
    encoding: "utf8",
    env: { ...process.env, AC4_E2E_REQUIRED: required, AC4_E2E_SUITES_JSON: suites },
  });
  if (execution.error) throw execution.error;
  return { status: execution.status, output: execution.stdout + execution.stderr };
}

describe("Capture Hermetic Chromium hosted proof", () => {
  it("selects connector-client changes with the unchanged shared scope and gate plan", () => {
    const scope = classifyChanges({
      changedFiles: [
        "bounded-contexts/channels/features/connector-client/integrations/order-authority-probe/capture.test.ts",
      ],
    });
    const plan = createCiGatePlan({ mode: "pull-request", provenance: "same-repository", scope });
    expect(ciGatePlanOutputMap(plan).e2e_tests_required).toBe("true");
    expect(JSON.parse(toGithubOutputMap(scope).e2e_suites_json)).toContain("tcgplayer_connector_extension");
    expect(job.if).toBe(condition);
    expect(job.needs).toBe("change-scope");
    expect(workflow.jobs["pr-required"].needs).toContain("capture-hermetic-chromium");
    expect(gate.env).toEqual({
      AC4_E2E_REQUIRED: "${{ needs['change-scope'].outputs.e2e_tests_required }}",
      AC4_E2E_SUITES_JSON: "${{ needs['change-scope'].outputs.e2e_suites_json }}",
    });
  });

  it("uses a secret-free source-pinned checkout and strict bounded synthetic Chromium command", () => {
    const source = "${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}";
    expect(job.name).toBe("Capture Hermetic Chromium");
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBe(15);
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.env).toEqual({ AC4_SOURCE_SHA: source });
    expect(job.steps[0]).toEqual({
      name: "Require explicit AC4 source",
      shell: "bash",
      run: 'test -n "$AC4_SOURCE_SHA"',
    });
    expect(job.steps[1]).toEqual({
      uses: "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
      with: { ref: source, "persist-credentials": false },
    });
    expect(job.steps[2]).toEqual({ uses: "./.github/actions/setup-pnpm-workspace", with: { install: true } });
    expect(job.steps).toHaveLength(4);
    const proof = job.steps[3];
    expect(proof.shell).toBe("bash");
    expect(proof.env).toEqual({ PLAYWRIGHT_BROWSERS_PATH: "${{ runner.temp }}/ac4-playwright" });
    for (const fragment of [
      "set -euo pipefail",
      'test "$(git rev-parse HEAD)" = "$AC4_SOURCE_SHA"',
      'test "${CHASE_SETS_LANE_MODE+x}" != x',
      "AC4 source=%s run=%s attempt=%s job=%s",
      "pnpm exec playwright install --with-deps chromium",
      "CHASE_SETS_HERMETIC_CHROMIUM=1 xvfb-run --auto-servernum",
      "pnpm --filter @chase-sets/channels run test:unit",
      "features/connector-client/integrations/order-authority-probe/capture.test.ts",
      "-t 'host-attributed hermetic Chromium'",
      "--maxWorkers=1 --no-file-parallelism",
      "--reporter=verbose --reporter=json",
      '--outputFile.json="$RUNNER_TEMP/ac4-chromium.json"',
    ])
      expect(proof.run).toContain(fragment);
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|continue-on-error|passWithNoTests|--retry|--testTimeout/);
  });

  it.each(["success", "failure", "skipped", "cancelled", "", "unknown"])(
    "requires successful selected proof: %s",
    (result) => {
      const execution = runGate("true", '["tcgplayer_connector_extension"]', result);
      expect(execution.status, execution.output).toBe(result === "success" ? 0 : 1);
      if (result !== "success") expect(execution.output).toContain("Capture Hermetic Chromium was required");
    },
  );

  it.each([
    ["false", '["tcgplayer_connector_extension"]'],
    ["true", '["marketplace"]'],
    ["false", "[]"],
  ])("does not require unselected proof: %s %s", (required, suites) => {
    const execution = runGate(required, suites, "skipped");
    expect(execution.status, execution.output).toBe(0);
  });

  it.each([
    ["", "[]"],
    ["unknown", "[]"],
    ["true", ""],
    ["false", "not-json"],
    ["true", "null"],
    ["true", '"tcgplayer_connector_extension"'],
    ["true", "{}"],
    ["true", "[1]"],
    ["false", '[""]'],
  ])("fails closed on unknown selection: %s %s", (required, suites) => {
    expect(runGate(required, suites, "success").status).toBe(1);
  });

  it.each(["", "failure", "cancelled", "unknown"])("rejects unknown or failed unselected results: %s", (result) => {
    expect(runGate("false", "[]", result).status).toBe(1);
  });

  const cases = ["qualified", "canceled", "expired"].map((terminal) => ({
    fullName: `host-attributed hermetic Chromium terminal ${terminal} with synthetic install/removal`,
    status: "passed",
  }));
  function assertReceipt(assertions, success = true) {
    const script = job.steps[3].run.match(/node --input-type=module -e '\n([\s\S]+?)\n' /)?.[1];
    expect(script).toBeTruthy();
    const messages = [];
    runInNewContext(script.replace('import fs from "node:fs";', ""), {
      fs: { readFileSync: () => JSON.stringify({ success, testResults: [{ assertionResults: assertions }] }) },
      process: { argv: ["node", "synthetic.json"] },
      console: { log: (message) => messages.push(message) },
    });
    return messages;
  }

  it("accepts exactly the three named passing receipts, with ordinary tests filtered", () => {
    expect(assertReceipt([...cases, { fullName: "ordinary capture case", status: "pending" }])).toEqual([
      "AC4: qualified/canceled/expired passed; synthetic only",
    ]);
  });

  it("rejects partial, duplicated, failed, skipped and extra passing receipts", () => {
    for (const assertions of [
      [],
      cases.slice(0, 2),
      [cases[0], cases[0], cases[2]],
      cases.map((entry, index) => (index === 1 ? { ...entry, status: "failed" } : entry)),
      cases.map((entry, index) => (index === 1 ? { ...entry, status: "pending" } : entry)),
      [...cases, { fullName: "ordinary capture case", status: "passed" }],
    ])
      expect(() => assertReceipt(assertions)).toThrow("AC4 requires exactly the three named Chromium cases to pass");
    expect(() => assertReceipt(cases, false)).toThrow("AC4 requires exactly the three named Chromium cases to pass");
  });
});
