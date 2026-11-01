import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const instruction = readFileSync(new URL("../../.agents/skills/delivery/SKILL.md", import.meta.url), "utf8");
const readProse = (relativePath) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8").replace(/\s+/g, " ");
const verificationContractFiles = [
  "AGENTS.md",
  ".agents/skills/delivery/SKILL.md",
  ".claude/skills/delivery/SKILL.md",
  "docs/runbooks/digitalocean-platform-deployment.md",
].map((relativePath) => ({ relativePath, text: readProse(relativePath) }));
const planningSkill = readProse(".agents/skills/planning/SKILL.md");
const backlogModel = readProse("docs/contributing/backlog-model.md");
const codexDeliveryPrompt = parseYaml(
  readFileSync(new URL("../../.agents/skills/delivery/agents/openai.yaml", import.meta.url), "utf8"),
).interface;

function assertCodexDeliveryPromptContract(value) {
  expect(Object.keys(value)).toEqual(["display_name", "short_description", "default_prompt"]);
  expect(value.display_name).toBe("Delivery");
  expect(value.short_description).toBe("Deliver changes with bounded-context evidence");
  expect(value.default_prompt).toContain(
    "In lane mode (orchestrator dispatch) stop at a pushed draft PR plus a completion report — do not launch reviewers or mark your own PR ready; it may become ready only after a host-dispatched exact-head independent PASS with every selected REQUIRED hosted gate green; never enqueue or merge;",
  );
  expect(value.default_prompt).not.toContain("ready, non-draft");
  expect(value.default_prompt).not.toContain("the host marks it ready");
  expect(value.default_prompt).toContain(
    "in solo mode land through the merge queue only after confirming no orchestrator lease is active.",
  );
}

describe("Codex delivery default prompt contract", () => {
  it("pins the ruled draft-review lane boundary without changing the solo clause", () => {
    assertCodexDeliveryPromptContract(codexDeliveryPrompt);
  });

  it.each([
    {
      name: "restores the ready non-draft boundary",
      mutate: (prompt) =>
        prompt.replace(
          "In lane mode (orchestrator dispatch) stop at a pushed draft PR plus a completion report — do not launch reviewers or mark your own PR ready; it may become ready only after a host-dispatched exact-head independent PASS with every selected REQUIRED hosted gate green; never enqueue or merge;",
          "In lane mode (orchestrator dispatch) stop at a green, ready, non-draft PR plus a completion report — never enqueue or merge;",
        ),
    },
    {
      name: "names an actor for the draft-to-ready mutation",
      mutate: (prompt) =>
        prompt.replace(
          "it may become ready only after a host-dispatched exact-head independent PASS",
          "the host marks it ready only after a host-dispatched exact-head independent PASS",
        ),
    },
  ])("rejects a lane-boundary mutant that $name", ({ mutate }) => {
    const mutant = { ...codexDeliveryPrompt, default_prompt: mutate(codexDeliveryPrompt.default_prompt) };
    expect(mutant.default_prompt).not.toBe(codexDeliveryPrompt.default_prompt);
    expect(() => assertCodexDeliveryPromptContract(mutant)).toThrow();
  });
});

function assertPremiseContract(text) {
  const premiseStart = text.indexOf("### Premise check (before the first edit)");
  const implementationStart = text.indexOf("## Implementation & Verification");

  expect(premiseStart).toBeGreaterThan(-1);
  expect(implementationStart).toBeGreaterThan(premiseStart);

  const premise = text.slice(premiseStart, implementationStart);
  expect(premise).toContain(
    "Before implementation guidance, run the premise check before the first edit using reads and the brief's own inspection steps only.",
  );
  expect(premise).toContain(
    "The issue must be open and carry neither `status:needs-replan` nor `status:tracking-only`; no comment after the brief's last edit may supersede it; the outcome must not already be present at the baseline; and a defect must still be present at the baseline when it can be shown.",
  );
  expect(premise).toContain(
    "Product work uses fresh `origin/main`; controller work under the container `.orchestrator/` uses the installed reviewed controller head from `~/.claude/skills/native-db/identity.json`, validated as `controller-release-battery.ps1:646-648` does: the identity has exactly two properties, a lowercase 40-hex `head` and a lowercase 64-hex `digest`. A missing or invalid identity makes the baseline unavailable (handled as unavailable, never a negative premise); and a path the brief plans to create does not exist yet, so its absence is never a premise failure.",
  );
  expect(premise).toContain(
    "Any result except `CONFIRMED` ends the lane before an edit, push or PR, with the evidence in the report; the lane never closes or relabels the issue.",
  );
  expect(premise).toContain(
    "Unavailable is not negative: `NOT_REPRODUCED` requires a reproduction that actually ran and did not show the defect, `ALREADY_DELIVERED` requires a named commit or PR at an available baseline, and a local harness, environment or lock failure or unavailable baseline yields `CONFIRMED (unverified: <reason>)` and proceeds under the existing hosted-substitution rule.",
  );
  expect(premise).toContain(
    "In solo mode, run the same check and disposition its result: `ALREADY_DELIVERED` closes the issue citing the commit or PR; `SUPERSEDED_BY` applies the planning supersession rule including its product-question exception; and `NOT_REPRODUCED` or `PREMISE_CHANGED` comments with evidence and then amends the brief, closes it only when no accepted product scope is dropped, or asks Todd one product question.",
  );

  const laneIndex = premise.indexOf("Before implementation guidance, run the premise check");
  const baselineIndex = premise.indexOf("Product work uses fresh `origin/main`");
  const dispositionIndex = premise.indexOf("Any result except `CONFIRMED`");
  const unavailableIndex = premise.indexOf("Unavailable is not negative");
  expect(laneIndex).toBeGreaterThan(-1);
  expect(baselineIndex).toBeGreaterThan(laneIndex);
  expect(dispositionIndex).toBeGreaterThan(baselineIndex);
  expect(unavailableIndex).toBeGreaterThan(dispositionIndex);

  const reportStart = text.indexOf("## Completion Report (lane mode)");
  const landingStart = text.indexOf("## Landing (solo mode only)");
  expect(reportStart).toBeGreaterThan(-1);
  expect(landingStart).toBeGreaterThan(reportStart);
  const report = text.slice(reportStart, landingStart);
  expect(report).toMatch(
    /0\. `PREMISE:` — exactly one of `PREMISE: CONFIRMED <one line>`, `PREMISE: ALREADY_DELIVERED <commit or PR>`, `PREMISE: SUPERSEDED_BY #<n>`, `PREMISE: NOT_REPRODUCED <command and observed output>`, or `PREMISE: PREMISE_CHANGED <what changed>`\./,
  );

  const values =
    report.match(
      /`PREMISE: (?:CONFIRMED <one line>|ALREADY_DELIVERED <commit or PR>|SUPERSEDED_BY #<n>|NOT_REPRODUCED <command and observed output>|PREMISE_CHANGED <what changed>)`/g,
    ) ?? [];
  expect(values).toHaveLength(5);
  expect(new Set(values).size).toBe(5);
}

describe("delivery premise contract", () => {
  it("requires the pre-edit lane and solo premise checks and exact report vocabulary", () => {
    assertPremiseContract(instruction);
  });

  it.each([
    {
      name: "moves the check after the first edit",
      from: "Before implementation guidance, run the premise check before the first edit",
      to: "After the first edit, run the premise check",
    },
    {
      name: "drops the controller baseline",
      from: "Product work uses fresh `origin/main`; controller work under the container `.orchestrator/` uses the installed reviewed controller head from `~/.claude/skills/native-db/identity.json`, validated as `controller-release-battery.ps1:646-648` does: the identity has exactly two properties, a lowercase 40-hex `head` and a lowercase 64-hex `digest`. A missing or invalid identity makes the baseline unavailable (handled as unavailable, never a negative premise); and a path the brief plans to create does not exist yet, so its absence is never a premise failure.",
      to: "Product work uses fresh `origin/main`.",
    },
    {
      name: "turns an unavailable baseline into a negative premise",
      from: "and a local harness, environment or lock failure or unavailable baseline yields `CONFIRMED (unverified: <reason>)` and proceeds under the existing hosted-substitution rule.",
      to: "and an unavailable baseline yields `NOT_REPRODUCED`.",
    },
    {
      name: "drops the solo mapping",
      from: "In solo mode, run the same check and disposition its result: `ALREADY_DELIVERED` closes the issue citing the commit or PR; `SUPERSEDED_BY` applies the planning supersession rule including its product-question exception; and `NOT_REPRODUCED` or `PREMISE_CHANGED` comments with evidence and then amends the brief, closes it only when no accepted product scope is dropped, or asks Todd one product question.",
      to: "In solo mode, run the same check.",
    },
  ])("rejects a premise mutant that $name", ({ from, to }) => {
    const mutant = instruction.replace(from, to);

    expect(mutant).not.toBe(instruction);
    expect(() => assertPremiseContract(mutant)).toThrow();
  });

  it.each([
    {
      name: "adds a report value",
      mutate: (report) =>
        report.replace(
          "`PREMISE: PREMISE_CHANGED <what changed>`",
          "`PREMISE: PREMISE_CHANGED <what changed>` or `PREMISE: UNKNOWN <reason>`,",
        ),
    },
    {
      name: "removes a report value",
      mutate: (report) => report.replace("`PREMISE: NOT_REPRODUCED <command and observed output>`, or ", ""),
    },
  ])("rejects a premise vocabulary mutant that $name", ({ mutate }) => {
    const reportStart = instruction.indexOf("## Completion Report (lane mode)");
    const landingStart = instruction.indexOf("## Landing (solo mode only)");
    const report = instruction.slice(reportStart, landingStart);
    const mutatedReport = mutate(report);
    const mutant = instruction.slice(0, reportStart) + mutatedReport + instruction.slice(landingStart);

    expect(mutant).not.toBe(instruction);
    expect(() => assertPremiseContract(mutant)).toThrow();
  });
});

function assertVerificationContract(text) {
  expect(text).toMatch(
    /^\*\*Lane mode \(default when dispatched\)\.\*\*[^\r\n]* Your scope ends at a \*\*pushed draft PR plus a completion report\*\*, with scoped checks green and the Quality Packet complete \(see \*\*Draft semantics\*\*\)\. The host dispatches independent exact-head review; do not launch reviewers, mark ready, enqueue, merge, verify deploys, or create\/remove worktrees — the orchestrator owns review dispatch, landing and the pipeline\.$/m,
  );
  expect(text).not.toContain("ready, non-draft");
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
  expect(text).toContain(
    "The ordinary lane pre-push set is changed-file Prettier, `pnpm run format:check -- --changed`, named non-DB focused tests, and `scripts/check-structure/issue-reference-comments.test.mjs` when non-test source changed.",
  );
  expect(text).toContain(
    "`pnpm run typecheck:changed` is a host-attributed diagnostic only: it runs only after host-wide heavy admission; a refusal exits 73 before reservation and is `NOT_EXECUTED`, while hosted exact-head `Typecheck` is authoritative.",
  );
  expect(text).toContain(
    "Lanes run no `verify:*` gate (including `verify:static:scoped`), local DB test, workspace-wide or full battery, or other unadmitted heavy command; hosted CI owns full Static, Typecheck, Unit and DB Profile proof.",
  );
  expect(text).toMatch(
    /^- For database-touching changes, the normal final-head hosted `DB Profile Tests` job is the DB proof\. Hosted gates, timeouts, skips and reviews are unchanged\.$/m,
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
  expect(text).toMatch(
    /^\*\*Draft semantics\.\*\*[^\r\n]* If anything is unresolved, stay draft and say why in your report — draft vs\. ready is a deliberate signal; in lane mode, leave the PR draft and do not mark it ready yourself\. The draft may become ready only after a host-dispatched exact-head independent PASS with every selected REQUIRED hosted gate green, never over a blocker the lane reported\.$/m,
  );
  expect(text).not.toContain("never readies drafts on your behalf");
  const reportStart = text.indexOf("## Completion Report (lane mode)");
  const landingStart = text.indexOf("## Landing (solo mode only)");
  expect(reportStart).toBeGreaterThan(-1);
  expect(landingStart).toBeGreaterThan(reportStart);
  const report = text.slice(reportStart, landingStart);
  expect(report).toMatch(
    /^1\. PR number and state — draft plus what remains before ready \(hosted gates, the host-dispatched review, or a named blocker\)\.$/m,
  );
}

function assertScopedMirrorContract(text) {
  expect(text).toContain(
    "The ordinary lane pre-push set is changed-file Prettier, `pnpm run format:check -- --changed`, named non-DB focused tests, and `scripts/check-structure/issue-reference-comments.test.mjs` when non-test source changed.",
  );
  expect(text).toContain(
    "`pnpm run typecheck:changed` is a host-attributed diagnostic only: it runs only after host-wide heavy admission; a refusal exits 73 before reservation and is `NOT_EXECUTED`, while hosted exact-head `Typecheck` is authoritative.",
  );
  expect(text).toContain("Prettier is `--write` on committed changed files.");
  expect(text).toContain(
    "Lanes run no `verify:*` gate (including `verify:static:scoped`), local DB test, workspace-wide or full battery, or other unadmitted heavy command",
  );
  expect(text).not.toContain("Keep `pnpm run verify`");
  expect(text).not.toContain("Focused local `test:db`");
  expect(text).not.toContain("A focused local `test:db`");
  expect(text).not.toContain("Run pnpm run verify");
  expect(text).not.toContain("Run pnpm run test:db");
  const banStart = text.indexOf("Lanes run no `verify:*` gate");
  const banEnd = text.indexOf("hosted CI owns", banStart);
  expect(banStart).toBeGreaterThanOrEqual(0);
  expect(banEnd).toBeGreaterThan(banStart);
  for (const match of text.matchAll(/verify:static:scoped|verify-static-scoped/g)) {
    expect(match.index).toBeGreaterThanOrEqual(banStart);
    expect(match.index).toBeLessThan(banEnd);
  }
}

describe("delivery verification contract", () => {
  it("separates exact-head dry-run planning and scoped-green drafts from hosted readiness", () => {
    assertVerificationContract(instruction);
  });

  it("pins the scoped contract in every instruction and runbook mirror", () => {
    for (const { text } of verificationContractFiles) assertScopedMirrorContract(text);
  });

  it.each(
    verificationContractFiles.flatMap(({ relativePath, text }) => [
      [relativePath, "old verify sentence", `${text}\nKeep \`pnpm run verify\` as a local gate.\n`],
      [relativePath, "scoped verifier command", `${text}\nRun pnpm verify:static:scoped before push.\n`],
      [
        relativePath,
        "node scoped verifier command",
        `${text}\nRun node ./scripts/verify-static-scoped.mjs before push.\n`,
      ],
      [relativePath, "local database command", `${text}\nRun pnpm run test:db before push.\n`],
      [relativePath, "whole verify command", `${text}\nRun pnpm run verify before push.\n`],
      [
        relativePath,
        "typecheck in ordinary set",
        text.replace("named non-DB focused tests", "named non-DB focused tests, typecheck:changed"),
      ],
    ]),
  )("rejects the $relativePath $1 mutant", (_relativePath, _name, mutant) => {
    expect(() => assertScopedMirrorContract(mutant)).toThrow();
  });

  it.each([
    {
      name: "restores the ready, non-draft lane boundary",
      from: /^\*\*Lane mode \(default when dispatched\)\.\*\*[^\r\n]*$/m,
      to: "**Lane mode (default when dispatched).** Your prompt came from the milestone orchestrator with an issue and an assigned worktree. Your scope ends at a **green, ready, non-draft PR plus a completion report**. Do not enqueue, merge, verify deploys, or create/remove worktrees — the orchestrator owns landing and the pipeline.",
    },
    {
      name: "restores the nobody-readies-drafts clause",
      from: /If anything is unresolved, stay draft[^\r\n]*$/m,
      to: "If anything is unresolved, stay draft and say why in your report — draft vs. ready is a deliberate signal, and the orchestrator never readies drafts on your behalf.",
    },
    {
      name: "restores the ready lane completion state",
      from: /^1\. PR number and state[^\r\n]*$/m,
      to: "1. PR number and state — ready, or draft plus why.",
    },
    {
      name: "lets a lane mark ready after PASS",
      from: "leave the PR draft and do not mark it ready yourself",
      to: "mark the PR ready yourself after PASS",
    },
    {
      name: "names an actor for the draft-to-ready mutation",
      from: "The draft may become ready only after",
      to: "The orchestrator marks the draft ready only after",
    },
    {
      name: "allows readiness over a reported blocker",
      from: ", never over a blocker the lane reported",
      to: "",
    },
  ])("rejects a boundary mutant that $name", ({ from, to }) => {
    const mutant = instruction.replace(from, to);

    expect(mutant).not.toBe(instruction);
    expect(() => assertVerificationContract(mutant)).toThrow();
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
    /^ {2}- \*\*Decision routing\*\*: the host decides same-attempt, in-scope repairs itself [^\r\n]* and records each as `decision-resolved` with its reasoning\./m,
  );
  expect(text).toMatch(
    /^ {2}- \*\*Decision routing\*\*: [^\r\n]* An independent decision lane is required only when the decision changes accepted scope or acceptance criteria, ownership or authority, or crosses lineages; its verdict is final, and the host records it and proceeds\./m,
  );
  expect(text).toMatch(
    /^ {2}- \*\*Decision routing\*\*: [^\r\n]* A decision lane may not return `TODD_RULING_NEEDED`: if it believes Todd must decide, that is a finding the host resolves with a second independent lane\. Independent code\/planning review and review-contract\/v2 are unchanged\.$/m,
  );
  expect(text).not.toMatch(/attempt\s+ceiling/i);
  expect(text).toMatch(
    /^ {2}- \*\*Todd receives only two kinds of question\*\*: product priority or scope changes, and operator actions no lane can perform\. Package an operator action as one concrete, runnable step\. Never escalate another review pass, revision, replan, step-back verdict or proof route to Todd; the host routes those decisions\.$/m,
  );
}

function assertPlanningDecisionRouting(text) {
  expect(text).toContain(
    "Other unresolved product, legal and provider-authority choices inside accepted scope go to the orchestrator as host. The host decides same-attempt, in-scope repairs itself and records its reasoning.",
  );
  expect(text).toContain(
    "An independent decision lane is required only for a change to accepted scope or acceptance criteria, ownership or authority, or a cross-lineage question; its verdict is final.",
  );
  expect(text).not.toMatch(/attempt\s+ceiling/i);
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
  it("keeps citation-free labels in their original bold-label form", () => {
    expect(instruction).toContain("  - **Decision routing**: the host decides");
    expect(instruction).toContain(
      "  - **Todd receives only two kinds of question**: product priority or scope changes",
    );
  });

  it("deletes ruling history and the entire registered-prediction sentence, keeping standing rules", () => {
    const pressureTest = readProse(".agents/skills/planning/references/pressure-test.md");
    expect(instruction).not.toContain("prospective amendment");
    expect(instruction).not.toContain("narrows the performer boundary of the earlier rulings, not their history");
    expect(pressureTest).not.toContain("The registered prediction");
    expect(pressureTest).not.toContain("median mandated-evidence lines per slice");
    expect(pressureTest).toContain(
      "12. **Evidence proportionality.** An AC that mandates a test architecture or artifact rather than an observable property, or an evidence artifact with no named ledger defect class justifying it, is a finding. 13. **Supersession completeness.**",
    );
  });

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
      from: "is required only when the decision changes accepted scope or acceptance criteria, ownership or authority, or crosses lineages;",
      to: "is required for every decision;",
    },
    {
      name: "restores an attempt ceiling to the decision-lane triggers",
      from: "accepted scope or acceptance criteria, ownership or authority, or crosses lineages;",
      to: "accepted scope or acceptance criteria, an attempt ceiling, ownership or authority, or crosses lineages;",
    },
    {
      name: "restores an attempt ceiling to the Todd escalation list",
      from: "revision, replan, step-back verdict or proof route to Todd;",
      to: "revision, replan, attempt ceiling or proof route to Todd;",
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
      from: "is required only for a change to accepted scope or acceptance criteria, ownership or authority, or a cross-lineage question;",
      to: "is required for every decision;",
    },
    {
      name: "restores an attempt ceiling to the decision-lane triggers",
      from: "accepted scope or acceptance criteria, ownership or authority, or a cross-lineage question;",
      to: "accepted scope or acceptance criteria, an attempt ceiling, ownership or authority, or a cross-lineage question;",
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

// #4388 ruling 5845981597 (#8205): hosted CI is the proof for every product
// attempt, an attempt counts only with a hosted or exact-head review verdict,
// diagnostics never block product issues, and serial blocking backfills the
// product floor from the next committed outcomes.
const issueStandard = readProse(".agents/skills/planning/references/issue-standard.md");

function assertHostedAttemptProof(text) {
  expect(text).toMatch(
    /^- Hosted CI is the proof for every product attempt, not only DB\. The hosted jobs on the pushed head decide it, including E2E, DB Profile, unit, static and build\. Local E2E, local `verify:test-db` and other local full or harness runs are diagnostics only and never a prerequisite for push, draft, ready or landing\. A local-harness, environment or lock failure never parks, fails or classifies your candidate: push it to the draft PR and let hosted CI judge it\. When a brief names a local run as a gate or a stop condition, take the hosted substitution and disclose it in the PR body\.$/m,
  );
  expect(text).toMatch(
    /^- An implementation attempt counts only when a pushed head receives a hosted CI verdict or an exact-head review verdict\. Attempt counts are telemetry and step-back triggers, never a stop; no attempt count parks your issue\. Local-only failures, preparation stops, harness or environment failures, lock refusals and defects in your own tooling \(helper scripts, probes, config\) do not count\. Fix them and continue within the same attempt instead of stopping\.$/m,
  );
  expect(text).toContain(
    "PR-lane CI runs the `DB Profile Tests` job on every PR whose change scope requires it (an affected workspace with DB-profile tests), and that hosted job is the DB proof; confirm it ran rather than skipped at your head.",
  );
  expect(text).toContain(
    "disclose the exact-head PLAN_ONLY evidence. A harness or lock refusal of a scoped check is disclosed, not a draft blocker.",
  );
  expect(text).not.toMatch(/PR-lane CI does \*\*not\*\* run the DB-profile suite/);
}

function assertIssueStandardVelocity(text) {
  expect(text).toContain("Hosted CI on the pushed head is the proof for every product attempt");
  expect(text).toContain("without its output; run it in parallel instead.");
  expect(text).toContain(
    "never make local E2E or another local full or harness run a gate, a prerequisite, or a PARK or stop condition.",
  );
  expect(text).toContain(
    "A probe, diagnostic or test-infrastructure issue is never a blocking dependency of a product issue unless the product change cannot be written without its output",
  );
}

function assertFloorBackfill(text) {
  expect(text).toContain(
    "When the current priority outcome has fewer ready product issues than the floor (for example because it is a serial chain), the remaining product lanes take ready `kind:product` issues from the next committed outcomes in marker order",
  );
  expect(text).toContain("That backfill is not a priority change and needs no question.");
  expect(text).toContain(
    "The current priority keeps first claim on each lane that frees, and backfill never preempts a running lane.",
  );
}

describe("hosted attempt proof and floor backfill contract", () => {
  it("pins hosted proof, attempt counting, diagnostic blocking and backfill", () => {
    assertHostedAttemptProof(instruction);
    assertIssueStandardVelocity(issueStandard);
    assertFloorBackfill(backlogModel);
  });

  it.each([
    {
      name: "narrows hosted proof to DB",
      from: "Hosted CI is the proof for every product attempt, not only DB",
      to: "Hosted CI is the proof for DB",
    },
    {
      name: "makes local E2E a gate",
      from: "are diagnostics only and never a prerequisite for push, draft, ready or landing.",
      to: "are required before push.",
    },
    {
      name: "lets a local failure park a candidate",
      from: "never parks, fails or classifies your candidate",
      to: "parks your candidate",
    },
    {
      name: "makes an attempt count a stop",
      from: "Attempt counts are telemetry and step-back triggers, never a stop; no attempt count parks your issue",
      to: "A third counted attempt parks your issue",
    },
    {
      name: "restores the attempt ceiling to attempt counting",
      from: "An implementation attempt counts only when",
      to: "An implementation attempt counts toward an attempt ceiling only when",
    },
    {
      name: "counts local-only stops",
      from: "do not count. Fix them and continue within the same attempt instead of stopping.",
      to: "count as attempts.",
    },
    {
      name: "restores the stale DB-profile claim",
      from: "PR-lane CI runs the `DB Profile Tests` job on every PR whose change scope requires it (an affected workspace with DB-profile tests), and that hosted job is the DB proof; confirm it ran rather than skipped at your head.",
      to: "PR-lane CI does **not** run the DB-profile suite.",
    },
    {
      name: "claims DB Profile runs on every PR",
      from: "on every PR whose change scope requires it (an affected workspace with DB-profile tests),",
      to: "on every PR,",
    },
    {
      name: "deletes the DB Profile proof sentence",
      from: "PR-lane CI runs the `DB Profile Tests` job on every PR whose change scope requires it (an affected workspace with DB-profile tests), and that hosted job is the DB proof; confirm it ran rather than skipped at your head.",
      to: "",
    },
    {
      name: "drops the brief substitution",
      from: " When a brief names a local run as a gate or a stop condition, take the hosted substitution and disclose it in the PR body.",
      to: "",
    },
    {
      name: "narrows tooling defects to helper scripts",
      from: "defects in your own tooling (helper scripts, probes, config)",
      to: "defects in your own helper scripts",
    },
    {
      name: "lets a scoped-check refusal block the draft",
      from: " A harness or lock refusal of a scoped check is disclosed, not a draft blocker.",
      to: "",
    },
  ])("rejects a delivery mutant that $name", ({ from, to }) => {
    const mutant = instruction.replace(from, to);

    expect(mutant).not.toBe(instruction);
    expect(() => assertHostedAttemptProof(mutant)).toThrow();
  });

  it.each([
    {
      name: "allows a local PARK condition",
      from: "a gate, a prerequisite, or a PARK or stop condition.",
      to: "a gate.",
    },
    {
      name: "drops the hosted lead clause",
      from: "Hosted CI on the pushed head is the proof for every product attempt",
      to: "Hosted CI is advisory",
    },
    {
      name: "drops run-in-parallel",
      from: "; run it in parallel instead.",
      to: ".",
    },
    {
      name: "lets diagnostics block product",
      from: "is never a blocking dependency of a product issue",
      to: "may block a product issue",
    },
  ])("rejects an issue-standard mutant that $name", ({ from, to }) => {
    const mutant = issueStandard.replace(from, to);

    expect(mutant).not.toBe(issueStandard);
    expect(() => assertIssueStandardVelocity(mutant)).toThrow();
  });

  it.each([
    {
      name: "re-narrows backfill to serial blocking",
      from: "When the current priority outcome has fewer ready product issues than the floor (for example because it is a serial chain),",
      to: "When the current priority outcome is serially blocked and has fewer ready product issues than the floor,",
    },
    {
      name: "drops the backfill",
      from: "the remaining product lanes take ready `kind:product` issues from the next committed outcomes in marker order",
      to: "the remaining lanes wait",
    },
    {
      name: "makes backfill a priority question",
      from: "That backfill is not a priority change and needs no question.",
      to: "That backfill needs a Todd priority question.",
    },
    {
      name: "lets backfill preempt",
      from: "and backfill never preempts a running lane.",
      to: "and backfill may preempt a running lane.",
    },
  ])("rejects a backlog-model mutant that $name", ({ from, to }) => {
    const mutant = backlogModel.replace(from, to);

    expect(mutant).not.toBe(backlogModel);
    expect(() => assertFloorBackfill(mutant)).toThrow();
  });
});

// #9195: the `.claude/skills/` copies are byte-identical mirrors of the
// `.agents/skills/` sources these contracts pin.
describe("delivery and planning skill mirrors", () => {
  it.each(["delivery", "planning"])("keeps the %s skill mirror byte-identical", (skill) => {
    const read = (root) => readFileSync(new URL(`../../${root}/skills/${skill}/SKILL.md`, import.meta.url));

    expect(read(".claude").equals(read(".agents"))).toBe(true);
  });

  it("pins the TCGplayer boundary invariant and removes operator-session custody wording", () => {
    for (const root of [".agents", ".claude"]) {
      const text = readProse(`${root}/skills/delivery/SKILL.md`);
      expect(text).toContain(
        "Chase Sets never contacts TCGplayer servers and never stores or uses TCGplayer auth cookies or credentials.",
      );
      expect(text).not.toContain("operator-session custody");
    }
  });
});
