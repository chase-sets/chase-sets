import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const workspaceRoots = ["bounded-contexts", "contracts", "infrastructure", "packages", "deployables"];

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function readDir(rootPath) {
  return existsSync(rootPath) ? readdirSync(rootPath, { withFileTypes: true }) : [];
}

export function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

export function listContextManifests(options = {}) {
  const rootDir = options.repoRoot ?? repoRoot;
  const contextsDir = path.join(rootDir, "bounded-contexts");

  return (
    readDir(contextsDir)
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        dirName: entry.name,
        dir: path.join(contextsDir, entry.name),
        manifestPath: path.join(contextsDir, entry.name, "context.json"),
      }))
      // Switching branches in a git worktree leaves ghost context directories
      // behind when only ignored files (node_modules) remain inside them; a
      // directory is a context only when its tracked manifest exists.
      .filter((context) => existsSync(context.manifestPath))
      .map((context) => ({ ...context, manifest: readJson(context.manifestPath) }))
      .sort((left, right) => left.dirName.localeCompare(right.dirName, "en"))
  );
}

export function normalizeRelative(filePath, fromRoot = repoRoot) {
  return normalizePath(path.relative(fromRoot, filePath));
}

export function listWorkspacePackages(options = {}) {
  const roots = options.roots ?? workspaceRoots;
  const rootDir = options.repoRoot ?? repoRoot;
  const workspaces = [];

  for (const workspaceRoot of roots) {
    const rootPath = path.join(rootDir, workspaceRoot);

    for (const entry of readDir(rootPath)) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packageDir = path.join(rootPath, entry.name);
      const packageJsonPath = path.join(packageDir, "package.json");

      try {
        const packageJson = readJson(packageJsonPath);
        workspaces.push({
          name: packageJson.name,
          dir: packageDir,
          dirName: entry.name,
          root: workspaceRoot,
          packageJson,
          packageJsonPath,
        });
      } catch {
        // Ignore conceptual directories that are not implemented packages.
      }
    }
  }

  return workspaces.sort((left, right) => left.name.localeCompare(right.name));
}
