import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Repo skills are tracked at both .codex/skills/ (Codex lanes) and
// .claude/skills/ (Claude lanes) because each harness only reads its own
// directory; git symlinks are unreliable on Windows checkouts, so the copies
// are plain files and this guard keeps them from drifting.
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

describe("skill mirror guard", () => {
  it("mirrors every .codex skill's SKILL.md byte-identically under .claude/skills", () => {
    const names = codexSkillNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const claudePath = join(claudeSkillsDir, name, "SKILL.md");
      expect(existsSync(claudePath), `missing .claude/skills/${name}/SKILL.md`).toBe(true);
      const codexContent = readFileSync(join(codexSkillsDir, name, "SKILL.md"), "utf8");
      const claudeContent = readFileSync(claudePath, "utf8");
      expect(claudeContent, `SKILL.md drift for ${name} — edit both copies in the same PR`).toBe(codexContent);
    }
  });
});
