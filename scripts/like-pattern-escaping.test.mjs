import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceRoots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages", "scripts"];
const sourceFilePattern = /\.(?:ts|tsx|mts|mjs)$/;
const ignoredPathParts = new Set(["node_modules", "dist", "coverage", ".react-router"]);
const unescapedContainsPattern = /`%(\$\{(?!escapeLikePattern\()[^}]+\})%`/g;

describe("LIKE pattern escaping guard", () => {
  it("keeps template-literal contains search patterns behind escapeLikePattern", () => {
    const violations = productionSourceFiles()
      .flatMap((filePath) => {
        const source = readFileSync(filePath, "utf8");
        return [...source.matchAll(unescapedContainsPattern)].map((match) => ({
          filePath,
          snippet: match[0],
        }));
      })
      .map(({ filePath, snippet }) => `${path.relative(repoRoot, filePath)}: ${snippet}`);

    expect(violations).toEqual([]);
  });
});

function productionSourceFiles() {
  return sourceRoots
    .flatMap((root) => walk(path.join(repoRoot, root)))
    .filter((filePath) => {
      if (!sourceFilePattern.test(filePath)) {
        return false;
      }
      const basename = path.basename(filePath);
      return !basename.includes(".test.") && !basename.includes(".spec.");
    });
}

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ignoredPathParts.has(entry.name) ? [] : walk(fullPath);
    }
    if (entry.isFile()) {
      return [fullPath];
    }
    if (entry.isSymbolicLink()) {
      return statSync(fullPath).isDirectory() ? walk(fullPath) : [fullPath];
    }
    return [];
  });
}
