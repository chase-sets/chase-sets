import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const instruction = readFileSync(new URL("../../.agents/skills/delivery/SKILL.md", import.meta.url), "utf8");

function assertVerificationContract(text) {
  expect(text).toMatch(
    /^- For every nonempty diff, the ordinary pre-PR gate is a dry-run plan: `pnpm run verify:ci-local -- --mode=pull-request --provenance=same-repository --dry-run`\.[^\r\n]* Retain the exact-head plan as PLAN_ONLY before push\.$/m,
  );
  expect(text).toMatch(
    /^- For every nonempty diff,[^\r\n]* Use `pnpm run verify:ci-local -- --mode=pull-request --provenance=fork --dry-run` for a fork candidate\.[^\r\n]*$/m,
  );
  expect(text).toMatch(
    /^- For every nonempty diff,[^\r\n]* Use `pnpm run verify:ci-local -- --mode=merge-group --dry-run` only when the delivery contract explicitly requires a local preview of merge-group selection; the real hosted merge group remains authoritative\.[^\r\n]*$/m,
  );
  expect(text).toMatch(
    /^- PLAN_ONLY records a plan, not an executed local or hosted PASS\. Do not execute the selected broad local battery just to publish a draft\.$/m,
  );
  expect(text).toMatch(
    /^- Run `pnpm run verify:static:scoped` before every push, plus named focused tests for changed script tooling\. Do not use local full `verify:static`, full `verify`, or the complete `test:scripts` battery as delivery gates; hosted CI owns those unchanged strict full gates on every PR\.$/m,
  );
  expect(text).toMatch(
    /^\*\*Draft semantics\.\*\* Open the PR as a draft once scoped checks and affected focused checks are green and the Quality Packet is complete; disclose the exact-head PLAN_ONLY evidence\.[^\r\n]*$/m,
  );
  expect(text).toMatch(
    /^\*\*Draft semantics\.\*\*[^\r\n]* Before ready or enqueue, all selected REQUIRED hosted gates must pass and independent exact-head implementation review must pass, with no unresolved full-path assumption\.[^\r\n]*$/m,
  );
  expect(text).toMatch(
    /^\*\*Draft semantics\.\*\*[^\r\n]* Missing, red, or skipped REQUIRED hosted gates block readiness; PLAN_ONLY never substitutes for them\.[^\r\n]*$/m,
  );
}

describe("delivery verification contract", () => {
  it("separates exact-head dry-run planning and scoped-green drafts from hosted readiness", () => {
    assertVerificationContract(instruction);
  });

  it("rejects restoring the whole ordinary executing pre-PR instruction", () => {
    const executingInstruction =
      "- The ordinary pre-PR gate is `pnpm run verify:ci-local -- --mode=pull-request --provenance=same-repository`. Use `--provenance=fork` for a fork candidate. Use `--mode=merge-group` only when the delivery contract explicitly requires a local preview of merge-group selection; the real hosted merge group remains authoritative.";
    const mutant = instruction.replace(/^- For every nonempty diff,[^\r\n]*$/m, executingInstruction);

    expect(mutant).not.toBe(instruction);
    expect(() => assertVerificationContract(mutant)).toThrow();
  });
});
