import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDocsIndex } from "./check-docs-index.mjs";

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-docs-index-"));
  temporaryRoots.push(rootDir);
  write(rootDir, "README.md", "- [Docs](docs/README.md)\n");
  write(rootDir, "docs/README.md", "# Docs\n");
  return rootDir;
}

function write(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { force: true, recursive: true });
  }
});

describe("checkDocsIndex", () => {
  it("reports Markdown files under docs that are unreachable from the docs indexes", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "docs/architecture/orphan.md", "# Orphan\n");

    await expect(checkDocsIndex({ repoRoot: rootDir })).resolves.toEqual({
      orphanDocs: ["docs/architecture/orphan.md"],
    });
  });

  it("treats docs linked through indexed docs as reachable", async () => {
    const rootDir = createTempRepo();
    write(rootDir, "docs/README.md", "- [Architecture](./architecture/root.md)\n");
    write(rootDir, "docs/architecture/root.md", "- [Leaf](./leaf.md)\n");
    write(rootDir, "docs/architecture/leaf.md", "# Leaf\n");

    await expect(checkDocsIndex({ repoRoot: rootDir })).resolves.toEqual({ orphanDocs: [] });
  });
});
