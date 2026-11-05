import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const contextNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const testPathPattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function fail(message) {
  throw new Error(`Canonical proof sets: ${message}`);
}

function record(value, required, optional = []) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => [...required, ...optional].includes(key))
  );
}

function relativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !path.posix.isAbsolute(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function compare(left, right) {
  for (const key of ["ownerContext", "proofSetId", "path"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

function readJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid metadata root");
    return value;
  } catch {
    return fail(`missing or malformed metadata: ${file}`);
  }
}

function assertTestPath(testPath, ownerContext, baseDir) {
  const ownerRoot = `bounded-contexts/${ownerContext}/`;
  if (
    !relativePath(testPath) ||
    !testPath.startsWith(ownerRoot) ||
    testPath.slice(ownerRoot.length).startsWith("-") ||
    !testPathPattern.test(testPath)
  ) {
    fail(`non-relative, foreign-owner or non-test proof path: ${testPath}`);
  }
  const absolute = path.join(baseDir, testPath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) fail(`absent proof test: ${testPath}`);
  const realOwner = realpathSync(path.join(baseDir, ownerRoot));
  const realRelative = path.relative(realOwner, realpathSync(absolute));
  if (realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    fail(`proof test escapes its owner: ${testPath}`);
  }
}

export function resolveRequiredProofPaths({ changedFiles, baseDir = rootDir }) {
  if (!Array.isArray(changedFiles) || changedFiles.some((file) => typeof file !== "string")) {
    fail("missing or malformed changed paths");
  }
  const contexts = new Set();
  for (const file of changedFiles) {
    const match = /^bounded-contexts\/([^/]+)\//.exec(file);
    if (match) {
      if (!contextNamePattern.test(match[1])) fail(`invalid source context: ${match[1]}`);
      contexts.add(match[1]);
    }
  }
  const references = new Map();
  for (const context of [...contexts].sort()) {
    const metadataPath = path.join(baseDir, "bounded-contexts", context, "context.json");
    if (!existsSync(metadataPath)) continue;
    const metadata = readJson(metadataPath);
    if (!Object.hasOwn(metadata, "requiredProofSets")) continue;
    if (!Array.isArray(metadata.requiredProofSets) || metadata.requiredProofSets.length === 0) {
      fail(`declared-but-empty or malformed requiredProofSets in ${context}`);
    }
    const seen = new Set();
    for (const reference of metadata.requiredProofSets) {
      if (
        !record(reference, ["version", "ownerContext", "proofSetId"], ["reason"]) ||
        reference.version !== 1 ||
        typeof reference.ownerContext !== "string" ||
        !contextNamePattern.test(reference.ownerContext) ||
        typeof reference.proofSetId !== "string" ||
        reference.proofSetId.trim().length === 0 ||
        (Object.hasOwn(reference, "reason") &&
          (typeof reference.reason !== "string" || reference.reason.trim().length === 0))
      ) {
        fail(`invalid requiredProofSets reference in ${context}`);
      }
      const key = JSON.stringify([reference.ownerContext, reference.proofSetId]);
      if (seen.has(key)) fail(`duplicate proof reference in ${context}: ${key}`);
      seen.add(key);
      references.set(key, reference);
    }
  }
  const paths = [];
  for (const { ownerContext, proofSetId } of references.values()) {
    const owner = readJson(path.join(baseDir, "bounded-contexts", ownerContext, "context.json"));
    if (owner.contextName !== ownerContext || !Array.isArray(owner.mutationConsistencyInventory)) {
      fail(`absent canonical proof owner: ${ownerContext}`);
    }
    const matches = owner.mutationConsistencyInventory.filter((entry) => entry?.id === proofSetId);
    if (matches.length !== 1 || matches[0].owner !== ownerContext) {
      fail(`unknown or duplicate canonical proof ID: ${ownerContext}/${proofSetId}`);
    }
    const tests = matches[0].proof?.tests;
    if (!Array.isArray(tests) || tests.length === 0) fail(`declared-but-empty proof: ${proofSetId}`);
    const seen = new Set();
    for (const testPath of tests) {
      assertTestPath(testPath, ownerContext, baseDir);
      if (seen.has(testPath)) fail(`duplicate canonical proof path: ${testPath}`);
      seen.add(testPath);
      paths.push({ version: 1, ownerContext, proofSetId, path: testPath });
    }
  }
  return paths.sort(compare);
}

export function validateRequiredProofPaths({ pathsJson, changedFiles, baseDir = rootDir }) {
  let paths;
  try {
    paths = JSON.parse(pathsJson);
  } catch {
    fail("missing or malformed required_proof_paths_json");
  }
  if (
    !Array.isArray(paths) ||
    paths.some(
      (entry) =>
        !record(entry, ["version", "ownerContext", "proofSetId", "path"]) ||
        entry.version !== 1 ||
        typeof entry.ownerContext !== "string" ||
        !contextNamePattern.test(entry.ownerContext) ||
        typeof entry.proofSetId !== "string" ||
        entry.proofSetId.trim().length === 0 ||
        !relativePath(entry.path),
    )
  ) {
    fail("invalid required_proof_paths_json record shape");
  }
  const current = resolveRequiredProofPaths({ changedFiles, baseDir });
  const normalized = paths.map(({ version, ownerContext, proofSetId, path: testPath }) => ({
    version,
    ownerContext,
    proofSetId,
    path: testPath,
  }));
  if (JSON.stringify(normalized) !== JSON.stringify(current)) fail("stale or different canonical proof paths");
  if (paths.length === 0 && pathsJson !== "[]") fail("empty proof output must be exactly []");
  return current;
}

export function requireCanonicalProofResult(paths, result) {
  if (result !== "success" && !(paths.length === 0 && result === "skipped")) {
    fail(`required job finished with result '${result}' for ${paths.length} proof paths`);
  }
}

export function canonicalProofCommands(paths, baseDir = rootDir) {
  const owners = new Map();
  for (const entry of paths) {
    const tests = owners.get(entry.ownerContext) ?? new Set();
    tests.add(entry.path.slice(`bounded-contexts/${entry.ownerContext}/`.length));
    owners.set(entry.ownerContext, tests);
  }
  return [...owners].map(([ownerContext, tests]) => {
    const directory = path.join(baseDir, "bounded-contexts", ownerContext);
    const { name } = readJson(path.join(directory, "package.json"));
    if (name !== `@chase-sets/${ownerContext}` || !existsSync(path.join(directory, "tests/vitest.config.mjs"))) {
      fail(`missing canonical test runner for ${ownerContext}`);
    }
    return ["--filter", name, "exec", "vitest", "run", "--config", "./tests/vitest.config.mjs", ...tests];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = validateRequiredProofPaths({
    pathsJson: process.env.REQUIRED_PROOF_PATHS_JSON,
    changedFiles: JSON.parse(process.env.CHANGED_FILES_JSON),
  });
  if (process.argv[2] === "require-result") {
    requireCanonicalProofResult(paths, process.env.CANONICAL_PROOF_RESULT);
  } else if (process.argv[2] === "run") {
    if (paths.length === 0) fail("execution requested for empty canonical proof selection");
    const commands = canonicalProofCommands(paths);
    for (const command of commands) {
      console.log(`Canonical proof invocation: pnpm ${command.join(" ")}`);
      const result = spawnSync("pnpm", command, { cwd: rootDir, stdio: "inherit" });
      if (result.error || result.status !== 0) fail(`test runner failed: ${result.error?.message ?? result.status}`);
    }
  } else {
    fail("expected run or require-result");
  }
}
