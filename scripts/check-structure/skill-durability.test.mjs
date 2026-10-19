import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const skillRoots = [".agents/skills", ".claude/skills"];

const DURABILITY_RULES = Object.freeze([
  { name: "ruling-comment-citation", pattern: /issuecomment-\d+|\b\d{4}\/\d{9,10}\b/gi },
  { name: "issue-state-condition", pattern: /\b(?:while|until|once|after)\s+(?:\[#\d+\]|#\d+)/gi },
  { name: "iso-date", pattern: /\b20\d{2}-\d{2}-\d{2}\b/g },
  { name: "exact-model-selector", pattern: /\b(?:gpt-\d[\w.-]*|claude-(?:opus|sonnet|haiku|fable)-\d[\w.-]*)\b/gi },
  { name: "version-qualified-model-family", pattern: /\b(?:Opus|Sonnet|Haiku|Fable|Sol|Luna|Astra|GPT)[ -]?\d[\w.-]*/gi },
]);

function candidateFiles(root) {
  return readdirSync(join(repoRoot, root), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(root, relative(join(repoRoot, root), join(entry.parentPath, entry.name))))
    .sort();
}

function scanText(text, filePath) {
  const findings = [];
  for (const rule of DURABILITY_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      findings.push({ file: filePath, line, class: rule.name, match: match[0] });
    }
  }
  return findings.sort((left, right) => left.line - right.line || left.class.localeCompare(right.class));
}

export function scanSkillTexts(files) {
  return files.flatMap(({ file, text }) => scanText(text, file));
}

export function scanSkillFiles() {
  const files = skillRoots.flatMap(candidateFiles);
  const findings = scanSkillTexts(files.map((file) => ({ file, text: readFileSync(join(repoRoot, file), "utf8") })));
  return { findings, scannedFiles: files.length, totalCandidateFiles: files.length };
}

describe("skill durability guard", () => {
  it("scans every skill file and reports no ruling, state, date, or model drift", () => {
    const result = scanSkillFiles();
    expect(result.scannedFiles).toBeGreaterThan(0);
    expect(result.scannedFiles).toBe(result.totalCandidateFiles);
    expect(result.findings, `scanned/total candidate files: ${result.scannedFiles}/${result.totalCandidateFiles}`).toEqual([]);
  });

  it.each([
    ["ruling-comment-citation", "See https://github.com/chase-sets/chase-sets/issues/4388#issuecomment-5838576100."],
    ["issue-state-condition", "While [#8159](https://github.com/chase-sets/chase-sets/issues/8159) is open."],
    ["iso-date", "Review this rule by 2026-09-01."],
    ["exact-model-selector", "Dispatch a gpt-6-luna/medium participant."],
    ["version-qualified-model-family", "Use the Sol 6 model."],
  ])("rejects the historical %s shape at its real path", (expectedClass, text) => {
    const source = readFileSync(join(repoRoot, ".agents/skills/delivery/SKILL.md"), "utf8");
    const findings = scanSkillTexts([{ file: ".agents/skills/delivery/SKILL.md", text: `${source}\n${text}` }]);
    expect(findings.map((finding) => finding.class)).toContain(expectedClass);
  });

  it("rejects a violation planted at a new Claude skill path", () => {
    const findings = scanSkillTexts([{ file: ".claude/skills/new-skill/example.txt", text: "After #1234, use GPT 6." }]);
    expect(findings.map((finding) => finding.class)).toEqual(
      expect.arrayContaining(["issue-state-condition", "version-qualified-model-family"]),
    );
  });
});
