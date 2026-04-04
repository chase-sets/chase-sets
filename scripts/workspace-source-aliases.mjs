import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoots = ["bounded-contexts", "contracts", "infrastructure", "packages"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function resolveWorkspacePackagePaths() {
  const packagePaths = [];

  for (const workspaceRoot of workspaceRoots) {
    const workspaceDir = path.join(repoRoot, workspaceRoot);
    for (const entry of readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packageJsonPath = path.join(workspaceDir, entry.name, "package.json");
      try {
        JSON.parse(readFileSync(packageJsonPath, "utf8"));
        packagePaths.push(packageJsonPath);
      } catch {
        // Ignore conceptual directories that are not implemented packages.
      }
    }
  }

  return packagePaths;
}

function createAliasEntry(packageName, exportKey, exportTarget, packageDir) {
  if (typeof exportTarget !== "string") {
    return [];
  }

  const targetPath = normalizePath(path.join(packageDir, exportTarget.replace(/^\.\//, "")));
  if (exportKey === ".") {
    return [{ find: packageName, replacement: targetPath }];
  }

  const exportSuffix = exportKey.replace(/^\.\//, "");
  if (!exportKey.includes("*")) {
    return [
      {
        find: new RegExp(`^${escapeRegExp(`${packageName}/${exportSuffix}`)}$`),
        replacement: targetPath,
      },
    ];
  }

  const exportPrefix = exportSuffix.split("*")[0];
  const exportPostfix = exportSuffix.split("*")[1] ?? "";
  const targetPrefix = targetPath.split("*")[0];
  const targetPostfix = targetPath.split("*")[1] ?? "";

  return [
    {
      find: new RegExp(
        `^${escapeRegExp(`${packageName}/${exportPrefix}`)}(.*)${escapeRegExp(exportPostfix)}$`,
      ),
      replacement: `${targetPrefix}$1${targetPostfix}`,
    },
  ];
}

export function createWorkspaceSourceAliases() {
  const aliases = [];

  for (const packageJsonPath of resolveWorkspacePackagePaths()) {
    const packageDir = path.dirname(packageJsonPath);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const exportsField =
      typeof packageJson.exports === "string"
        ? { ".": packageJson.exports }
        : packageJson.exports ?? {};

    for (const [exportKey, exportTarget] of Object.entries(exportsField)) {
      aliases.push(
        ...createAliasEntry(packageJson.name, exportKey, exportTarget, packageDir),
      );
    }
  }

  return aliases.sort((left, right) => {
    const leftPattern =
      typeof left.find === "string" ? left.find : left.find.source;
    const rightPattern =
      typeof right.find === "string" ? right.find : right.find.source;

    return rightPattern.length - leftPattern.length;
  });
}
