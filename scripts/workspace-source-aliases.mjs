import path from "node:path";
import { listWorkspacePackages, normalizePath } from "./lib/repo.mjs";

const sourceAliasWorkspaceRoots = ["bounded-contexts", "contracts", "infrastructure", "packages"];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createAliasEntry(packageName, exportKey, exportTarget, packageDir) {
  if (typeof exportTarget !== "string") {
    return [];
  }

  const targetPath = normalizePath(path.join(packageDir, exportTarget.replace(/^\.\//, "")));
  if (exportKey === ".") {
    return [
      {
        find: new RegExp(`^${escapeRegExp(packageName)}$`),
        replacement: targetPath,
      },
    ];
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

  for (const workspace of listWorkspacePackages({ roots: sourceAliasWorkspaceRoots })) {
    const packageDir = workspace.dir;
    const packageJson = workspace.packageJson;
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
