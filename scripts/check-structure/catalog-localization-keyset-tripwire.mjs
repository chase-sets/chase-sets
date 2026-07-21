// Guards the committed localization key-set fingerprint against source-key
// drift. The enforcement surface is discovered from the test's data shape:
// a createHash-backed { count, sha256 } baseline asserted against Object.keys()
// of an imported translation map. It deliberately does not select files by
// catalog/localization path vocabulary.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fingerprintBaselinePattern =
  /const\s+(\w+)\s*=\s*\{\s*count:\s*\d+,\s*sha256:\s*"[a-f0-9]{64}"\s*,?\s*\}\s*as const;/gs;
// Discovery recognizes only the canonical single-named-import idiom.
const namedImportPattern = /import\s*\{\s*(\w+)\s*\}\s*from\s*["'](\.[^"']+)["'];/g;
const staticImportPattern = /import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["'](\.[^"']+)["'];/g;
const translationKeyPattern = /^\s{2}"([^"]+)":/gm;

export function keySetFingerprint(keys) {
  const sortedKeys = [...keys].sort();
  return {
    count: sortedKeys.length,
    sha256: createHash("sha256").update(JSON.stringify(sortedKeys)).digest("hex"),
  };
}

export function discoverKeySetTripwires(files) {
  const tripwires = [];

  for (const [relativeFile, source] of Object.entries(files)) {
    if (!source.includes("createHash") || !source.includes("Object.keys")) continue;

    const imports = [...source.matchAll(namedImportPattern)].map((match) => ({
      binding: match[1],
      specifier: match[2],
    }));
    for (const baseline of source.matchAll(fingerprintBaselinePattern)) {
      const baselineName = baseline[1];
      const matchingImport = imports.find(({ binding }) =>
        new RegExp(`Object\\.keys\\(\\s*${binding}\\s*\\)`).test(source),
      );
      if (!matchingImport || !new RegExp(`toEqual\\(\\s*${baselineName}\\s*\\)`).test(source)) continue;

      tripwires.push({
        baselineName,
        baselineSource: baseline[0],
        baselineStart: baseline.index,
        importedBinding: matchingImport.binding,
        sourceRoot: resolveModulePath(relativeFile, matchingImport.specifier, files),
        testPath: relativeFile,
      });
    }
  }

  return tripwires;
}

export function findKeySetTripwireViolations({ baseFiles, currentFiles }) {
  const violations = [];

  for (const tripwire of discoverKeySetTripwires(currentFiles)) {
    const currentKeys = collectTranslationKeys(tripwire.sourceRoot, currentFiles);
    const baseKeys = collectTranslationKeys(tripwire.sourceRoot, baseFiles);
    if (setsEqual(currentKeys, baseKeys)) continue;

    const currentFingerprint = keySetFingerprint(currentKeys);
    const committedFingerprint = parseFingerprint(tripwire.baselineSource);
    const baselineChanged = baseFiles[tripwire.testPath] !== currentFiles[tripwire.testPath];

    if (!baselineChanged || !fingerprintsEqual(committedFingerprint, currentFingerprint)) {
      violations.push({
        testPath: tripwire.testPath,
        sourceRoot: tripwire.sourceRoot,
        message:
          "translation-map key set changed without a matching committed key-set fingerprint baseline. " +
          "Run `node scripts/check-structure/catalog-localization-keyset-tripwire.mjs --write-baseline`, then " +
          `\`pnpm --filter @chase-sets/localization run test -- ${path.posix.basename(tripwire.testPath)}\`.`,
      });
    }
  }

  return violations;
}

export function updateKeySetBaselines(files) {
  const updated = { ...files };
  for (const tripwire of discoverKeySetTripwires(updated)) {
    const fingerprint = keySetFingerprint(collectTranslationKeys(tripwire.sourceRoot, updated));
    updated[tripwire.testPath] = updated[tripwire.testPath].replace(
      tripwire.baselineSource,
      `const ${tripwire.baselineName} = {\n  count: ${fingerprint.count},\n  sha256: "${fingerprint.sha256}",\n} as const;`,
    );
  }
  return updated;
}

export function findGitKeySetTripwireViolations({ rootDir = process.cwd() } = {}) {
  const baseRef = git(rootDir, ["merge-base", "origin/main", "HEAD"], { allowFailure: true });
  if (!baseRef) return [];

  const currentFiles = loadTrackedTypeScriptFiles(rootDir);
  const baseFiles = { ...currentFiles };
  const changedFiles = git(rootDir, ["diff", "--name-only", baseRef, "HEAD", "--", "*.ts", "*.tsx"])
    .split(/\r?\n/)
    .filter(Boolean);
  for (const relativeFile of changedFiles) {
    const source = git(rootDir, ["show", `${baseRef}:${relativeFile}`], { allowFailure: true });
    if (source === null) delete baseFiles[relativeFile];
    else baseFiles[relativeFile] = source;
  }

  return findKeySetTripwireViolations({ baseFiles, currentFiles });
}

function collectTranslationKeys(root, files) {
  if (!root || !files[root]) return new Set();
  const visited = new Set();
  const keys = new Set();
  const visit = (relativeFile) => {
    if (visited.has(relativeFile) || !files[relativeFile]) return;
    visited.add(relativeFile);
    const source = files[relativeFile];
    for (const match of source.matchAll(translationKeyPattern)) keys.add(match[1]);
    for (const match of source.matchAll(staticImportPattern)) {
      const imported = resolveModulePath(relativeFile, match[1], files);
      if (imported) visit(imported);
    }
  };
  visit(root);
  return keys;
}

function resolveModulePath(from, specifier, files) {
  const unresolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return (
    [unresolved, `${unresolved}.ts`, `${unresolved}.tsx`, `${unresolved}/index.ts`].find(
      (candidate) => candidate in files,
    ) ?? null
  );
}

function parseFingerprint(source) {
  const count = source.match(/count:\s*(\d+)/)?.[1];
  const sha256 = source.match(/sha256:\s*"([a-f0-9]{64})"/)?.[1];
  return count && sha256 ? { count: Number(count), sha256 } : null;
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function fingerprintsEqual(left, right) {
  return left?.count === right.count && left?.sha256 === right.sha256;
}

function trackedFiles(rootDir) {
  return loadTrackedTypeScriptFiles(rootDir);
}

function loadTrackedTypeScriptFiles(rootDir) {
  const files = {};
  for (const relativeFile of git(rootDir, ["ls-files", "*.ts", "*.tsx"]).split(/\r?\n/).filter(Boolean)) {
    files[relativeFile] = readFileSync(path.join(rootDir, relativeFile), "utf8");
  }
  return files;
}

function git(rootDir, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv.includes("--write-baseline")) {
    throw new Error("Usage: node scripts/check-structure/catalog-localization-keyset-tripwire.mjs --write-baseline");
  }
  const rootDir = process.cwd();
  const files = trackedFiles(rootDir);
  const updated = updateKeySetBaselines(files);
  for (const [relativeFile, source] of Object.entries(updated)) {
    if (files[relativeFile] !== source) writeFileSync(path.join(rootDir, relativeFile), source, "utf8");
  }
}
