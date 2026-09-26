import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const instruction = readFileSync(new URL("../../.agents/skills/delivery/SKILL.md", import.meta.url), "utf8");
const readProse = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8").replace(/\s+/g, " ");
const planningSkill = readProse(".agents/skills/planning/SKILL.md");
const backlogModel = readProse("docs/contributing/backlog-model.md");

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
    /^- For database-touching changes, the normal final-head hosted `DB Profile Tests` job is the DB proof \(\[#4388 ruling\]\([^)\s]+\)\)\. While \[#8159\]\([^)\s]+\) is open, a full local `verify:test-db` is never a prerequisite for push, draft, ready or landing\.[^\r\n]* Hosted gates, timeouts, skips and reviews are unchanged\.$/m,
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

  it("rejects making a full local verify:test-db a delivery prerequisite again", () => {
    const mutant = instruction.replace(
      /^- For database-touching changes,[^\r\n]*$/m,
      "- For database-touching changes, run a full local `verify:test-db` before every push.",
    );

    expect(mutant).not.toBe(instruction);
    expect(() => assertVerificationContract(mutant)).toThrow();
  });

  it("rejects restoring the whole ordinary executing pre-PR instruction", () => {
    const executingInstruction =
      "- The ordinary pre-PR gate is `pnpm run verify:ci-local -- --mode=pull-request --provenance=same-repository`. Use `--provenance=fork` for a fork candidate. Use `--mode=merge-group` only when the delivery contract explicitly requires a local preview of merge-group selection; the real hosted merge group remains authoritative.";
    const mutant = instruction.replace(/^- For every nonempty diff,[^\r\n]*$/m, executingInstruction);

    expect(mutant).not.toBe(instruction);
    expect(() => assertVerificationContract(mutant)).toThrow();
  });
});

// #4388 rulings 5838576100 items 5-6, 5838600629 and 5838628573: the host owns
// same-attempt repairs, heavier decisions get a final independent verdict, and
// only product priority/scope or operator actions reach Todd.
function assertDeliveryDecisionRouting(text) {
  expect(text).toMatch(
    /^ {2}- \*\*Full-path trigger decisions\*\* \([^)]+\): never assume\. Lane mode — stop that thread, state the decision with a recommendation and repo evidence in your completion report; the orchestrator is the host and routes it\. Solo mode — you are the host: [^\r\n]*route it under Decision routing\. Never batch these decisions to Todd\.$/m,
  );
  expect(text).not.toMatch(/batch all such questions into one message to Todd/);
  expect(text).toMatch(
    /^ {2}- \*\*Decision routing\*\* [^\r\n]*: the host decides same-attempt, in-scope repairs itself [^\r\n]* and records each as `decision-resolved` with its reasoning\./m,
  );
  expect(text).toMatch(
    /^ {2}- \*\*Decision routing\*\*[^\r\n]* An independent decision lane is required only when the decision changes accepted scope or acceptance criteria, an attempt ceiling, ownership or authority, or crosses lineages; its verdict is final, and the host records it and proceeds\./m,
  );
  expect(text).toMatch(
    /^ {2}- \*\*Decision routing\*\*[^\r\n]* A decision lane may not return `TODD_RULING_NEEDED`: if it believes Todd must decide, that is a finding the host resolves with a second independent lane\. Independent code\/planning review and review-contract\/v2 are unchanged\.$/m,
  );
  expect(text).toMatch(
    /^ {2}- \*\*Todd receives only two kinds of question\*\* [^\r\n]*: product priority or scope changes, and operator actions no lane can perform\. Package an operator action as one concrete, runnable step\. Never escalate another review pass, revision, replan, attempt ceiling or proof route to Todd; the host routes those decisions\.$/m,
  );
}

function assertPlanningDecisionRouting(text) {
  expect(text).toContain(
    "Other unresolved product, legal and provider-authority choices inside accepted scope go to the orchestrator as host. The host decides same-attempt, in-scope repairs itself and records its reasoning.",
  );
  expect(text).toContain(
    "An independent decision lane is required only for a change to accepted scope or acceptance criteria, an attempt ceiling, ownership or authority, or a cross-lineage question; its verdict is final.",
  );
  expect(text).toContain(
    "A decision lane may not return `TODD_RULING_NEEDED`; if it believes Todd must decide, the host resolves that finding with a second independent lane.",
  );
  expect(text).toContain(
    "The queue is the orchestrator and its independent decision lanes, not Todd, unless the decision changes product priority or scope. Route it by the threshold in Agent-owned placement: same-attempt, in-scope repairs stay with the host; the listed heavier changes get a final independent verdict.",
  );
}

function assertProductCapacityFloor(text) {
  expect(text).toContain(
    "Todd decides which product outcome or pilot is the current priority, and whether accepted product scope is added or dropped.",
  );
  expect(text).toContain("Whenever ready, runnable `kind:product` work exists, at least two delivery lanes run on it.");
  expect(text).toContain(
    "If fewer than two product issues are ready, planning lanes that make product issues ready take precedence over new infrastructure probes",
  );
  expect(text).toContain("Controller, platform and test-infrastructure work use the remaining capacity.");
  expect(text).toContain("Heavy-slot admission order is unchanged; nothing preempts a live heavy owner.");
}

describe("delivery decision routing contract", () => {
  it("routes solo and lane decisions to the host with a final independent verdict above the threshold", () => {
    assertDeliveryDecisionRouting(instruction);
    assertPlanningDecisionRouting(planningSkill);
  });

  it.each([
    {
      name: "restores the solo Todd batch",
      from: /Solo mode — you are the host: [^\r\n]*Never batch these decisions to Todd\./,
      to: "Solo mode — batch all such questions into one message to Todd, each with the decision, why it matters, a recommended answer, and repo evidence.",
    },
    {
      name: "drops the lane-mode stop and evidence handoff",
      from: "Lane mode — stop that thread, state the decision with a recommendation and repo evidence in your completion report;",
      to: "Lane mode — decide it yourself;",
    },
    {
      name: "drops the host's same-attempt repair ownership",
      from: "the host decides same-attempt, in-scope repairs itself",
      to: "an independent decision lane decides every repair",
    },
    {
      name: "drops the independent-lane threshold",
      from: "is required only when the decision changes accepted scope or acceptance criteria, an attempt ceiling, ownership or authority, or crosses lineages;",
      to: "is required for every decision;",
    },
    {
      name: "makes the independent verdict non-final",
      from: "its verdict is final, and the host records it and proceeds.",
      to: "its verdict is advisory.",
    },
    {
      name: "lets a decision lane return a Todd ruling",
      from: "A decision lane may not return `TODD_RULING_NEEDED`: if it believes Todd must decide, that is a finding the host resolves with a second independent lane.",
      to: "A decision lane may return `TODD_RULING_NEEDED` when it believes Todd must decide.",
    },
  ])("rejects a delivery mutant that $name", ({ from, to }) => {
    const mutant = instruction.replace(from, to);

    expect(mutant).not.toBe(instruction);
    expect(() => assertDeliveryDecisionRouting(mutant)).toThrow();
  });

  it.each([
    {
      name: "sends every in-scope choice through a decision lane",
      from: "go to the orchestrator as host. The host decides same-attempt, in-scope repairs itself and records its reasoning.",
      to: "go to the orchestrator, which decides them through an independent decision lane.",
    },
    {
      name: "drops the independent-lane threshold",
      from: "is required only for a change to accepted scope or acceptance criteria, an attempt ceiling, ownership or authority, or a cross-lineage question;",
      to: "is required for every decision;",
    },
    {
      name: "makes the independent verdict non-final",
      from: "or a cross-lineage question; its verdict is final.",
      to: "or a cross-lineage question; its verdict is advisory.",
    },
    {
      name: "lets a decision lane return a Todd ruling",
      from: "A decision lane may not return `TODD_RULING_NEEDED`;",
      to: "A decision lane may return `TODD_RULING_NEEDED`;",
    },
    {
      name: "routes the decision queue to Todd",
      from: "The queue is the orchestrator and its independent decision lanes, not Todd,",
      to: "The queue is Todd,",
    },
  ])("rejects a planning mutant that $name", ({ from, to }) => {
    const mutant = planningSkill.replace(from, to);

    expect(mutant).not.toBe(planningSkill);
    expect(() => assertPlanningDecisionRouting(mutant)).toThrow();
  });
});

describe("product capacity floor contract", () => {
  it("reserves two lanes for ready, runnable product work and prefers product planning below two ready issues", () => {
    assertProductCapacityFloor(backlogModel);
  });

  it.each([
    {
      name: "drops the runnable qualifier",
      from: "Whenever ready, runnable `kind:product` work exists, at least two delivery lanes run on it.",
      to: "While ready product work exists, at least two delivery lanes serve it.",
    },
    {
      name: "drops the fewer-than-two planning fallback",
      from: "If fewer than two product issues are ready, planning lanes that make product issues ready take precedence over new infrastructure probes",
      to: "New infrastructure probes may start",
    },
    {
      name: "lets the floor preempt a live heavy owner",
      from: "Heavy-slot admission order is unchanged; nothing preempts a live heavy owner.",
      to: "Product lanes may preempt a live heavy owner.",
    },
    {
      name: "moves product priority away from Todd",
      from: "Todd decides which product outcome or pilot is the current priority,",
      to: "Agents decide which product outcome or pilot is the current priority,",
    },
  ])("rejects a backlog-model mutant that $name", ({ from, to }) => {
    const mutant = backlogModel.replace(from, to);

    expect(mutant).not.toBe(backlogModel);
    expect(() => assertProductCapacityFloor(mutant)).toThrow();
  });
});
