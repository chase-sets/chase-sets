import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles } from "../lib/files.mjs";

const canonicalContractPath = "bounded-contexts/channels/features/connections/domain/contracts.ts";
const canonicalSymbols = new Set([
  "ChannelEnvironment",
  "ChannelConnectionSetupResolver",
  "ChannelCredentialAuthorityResolver",
  "ChannelStorageLocationAuthorityResolver",
  "ChannelPolicyAuthorityResolver",
  "ChannelConnectionServices",
  "ChannelConnectionHostPorts",
  "ChannelsServices",
]);

export function findChannelConnectionContractProvenanceViolations(source, relativeFile = "fixture.ts") {
  const parsed = ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];
  const importedCanonicalSymbols = new Set();
  const referencedCanonicalSymbols = new Set();

  for (const statement of parsed.statements) {
    if (
      relativeFile.replaceAll("\\", "/") !== canonicalContractPath &&
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "ChannelEnvironment"
    ) {
      violations.push(`${relativeFile}: redeclares ChannelEnvironment instead of importing the canonical union`);
    }
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text.replaceAll("\\", "/");
      const resolved = specifier.startsWith(".")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(relativeFile.replaceAll("\\", "/")), specifier))
        : specifier;
      if (resolved !== canonicalContractPath && `${resolved}.ts` !== canonicalContractPath) {
        continue;
      }
      const bindings = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : statement.exportClause;
      if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
        for (const element of bindings.elements) importedCanonicalSymbols.add(element.name.text);
      }
    }
  }

  function visit(node) {
    if (ts.isTypeAssertionExpression(node) || ts.isAsExpression(node)) {
      if (ts.isTypeLiteralNode(node.type)) {
        violations.push(`${relativeFile}: uses a structural as/type assertion for a Channel Connection contract`);
      }
    }
    if (ts.isIdentifier(node) && canonicalSymbols.has(node.text)) referencedCanonicalSymbols.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(parsed);

  if (relativeFile.replaceAll("\\", "/") !== canonicalContractPath) {
    for (const symbol of referencedCanonicalSymbols) {
      if (!importedCanonicalSymbols.has(symbol)) {
        violations.push(
          `${relativeFile}: references ${symbol} without importing it from the canonical contract module`,
        );
      }
    }
  }

  return [...new Set(violations)].sort();
}

export async function validateChannelConnectionContractProvenance({ repoRoot }) {
  const root = path.join(repoRoot, "bounded-contexts/channels");
  const files = await collectFiles(root, { extensions: new Set([".ts", ".tsx"]) });
  const violations = [];
  for (const absolute of files) {
    const relative = path.relative(repoRoot, absolute).replaceAll("\\", "/");
    if (relative.includes("/tests/") || /\.(?:test|spec)\.[^/]+$/.test(relative)) continue;
    violations.push(...findChannelConnectionContractProvenanceViolations(await readFile(absolute, "utf8"), relative));
  }
  return { violations };
}
