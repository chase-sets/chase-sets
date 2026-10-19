import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const planningSkillPath = `${repoRoot}/.agents/skills/planning/SKILL.md`;
const registrationAnchor = "7. **Registration.**";

const parentageRule = Object.freeze({
  recordDisposition:
    "when a replacement round dispositions a predecessor, before removing its\n" +
    "     parent link in the same registration pass, confirm that the predecessor's\n" +
    "     disposition is already recorded,",
  recordSuccessorSet: "exactly one durable disposition comment\n" + "     or record names the successor set,",
  reverseReference: "and every successor carries a\n" + "     reverse-reference to the predecessor;",
  attachSuccessors:
    "first attach every successor that\n" + "     carries the parent's acceptance as a child of that parent;",
  detachInSamePass:
    "only after every\n" +
    "     attached successor carries that parentage, detach the predecessor from the\n" +
    "     parent in the same registration pass.",
  retainWithoutSuccessor: "If no successor is attached to the\n" + "     parent, keep the predecessor's parent link;",
});

const supersessionRule = Object.freeze({
  discoveryOpenIssues:
    "including open issues found by searching the planned outcome terms and predicted footprint paths.",
  wholeSuccessorSet:
    "judge coverage over the whole successor set: `full` carries every accepted acceptance criterion, `partial` replaces named criteria only, and `adjacent` shares a theme but triggers no action;",
  fullDisposition:
    "for `full`, in the same registration pass close the predecessor as `duplicate` when scope is identical or `not planned` otherwise, with one comment naming the successor set;",
  partialDisposition:
    "for `partial`, in the same registration pass remove only the dropped criteria in place, then post one comment naming those criteria and the successor set, and never add `status:needs-replan`; the edited body takes the ordinary readiness check on its new revision before any further dispatch.",
  productQuestion:
    "if either class would drop accepted product scope, leave the predecessor unchanged and route one product question to Todd;",
  repairBoundary:
    "the `planning-repair/v1` boundary is unchanged: its input is a closed PR, and it is not the supersession route. When the predecessor is already in a planning-repair round, the supersession comment is input to that round, and a `REPLACED` original remains open as `status:tracking-only` until its replacements land. The `full`, `partial` and product-question rules above never apply to an issue's own repair replacements;",
  orphanedAcceptance:
    "a closed `not planned` or `duplicate` predecessor is orphaned when at least one issue names it `full` and every such successor is itself closed `not planned`;",
  filingHome:
    "every new non-Epic, including host and review follow-ups, gets a home after a duplicate search: a committed milestone, Candidate capabilities, or Operations for machine-generated incidents;",
  deferredTodd: "use `Deferred / Incubation` only on Todd's explicit deferral;",
});

function registrationSection(skill) {
  const anchors = [...skill.matchAll(/^7\. \*\*Registration\.\*\*/gm)];
  if (anchors.length !== 1) {
    throw new Error("registration-section-start-anchor-must-be-unique");
  }

  const sectionStart = anchors[0].index;
  const afterStart = skill.slice(sectionStart + registrationAnchor.length);
  const nextHeadingOffset = afterStart.search(/^## /m);
  if (nextHeadingOffset === -1) {
    throw new Error("registration-section-end-heading-required");
  }

  return skill.slice(sectionStart, sectionStart + registrationAnchor.length + nextHeadingOffset);
}

function removeRegistrationParentageRule(skill) {
  const ruleStart = skill.indexOf(`   - ${parentageRule.recordDisposition}`);
  const ruleEnd = skill.indexOf("\n   - every open slice classified", ruleStart);
  if (ruleStart === -1 || ruleEnd === -1) {
    throw new Error("registration-parentage-rule-required");
  }

  return {
    rule: skill.slice(ruleStart, ruleEnd),
    withoutRule: skill.slice(0, ruleStart) + skill.slice(ruleEnd),
  };
}

function activeMarkdown(markdown) {
  return markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

function occurrenceCount(source, value) {
  return source.split(value).length - 1;
}

function duplicateViolation(requirement) {
  return `duplicate${requirement[0].toUpperCase()}${requirement.slice(1)}`;
}

function registrationContractViolations(skill) {
  const section = registrationSection(activeMarkdown(skill));
  const missing = Object.entries(parentageRule)
    .filter(([, clause]) => occurrenceCount(section, clause) === 0)
    .map(([requirement]) => requirement);
  const duplicated = Object.entries(parentageRule)
    .filter(([, clause]) => occurrenceCount(section, clause) > 1)
    .map(([requirement]) => duplicateViolation(requirement));
  if (missing.length > 0 || duplicated.length > 0) return [...missing, ...duplicated];

  return section.indexOf(parentageRule.attachSuccessors) < section.indexOf(parentageRule.detachInSamePass)
    ? []
    : ["attachSuccessorsBeforeDetachment"];
}

function supersessionContractViolations(skill) {
  const active = activeMarkdown(skill);
  const discovery = active.slice(active.indexOf("2. **Discovery.**"), active.indexOf("3. **Decomposition.**"));
  const registration = registrationSection(active);
  const normalize = (value) => value.replace(/\s+/g, " ").trim();
  const searchable = `${normalize(discovery)} ${normalize(registration)}`;
  return Object.entries(supersessionRule)
    .filter(([, clause]) => !searchable.includes(normalize(clause)))
    .map(([requirement]) => requirement);
}

function removeWhitespaceInsensitive(source, value) {
  const escaped = value
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return source.replace(new RegExp(escaped), "");
}

describe("planning decomposition contract", () => {
  it("requires the complete supersession rule in Stage 7 Registration", () => {
    const skill = readFileSync(planningSkillPath, "utf8");

    expect(registrationContractViolations(skill)).toEqual([]);

    const { rule, withoutRule } = removeRegistrationParentageRule(skill);
    const relocated = withoutRule.replace("\n## Replan intake", `\n## Replan intake\n${rule}`);
    expect(relocated).toContain(rule);
    expect(registrationSection(relocated)).not.toContain(rule);
    expect(registrationContractViolations(relocated)).toEqual(Object.keys(parentageRule));

    const preAnchorRelocated = withoutRule.replace(
      registrationAnchor,
      `Incidental prose mentions ${registrationAnchor} but is not the Stage 7 line.\n${rule}\n${registrationAnchor}`,
    );
    expect(registrationSection(preAnchorRelocated)).not.toContain(rule);
    expect(registrationContractViolations(preAnchorRelocated)).toEqual(Object.keys(parentageRule));

    const commented = skill.replace(rule, `<!--\n${rule}\n-->`);
    expect(registrationContractViolations(commented)).toEqual(Object.keys(parentageRule));

    const wholeSectionCommented = skill.replace(registrationSection(skill), `<!--\n${registrationSection(skill)}\n-->`);
    expect(() => registrationContractViolations(wholeSectionCommented)).toThrow(
      "registration-section-start-anchor-must-be-unique",
    );

    const duplicated = skill.replace(rule, `${rule}\n${rule}`);
    expect(registrationContractViolations(duplicated)).toEqual(Object.keys(parentageRule).map(duplicateViolation));
  });

  it("fails closed when the Stage 7 boundaries are ambiguous or absent", () => {
    const skill = readFileSync(planningSkillPath, "utf8");

    expect(() => registrationSection(skill.replace(registrationAnchor, "7. **Register.**"))).toThrow(
      "registration-section-start-anchor-must-be-unique",
    );
    expect(() =>
      registrationSection(skill.replace(registrationAnchor, `${registrationAnchor}\n${registrationAnchor}`)),
    ).toThrow("registration-section-start-anchor-must-be-unique");
    expect(() => registrationSection(skill.replaceAll("\n## ", "\n### "))).toThrow(
      "registration-section-end-heading-required",
    );
  });

  it("rejects each missing detachment precondition and retention exception", () => {
    const skill = readFileSync(planningSkillPath, "utf8");

    for (const [requirement, clause] of Object.entries(parentageRule)) {
      expect(registrationContractViolations(skill.replace(clause, ""))).toEqual([requirement]);
    }
  });

  it("requires successor attachment before predecessor detachment", () => {
    const skill = readFileSync(planningSkillPath, "utf8");
    const reordered = skill.replace(
      `${parentageRule.attachSuccessors} ${parentageRule.detachInSamePass}`,
      `${parentageRule.detachInSamePass} ${parentageRule.attachSuccessors}`,
    );

    expect(registrationContractViolations(reordered)).toEqual(["attachSuccessorsBeforeDetachment"]);
  });

  it("requires open-issue discovery and the complete registration disposition contract", () => {
    const skill = readFileSync(planningSkillPath, "utf8");
    expect(supersessionContractViolations(skill)).toEqual([]);

    for (const [requirement, clause] of Object.entries(supersessionRule)) {
      expect(supersessionContractViolations(removeWhitespaceInsensitive(skill, clause))).toContain(requirement);
    }
  });
});

describe("repository routing", () => {
  const backlogModel = readFileSync(`${repoRoot}/docs/contributing/backlog-model.md`, "utf8");
  const skills = [".agents", ".claude"].map((root) =>
    readFileSync(`${repoRoot}/${root}/skills/planning/SKILL.md`, "utf8"),
  );

  it("states the rule once in the backlog model, before placement", () => {
    const rule = "### Repository routing\n\nAn issue lives in the repository its change merges into.";
    expect(occurrenceCount(backlogModel, rule)).toBe(1);
    expect(backlogModel.indexOf(rule)).toBeLessThan(backlogModel.indexOf("### Agents own placement and priority"));
    expect(backlogModel).toContain(
      "- An issue that changes no tracked file lives with the loop whose work it\n  serves.",
    );
  });

  it("starts the placement test with the repository", () => {
    expect(backlogModel).toContain(
      "Apply this placement test at intake:\n\n1. Identify the repository the change merges into (Repository routing). File\n   the issue there.\n2. Identify the issue's observable acceptance",
    );
  });

  it("routes planning intake and registration through the rule in both mirrors", () => {
    for (const skill of skills) {
      expect(skill).toContain(
        "1. **Intake.** Outcome statement, why-now, constraints, the repository each\n   issue's change merges into (`docs/contributing/backlog-model.md`,\n   Repository routing),",
      );
      expect(registrationSection(skill)).toContain(
        "7. **Registration.** Register each issue in the repository its change merges\n   into. A `chase-sets/chase-sets-controller` issue uses the same brief\n   standard and pressure test. Its milestone and release follow that\n   repository's controller-orchestrator skill. Create on GitHub",
      );
    }
  });

  it("states the closure and supersession contract in the backlog model", () => {
    const normalized = backlogModel.replace(/\s+/g, " ");
    for (const clause of [
      "with one comment naming the successor set; each successor names the predecessor in its `### Supersedes` section, and the planner never waits for a successor to land.",
      "at least one issue names it `full` and every such issue is itself closed `not planned`",
      "superseding an Epic takes a superseding comment, plus closure when it is `full`.",
    ]) {
      expect(normalized).toContain(clause);
    }
  });
});
