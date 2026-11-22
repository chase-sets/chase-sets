import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

const routeExports = new Set(["default", "loader", "action", "meta", "headers"]);

export function findFeatureRouteReexports(repoRoot, adapterFile, content) {
  const contextRoot = adapterFile.match(/^(bounded-contexts\/[^/]+)\/routes\//)?.[1];
  if (!contextRoot) return [];
  const sourceText =
    content ??
    (existsSync(path.join(repoRoot, adapterFile)) ? readFileSync(path.join(repoRoot, adapterFile), "utf8") : "");
  if (!/\bexport\s*\{/.test(sourceText)) return [];

  const source = ts.createSourceFile(adapterFile, sourceText, ts.ScriptTarget.Latest);
  const targets = new Set();
  for (const statement of source.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause) ||
      !statement.exportClause.elements.some((element) => !element.isTypeOnly && routeExports.has(element.name.text))
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) continue;
    const targetBase = path.posix.normalize(path.posix.join(path.posix.dirname(adapterFile), specifier.text));
    if (
      !targetBase.startsWith(`${contextRoot}/features/`) ||
      !/^[^/]+\/ui\/routes\/.+/.test(targetBase.slice(`${contextRoot}/features/`.length))
    ) {
      continue;
    }
    for (const candidate of [targetBase, `${targetBase}.tsx`, `${targetBase}.ts`]) {
      if (/\.tsx?$/.test(candidate) && existsSync(path.join(repoRoot, candidate))) {
        targets.add(candidate);
        break;
      }
    }
  }
  return [...targets];
}
