import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Guards complete authoritative event-stream rehydration.
 *
 * Every event store caps one `readStream` page at 500 events and defaults an
 * omitted `limit` to that cap, so a single call only ever returns a PREFIX.
 * Folding authoritative aggregate state over one such call truncates silently
 * the moment a stream outgrows a page. It has shipped twice: once as a capped
 * provider file list classified as complete, once as a 501-event registration
 * history folded from 500 events while the shipped suite stayed green.
 *
 * The rule this enforces: outside the event-store implementations and the
 * canonical complete-history reader, production code may not touch `readStream`
 * at all unless the site declares, in the source, that a bounded prefix IS the
 * contract -- and a registry entry names the test that consumes that bound.
 * Complete-history readers use `readCompleteStream`. Consumers are derived from
 * the corpus, never from the registry, so a new call site fails closed.
 */

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "artifacts",
  "tests",
  "__tests__",
]);

export const DEFAULT_STREAM_READ_SCAN_ROOTS = [
  "bounded-contexts",
  "contracts",
  "deployables",
  "infrastructure",
  "packages",
];

/**
 * The modules that ARE the event-store read surface, plus the one canonical
 * complete-history reader built on it. Nothing else may call `readStream`
 * without an explicit bounded-prefix contract.
 */
export const CANONICAL_STREAM_READ_MODULES = new Set([
  "contracts/event-core/complete-stream.ts",
  "contracts/event-core/event-store.ts",
  "contracts/event-core/storage.ts",
  "infrastructure/event-core-postgres/event-store.ts",
]);

export const CANONICAL_COMPLETE_STREAM_READER = "readCompleteStream";
const CANONICAL_COMPLETE_STREAM_MODULE = "@chase-sets/event-core/complete-stream";
const EVENT_STORE_READ_PAGE_SIZE_MAX = 500;
const ANNOTATION_PATTERN = /event-stream-read:\s*([a-z-]+)/;
const ANNOTATION_LOOKBACK_LINES = 10;
const SUPPORTED_DECLARED_CLASSIFICATIONS = new Set(["bounded-prefix", "paged-catch-up"]);
const MINIMUM_REASON_LENGTH = 40;

function normalizeRelative(filePath, repoRoot) {
  return path.relative(repoRoot, filePath).replaceAll("\\", "/");
}

function isNonProductionFile(relativeFile) {
  return (
    relativeFile.includes("/tests/") ||
    relativeFile.includes("/__tests__/") ||
    relativeFile.includes("/fixtures/") ||
    /(?:^|\/)[^/]*(?:test-support|test-harness|db-test-support)[^/]*\.[^.]+$/.test(relativeFile) ||
    /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(relativeFile)
  );
}

async function walkSourceFiles(rootDir) {
  const files = [];
  for (const entry of await readdir(rootDir, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkSourceFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }
  return files;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

/** Returns the index just past the balanced `(...)` opened at `openIndex`, or -1. */
function matchingCloseParen(content, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function callArgumentsAt(content, identifierEndIndex) {
  let cursor = identifierEndIndex;
  while (/\s/.test(content[cursor] ?? "")) cursor += 1;
  if (content[cursor] !== "(") return null;
  const closeIndex = matchingCloseParen(content, cursor);
  return closeIndex === -1 ? null : content.slice(cursor + 1, closeIndex);
}

function annotationBefore(content, index) {
  const linesBefore = content.slice(0, index).split(/\r?\n/);
  const window = linesBefore.slice(Math.max(0, linesBefore.length - 1 - ANNOTATION_LOOKBACK_LINES));
  for (let offset = window.length - 1; offset >= 0; offset -= 1) {
    const match = window[offset].match(ANNOTATION_PATTERN);
    if (match) return match[1];
  }
  return null;
}

/** The literal `limit:` expression this call passes, or null when it passes none. */
function declaredLimitExpression(callArguments) {
  const match = callArguments.match(/\blimit\s*:\s*([^,}\n]+)/);
  return match ? match[1].trim() : null;
}

function declaresFromVersion(callArguments) {
  return /\bfromVersion\s*[:,}]/.test(callArguments);
}

/**
 * Every mention of `readStream` in one file, split into immediate calls and
 * every other form -- destructuring, property aliasing, computed member access,
 * or passing the method as a value. The second group is how a truncating fold
 * hides from a call-shaped scan, so it is reported, never ignored.
 */
function collectStreamReadReferences(content) {
  const references = [];
  for (const match of content.matchAll(/\breadStream\b/g)) {
    const index = match.index ?? 0;
    const callArguments = callArgumentsAt(content, index + match[0].length);
    references.push({
      index,
      line: lineNumberAt(content, index),
      kind: callArguments === null ? "indirect-reference" : "direct-call",
      callArguments: callArguments ?? "",
    });
  }
  return references;
}

function collectCompleteStreamCalls(content) {
  if (!content.includes(CANONICAL_COMPLETE_STREAM_MODULE)) {
    return [];
  }
  const calls = [];
  const pattern = new RegExp(`\\b${CANONICAL_COMPLETE_STREAM_READER}\\s*\\(`, "g");
  for (const match of content.matchAll(pattern)) {
    calls.push({ index: match.index ?? 0, line: lineNumberAt(content, match.index ?? 0) });
  }
  return calls;
}

function withOccurrenceIds(rows) {
  const counts = new Map();
  return rows
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
    .map((row) => {
      const key = `${row.file}:${row.mechanism}`;
      const occurrence = (counts.get(key) ?? 0) + 1;
      counts.set(key, occurrence);
      return { ...row, occurrence, id: `${row.file}:${row.mechanism}#${occurrence}` };
    });
}

/**
 * Derives every production event-stream read site from the code corpus. The
 * registry classifies declared exceptions; it never decides what exists.
 */
export async function collectEventStreamReadSites({ repoRoot, roots = DEFAULT_STREAM_READ_SCAN_ROOTS }) {
  const rows = [];

  for (const root of roots) {
    const absoluteRoot = path.join(repoRoot, root);
    if (!existsSync(absoluteRoot)) continue;

    for (const filePath of await walkSourceFiles(absoluteRoot)) {
      const relativeFile = normalizeRelative(filePath, repoRoot);
      if (isNonProductionFile(relativeFile)) continue;

      const content = await readFile(filePath, "utf8");
      if (!content.includes("readStream") && !content.includes(CANONICAL_COMPLETE_STREAM_READER)) continue;

      const canonicalModule = CANONICAL_STREAM_READ_MODULES.has(relativeFile);

      for (const reference of collectStreamReadReferences(content)) {
        const declaredClassification = canonicalModule ? null : annotationBefore(content, reference.index);
        rows.push({
          file: relativeFile,
          line: reference.line,
          mechanism: "readStream",
          referenceKind: reference.kind,
          classification: canonicalModule ? "event-store-implementation" : (declaredClassification ?? "undeclared"),
          declaredLimit: declaredLimitExpression(reference.callArguments),
          declaresFromVersion: declaresFromVersion(reference.callArguments),
        });
      }

      if (canonicalModule) continue;

      for (const call of collectCompleteStreamCalls(content)) {
        rows.push({
          file: relativeFile,
          line: call.line,
          mechanism: CANONICAL_COMPLETE_STREAM_READER,
          referenceKind: "direct-call",
          classification: "complete-history",
          declaredLimit: null,
          declaresFromVersion: false,
        });
      }
    }
  }

  return withOccurrenceIds(rows);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function readRegistry(repoRoot, registryPath) {
  const absolutePath = path.resolve(repoRoot, registryPath);
  if (!existsSync(absolutePath)) return { entries: [] };
  return JSON.parse(await readFile(absolutePath, "utf8"));
}

function useTheCanonicalReaderMessage(row) {
  return (
    `${row.file}:${row.line}: production readStream ${row.referenceKind === "direct-call" ? "call" : "reference"} ` +
    `outside the event store. A single readStream page is capped at ${EVENT_STORE_READ_PAGE_SIZE_MAX} events and an ` +
    `omitted limit defaults to that cap, so this cannot prove it saw a complete history. Fold authoritative state with ` +
    `${CANONICAL_COMPLETE_STREAM_READER}() from ${CANONICAL_COMPLETE_STREAM_MODULE}, or declare the bounded-prefix ` +
    `contract with an "event-stream-read: bounded-prefix" annotation plus an entry in the registry. See #6277.`
  );
}

function validateRegistryEntryShape(entry, index, registryPath, violations) {
  const label = `${registryPath} entries[${index}]`;
  if (!isPlainObject(entry)) {
    violations.push(`${label}: entry must be an object.`);
    return false;
  }
  let ok = true;
  for (const field of ["id", "file", "classification", "bound", "reason", "boundTest"]) {
    if (!isNonEmptyString(entry[field])) {
      violations.push(`${label}: ${field} must be a non-empty string.`);
      ok = false;
    }
  }
  if (ok && !SUPPORTED_DECLARED_CLASSIFICATIONS.has(entry.classification)) {
    violations.push(
      `${label}: classification must be one of ${[...SUPPORTED_DECLARED_CLASSIFICATIONS].sort().join(", ")}.`,
    );
    ok = false;
  }
  if (ok && entry.reason.trim().length < MINIMUM_REASON_LENGTH) {
    violations.push(
      `${label}: reason must state why a prefix IS the contract in at least ${MINIMUM_REASON_LENGTH} characters.`,
    );
    ok = false;
  }
  return ok;
}

async function validateBoundTest(entry, repoRoot, registryPath, violations) {
  const absoluteTest = path.resolve(repoRoot, entry.boundTest);
  if (!existsSync(absoluteTest)) {
    violations.push(`${registryPath}: '${entry.id}' names boundTest '${entry.boundTest}', which does not exist.`);
    return;
  }
  const testSource = await readFile(absoluteTest, "utf8");
  if (!testSource.includes(entry.id)) {
    violations.push(
      `${registryPath}: '${entry.id}' boundTest '${entry.boundTest}' does not name this site, so nothing proves the ` +
        `declared bound is consumed. Cite the id in the test and assert the store is read with limit ${entry.bound}.`,
    );
  }
}

function writeInventoryArtifact({ repoRoot, artifactOutputPath, rows, registryById }) {
  const absoluteOutputPath = path.resolve(repoRoot, artifactOutputPath);
  mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
  const artifact = {
    issue: "#6277",
    defectClass: "pagination-truncates-authoritative-state",
    pageSizeMax: EVENT_STORE_READ_PAGE_SIZE_MAX,
    canonicalReader: `${CANONICAL_COMPLETE_STREAM_READER} (${CANONICAL_COMPLETE_STREAM_MODULE})`,
    canonicalModules: [...CANONICAL_STREAM_READ_MODULES].sort(),
    entries: rows.map((row) => ({
      ...row,
      reason: registryById.get(row.id)?.reason,
      boundTest: registryById.get(row.id)?.boundTest,
    })),
  };
  writeFileSync(absoluteOutputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function validateAuthoritativeStreamReadInventory(options) {
  const {
    repoRoot,
    roots = DEFAULT_STREAM_READ_SCAN_ROOTS,
    registryPath = "scripts/check-structure/authoritative-stream-read-registry.json",
    artifactOutputPath = "artifacts/authoritative-stream-read-inventory.json",
    writeArtifact = true,
  } = options;
  const violations = [];
  const rows = await collectEventStreamReadSites({ repoRoot, roots });
  const registry = await readRegistry(repoRoot, registryPath);
  const registryEntries = Array.isArray(registry.entries) ? registry.entries : [];
  if (!Array.isArray(registry.entries)) {
    violations.push(`${registryPath}: entries must be an array.`);
  }

  const validEntries = [];
  const seenIds = new Set();
  for (const [index, entry] of registryEntries.entries()) {
    if (!validateRegistryEntryShape(entry, index, registryPath, violations)) continue;
    if (seenIds.has(entry.id)) {
      violations.push(`${registryPath}: duplicate entry id '${entry.id}'.`);
      continue;
    }
    seenIds.add(entry.id);
    validEntries.push(entry);
  }

  const registryById = new Map(validEntries.map((entry) => [entry.id, entry]));
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  for (const row of rows) {
    if (row.mechanism !== "readStream" || row.classification === "event-store-implementation") continue;

    if (row.referenceKind === "indirect-reference") {
      violations.push(
        `${row.file}:${row.line}: readStream is referenced without being called directly (alias, destructure, or ` +
          `computed access). A wrapper hides the page cap from every call-shaped review, so it is rejected outright. ` +
          `Call ${CANONICAL_COMPLETE_STREAM_READER}() instead. See #6277.`,
      );
      continue;
    }

    if (row.classification === "undeclared") {
      violations.push(useTheCanonicalReaderMessage(row));
      continue;
    }

    if (!SUPPORTED_DECLARED_CLASSIFICATIONS.has(row.classification)) {
      violations.push(
        `${row.file}:${row.line}: unknown event-stream-read classification '${row.classification}'; use one of ` +
          `${[...SUPPORTED_DECLARED_CLASSIFICATIONS].sort().join(", ")}.`,
      );
      continue;
    }

    if (row.declaredLimit === null) {
      violations.push(
        `${row.file}:${row.line}: an event-stream-read '${row.classification}' annotation must pass an explicit ` +
          `limit. Without one the read silently takes the ${EVENT_STORE_READ_PAGE_SIZE_MAX}-event default cap, which ` +
          `is the truncation this annotation claims not to be. See #6277.`,
      );
      continue;
    }

    if (row.classification === "bounded-prefix") {
      const bound = Number(row.declaredLimit);
      if (!Number.isInteger(bound) || bound < 1 || bound >= EVENT_STORE_READ_PAGE_SIZE_MAX) {
        violations.push(
          `${row.file}:${row.line}: a bounded-prefix limit must be an integer literal below the ` +
            `${EVENT_STORE_READ_PAGE_SIZE_MAX}-event page cap, so the bound is the contract rather than the cap; ` +
            `found '${row.declaredLimit}'. See #6277.`,
        );
        continue;
      }
    }

    if (row.classification === "paged-catch-up" && !row.declaresFromVersion) {
      violations.push(
        `${row.file}:${row.line}: a paged-catch-up read must pass fromVersion, since draining a stream page by page ` +
          `is the only thing that makes a bounded limit complete. See #6277.`,
      );
      continue;
    }

    const entry = registryById.get(row.id);
    if (!entry) {
      violations.push(
        `${registryPath}: '${row.id}' (${row.file}:${row.line}) declares '${row.classification}' in source but has no ` +
          `registry entry naming the test that consumes its bound. An annotation alone cannot waive a complete fold. ` +
          `See #6277.`,
      );
      continue;
    }
    if (entry.classification !== row.classification) {
      violations.push(
        `${registryPath}: '${row.id}' is registered as '${entry.classification}' but the source annotation says ` +
          `'${row.classification}'.`,
      );
    }
    if (entry.bound !== row.declaredLimit) {
      violations.push(
        `${registryPath}: '${row.id}' registers bound '${entry.bound}' but the call passes limit ` +
          `'${row.declaredLimit}'.`,
      );
    }
    if (entry.file !== row.file) {
      violations.push(`${registryPath}: '${row.id}' registers file '${entry.file}' but was found in '${row.file}'.`);
    }
    await validateBoundTest(entry, repoRoot, registryPath, violations);
  }

  for (const entry of validEntries) {
    if (!rowsById.has(entry.id)) {
      violations.push(
        `${registryPath}: stale entry '${entry.id}' was not discovered in the corpus; remove it once the site is gone.`,
      );
    }
  }

  if (writeArtifact) {
    writeInventoryArtifact({ repoRoot, artifactOutputPath, rows, registryById });
  }

  return { ok: violations.length === 0, rows, violations };
}

if (process.argv[1]?.endsWith("authoritative-stream-read-inventory.mjs")) {
  const result = await validateAuthoritativeStreamReadInventory({ repoRoot: process.cwd() });
  if (process.argv.includes("--inventory")) {
    console.log(JSON.stringify(result.rows, null, 2));
  }
  if (result.violations.length) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  }
}
