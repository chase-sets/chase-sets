import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractSelfReviewSection,
  MAX_SELF_REVIEW_SECTION_BYTES,
  selfReviewSectionErrors,
} from "./self-review-section-contract.mjs";

const skillPath = fileURLToPath(new URL("../../.agents/skills/delivery/SKILL.md", import.meta.url));
const section = extractSelfReviewSection(readFileSync(skillPath, "utf8"));

function replaceField(source, field) {
  return source.replace(new RegExp(`^${field}:.*$`, "m"), "");
}

describe("delivery self-review section contract", () => {
  it("validates the actual documented snippet", () => {
    expect(section).not.toBe("");
    expect(selfReviewSectionErrors(section)).toEqual([]);
  });

  it("rejects a missing heading and every missing required field", () => {
    expect(selfReviewSectionErrors(section.replace("## Self-review", "## Review"))).toContain("missing heading");
    for (const field of [
      "Dimensions passed",
      "Edits per dimension",
      "Enforcement pairs checked",
      "Reproduction and results",
      "Unverifiable assumptions",
    ]) {
      expect(selfReviewSectionErrors(replaceField(section, field))).toContain(`missing required field: ${field}`);
    }
  });

  it("accepts a legitimate section at the exact size boundary and rejects an oversize section", () => {
    const exactSize = `${section}${" ".repeat(MAX_SELF_REVIEW_SECTION_BYTES - Buffer.byteLength(section, "utf8"))}`;
    expect(Buffer.byteLength(exactSize, "utf8")).toBe(MAX_SELF_REVIEW_SECTION_BYTES);
    expect(selfReviewSectionErrors(exactSize)).toEqual([]);
    expect(selfReviewSectionErrors(`${exactSize}x`)).toContain("section exceeds 2048 bytes");
  });
});
