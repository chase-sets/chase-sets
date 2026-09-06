import { describe, expect, it } from "vitest";
import { classifyChanges } from "./change-scope.mjs";
import { CI_GATE_DEFINITIONS, createCiGatePlan } from "./ci-gate-plan.mjs";
import {
  CI_GATE_EVIDENCE,
  CI_LOCAL_DISPOSITIONS,
  createLocalCommandPlan,
  executeGateEntries,
  parseCiLocalArgs,
  runCiLocalVerification,
  validateChangeScopeCommandShape,
  validateCiLocalReceipt,
  validateExecutionResult,
  validateLocalCommandCoverage,
} from "./verify-ci-local.mjs";

const baseSha = "1".repeat(40);
const headSha = "2".repeat(40);

function fakeGit(command, args) {
  expect(command).toBe("git");
  if (args[0] === "merge-base") return `${baseSha}\n`;
  if (args.at(-1) === "HEAD^{commit}") return `${headSha}\n`;
  return `${baseSha}\n`;
}

function clock() {
  const values = [new Date("2026-09-06T08:00:00.000Z"), new Date("2026-09-06T08:00:00.010Z")];
  return () => values.shift() ?? values.at(-1);
}

function scopeFor(changedFiles = ["bounded-contexts/checkout/features/cart/ui/cart-page.tsx"]) {
  return classifyChanges({ changedFiles });
}

function executorFor(scope, overrides = new Map(), records = []) {
  return (spec, gate) => {
    records.push({ spec, gate });
    if (spec.args[0] === "./scripts/change-scope.mjs") {
      return { outcome: "passed", exitCode: 0, signal: null, stdout: JSON.stringify(scope), stderr: "" };
    }
    return overrides.get(gate.id) ?? { outcome: "passed", exitCode: 0, signal: null, stdout: "", stderr: "" };
  };
}

function dryRunReceipt(options = {}) {
  const scope = scopeFor(options.changedFiles);
  return runCiLocalVerification(
    {
      mode: options.mode ?? "pull-request",
      provenance: options.provenance ?? "same-repository",
      labels: options.labels ?? [],
      baseRef: "origin/main",
      headRef: "HEAD",
      dryRun: true,
    },
    { gitExec: fakeGit, executor: executorFor(scope), now: clock() },
  );
}

describe("verify-ci-local", () => {
  it("builds one exact command matrix for all and only repository-local gates", () => {
    const scope = scopeFor();
    const plan = createCiGatePlan({ mode: "merge-group", scope });
    const matrix = createLocalCommandPlan({ plan, baseSha, headSha, scope });
    const localIds = CI_GATE_DEFINITIONS.filter(({ executability }) => executability === "REPOSITORY_LOCAL").map(
      ({ id }) => id,
    );
    expect([...matrix.keys()]).toEqual(localIds);
    expect(matrix.get("change-scope")).toEqual([
      {
        command: "node",
        args: ["./scripts/change-scope.mjs", "json", `--base=${baseSha}`, `--head=${headSha}`],
        env: {},
        clearEnv: ["CHANGED_FILES_JSON", "GITHUB_OUTPUT"],
      },
    ]);
    expect(matrix.get("static").map(({ args }) => args)).toEqual([
      ["run", "verify:metadata"],
      ["run", "verify:static"],
    ]);
    expect(matrix.get("unit-tests")).toHaveLength(2);
    expect(matrix.get("db-tests").map(({ args }) => args[0])).toEqual([
      "./scripts/db-test-preflight.mjs",
      "./scripts/run-workspaces.mjs",
    ]);
    expect(matrix.get("e2e-tests")[0].args).toEqual(["exec", "playwright", "install", "--with-deps", "chromium"]);
    expect(matrix.get("build")[0].args).toContain(`--workspace-list=${scope.affectedWorkspaces.join(",")}`);

    const omitChangeScopeCommandShape = new Map(matrix);
    omitChangeScopeCommandShape.set("change-scope", []);
    expect(() => validateLocalCommandCoverage(omitChangeScopeCommandShape, { baseSha, headSha })).toThrow(
      "MISSING_LOCAL_COMMAND_SHAPE",
    );
  });

  it("emits complete PLAN_ONLY receipts for both honest dry-run modes", () => {
    for (const options of [
      { mode: "pull-request", provenance: "same-repository" },
      { mode: "merge-group", provenance: undefined },
    ]) {
      const receipt = dryRunReceipt(options);
      expect(receipt).toMatchObject({
        baseSha,
        headSha,
        mode: options.mode,
        disposition: "PLAN_ONLY",
        hostedAuthorityOutstanding: true,
      });
      expect(receipt.gates).toHaveLength(17);
      expect(
        receipt.gates.filter(
          ({ selection, executability }) => selection === "REQUIRED" && executability === "HOSTED_ONLY",
        ),
      ).not.toHaveLength(0);
      expect(receipt.gates.some(({ evidence }) => evidence === "NOT_RUN_HOSTED_ONLY")).toBe(true);
      expect(receipt.gates.some(({ evidence }) => evidence === "NOT_RUN_DRY_RUN")).toBe(true);
      expect(receipt.gates.some(({ evidence }) => evidence === "PASSED")).toBe(false);
      expect(() => validateCiLocalReceipt(receipt)).not.toThrow();
    }
  });

  it("fails closed without pull-request provenance and names the reached error", () => {
    const scope = scopeFor(["README.md"]);
    const receipt = runCiLocalVerification(
      { mode: "pull-request", labels: ["preview"], dryRun: true },
      { gitExec: fakeGit, executor: executorFor(scope), now: clock() },
    );
    expect(receipt.disposition).toBe("FAIL_CLOSED");
    expect(receipt.errors.map(({ code }) => code)).toContain("MISSING_PULL_REQUEST_PROVENANCE");
    expect(receipt.gates.find(({ id }) => id === "preview-deploy-smoke")).toMatchObject({
      selection: "UNDECIDABLE",
      evidence: "NOT_RUN_UNDECIDABLE",
    });
  });

  it("records interruption and every later selected local gate as aborted", () => {
    const plan = createCiGatePlan({ mode: "merge-group", scope: scopeFor() });
    const entries = plan.gates.filter(({ id }) => ["change-scope", "static", "typecheck"].includes(id));
    const commands = new Map(entries.map(({ id }) => [id, [{ command: "node", args: [id], env: {}, clearEnv: [] }]]));
    let call = 0;
    const result = executeGateEntries({
      entries,
      commandPlan: commands,
      executor: () => {
        call += 1;
        return call === 2
          ? { outcome: "interrupted", exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" }
          : { outcome: "passed", exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
    });
    expect(result.gates.map(({ evidence }) => evidence)).toEqual(["PASSED", "INTERRUPTED", "NOT_RUN_ABORTED"]);
    expect(result.disposition).toBe("FAIL_CLOSED");

    const dropPostInterruptionGate = result.gates.slice(0, 2);
    expect(() => validateExecutionResult(entries, { ...result, gates: dropPostInterruptionGate })).toThrow(
      "EXECUTION_GATE_COVERAGE_MISMATCH",
    );
    const interruptionAsProductFailure = { ...result, disposition: "FAIL" };
    expect(() => validateExecutionResult(entries, interruptionAsProductFailure)).toThrow(
      "EXECUTION_DISPOSITION_MISMATCH",
    );
  });

  it("does not short-circuit after a completed product failure", () => {
    const plan = createCiGatePlan({ mode: "merge-group", scope: scopeFor() });
    const entries = plan.gates.filter(({ id }) => ["change-scope", "static", "typecheck"].includes(id));
    const commands = new Map(entries.map(({ id }) => [id, [{ command: "node", args: [id], env: {}, clearEnv: [] }]]));
    let call = 0;
    const result = executeGateEntries({
      entries,
      commandPlan: commands,
      executor: () => {
        call += 1;
        return {
          outcome: call === 1 ? "failed" : "passed",
          exitCode: call === 1 ? 1 : 0,
          signal: null,
          stdout: "",
          stderr: "",
        };
      },
    });
    expect(call).toBe(3);
    expect(result.gates.map(({ evidence }) => evidence)).toEqual(["FAILED", "PASSED", "PASSED"]);
    expect(result.disposition).toBe("FAIL");
    expect(result.gates.some(({ evidence }) => evidence === "NOT_RUN_ABORTED")).toBe(false);

    const shortCircuitAfterFailedGate = result.gates.slice(0, 1);
    expect(() => validateExecutionResult(entries, { ...result, gates: shortCircuitAfterFailedGate })).toThrow(
      "EXECUTION_GATE_COVERAGE_MISMATCH",
    );
  });

  it("rejects dry-run-as-pass, unknown evidence, nested unknowns, and out-of-range numerics", () => {
    const receipt = dryRunReceipt();
    const dryRunAsPass = structuredClone(receipt);
    dryRunAsPass.disposition = "PASS";
    expect(() => validateCiLocalReceipt(dryRunAsPass)).toThrow("RECEIPT_DISPOSITION_MISMATCH");

    const acceptUnknownEvidenceState = structuredClone(receipt);
    acceptUnknownEvidenceState.gates[0].evidence = "INDETERMINATE";
    expect(() => validateCiLocalReceipt(acceptUnknownEvidenceState)).toThrow("UNKNOWN_RECEIPT_EVIDENCE");

    const nestedUnknown = structuredClone(receipt);
    nestedUnknown.plan.gates[0].unexpected = true;
    expect(() => validateCiLocalReceipt(nestedUnknown)).toThrow("unexpected keys");

    const outOfRange = structuredClone(receipt);
    outOfRange.durationMs = 86_400_001;
    expect(() => validateCiLocalReceipt(outOfRange)).toThrow("RECEIPT_DURATION_OUT_OF_RANGE");
    expect(CI_GATE_EVIDENCE).toHaveLength(8);
    expect(CI_LOCAL_DISPOSITIONS).toEqual(["PASS", "FAIL", "FAIL_CLOSED", "PLAN_ONLY"]);
  });

  it("continues all repository-local gates after failures and binds immutable command identity", () => {
    const scope = scopeFor();
    const records = [];
    const receipt = runCiLocalVerification(
      { mode: "merge-group", baseRef: "origin/main", headRef: "HEAD" },
      {
        gitExec: fakeGit,
        executor: executorFor(scope, new Map([["static", { outcome: "failed", exitCode: 1 }]]), records),
        now: clock(),
      },
    );
    expect(receipt.disposition).toBe("FAIL");
    expect(receipt.gates.find(({ id }) => id === "static").evidence).toBe("FAILED");
    expect(receipt.gates.find(({ id }) => id === "build").evidence).toBe("PASSED");
    const classifier = records[0].spec;
    expect(classifier.args).toEqual(["./scripts/change-scope.mjs", "json", `--base=${baseSha}`, `--head=${headSha}`]);
    expect(classifier.clearEnv).toEqual(["CHANGED_FILES_JSON", "GITHUB_OUTPUT"]);
    expect(receipt.headSha).toBe(headSha);

    const wrongHead = "3".repeat(40);
    const wrongHeadCommand = structuredClone(classifier);
    wrongHeadCommand.args[3] = `--head=${wrongHead}`;
    expect(() => validateChangeScopeCommandShape(wrongHeadCommand, { baseSha, headSha })).toThrow(
      "CHANGE_SCOPE_COMMAND_IDENTITY_MISMATCH",
    );
  });

  it("fails closed through the specific malformed-input, ref, classifier, and executor paths", () => {
    const scope = scopeFor();
    const cases = [
      {
        expected: "MALFORMED_MODE",
        input: { mode: "workflow-dispatch", dryRun: true },
        dependencies: { gitExec: fakeGit, executor: executorFor(scope), now: clock() },
      },
      {
        expected: "MALFORMED_LABELS",
        input: { mode: "merge-group", labels: [" full-ci"], dryRun: true },
        dependencies: { gitExec: fakeGit, executor: executorFor(scope), now: clock() },
      },
      {
        expected: "MALFORMED_PROVENANCE",
        input: { mode: "pull-request", provenance: "internal", dryRun: true },
        dependencies: { gitExec: fakeGit, executor: executorFor(scope), now: clock() },
      },
      {
        expected: "REF_RESOLUTION_FAILED",
        input: { mode: "merge-group", baseRef: "missing", dryRun: true },
        dependencies: {
          gitExec: () => {
            throw new Error("missing ref");
          },
          executor: executorFor(scope),
          now: clock(),
        },
      },
      {
        expected: "CLASSIFIER_OUTPUT_MALFORMED",
        input: { mode: "merge-group", dryRun: true },
        dependencies: {
          gitExec: fakeGit,
          executor: () => ({ outcome: "passed", exitCode: 0, stdout: "not json", stderr: "" }),
          now: clock(),
        },
      },
      {
        expected: "CLASSIFIER_INTERRUPTED",
        input: { mode: "merge-group", dryRun: true },
        dependencies: {
          gitExec: fakeGit,
          executor: () => ({ outcome: "interrupted", exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" }),
          now: clock(),
        },
      },
    ];
    for (const testCase of cases) {
      const receipt = runCiLocalVerification(testCase.input, testCase.dependencies);
      expect(receipt.disposition).toBe("FAIL_CLOSED");
      expect(receipt.errors[0].code).toBe(testCase.expected);
      expect(receipt.disposition).not.toBe("PASS");
      expect(receipt.disposition).not.toBe("PLAN_ONLY");
    }
    expect(() => parseCiLocalArgs(["--wat"])).toThrow("UNKNOWN_ARGUMENT");
    expect(() => parseCiLocalArgs(["--mode=merge-group", "--mode=pull-request"])).toThrow("DUPLICATE_ARGUMENT");
  });
});
