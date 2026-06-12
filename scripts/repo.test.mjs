import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listContextManifests, listWorkspacePackages } from "./lib/repo.mjs";

const temporaryRoots = [];

function createTempRepo() {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "chase-sets-repo-"));
  temporaryRoots.push(rootDir);
  return rootDir;
}

function writeContext(rootDir, dirName, manifest) {
  const contextDir = path.join(rootDir, "bounded-contexts", dirName);
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(path.join(contextDir, "context.json"), `${JSON.stringify(manifest)}\n`);
  writeFileSync(path.join(contextDir, "package.json"), `${JSON.stringify({ name: `@chase-sets/${dirName}` })}\n`);
}

function writeGhostDirectory(rootDir, workspaceRoot, dirName) {
  // Switching branches in a git worktree removes a deleted workspace's tracked
  // files but leaves the directory behind when ignored files (node_modules)
  // remain inside it, even though git status reports a clean checkout.
  const ghostDir = path.join(rootDir, workspaceRoot, dirName, "node_modules", ".pnpm");
  mkdirSync(ghostDir, { recursive: true });
  writeFileSync(path.join(ghostDir, "lock.yaml"), "");
}

afterEach(() => {
  for (const rootDir of temporaryRoots.splice(0)) {
    rmSync(rootDir, { force: true, recursive: true });
  }
});

describe("listContextManifests", () => {
  it("lists implemented contexts with parsed manifests sorted by directory name", () => {
    const rootDir = createTempRepo();
    writeContext(rootDir, "marketplace", { contextName: "marketplace", apiDeployables: ["platform-api"] });
    writeContext(rootDir, "catalog", { contextName: "catalog" });

    const contexts = listContextManifests({ repoRoot: rootDir });

    expect(contexts.map((context) => context.dirName)).toEqual(["catalog", "marketplace"]);
    expect(contexts[1].manifest.apiDeployables).toEqual(["platform-api"]);
  });

  it("skips worktree ghost context directories that hold only node_modules", () => {
    const rootDir = createTempRepo();
    writeContext(rootDir, "catalog", { contextName: "catalog" });
    writeGhostDirectory(rootDir, "bounded-contexts", "experience");

    expect(listContextManifests({ repoRoot: rootDir }).map((context) => context.dirName)).toEqual(["catalog"]);
  });

  it("returns an empty list when bounded-contexts does not exist", () => {
    expect(listContextManifests({ repoRoot: createTempRepo() })).toEqual([]);
  });
});

describe("listWorkspacePackages", () => {
  it("skips worktree ghost workspace directories that hold only node_modules", () => {
    const rootDir = createTempRepo();
    writeContext(rootDir, "catalog", { contextName: "catalog" });
    writeGhostDirectory(rootDir, "contracts", "tax");
    writeGhostDirectory(rootDir, "deployables", "insights-web");

    const workspaces = listWorkspacePackages({ repoRoot: rootDir });

    expect(workspaces.map((workspace) => workspace.name)).toEqual(["@chase-sets/catalog"]);
  });
});
