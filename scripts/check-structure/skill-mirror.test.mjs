import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Repo skills are tracked at both .agents/skills/ (the Agent Skills standard
// path, read by Codex lanes) and .claude/skills/ (read by Claude lanes)
// because Claude Code does not read .agents/skills yet; git symlinks are
// unreliable on Windows checkouts, so the copies are plain files and this
// guard keeps them from drifting. Every .md file in a skill directory is
// mirrored (SKILL.md plus references/); non-markdown files like
// agents/openai.yaml are Codex-specific and stay unmirrored. Once Claude Code
// supports .agents/skills, collapse the mirror and delete this guard.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const agentsSkillsDir = join(repoRoot, ".agents", "skills");
const claudeSkillsDir = join(repoRoot, ".claude", "skills");

function agentsSkillNames() {
  if (!existsSync(agentsSkillsDir)) return [];
  return readdirSync(agentsSkillsDir, { withFileTypes: true })
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
  it("mirrors every .agents skill's markdown byte-identically under .claude/skills", () => {
    const names = agentsSkillNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const agentsDir = join(agentsSkillsDir, name);
      const claudeDir = join(claudeSkillsDir, name);
      const files = markdownFilesUnder(agentsDir);
      expect(files, `no markdown found in .agents/skills/${name}`).toContain("SKILL.md");
      for (const file of files) {
        const claudePath = join(claudeDir, file);
        expect(existsSync(claudePath), `missing .claude/skills/${name}/${file}`).toBe(true);
        const agentsContent = readFileSync(join(agentsDir, file), "utf8");
        const claudeContent = readFileSync(claudePath, "utf8");
        expect(claudeContent, `drift in ${name}/${file} — edit both copies in the same PR`).toBe(agentsContent);
      }
    }
  });
});
