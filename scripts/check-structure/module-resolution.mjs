import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const supportedSourceExtensions = [".ts", ".mts"];

function normalizeRepoPath(value) {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function fileCandidates(target) {
  if (supportedSourceExtensions.some((extension) => target.endsWith(extension))) return [target];
  return [`${target}.ts`, `${target}.mts`, `${target}/index.ts`, `${target}/index.mts`];
}

function firstExistingCandidate(target, existingPaths) {
  return fileCandidates(target).find((candidate) => existingPaths.has(candidate));
}

function parseWorkspaceSpecifier(specifierText, workspacePackages) {
  for (const packageName of workspacePackages.keys()) {
    if (specifierText === packageName) return { packageName, subpath: null };
    if (specifierText.startsWith(`${packageName}/`)) {
      return { packageName, subpath: specifierText.slice(packageName.length + 1) };
    }
  }
  return null;
}

function resolveWorkspaceExport(packageRecord, subpath) {
  const exportsMap = packageRecord.exports;
  if (!exportsMap || typeof exportsMap !== "object" || Array.isArray(exportsMap)) return null;
  const key = subpath === null ? "." : `./${subpath}`;
  const exactTarget = exportsMap[key];
  if (typeof exactTarget === "string") return exactTarget;
  if (subpath === null) return null;
  const wildcardKeys = Object.keys(exportsMap).filter((candidate) => candidate === "./*");
  if (wildcardKeys.length !== 1 || typeof exportsMap["./*"] !== "string") return null;
  return exportsMap["./*"].replaceAll("*", subpath);
}

/**
 * Resolve a specifier from immutable repository metadata. The function performs
 * no I/O and returns the same result for the same inputs.
 */
export function resolveModule({ importerPath, specifierText, workspacePackages, existingPaths }) {
  const normalizedImporter = normalizeRepoPath(importerPath);
  if (specifierText.startsWith("./") || specifierText.startsWith("../")) {
    const target = normalizeRepoPath(path.posix.join(path.posix.dirname(normalizedImporter), specifierText));
    if (target === ".." || target.startsWith("../")) {
      return { kind: "unresolved", reason: "path-escapes-repository" };
    }
    const candidate = firstExistingCandidate(target, existingPaths);
    return candidate ? { kind: "repo", path: candidate } : { kind: "unresolved", reason: "missing-file" };
  }

  const workspaceSpecifier = parseWorkspaceSpecifier(specifierText, workspacePackages);
  if (workspaceSpecifier) {
    const packageRecord = workspacePackages.get(workspaceSpecifier.packageName);
    const exportedTarget = resolveWorkspaceExport(packageRecord, workspaceSpecifier.subpath);
    if (!exportedTarget) return { kind: "unresolved", reason: "workspace-export-not-found" };
    const target = normalizeRepoPath(path.posix.join(packageRecord.root, exportedTarget));
    if (target === ".." || target.startsWith("../")) {
      return { kind: "unresolved", reason: "path-escapes-repository" };
    }
    const candidate = firstExistingCandidate(target, existingPaths);
    return candidate ? { kind: "repo", path: candidate } : { kind: "unresolved", reason: "missing-file" };
  }

  return { kind: "external" };
}

function workspacePatterns(repoRoot) {
  const workspaceYaml = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  return [...workspaceYaml.matchAll(/^\s*-\s*["']([^"']+)["']\s*$/gm)].map((match) => match[1]);
}

function workspaceDirectories(repoRoot, pattern) {
  const normalizedPattern = normalizeRepoPath(pattern);
  const wildcardIndex = normalizedPattern.indexOf("*");
  if (wildcardIndex < 0) return [normalizedPattern];
  const prefix = normalizedPattern.slice(0, wildcardIndex).replace(/\/$/, "");
  const suffix = normalizedPattern.slice(wildcardIndex + 1).replace(/^\//, "");
  const absolutePrefix = path.join(repoRoot, ...prefix.split("/"));
  if (!existsSync(absolutePrefix)) return [];
  return readdirSync(absolutePrefix, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => normalizeRepoPath(path.posix.join(prefix, entry.name, suffix)));
}

function collectExistingPaths(repoRoot, relativeDirectory = "") {
  const absoluteDirectory = path.join(repoRoot, ...relativeDirectory.split("/").filter(Boolean));
  if (!existsSync(absoluteDirectory)) return [];
  const ignored = new Set([".git", "node_modules", "artifacts", "coverage", "dist", "build"]);
  const paths = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const relativePath = normalizeRepoPath(path.posix.join(relativeDirectory, entry.name));
    if (entry.isDirectory()) paths.push(...collectExistingPaths(repoRoot, relativePath));
    else if (entry.isFile()) paths.push(relativePath);
  }
  return paths;
}

export function loadModuleResolutionContext(repoRoot) {
  const workspacePackages = new Map();
  for (const pattern of workspacePatterns(repoRoot)) {
    for (const root of workspaceDirectories(repoRoot, pattern)) {
      const packageJsonPath = path.join(repoRoot, ...root.split("/"), "package.json");
      if (!existsSync(packageJsonPath)) continue;
      const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (typeof manifest.name !== "string") continue;
      workspacePackages.set(manifest.name, {
        root,
        exports: manifest.exports,
      });
    }
  }
  return {
    workspacePackages,
    existingPaths: new Set(collectExistingPaths(repoRoot)),
  };
}
