import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { listWorkspacePackages, normalizeRelative, repoRoot } from "./lib/repo.mjs";

function isConditionMap(exportsValue) {
  if (!exportsValue || typeof exportsValue !== "object" || Array.isArray(exportsValue)) {
    return false;
  }

  return Object.keys(exportsValue).every((key) => !key.startsWith("."));
}

export function collectExportTargets(exportsValue, exportPath = ".") {
  if (typeof exportsValue === "string") {
    return [{ exportPath, target: exportsValue }];
  }

  if (exportsValue === null || exportsValue === undefined) {
    return [];
  }

  if (Array.isArray(exportsValue)) {
    return exportsValue.flatMap((entry) => collectExportTargets(entry, exportPath));
  }

  if (typeof exportsValue !== "object") {
    return [];
  }

  if (isConditionMap(exportsValue)) {
    return Object.entries(exportsValue).flatMap(([condition, value]) =>
      collectExportTargets(value, `${exportPath} (${condition})`),
    );
  }

  return Object.entries(exportsValue).flatMap(([subpath, value]) => collectExportTargets(value, subpath));
}

function normalizeTarget(target) {
  return target.split("?")[0].split("#")[0];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectPackageFiles(packageDir) {
  const files = [];
  const ignoredDirectories = new Set([".react-router", "coverage", "dist", "node_modules"]);

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          visit(path.join(directory, entry.name));
        }
        continue;
      }

      if (entry.isFile()) {
        files.push(path.join(directory, entry.name));
      }
    }
  }

  visit(packageDir);
  return files;
}

function targetExists(packageDir, target) {
  const normalizedTarget = normalizeTarget(target);
  const resolvedPath = path.resolve(packageDir, normalizedTarget);
  if (!normalizedTarget.includes("*")) {
    return existsSync(resolvedPath);
  }

  const relativePattern = normalizedTarget.slice("./".length);
  const pattern = new RegExp(`^${escapeRegExp(relativePattern).replaceAll("\\*", ".+")}$`);
  return collectPackageFiles(packageDir).some((filePath) => {
    const relativePath = path.relative(packageDir, filePath).replaceAll("\\", "/");
    return pattern.test(relativePath);
  });
}

export function checkPackageExportTargets(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const workspaces = options.workspaces ?? listWorkspacePackages({ repoRoot: rootDir });
  const violations = [];
  const checkedTargets = [];

  for (const workspace of workspaces) {
    if (!workspace.packageJson.exports) {
      continue;
    }

    for (const entry of collectExportTargets(workspace.packageJson.exports)) {
      if (!entry.target.startsWith("./")) {
        violations.push(
          `${normalizeRelative(workspace.packageJsonPath, rootDir)}: export ${entry.exportPath} target '${entry.target}' must be package-relative.`,
        );
        continue;
      }

      const resolvedPath = path.resolve(workspace.dir, normalizeTarget(entry.target));
      const record = {
        packageName: workspace.name,
        packageJsonPath: normalizeRelative(workspace.packageJsonPath, rootDir),
        exportPath: entry.exportPath,
        target: entry.target,
        targetPath: normalizeRelative(resolvedPath, rootDir),
      };
      checkedTargets.push(record);

      if (!targetExists(workspace.dir, entry.target)) {
        violations.push(
          `${record.packageJsonPath}: export ${entry.exportPath} target '${entry.target}' does not resolve to ${record.targetPath}.`,
        );
      }
    }
  }

  return {
    passed: violations.length === 0,
    checkedTargets,
    violations,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkPackageExportTargets();

  if (!result.passed) {
    console.error("Package export target check failed:");
    for (const violation of result.violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log(`Package export target check passed (${result.checkedTargets.length} targets resolved).`);
}
