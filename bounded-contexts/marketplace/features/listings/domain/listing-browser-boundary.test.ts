import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const evidence = "bounded-contexts/marketplace/features/listings/domain/evidence-coverage.ts";
const entries = [
  "bounded-contexts/marketplace/features/listings/ui/listing-evidence-readiness.tsx",
  "bounded-contexts/marketplace/client.ts",
];
const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const resolutionCache = ts.createModuleResolutionCache(root, (file) => file, options);
const referenceCache = new Map<string, readonly string[]>();

function hasRuntimeBindings(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
    return (
      clause.namedBindings.elements.length === 0 || clause.namedBindings.elements.some((element) => !element.isTypeOnly)
    );
  }
  if (node.isTypeOnly) return false;
  return (
    !node.exportClause ||
    ts.isNamespaceExport(node.exportClause) ||
    node.exportClause.elements.length === 0 ||
    node.exportClause.elements.some((element) => !element.isTypeOnly)
  );
}

function runtimeReferences(file: string, plantedSource?: string): readonly string[] {
  if (plantedSource === undefined && referenceCache.has(file)) return referenceCache.get(file)!;
  const source = plantedSource ?? readFileSync(file, "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const references: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      hasRuntimeBindings(node)
    )
      references.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      references.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (plantedSource === undefined) referenceCache.set(file, references);
  return references;
}

function nodeImportChains(entry: string, plantedSource?: string): string[] {
  const pending = [{ file: path.join(root, entry), chain: [entry] }];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length) {
    const next = pending.pop()!;
    const file = path.resolve(next.file);
    const { chain } = next;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of runtimeReferences(
      file,
      file === path.resolve(root, evidence) ? plantedSource : undefined,
    )) {
      const next = [...chain, specifier];
      if (isBuiltin(specifier)) {
        violations.push(next.join(" -> "));
        continue;
      }
      if (!specifier.startsWith(".") && !specifier.startsWith("@chase-sets/")) continue;
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys, resolutionCache).resolvedModule;
      expect(resolved, `resolve runtime edge ${next.join(" -> ")}`).toBeDefined();
      if (resolved && !resolved.resolvedFileName.endsWith(".d.ts")) {
        pending.push({ file: resolved.resolvedFileName, chain: next });
      }
    }
  }
  return violations;
}

describe("Listing browser boundary", () => {
  for (const entry of entries) {
    it(`keeps ${entry} runtime closure free of Node built-ins`, () => {
      expect(nodeImportChains(entry)).toEqual([]);
    });

    it(`rejects a planted transitive unsafe value import through ${entry}`, () => {
      const planted = `${readFileSync(path.join(root, evidence), "utf8")}\nimport "./domain";`;
      expect(nodeImportChains(entry, planted).some((chain) => chain.endsWith("node:async_hooks"))).toBe(true);
    });

    it(`rejects a planted empty-binding import edge through ${entry}`, () => {
      const planted = `${readFileSync(path.join(root, evidence), "utf8")}
        import {} from "./domain";
      `;
      expect(nodeImportChains(entry, planted).some((chain) => chain.endsWith("node:async_hooks"))).toBe(true);
    });

    it(`rejects a planted empty-binding export edge through ${entry}`, () => {
      const planted = `${readFileSync(path.join(root, evidence), "utf8")}
        export {} from "./domain";
      `;
      expect(nodeImportChains(entry, planted).some((chain) => chain.endsWith("node:async_hooks"))).toBe(true);
    });

    it(`erases type-only imports and exports through ${entry}`, () => {
      const planted = `${readFileSync(path.join(root, evidence), "utf8")}\n
        import type { MarketplaceListingPhoto } from "./domain";
        import { type DomainEvent } from "@chase-sets/event-core";
        export type { MarketplaceListingState } from "./domain";
        export { type DomainEvent } from "@chase-sets/event-core";
      `;
      expect(nodeImportChains(entry, planted)).toEqual([]);
    });
  }
});
