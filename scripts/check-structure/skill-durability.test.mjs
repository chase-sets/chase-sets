import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const skillRoots = [".agents/skills", ".claude/skills"];

const DURABILITY_RULES = Object.freeze([
  { name: "ruling-comment-citation", pattern: /issuecomment-\d+|\b\d{4}\/\d{9,10}\b/gi },
  { name: "issue-state-condition", pattern: /\b(?:while|until|once|after)\s+(?:\[#\d+\]|#\d+)/gi },
  { name: "iso-date", pattern: /\b20\d{2}-\d{2}-\d{2}\b/g },
  { name: "exact-model-selector", pattern: /\b(?:gpt-\d[\w.-]*|claude-(?:opus|sonnet|haiku|fable)-\d[\w.-]*)\b/gi },
  {
    name: "version-qualified-model-family",
    pattern: /\b(?:Opus|Sonnet|Haiku|Fable|Sol|Luna|Astra|GPT)[ -]?\d[\w.-]*/gi,
  },
]);

function candidateFiles(baseDir, root) {
  const rootDir = join(baseDir, root);
  return readdirSync(rootDir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(root, relative(rootDir, join(entry.parentPath, entry.name))))
    .sort();
}

function countCandidateFiles(baseDir, root) {
  return readdirSync(join(baseDir, root), { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile())
    .length;
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

function scanSkillTexts(files) {
  return files.flatMap(({ file, text }) => scanText(text, file));
}

function scanSkillFiles(baseDir = repoRoot) {
  const files = skillRoots.flatMap((root) => candidateFiles(baseDir, root));
  const findings = scanSkillTexts(files.map((file) => ({ file, text: readFileSync(join(baseDir, file), "utf8") })));
  const totalCandidateFiles = skillRoots.reduce((total, root) => total + countCandidateFiles(baseDir, root), 0);
  return { findings, scannedFiles: files.length, totalCandidateFiles };
}

// Complete historical lines from cd1bdae3571a21c9df1db84b123f87f34cd49ce3.
const historicalBrowserLine =
  "For a new or changed user-facing flow, use `pnpm run ops browser:usability select --base origin/main` to identify advisory goals, then follow `docs/contributing/browser-usability.md`. Dispatch a fresh goal-only `gpt-6-luna/medium` participant without implementation context; use screenshot-grounded navigation, the code-owned timer/action recorder, an isolated preflighted fixture, and a separate moderator outcome check. Do not use the participant's completion label as a pass. Report the adjudicated result and timing in Verification, or explicitly record not-run coverage and why. Unmapped flows need a relevant goal or an explicit coverage note. Hosted gates and independent code review remain authoritative; an unavailable local browser/sandbox is not a publication or readiness gate. Reproduced defects follow existing severity rules and get deterministic regression coverage.";
const historicalDateLine = "    ledger defect classes remain covered; review this rule by 2026-09-01.";
const historicalControls = [
  {
    name: "ruling-comment-citation",
    file: ".agents/skills/delivery/SKILL.md",
    text: "  [production credential custody](https://github.com/chase-sets/chase-sets/issues/4388#issuecomment-6114225296),",
    diagnostics: [{ class: "ruling-comment-citation", match: "issuecomment-6114225296" }],
  },
  {
    name: "issue-state-condition",
    file: ".agents/skills/delivery/SKILL.md",
    text: "- For database-touching changes, the normal final-head hosted `DB Profile Tests` job is the DB proof ([#4388 ruling](https://github.com/chase-sets/chase-sets/issues/4388#issuecomment-5838576100)). While [#8159](https://github.com/chase-sets/chase-sets/issues/8159) is open, a full local `verify:test-db` is never a prerequisite for push, draft, ready or landing. When a brief still names one, take the hosted substitution and disclose it in the PR body. Focused local `test:db` runs for the touched files remain useful diagnostics. Hosted gates, timeouts, skips and reviews are unchanged.",
    diagnostics: [
      { class: "issue-state-condition", match: "While [#8159]" },
      { class: "ruling-comment-citation", match: "issuecomment-5838576100" },
    ],
  },
  {
    name: "iso-date",
    file: ".agents/skills/planning/references/pressure-test.md",
    text: historicalDateLine,
    diagnostics: [{ class: "iso-date", match: "2026-09-01" }],
  },
  {
    name: "model-selector-and-family",
    file: ".agents/skills/delivery/SKILL.md",
    text: historicalBrowserLine,
    diagnostics: [
      { class: "exact-model-selector", match: "gpt-6-luna" },
      { class: "version-qualified-model-family", match: "gpt-6-luna" },
    ],
  },
];

describe("skill durability guard", () => {
  it("scans every skill file and reports no ruling, state, date, or model drift", () => {
    const result = scanSkillFiles();
    expect(result.scannedFiles).toBeGreaterThan(0);
    const surface = `scanned/total candidate files: ${result.scannedFiles}/${result.totalCandidateFiles}`;
    expect(result.findings, surface).toEqual([]);
    process.stdout.write(`${surface}\n`);
  });

  it.each(historicalControls)("rejects the historical $name line at its real path", ({ file, text, diagnostics }) => {
    const source = readFileSync(join(repoRoot, file), "utf8").trimEnd();
    const line = source.split(/\r?\n/).length + 1;
    const findings = scanSkillTexts([{ file, text: `${source}\n${text}\n` }]);
    expect(findings).toEqual(diagnostics.map((diagnostic) => ({ file, line, ...diagnostic })));
  });

  it("rejects a violation planted at a new Claude skill path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "skill-durability-"));
    const file = join(".claude/skills", "new-skill", "example.txt");
    try {
      mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
      mkdirSync(join(tempDir, ".claude", "skills", "new-skill"), { recursive: true });
      writeFileSync(join(tempDir, file), historicalDateLine);
      const result = scanSkillFiles(tempDir);
      expect(result.findings).toEqual([{ file, line: 1, class: "iso-date", match: "2026-09-01" }]);
      expect(result.scannedFiles).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("allows plain historical issue references and row identifiers", () => {
    const findings = scanSkillTexts([
      {
        file: ".agents/skills/planning/references/pressure-test.md",
        text: "Historical incidents: #5811, #5883, #6058, #6105, #6106, #5684. Quality Packet: #7716, #7737; row-8.",
      },
    ]);
    expect(findings).toEqual([]);
  });
});
