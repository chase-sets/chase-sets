import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import ts from "@chase-sets/typescript-compiler-api";
import { format } from "prettier";
import { importerSpecifierFixture } from "./fixtures/guard-import-candidate-emission/importer-specifier-fixture.mjs";

export const PINNED_SOURCE = Object.freeze({
  commit: "f78143573af96c636d97696b987a82990df23904",
  path: "scripts/release-qualification-scope.mjs",
  blobObjectId: "0c0e536f46d3f597947e4e2b1b08ce97345460df",
  byteLength: 51413,
  sha256: "43f554b410922f491b4aa0c755f73188f5e32cb3ea2d35a7417b99c697f1524c",
});

const declarationName = "collectResolvedImportCodes";
const repoRoot = path.resolve(import.meta.dirname, "../..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function refuse(code, reachedClause) {
  throw Object.assign(new Error(`${code}: ${reachedClause}`), { code, reachedClause });
}

function defaultExecGit(args) {
  return execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

export function readGitObject({ sourceCommit, sourcePath, execGit = defaultExecGit, expectedBlobObjectId }) {
  let blobObjectId;
  try {
    blobObjectId = execGit(["rev-parse", "--verify", `${sourceCommit}:${sourcePath}`])
      .toString("utf8")
      .trim();
  } catch {
    refuse("SOURCE_OBJECT_UNREADABLE", "git-object-read");
  }
  if (expectedBlobObjectId !== undefined && blobObjectId !== expectedBlobObjectId) {
    refuse("SOURCE_BLOB_OBJECT_MISMATCH", "source-blob-object-equality");
  }
  try {
    const bytes = execGit(["cat-file", "blob", blobObjectId]);
    if (!Buffer.isBuffer(bytes)) throw new Error("Git object reader must return raw bytes");
    return { blobObjectId, bytes };
  } catch {
    refuse("SOURCE_OBJECT_UNREADABLE", "git-object-read");
  }
}

export function loadPinnedSource({ sourceCommit, sourcePath, execGit = defaultExecGit }) {
  if (sourceCommit !== PINNED_SOURCE.commit) refuse("SOURCE_COMMIT_NOT_PINNED", "source-commit-equality");
  if (sourcePath !== PINNED_SOURCE.path) refuse("SOURCE_PATH_NOT_PINNED", "source-path-equality");
  const source = readGitObject({ sourceCommit, sourcePath, execGit, expectedBlobObjectId: PINNED_SOURCE.blobObjectId });
  if (source.bytes.length !== PINNED_SOURCE.byteLength) refuse("SOURCE_BYTE_LENGTH_MISMATCH", "source-byte-length");
  if (digest(source.bytes) !== PINNED_SOURCE.sha256) refuse("SOURCE_SHA256_MISMATCH", "source-sha256-equality");
  return source;
}

function bindingNames(name) {
  if (!name) return [];
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
  }
  return [];
}

function isBinding(node) {
  return (
    ts.isVariableDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isFunctionExpression(node) ||
    ts.isImportClause(node) ||
    ts.isImportSpecifier(node) ||
    ts.isNamespaceImport(node) ||
    ts.isImportEqualsDeclaration(node)
  );
}

function isPropertyName(node) {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    ((ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
      parent.label === node)
  );
}

export function selectDeclaration(bytes) {
  const source = ts.createSourceFile(
    "immutable-source.mjs",
    bytes.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (source.parseDiagnostics.length !== 0) refuse("SOURCE_PARSE_DIAGNOSTICS", "source-parse-diagnostics");
  const declarations = [];
  const alternateBindings = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === declarationName) declarations.push(node);
    if (isBinding(node) && bindingNames(node.name).includes(declarationName)) alternateBindings.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (declarations.length === 0) refuse("DECLARATION_ABSENT", "declaration-count-zero");
  if (declarations.length !== 1) refuse("DECLARATION_NOT_UNIQUE", "declaration-count-one");
  const declaration = declarations[0];
  if (declaration.parent !== source) refuse("DECLARATION_NOT_TOP_LEVEL", "declaration-parent-source-file");
  if (alternateBindings.length !== 0) refuse("ALTERNATE_BINDING_PRESENT", "whole-tree-alternate-bindings");

  // A no-lib, single-source program resolves lexical ownership without reading any files.
  const program = ts.createProgram(
    [source.fileName],
    { allowJs: true, noLib: true, noResolve: true },
    {
      getSourceFile: (name) => (name === source.fileName ? source : undefined),
      getDefaultLibFileName: () => "",
      writeFile: () => {},
      getCurrentDirectory: () => "",
      getDirectories: () => [],
      fileExists: (name) => name === source.fileName,
      readFile: () => undefined,
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
    },
  );
  const checker = program.getTypeChecker();
  const free = new Set();
  function collectFree(node) {
    if (ts.isIdentifier(node) && !isPropertyName(node)) {
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      const owned = symbol?.declarations?.some((binding) => {
        for (let owner = binding; owner; owner = owner.parent) if (owner === declaration) return true;
        return false;
      });
      if (!owned) free.add(node.text);
    }
    ts.forEachChild(node, collectFree);
  }
  collectFree(declaration);
  const freeIdentifiers = [...free].sort();
  if (JSON.stringify(freeIdentifiers) !== JSON.stringify(["matchesAny", "path"])) {
    refuse("FREE_IDENTIFIER_UNEXPECTED", "free-identifiers-exactly-path-and-matchesAny");
  }
  const text = source.text.slice(declaration.getStart(source), declaration.end);
  return {
    text,
    byteLength: Buffer.byteLength(text),
    sha256: digest(text),
    freeIdentifiers,
    declarationCount: declarations.length,
    alternateBindingCount: alternateBindings.length,
    parseDiagnosticCount: source.parseDiagnostics.length,
  };
}

export function executeDeclaration(bytes, importerPath, content, matcher = () => false) {
  const selected = selectDeclaration(bytes);
  const candidates = [];
  const recordingMatcher = (candidate, patterns) => {
    candidates.push(candidate);
    return matcher(candidate, patterns);
  };
  const factory = new Function("path", "matchesAny", `"use strict"; return (${selected.text});`);
  const collect = factory(path, recordingMatcher);
  const reasonCodes = new Set();
  collect(importerPath, content, { registry: { seedBootstrapImportReconciliationPatterns: [] } }, reasonCodes);
  return { candidates, reasonCodes, factoryParameterCount: factory.length };
}

export function buildArtifact({
  sourceCommit,
  sourcePath,
  execGit = defaultExecGit,
  fixture = importerSpecifierFixture,
}) {
  const { bytes, blobObjectId } = loadPinnedSource({ sourceCommit, sourcePath, execGit });
  const selected = selectDeclaration(bytes);
  return {
    schemaVersion: 1,
    sourceCommit,
    sourcePath,
    sourceBlobObjectId: blobObjectId,
    sourceByteLength: bytes.length,
    sourceSha256: digest(bytes),
    declarationSha256: selected.sha256,
    declarationByteLength: selected.byteLength,
    recordedChannel: "candidate-construction",
    fixture,
    rows: fixture.map(({ importerPath, specifierText }, index) => ({
      index: index + 1,
      importerPath,
      specifierText,
      candidates: executeDeclaration(selected.text, importerPath, `import value from '${specifierText}'`).candidates,
    })),
  };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      "source-commit": { type: "string" },
      "source-path": { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.out) refuse("OUTPUT_PATH_REQUIRED", "out-argument");
  const artifact = buildArtifact({ sourceCommit: values["source-commit"], sourcePath: values["source-path"] });
  const output = await format(JSON.stringify(artifact), { parser: "json", tabWidth: 2, printWidth: 120 });
  writeFileSync(values.out, output, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.code ?? "GENERATION_FAILED"}: ${error.reachedClause ?? error.message}\n`);
    process.exitCode = 1;
  }
}
