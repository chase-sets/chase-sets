import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const guardFile = "scripts/lib/heavy-slot.mjs";
const escapedDirectEntrypoints = [
  "scripts/check-structure/browser-e2e-disclosure-guard.mjs",
  "scripts/check-structure/provider-scope-picker-shape-guard.mjs",
  "scripts/managed-postgres-authority-guard.mjs",
];
const optionValues = new Set([
  "--config",
  "-c",
  "--dir",
  "-C",
  "--filter",
  "-F",
  "--project",
  "--reporter",
  "--testNamePattern",
  "-t",
  "--testTimeout",
  "--maxWorkers",
  "--minWorkers",
  "--pool",
  "--shard",
  "--exclude",
]);
const explicitTestFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?(?::\d+)?$/i;
const sourceExtensionPattern = /\.(?:[cm]?[jt]sx?)$/i;

function normalize(relativePath) {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function trackedFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map(normalize);
}

function tokenize(command) {
  return command.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
}

function hasExplicitTestFile(argumentsList) {
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (optionValues.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (explicitTestFilePattern.test(token)) return true;
  }
  return false;
}

function isDatabaseTestScript(scriptName) {
  return /^test:db(?::.+)?$/.test(scriptName);
}

function isHeavyWorkspaceScript(scriptName) {
  return (
    scriptName === "build" || scriptName === "test" || scriptName === "test:unit" || scriptName.startsWith("test:db")
  );
}

function resolveTrackedModule(root, packageDirectory, specifier, tracked) {
  const candidate = normalize(path.relative(root, path.resolve(root, packageDirectory, specifier)));
  return tracked.has(candidate) ? candidate : null;
}

function configFromVitestArguments(root, packageDirectory, argumentsList, tracked) {
  const configIndex = argumentsList.findIndex((argument) => argument === "--config" || argument === "-c");
  if (configIndex >= 0) {
    return resolveTrackedModule(root, packageDirectory, argumentsList[configIndex + 1] ?? "", tracked);
  }
  const candidates = [...tracked].filter(
    (file) =>
      path.posix.dirname(file) === normalize(packageDirectory) &&
      /^vitest\.config\.[cm]?[jt]s$/.test(path.posix.basename(file)),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function deriveFromScript(root, scriptName, command, packageDirectory, tracked, entrypoints, unresolved) {
  for (const segment of command.split(/&&|\|\||;/)) {
    const tokens = tokenize(segment);
    const normalized = tokens.map((token) => path.posix.basename(token.replaceAll("\\", "/")).toLowerCase());
    const nodeIndex = normalized.findIndex((token) => token === "node" || token === "node.exe");
    if (nodeIndex >= 0) {
      const script = tokens[nodeIndex + 1];
      const scriptArguments = tokens.slice(nodeIndex + 2);
      const basename = path.posix.basename((script ?? "").replaceAll("\\", "/")).toLowerCase();
      const knownHeavyScript =
        (basename === "run-workspaces.mjs" && isHeavyWorkspaceScript(scriptArguments[0] ?? "")) ||
        basename === "react-router-build.mjs" ||
        basename === "browser-e2e-probe.mjs" ||
        basename === "run-e2e-suite.mjs" ||
        basename === "format-check.mjs" ||
        (basename === "dev-system.mjs" && scriptArguments.some((argument) => argument.toLowerCase() === "browser-e2e"));
      if (knownHeavyScript) {
        const resolved = resolveTrackedModule(root, packageDirectory, script, tracked);
        if (resolved) entrypoints.add(resolved);
        else unresolved.add(`${packageDirectory || "."}: node ${script}`);
      }
    }

    const vitestIndex = normalized.findIndex((token) => /^vitest(?:\.(?:mjs|js|cmd))?$/.test(token));
    if (vitestIndex >= 0 && normalized.slice(vitestIndex + 1).includes("run")) {
      const runIndex = normalized.indexOf("run", vitestIndex + 1);
      const argumentsList = tokens.slice(runIndex + 1);
      if (isDatabaseTestScript(scriptName) || !hasExplicitTestFile(argumentsList)) {
        const config = configFromVitestArguments(root, packageDirectory, argumentsList, tracked);
        if (config) entrypoints.add(config);
        else unresolved.add(`${packageDirectory || "."}: ${segment.trim()}`);
      }
    }

    const playwrightIndex = normalized.findIndex((token) => /^(?:playwright|playwright\.(?:cmd|js))$/.test(token));
    if (playwrightIndex >= 0 && normalized.slice(playwrightIndex + 1).includes("test")) {
      const config = [...tracked].find((file) => file === "playwright.config.ts");
      if (config) entrypoints.add(config);
      else unresolved.add(`${packageDirectory || "."}: ${segment.trim()}`);
    }
  }
}

function relativeImports(source) {
  const imports = [];
  const pattern = /(?:from\s+|import\s*\(|require\s*\()\s*["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function resolveImport(importer, specifier, tracked) {
  const base = normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [base, ...[".mjs", ".cjs", ".js", ".ts", ".tsx"].map((extension) => `${base}${extension}`)];
  return candidates.find((candidate) => tracked.has(candidate)) ?? null;
}

function importGraph(entrypoint, tracked, sources) {
  const visited = new Set();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const source = sources.get(current);
    if (!source) continue;
    for (const specifier of relativeImports(source)) {
      const resolved = resolveImport(current, specifier, tracked);
      if (resolved) pending.push(resolved);
    }
  }
  return visited;
}

function activatesGuard(file, source) {
  if (file === guardFile) return false;
  return (
    /\bacquireHeavySlot\s*\(/.test(source) ||
    /\bacquireVitestHeavySlot\s*\(/.test(source) ||
    (/\bacquireSlot\s*=\s*acquireHeavySlot\b/.test(source) && /\bacquireSlot\s*\(/.test(source)) ||
    (/globalSetup\s*:/.test(source) && /heavySlot/i.test(source))
  );
}

export function checkHeavySlotCoverage(root = repoRoot) {
  const files = trackedFiles(root);
  const tracked = new Set(files);
  const sources = new Map(
    files
      .filter((file) => sourceExtensionPattern.test(file))
      .map((file) => [file, readFileSync(path.join(root, file), "utf8")]),
  );
  const entrypoints = new Set();
  const unresolved = new Set();

  for (const entrypoint of escapedDirectEntrypoints) {
    if (tracked.has(entrypoint)) entrypoints.add(entrypoint);
  }

  for (const packageFile of files.filter((file) => path.posix.basename(file) === "package.json")) {
    const packageJson = JSON.parse(readFileSync(path.join(root, packageFile), "utf8"));
    const packageDirectory = path.posix.dirname(packageFile) === "." ? "" : path.posix.dirname(packageFile);
    for (const [scriptName, command] of Object.entries(packageJson.scripts ?? {})) {
      if (typeof command === "string") {
        deriveFromScript(root, scriptName, command, packageDirectory, tracked, entrypoints, unresolved);
      }
    }
  }

  const violations = [];
  for (const entrypoint of [...entrypoints].sort()) {
    const graph = importGraph(entrypoint, tracked, sources);
    const reachesGuard = graph.has(guardFile);
    const activates = [...graph].some((file) => activatesGuard(file, sources.get(file) ?? ""));
    if (!reachesGuard || !activates) violations.push(`${entrypoint} does not activate ${guardFile}`);
  }
  for (const command of [...unresolved].sort()) {
    violations.push(`heavy command has no tracked artifact hook: ${command}`);
  }

  return {
    entrypoints: [...entrypoints].sort(),
    unresolved: [...unresolved].sort(),
    violations,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkHeavySlotCoverage();
  if (result.violations.length > 0) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `Heavy-slot coverage: ${result.entrypoints.length}/${result.entrypoints.length} derived entry points guarded.`,
    );
  }
}
