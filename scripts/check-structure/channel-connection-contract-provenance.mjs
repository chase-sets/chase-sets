import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles } from "../lib/files.mjs";

const connectionContractPath = "bounded-contexts/channels/features/connections/domain/contracts.ts";
const channelsServicesContractPath = "bounded-contexts/channels/support/runtime-support/services.ts";
const channelsRootSpecifier = "@chase-sets/channels";
export const channelConnectionCanonicalContractPathBySymbol = new Map([
  ["ChannelEnvironment", connectionContractPath],
  ["ChannelConnectionSetupResolver", connectionContractPath],
  ["ChannelCredentialAuthorityResolver", connectionContractPath],
  ["ChannelStorageLocationAuthorityResolver", connectionContractPath],
  ["ChannelPolicyAuthorityResolver", connectionContractPath],
  ["ChannelConnectionServices", connectionContractPath],
  ["ChannelConnectionHostPorts", connectionContractPath],
  ["ChannelsServices", channelsServicesContractPath],
]);
const channelConnectionSymbols = new Set(channelConnectionCanonicalContractPathBySymbol.keys());
const economicsPublicSymbols = new Set(["ChannelEnvironment", "ChannelProviderIdentity"]);
const economicsRoot = "bounded-contexts/pricing/features/economics";

export function findChannelConnectionContractProvenanceViolations(source, relativeFile = "fixture.ts") {
  const parsed = ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];
  const importedCanonicalSymbols = new Set();
  const importedPublicSymbols = new Set();
  const referencedCanonicalSymbols = new Set();
  const normalizedRelativeFile = relativeFile.replaceAll("\\", "/");
  const isEconomicsFile = normalizedRelativeFile.startsWith(`${economicsRoot}/`);
  const requiredSymbols = isEconomicsFile ? economicsPublicSymbols : channelConnectionSymbols;

  for (const statement of parsed.statements) {
    if (
      (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
      requiredSymbols.has(statement.name.text) &&
      normalizedRelativeFile !== channelConnectionCanonicalContractPathBySymbol.get(statement.name.text)
    ) {
      violations.push(`${relativeFile}: redeclares ${statement.name.text} instead of importing the canonical contract`);
    }
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text.replaceAll("\\", "/");
      const resolved = specifier.startsWith(".")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(normalizedRelativeFile), specifier))
        : specifier;
      const bindings = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : statement.exportClause;
      if (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))) {
        for (const element of bindings.elements) {
          const exportedName = element.propertyName?.text ?? element.name.text;
          const localName = element.name.text;
          const canonicalPath = channelConnectionCanonicalContractPathBySymbol.get(exportedName);
          if (canonicalPath && (resolved === canonicalPath || `${resolved}.ts` === canonicalPath)) {
            importedCanonicalSymbols.add(exportedName);
            importedCanonicalSymbols.add(localName);
          }
          if (specifier === channelsRootSpecifier && economicsPublicSymbols.has(exportedName)) {
            importedPublicSymbols.add(exportedName);
            importedPublicSymbols.add(localName);
          }
        }
      }
    }
  }

  function visit(node) {
    if (ts.isTypeAssertionExpression(node) || ts.isAsExpression(node)) {
      if (ts.isTypeLiteralNode(node.type)) {
        violations.push(`${relativeFile}: uses a structural as/type assertion for a Channel Connection contract`);
      }
    }
    if (ts.isIdentifier(node) && requiredSymbols.has(node.text)) referencedCanonicalSymbols.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(parsed);

  for (const symbol of referencedCanonicalSymbols) {
    const canonicalPath = channelConnectionCanonicalContractPathBySymbol.get(symbol);
    if (normalizedRelativeFile !== canonicalPath) {
      const importedFromRequiredBoundary = isEconomicsFile
        ? importedPublicSymbols.has(symbol)
        : importedCanonicalSymbols.has(symbol);
      if (!importedFromRequiredBoundary) {
        violations.push(
          isEconomicsFile
            ? `${relativeFile}: references ${symbol} without importing it from ${channelsRootSpecifier}`
            : `${relativeFile}: references ${symbol} without importing it from ${canonicalPath}`,
        );
      }
    }
  }

  return [...new Set(violations)].sort();
}

export async function validateChannelConnectionContractProvenance({ repoRoot }) {
  const violations = [];
  for (const relativeRoot of ["bounded-contexts/channels", economicsRoot]) {
    const root = path.join(repoRoot, relativeRoot);
    const files = await collectFiles(root, { extensions: new Set([".ts", ".tsx"]) });
    for (const absolute of files) {
      const relative = path.relative(repoRoot, absolute).replaceAll("\\", "/");
      if (relative.includes("/tests/") || /\.(?:test|spec)\.[^/]+$/.test(relative)) continue;
      violations.push(...findChannelConnectionContractProvenanceViolations(await readFile(absolute, "utf8"), relative));
    }
  }
  return { violations };
}
