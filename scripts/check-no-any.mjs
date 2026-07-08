import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";
import { repoRoot } from "./lib/repo.mjs";

const checkedExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const violations = [];

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

for (const filePath of await collectFiles(repoRoot, {
  extensions: checkedExtensions,
  skippedDirectories: defaultSkippedDirectories,
})) {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindFor(filePath));
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
