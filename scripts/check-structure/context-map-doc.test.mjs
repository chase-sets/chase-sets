import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { listContextManifests, repoRoot } from "../lib/repo.mjs";

it("context map lists every context", () => {
  const map = readFileSync(path.join(repoRoot, "bounded-contexts/README.md"), "utf8");
  const table = map.match(/^## Contexts\r?\n\r?\n((?:\|[^\r\n]*(?:\r?\n|$))+)/m)?.[1] ?? "";
  const links = table
    .trimEnd()
    .split(/\r?\n/)
    .slice(2)
    .flatMap((row) => {
      const targets = Array.from(row.matchAll(/\[[^\]]+\]\(([^)]+)\)/g), ([, target]) => target);
      expect(targets, row).toHaveLength(1);
      return targets;
    });
  const contexts = listContextManifests();

  expect(links.sort()).toEqual(contexts.map(({ dirName }) => `./${dirName}/README.md`).sort());
  for (const { dir, dirName } of contexts) {
    expect(statSync(path.join(dir, "README.md"), { throwIfNoEntry: false })?.isFile(), `${dirName}/README.md`).toBe(
      true,
    );
  }
});

it("R40 documents the exact link-intent integration export", () => {
  const guide = readFileSync(path.join(repoRoot, "docs/architecture/bounded-context-structure.md"), "utf8");
  const rule = guide.split(/\r?\n/).find((line) => line.startsWith("| R40 "));

  expect(rule).toContain("`./integration/link-intents`");
});
