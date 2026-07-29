import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript/unstable/ast";

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

function annotationBefore(content, index) {
  const linesBefore = content.slice(0, index).split(/\r?\n/);
  const window = linesBefore.slice(Math.max(0, linesBefore.length - 1 - ANNOTATION_LOOKBACK_LINES));
  for (let offset = window.length - 1; offset >= 0; offset -= 1) {
    const match = window[offset].match(ANNOTATION_PATTERN);
    if (match) return match[1];
  }
  return null;
}

function lineNumberAt(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

/** Tokenizes TypeScript/JavaScript without treating strings or comments as code. */
function tokenize(content) {
  const scanner = ts.createScanner(true, ts.LanguageVariant.Standard, content);
  const tokens = [];
  const append = (kind) => {
    tokens.push({
      kind,
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
      start: scanner.getTokenStart(),
      end: scanner.getTokenEnd(),
    });
  };
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFile; kind = scanner.scan()) {
    append(kind);
    if (kind !== ts.SyntaxKind.TemplateHead && kind !== ts.SyntaxKind.TemplateMiddle) continue;

    // The TypeScript scanner deliberately leaves a template interpolation open
    // for the caller to parse. This inventory only needs the template as one
    // expression, so consume each interpolation and re-scan its tail before
    // continuing with the surrounding source.
    let braceDepth = 0;
    for (;;) {
      const interpolationKind = scanner.scan();
      if (interpolationKind === ts.SyntaxKind.OpenBraceToken) braceDepth += 1;
      if (interpolationKind !== ts.SyntaxKind.CloseBraceToken || braceDepth-- > 0) continue;
      kind = scanner.reScanTemplateToken(false);
      append(kind);
      if (kind === ts.SyntaxKind.TemplateTail || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) break;
      braceDepth = 0;
    }
  }
  return tokens;
}

function matchingToken(tokens, openIndex, open, close) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].text === open) depth += 1;
    if (tokens[index].text === close && --depth === 0) return index;
  }
  return -1;
}

function isIdentifier(token, name) {
  return token?.kind === ts.SyntaxKind.Identifier && (name === undefined || token.value === name);
}

function expressionText(tokens, start, end) {
  return tokens
    .slice(start, end)
    .map((token) => token.text)
    .join("");
}

function staticString(tokens, constants, seen = new Set()) {
  if (!tokens.length) return null;
  if (
    tokens.length === 1 &&
    (tokens[0].kind === ts.SyntaxKind.StringLiteral || tokens[0].kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral)
  ) {
    return tokens[0].value;
  }
  const plus = tokens.findIndex((token) => token.text === "+");
  if (plus > 0) {
    const left = staticString(tokens.slice(0, plus), constants, seen);
    const right = staticString(tokens.slice(plus + 1), constants, seen);
    return left === null || right === null ? null : left + right;
  }
  if (tokens.length === 1 && isIdentifier(tokens[0]) && !seen.has(tokens[0].value)) {
    const initializer = constants.get(tokens[0].value);
    return initializer ? staticString(initializer, constants, new Set([...seen, tokens[0].value])) : null;
  }
  return null;
}

function callProperties(tokens, openParen) {
  if (tokens[openParen + 1]?.text !== "{") return { declaredLimit: null, declaresFromVersion: false };
  const closeBrace = matchingToken(tokens, openParen + 1, "{", "}");
  if (closeBrace === -1) return { declaredLimit: null, declaresFromVersion: false };
  let declaredLimit = null;
  let declaresFromVersion = false;
  for (let index = openParen + 2; index < closeBrace; index += 1) {
    if (!isIdentifier(tokens[index])) continue;
    if (tokens[index].value === "fromVersion") declaresFromVersion = true;
    if (tokens[index].value === "limit" && tokens[index + 1]?.text === ":") {
      let end = index + 2;
      while (end < closeBrace && tokens[end].text !== ",") end += 1;
      declaredLimit = expressionText(tokens, index + 2, end).trim();
    }
  }
  return { declaredLimit, declaresFromVersion };
}

function advancesCursorByCount(tokens, callIndex) {
  let loopStart = -1;
  for (let index = callIndex; index >= 0; index -= 1) {
    if (["for", "while", "do"].includes(tokens[index].text)) {
      loopStart = index;
      break;
    }
  }
  if (loopStart === -1) return false;
  const bodyStart = tokens.findIndex((token, index) => index >= loopStart && token.text === "{");
  const bodyEnd = bodyStart === -1 ? -1 : matchingToken(tokens, bodyStart, "{", "}");
  if (bodyEnd === -1 || callIndex > bodyEnd) return false;
  for (let index = bodyStart + 1; index < bodyEnd - 2; index += 1) {
    if (!isIdentifier(tokens[index], "fromVersion") || !["=", "+="].includes(tokens[index + 1]?.text)) continue;
    let end = index + 2;
    while (end < bodyEnd && tokens[end].text !== ";") end += 1;
    const right = tokens.slice(index + 2, end);
    if (right.some((token) => token.text === "length") && !right.some((token) => token.text === "streamVersion"))
      return true;
  }
  return false;
}

function collectStreamReadReferences(content) {
  const tokens = tokenize(content);
  const constants = new Map();
  const eventStoreAliases = new Set();
  const references = [];

  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (
      !["const", "let", "var"].includes(tokens[index].text) ||
      !isIdentifier(tokens[index + 1]) ||
      tokens[index + 2]?.text !== "="
    )
      continue;
    let end = index + 3;
    // Bindings relevant to computed member access are deliberately small. A
    // bounded token window keeps a malformed or semicolon-free declaration
    // from turning a repository sweep into a quadratic scan.
    while (end < tokens.length && end < index + 200 && ![";", "}"].includes(tokens[end].text)) end += 1;
    const initializer = tokens.slice(index + 3, end);
    constants.set(tokens[index + 1].value, initializer);
    if (
      initializer.length <= 6 &&
      /eventStore/i.test(initializer.at(-1)?.value ?? initializer.at(-1)?.text ?? "") &&
      !initializer.some((token) => token.value === "readStream")
    ) {
      eventStoreAliases.add(tokens[index + 1].value);
    }
  }

  const isEventStore = (token) =>
    isIdentifier(token) && (/eventStore$/i.test(token.value) || eventStoreAliases.has(token.value));
  const addReference = (token, kind, callIndex = -1) => {
    const properties =
      callIndex === -1 ? { declaredLimit: null, declaresFromVersion: false } : callProperties(tokens, callIndex);
    references.push({
      index: token.start,
      line: lineNumberAt(content, token.start),
      kind,
      ...properties,
      advancesCursorByCount: callIndex === -1 ? false : advancesCursorByCount(tokens, callIndex),
    });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isIdentifier(token, "readStream") && tokens[index - 1]?.text === ".") {
      addReference(token, tokens[index + 1]?.text === "(" ? "direct-call" : "indirect-reference", index + 1);
    } else if (isEventStore(token) && tokens[index + 1]?.text === "[") {
      const close = matchingToken(tokens, index + 1, "[", "]");
      if (close === -1) continue;
      const property = staticString(tokens.slice(index + 2, close), constants);
      if (property === "readStream") addReference(token, "computed-access", close + 1);
      else if (property === null) addReference(token, "unresolved-computed-access", close + 1);
    } else if (isIdentifier(token, "readStream") && tokens[index - 1]?.text === "{") {
      const close = matchingToken(tokens, index - 1, "{", "}");
      if (close !== -1 && tokens[close + 1]?.text === "=") addReference(token, "indirect-reference");
    }
  }
  return references;
}

function collectCompleteStreamCalls(content) {
  if (!content.includes(CANONICAL_COMPLETE_STREAM_MODULE)) return [];
  const tokens = tokenize(content);
  return tokens
    .filter((token, index) => isIdentifier(token, CANONICAL_COMPLETE_STREAM_READER) && tokens[index + 1]?.text === "(")
    .map((token) => ({ index: token.start, line: lineNumberAt(content, token.start) }));
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
      // This is only a corpus prefilter. The candidate analysis below remains
      // token-aware so split strings, aliases, destructuring, and computed
      // access cannot disappear from the inventory.
      if (
        !content.includes("eventStore") &&
        !content.includes("readStream") &&
        !content.includes(CANONICAL_COMPLETE_STREAM_READER)
      ) {
        continue;
      }
      const canonicalModule = CANONICAL_STREAM_READ_MODULES.has(relativeFile);

      for (const reference of collectStreamReadReferences(content, filePath)) {
        const declaredClassification = canonicalModule ? null : annotationBefore(content, reference.index);
        rows.push({
          file: relativeFile,
          line: reference.line,
          mechanism: "readStream",
          referenceKind: reference.kind,
          classification: canonicalModule ? "event-store-implementation" : (declaredClassification ?? "undeclared"),
          declaredLimit: reference.declaredLimit,
          declaresFromVersion: reference.declaresFromVersion,
          advancesCursorByCount: reference.advancesCursorByCount,
        });
      }

      if (canonicalModule) continue;

      for (const call of collectCompleteStreamCalls(content, filePath)) {
        rows.push({
          file: relativeFile,
          line: call.line,
          mechanism: CANONICAL_COMPLETE_STREAM_READER,
          referenceKind: "direct-call",
          classification: "complete-history",
          declaredLimit: null,
          declaresFromVersion: false,
          advancesCursorByCount: false,
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

    if (row.referenceKind !== "direct-call") {
      violations.push(
        `${row.file}:${row.line}: readStream is referenced without being called directly (alias, destructure, computed ` +
          `access, or unresolved computed access). A wrapper hides the page cap from every call-shaped review, so it is rejected outright. ` +
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

    if (row.classification === "paged-catch-up" && row.advancesCursorByCount) {
      violations.push(
        `${row.file}:${row.line}: a paged-catch-up cursor must advance from the last event's streamVersion plus one, ` +
          `never from page.length. Sparse stream versions make count-based advancement skip or repeat events. See #6277.`,
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
