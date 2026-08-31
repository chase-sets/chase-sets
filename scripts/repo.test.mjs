import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWorkspaceRootsCoverPackageDirectories,
  contextManifestContributesToApiHost,
  listBoundedContextManifests,
  listContextManifests,
  listWorkspacePackages,
} from "./lib/repo.mjs";
import { ensureWorktreeSandboxEnvironment, resolveWorktreeSandbox } from "./lib/sandbox.mjs";

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

function writePackage(rootDir, workspaceRoot, dirName, packageJson) {
  const packageDir = path.join(rootDir, workspaceRoot, dirName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "package.json"), `${JSON.stringify(packageJson)}\n`);
}

function writeManifestOnlyContext(rootDir, dirName, manifest) {
  const contextDir = path.join(rootDir, "bounded-contexts", dirName);
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(path.join(contextDir, "context.json"), `${JSON.stringify(manifest)}\n`);
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

describe("contextManifestContributesToApiHost", () => {
  it.each([
    ["apiDeployables", { apiDeployables: ["neutral-api"] }, { apiDeployables: ["sibling-api"] }],
    [
      "sourceRuntimeDeployables",
      { sourceRuntimeDeployables: ["neutral-api"] },
      { sourceRuntimeDeployables: ["sibling-api"] },
    ],
    ["sourceRuntimeProfiles", { sourceRuntimeProfiles: ["neutral-profile"] }, { sourceRuntimeProfiles: [] }],
  ])("api-host-ownership-predicate-parity admits %s and its exit mutant does not", (_shape, admitted, exited) => {
    const manifest = { contextName: "neutral-owner", ...admitted };

    expect(contextManifestContributesToApiHost(manifest, "neutral-api")).toBe(true);
    expect(contextManifestContributesToApiHost({ ...manifest, ...exited }, "neutral-api")).toBe(false);
  });

  it("excludes a behavior-free manifest and contributions to a different API host", () => {
    expect(contextManifestContributesToApiHost({ contextName: "neutral-foundation" }, "neutral-api")).toBe(false);
    expect(
      contextManifestContributesToApiHost(
        { contextName: "neutral-sibling", apiDeployables: ["sibling-api"] },
        "neutral-api",
      ),
    ).toBe(false);
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

  it("reports package directories skipped because package.json is missing a name", () => {
    const rootDir = createTempRepo();
    writePackage(rootDir, "packages", "named", { name: "@chase-sets/named" });
    writePackage(rootDir, "packages", "nameless", { private: true });
    const skipped = [];

    const workspaces = listWorkspacePackages({
      repoRoot: rootDir,
      onSkippedWorkspace: (workspace) => skipped.push(workspace),
    });

    expect(workspaces.map((workspace) => workspace.name)).toEqual(["@chase-sets/named"]);
    expect(skipped).toEqual([
      expect.objectContaining({
        packageJsonPath: path.join(rootDir, "packages", "nameless", "package.json"),
        reason: "package.json is missing a non-empty name",
      }),
    ]);
  });

  it("fails when a top-level package root is not represented in workspaceRoots", () => {
    const rootDir = createTempRepo();
    writePackage(rootDir, "services", "worker", { name: "@chase-sets/worker" });

    expect(() => assertWorkspaceRootsCoverPackageDirectories({ repoRoot: rootDir })).toThrow(
      "workspaceRoots is missing top-level package root(s): services.",
    );
  });
});

describe("listBoundedContextManifests", () => {
  it("api-host-owner-admission-parity admits only package+manifest contexts, sorted, and matches the sandbox and registry entry points", () => {
    const rootDir = createTempRepo();
    writeContext(rootDir, "zulu-owner", { contextName: "zulu-owner", apiDeployables: ["platform-api"] });
    writeContext(rootDir, "alpha-behavior-free", { contextName: "alpha-behavior-free" });
    writeManifestOnlyContext(rootDir, "manifest-only-contributor", {
      contextName: "manifest-only-contributor",
      apiDeployables: ["platform-api"],
    });
    writeGhostDirectory(rootDir, "bounded-contexts", "neutral-ghost");

    const contexts = listBoundedContextManifests({ repoRoot: rootDir });

    // manifest-only-contributor and the ghost directory are excluded: only
    // directories with BOTH a workspace package.json and a context.json are
    // admitted as implemented bounded contexts.
    expect(contexts.map((context) => context.contextName)).toEqual(["alpha-behavior-free", "zulu-owner"]);

    const apiOwners = contexts
      .filter((context) => contextManifestContributesToApiHost(context.manifest, "platform-api"))
      .map((context) => context.contextName);
    expect(apiOwners).toEqual(["zulu-owner"]);

    const sandboxOwners = resolveWorktreeSandbox({ rootDir, env: {} }).contextNames;
    expect(sandboxOwners).toEqual(apiOwners);

    const registryOwners = listBoundedContextManifests({
      repoRoot: rootDir,
      workspaces: listWorkspacePackages({ repoRoot: rootDir }),
    })
      .filter((context) => contextManifestContributesToApiHost(context.manifest, "platform-api"))
      .map((context) => context.contextName);
    expect(registryOwners).toEqual(sandboxOwners);
  });

  it("fails closed for a real package workspace with a missing manifest", () => {
    const rootDir = createTempRepo();
    writePackage(rootDir, "bounded-contexts", "package-only-context", {
      name: "@chase-sets/package-only-context",
    });

    expect(() => listBoundedContextManifests({ repoRoot: rootDir })).toThrow();
    expect(() =>
      listBoundedContextManifests({ repoRoot: rootDir, workspaces: listWorkspacePackages({ repoRoot: rootDir }) }),
    ).toThrow();
    expect(() => ensureWorktreeSandboxEnvironment({ rootDir, env: {} })).toThrow();
    expect(existsSync(path.join(rootDir, ".env.sandbox.local"))).toBe(false);
  });

  it("fails closed for a real package workspace with a malformed manifest", () => {
    const rootDir = createTempRepo();
    const contextDir = path.join(rootDir, "bounded-contexts", "malformed-context");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(
      path.join(contextDir, "package.json"),
      `${JSON.stringify({ name: "@chase-sets/malformed-context" })}\n`,
    );
    writeFileSync(path.join(contextDir, "context.json"), '{"contextName":\n');

    expect(() => listBoundedContextManifests({ repoRoot: rootDir })).toThrow(SyntaxError);
    expect(() =>
      listBoundedContextManifests({ repoRoot: rootDir, workspaces: listWorkspacePackages({ repoRoot: rootDir }) }),
    ).toThrow(SyntaxError);
    expect(() => ensureWorktreeSandboxEnvironment({ rootDir, env: {} })).toThrow(SyntaxError);
    expect(existsSync(path.join(rootDir, ".env.sandbox.local"))).toBe(false);
  });

  it.each([null, {}, { contextName: 42 }, { contextName: "" }])(
    "rejects malformed context identity %j before environment publication",
    (manifest) => {
      const rootDir = createTempRepo();
      writeContext(rootDir, "invalid", manifest);
      expect(() => listBoundedContextManifests({ repoRoot: rootDir })).toThrow(/contextName/);
      expect(() =>
        listBoundedContextManifests({ repoRoot: rootDir, workspaces: listWorkspacePackages({ repoRoot: rootDir }) }),
      ).toThrow(/contextName/);
      expect(() => ensureWorktreeSandboxEnvironment({ rootDir, env: {} })).toThrow(/contextName/);
      expect(existsSync(path.join(rootDir, ".env.sandbox.local"))).toBe(false);
    },
  );
});
