import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const repoRoot = process.cwd();
const excludedDirectoryNames = new Set([
  ".git",
  ".react-router",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const checkedExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const violations = [];

function shouldSkipDirectory(directoryPath) {
  return directoryPath
    .split(path.sep)
    .some((segment) => excludedDirectoryNames.has(segment));
}

function listTypeScriptFiles(directoryPath) {
  if (shouldSkipDirectory(path.relative(repoRoot, directoryPath))) {
    return [];
  }

  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(entryPath);
    }

    if (!entry.isFile()) {
      return [];
    }

    return checkedExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

function sourceKindFor(filePath) {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function visitNode(sourceFile, node) {
  if (node.kind === ts.SyntaxKind.AnyKeyword) {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      filePath: path.relative(repoRoot, sourceFile.fileName),
      line: position.line + 1,
      column: position.character + 1,
    });
  }

  ts.forEachChild(node, (child) => visitNode(sourceFile, child));
}

for (const filePath of listTypeScriptFiles(repoRoot)) {
  if (!statSync(filePath).isFile()) {
    continue;
  }

  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKindFor(filePath),
  );
  visitNode(sourceFile, sourceFile);
}

if (violations.length > 0) {
  console.error("Explicit TypeScript 'any' is not allowed:");
  for (const violation of violations) {
    console.error(`${violation.filePath}:${violation.line}:${violation.column}`);
  }
  process.exit(1);
}

console.log("No explicit TypeScript 'any' usage found.");
