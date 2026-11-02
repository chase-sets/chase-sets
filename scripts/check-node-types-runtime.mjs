#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

// One major only: "24", "24.x", "^24.19.1", "~24.1", or a bounded same-major
// comparator pair such as ">=24.16.0 <25". Anything wider cannot be compared
// with the runtime major and fails closed.
const SINGLE_MAJOR_RANGE = /^[\^~]?(\d+)(?:\.(?:\d+|x|\*)){0,2}$/;
const BOUNDED_MAJOR_RANGE =
  /^>=(0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?)?\s+<(0|[1-9]\d*)(?:\.0(?:\.0)?)?$/;

function singleMajor(range) {
  if (typeof range !== "string") {
    return null;
  }
  const normalizedRange = range.trim();
  const singleMatch = SINGLE_MAJOR_RANGE.exec(normalizedRange);
  if (singleMatch) {
    return Number(singleMatch[1]);
  }
  const boundedMatch = BOUNDED_MAJOR_RANGE.exec(normalizedRange);
  if (!boundedMatch) {
    return null;
  }
  const lowerMajor = Number(boundedMatch[1]);
  const upperMajor = Number(boundedMatch[2]);
  return Number.isSafeInteger(lowerMajor) && Number.isSafeInteger(upperMajor) && upperMajor === lowerMajor + 1
    ? lowerMajor
    : null;
}

function readManifest(repoRoot, manifestPath) {
  return JSON.parse(readFileSync(join(repoRoot, manifestPath), "utf8"));
}

function workspaceDirectories(repoRoot, pattern) {
  const normalized = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized.includes("*") && !normalized.startsWith("!")) {
    return { directories: [normalized] };
  }
  const parent = normalized.slice(0, -2);
  if (!normalized.endsWith("/*") || parent.includes("*") || normalized.startsWith("!")) {
    return { unsupported: pattern };
  }
  const absoluteParent = join(repoRoot, parent);
  if (!existsSync(absoluteParent)) {
    return { directories: [] };
  }
  return {
    directories: readdirSync(absoluteParent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`),
  };
}

export function listWorkspaceManifestPaths(repoRoot = defaultRepoRoot) {
  const workspace = parse(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8"));
  const patterns = Array.isArray(workspace?.packages) ? workspace.packages : [];
  const manifestPaths = ["package.json"];
  const unsupportedPatterns = [];
  for (const pattern of patterns) {
    const { directories, unsupported } = workspaceDirectories(repoRoot, String(pattern));
    if (unsupported) {
      unsupportedPatterns.push(unsupported);
      continue;
    }
    for (const directory of directories) {
      if (existsSync(join(repoRoot, directory, "package.json"))) {
        manifestPaths.push(`${directory}/package.json`);
      }
    }
  }
  return { manifestPaths: [...new Set(manifestPaths)].sort(), patterns, unsupportedPatterns };
}

export function collectNodeTypesRuntimeVerification(repoRoot = defaultRepoRoot) {
  const failures = [];
  const { manifestPaths, patterns, unsupportedPatterns } = listWorkspaceManifestPaths(repoRoot);
  if (patterns.length === 0) {
    failures.push("pnpm-workspace.yaml declares no workspace packages.");
  }
  for (const pattern of unsupportedPatterns) {
    failures.push(
      `pnpm-workspace.yaml package pattern ${JSON.stringify(pattern)} is not a directory or "<dir>/*" glob.`,
    );
  }

  const engineRange = readManifest(repoRoot, "package.json").engines?.node;
  const runtimeMajor = singleMajor(engineRange);
  if (runtimeMajor === null) {
    failures.push(`package.json engines.node ${JSON.stringify(engineRange)} must name exactly one Node major.`);
  }

  const declarations = [];
  for (const manifestPath of manifestPaths) {
    const manifest = readManifest(repoRoot, manifestPath);
    for (const field of DEPENDENCY_FIELDS) {
      const range = manifest[field]?.["@types/node"];
      if (range === undefined) {
        continue;
      }
      const major = singleMajor(range);
      declarations.push({ manifestPath, field, range, major });
      if (major === null) {
        failures.push(`${manifestPath} ${field} @types/node ${JSON.stringify(range)} must name exactly one major.`);
      } else if (runtimeMajor !== null && major !== runtimeMajor) {
        failures.push(
          `${manifestPath} ${field} @types/node ${JSON.stringify(range)} is major ${major}; engines.node runtime is major ${runtimeMajor}.`,
        );
      }
    }
  }

  return { runtimeMajor, manifestPaths, declarations, failures };
}

function main() {
  const { runtimeMajor, manifestPaths, declarations, failures } = collectNodeTypesRuntimeVerification();
  if (failures.length > 0) {
    console.error(
      `@types/node must match the Node runtime major:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`,
    );
    return 1;
  }

  console.log(
    `Verified ${declarations.length} @types/node declaration(s) across ${manifestPaths.length} workspace manifest(s) against Node ${runtimeMajor}.`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
