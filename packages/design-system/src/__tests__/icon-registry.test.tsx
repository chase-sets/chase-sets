import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as glyphs from "lucide-react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, type IconName } from "../icons";

const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const iconPath = "packages/design-system/src/icons/index.tsx";

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function bindings(source: string) {
  const map = source.match(/const iconMap: Record<IconName, LucideIcon> = \{([\s\S]*?)\n\};/);
  expect(map).not.toBeNull();
  return Object.fromEntries([...map![1].matchAll(/^\s+(\w+): (\w+),$/gm)].map((match) => [match[1], match[2]]));
}

function names(source: string) {
  const union = source.match(/export type IconName =([\s\S]*?);/);
  expect(union).not.toBeNull();
  return [...union![1].matchAll(/"(\w+)"/g)].map((match) => match[1]).sort();
}

describe("icon registry", () => {
  it("maps flag to a rendered glyph without changing any existing icon binding", () => {
    expect(renderToString(<Icon name="flag" />)).toContain("<svg");
    expect(Icon({ name: "flag" }).props.children.type).toBe(glyphs.Flag);

    const forkPoint = git("merge-base", "HEAD", "refs/remotes/origin/main");
    const originalSource = git("show", `${forkPoint}:${iconPath}`);
    const candidateSource = readFileSync(join(repositoryRoot, iconPath), "utf8");
    const originalBindings = bindings(originalSource);
    const candidateBindings = bindings(candidateSource);
    expect(Object.keys(originalBindings).length).toBeGreaterThan(0);
    expect(names(candidateSource)).toEqual([...names(originalSource), "flag"].sort());
    expect(candidateBindings).toEqual({ ...originalBindings, flag: "Flag" });
    for (const [name, glyph] of Object.entries(originalBindings)) {
      expect(Icon({ name: name as IconName }).props.children.type, name).toBe(glyphs[glyph as keyof typeof glyphs]);
    }

    // A synthetic unknown name must remain undefined, never acquire a fallback.
    const syntheticName = "__unmapped_icon_probe__" as IconName;
    expect(Icon({ name: syntheticName }).props.children.type).toBeUndefined();
    expect(() => renderToString(<Icon name={syntheticName} />)).toThrow("Element type is invalid");
  });
});
