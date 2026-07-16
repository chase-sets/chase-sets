import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Repo skills are tracked at both .codex/skills/ (Codex lanes) and
// .claude/skills/ (Claude lanes) because each harness only reads its own
// directory; git symlinks are unreliable on Windows checkouts, so the copies
// are plain files and this guard keeps them from drifting. Every .md file in a
// skill directory is mirrored (SKILL.md plus references/); non-markdown files
// like agents/openai.yaml are Codex-specific and stay unmirrored.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const codexSkillsDir = join(repoRoot, ".codex", "skills");
const claudeSkillsDir = join(repoRoot, ".claude", "skills");

function codexSkillNames() {
  if (!existsSync(codexSkillsDir)) return [];
  return readdirSync(codexSkillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function markdownFilesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
}

describe("skill mirror guard", () => {
  it("mirrors every .codex skill's markdown byte-identically under .claude/skills", () => {
    const names = codexSkillNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const codexDir = join(codexSkillsDir, name);
      const claudeDir = join(claudeSkillsDir, name);
      const files = markdownFilesUnder(codexDir);
      expect(files, `no markdown found in .codex/skills/${name}`).toContain("SKILL.md");
      for (const file of files) {
        const claudePath = join(claudeDir, file);
        expect(existsSync(claudePath), `missing .claude/skills/${name}/${file}`).toBe(true);
        const codexContent = readFileSync(join(codexDir, file), "utf8");
        const claudeContent = readFileSync(claudePath, "utf8");
        expect(claudeContent, `drift in ${name}/${file} — edit both copies in the same PR`).toBe(codexContent);
      }
    }
  });
});
