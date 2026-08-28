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

function registrationSection(skill) {
  const anchors = skill.match(/^7\. \*\*Registration\.\*\*/gm) ?? [];
  if (anchors.length !== 1) {
    throw new Error("registration-section-start-anchor-must-be-unique");
  }

  const sectionStart = skill.indexOf(registrationAnchor);
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

function registrationContractViolations(skill) {
  const section = registrationSection(skill);
  const missing = Object.entries(parentageRule)
    .filter(([, clause]) => !section.includes(clause))
    .map(([requirement]) => requirement);
  if (missing.length > 0) return missing;

  return section.indexOf(parentageRule.attachSuccessors) < section.indexOf(parentageRule.detachInSamePass)
    ? []
    : ["attachSuccessorsBeforeDetachment"];
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
});
