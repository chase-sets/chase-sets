import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRIEF_MAX_BYTES, lintBrief, main } from "./brief-lint.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ruleLines = [
  "is at most about 12 KB of body; anything larger splits into sub-issues with native sub-issue links;",
  "carries no collision census. Collision is a controller concern, resolved from GitHub native relationships and the board, not restated in prose;",
  "lists at most five don't-rebuild pointers, each a path or symbol, not a narrative;",
  "never designates a live draft PR as read-only salvage. A reviewed draft PR is always the implementation head for its issue; salvage applies only to a branch with no push in seven days;",
  "states acceptance as observable outcomes with the proving check named once, and repeats no policy that the orchestrator or review contract already owns.",
];

function codes(body) {
  return lintBrief(body).findings.map((finding) => finding.code);
}

describe("brief body byte limit", () => {
  it("accepts exactly 12 × 1024 UTF-8 bytes and rejects one byte more", () => {
    expect(lintBrief("a".repeat(BRIEF_MAX_BYTES))).toMatchObject({ bytes: BRIEF_MAX_BYTES, findings: [] });
    expect(codes("a".repeat(BRIEF_MAX_BYTES + 1))).toContain("BRIEF_BODY_BYTES");
  });

  it("measures a Unicode boundary in UTF-8 bytes rather than JavaScript characters", () => {
    const exact = `${"a".repeat(BRIEF_MAX_BYTES - 4)}💡`;
    expect(exact.length).toBeLessThan(BRIEF_MAX_BYTES);
    expect(lintBrief(exact)).toMatchObject({ bytes: BRIEF_MAX_BYTES, findings: [] });
    expect(codes(`${exact}a`)).toContain("BRIEF_BODY_BYTES");
  });
});

describe("collision census sections", () => {
  it.each(["## Collision census\n\n- scripts/a.mjs", "File-collision census\n---------------------\n\nnone"])(
    "rejects a census section expressed with Markdown headings",
    (body) => expect(codes(body)).toContain("BRIEF_COLLISION_CENSUS"),
  );

  it("allows ordinary prose that mentions the concept", () => {
    expect(
      codes("Collision risk is controller-owned; a collision census does not belong in this brief."),
    ).not.toContain("BRIEF_COLLISION_CENSUS");
  });
});

describe("don't-rebuild pointers", () => {
  const pointerSection = (count) =>
    [
      "### Don't-rebuild pointers",
      "",
      ...Array.from({ length: count }, (_, index) => `- \`scripts/prior-${index}.mjs\``),
    ].join("\n");

  it("accepts five path or symbol pointers and rejects six", () => {
    expect(codes(pointerSection(5))).toEqual([]);
    expect(codes(pointerSection(6))).toContain("BRIEF_DONT_REBUILD_POINTER_COUNT");
  });

  it("counts pointers across repeated don't-rebuild sections", () => {
    const body = `${pointerSection(3)}\n\n## Scope\n\nBounded.\n\n${pointerSection(3)}`;
    expect(codes(body)).toContain("BRIEF_DONT_REBUILD_POINTER_COUNT");
  });

  it("rejects narrative masquerading as a pointer", () => {
    expect(codes("Don't-rebuild pointers:\n\n- Reuse the old script because it already works.")).toContain(
      "BRIEF_DONT_REBUILD_POINTER_FORMAT",
    );
  });
});

describe("salvage wording", () => {
  it("rejects a live draft PR designated as read-only salvage", () => {
    expect(codes("Use live draft PR #42 as read-only salvage.")).toContain("BRIEF_LIVE_DRAFT_SALVAGE");
  });

  it("requires an affirmative salvage branch designation to carry the seven-day no-push fact", () => {
    expect(codes("Salvage branch: `feature/old`.")).toContain("BRIEF_SALVAGE_BRANCH_STALENESS");
    expect(codes("Salvage branch: `feature/old`, with no push in seven days.")).toEqual([]);
  });

  it("allows compliant policy prose and read-only historical artifacts", () => {
    const body = [
      "A reviewed draft PR remains the implementation head; salvage applies only to a stale branch.",
      "The closed PR #41 is a read-only historical artifact.",
      "Salvage: none.",
    ].join("\n\n");
    expect(codes(body)).toEqual([]);
  });
});

describe("planning integration", () => {
  it("carries the ruled limits verbatim in both skill mirrors and the slice template", () => {
    const paths = [
      ".agents/skills/planning/SKILL.md",
      ".claude/skills/planning/SKILL.md",
      ".github/ISSUE_TEMPLATE/slice.yml",
    ];
    for (const relativePath of paths) {
      const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
      for (const line of ruleLines) expect(source).toContain(line);
      expect(source.replace(/\s+/g, " ")).toContain("12 × 1024 = 12,288 UTF-8 bytes");
    }
  });

  it("invokes the lint from the planning skill without adding a package script", () => {
    const source = readFileSync(path.join(repoRoot, ".agents/skills/planning/SKILL.md"), "utf8");
    expect(source).toContain("node ./scripts/brief-lint.mjs <path-to-brief.md>");
  });

  it("returns a discriminating CLI status", async () => {
    const logs = [];
    const logger = { error: (message) => logs.push(message), log: (message) => logs.push(message) };
    await expect(main({ argv: ["brief.md"], load: async () => "# Context\n\nBounded.", logger })).resolves.toBe(0);
    await expect(main({ argv: ["brief.md"], load: async () => "# Collision census\n", logger })).resolves.toBe(1);
    expect(logs).toEqual([
      expect.stringContaining("Brief lint passed"),
      expect.stringContaining("BRIEF_COLLISION_CENSUS"),
    ]);
  });
});
