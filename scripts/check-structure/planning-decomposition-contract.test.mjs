import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const planningSkillPath = `${repoRoot}/.agents/skills/planning/SKILL.md`;

const parentageRule = Object.freeze({
  attachSuccessors:
    "when a replacement round dispositions a predecessor, first attach every\n" +
    "     successor that carries the parent's acceptance as a child of that parent;",
  verifyParentage:
    "only after every attached successor carries that parentage, detach the\n" +
    "     predecessor from the parent in the same registration pass.",
  retainWithoutSuccessor: "If no successor\n     is attached to the parent, keep the predecessor's parent link;",
});

function missingParentageRequirements(skill) {
  return Object.entries(parentageRule)
    .filter(([, clause]) => !skill.includes(clause))
    .map(([requirement]) => requirement);
}

describe("planning decomposition contract", () => {
  it("supersession detaches the predecessor link", () => {
    const skill = readFileSync(planningSkillPath, "utf8");

    expect(missingParentageRequirements(skill)).toEqual([]);

    const withoutException = skill.replace(parentageRule.retainWithoutSuccessor, "");
    expect(missingParentageRequirements(withoutException)).toEqual(["retainWithoutSuccessor"]);
  });

  it("registration checklist requires predecessor detachment", () => {
    const skill = readFileSync(planningSkillPath, "utf8");

    expect(missingParentageRequirements(skill)).toEqual([]);

    const withoutSamePassDetachment = skill.replace(parentageRule.verifyParentage, "");
    expect(missingParentageRequirements(withoutSamePassDetachment)).toEqual(["verifyParentage"]);
  });
});
