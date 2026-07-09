import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";

export const checkedRoots = ["bounded-contexts", "deployables", "packages"];
export const frameworkFormModules = new Set(["react-router", "@remix-run/react"]);
export const checkedExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);

export const approvedRawFormImplementationFiles = new Set(["packages/design-system/src/components/forms/form.tsx"]);

export const approvedFrameworkFormAdapterFiles = new Set([
  "packages/design-system/src/components/forms/router-form.tsx",
]);

const violationKinds = ["rawJsxForm", "rawCreateElementForm", "frameworkFormImport", "frameworkFormUsage"];

function sourceKindFor(filePath) {
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith(".js")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isCheckedProductionFile(relativeFile) {
  const normalized = relativeFile.replaceAll("\\", "/");

  if (!checkedRoots.some((root) => normalized.startsWith(`${root}/`))) return false;
  if (!checkedExtensions.has(path.extname(normalized))) return false;
  if (normalized.endsWith(".d.ts")) return false;
  if (normalized.includes("/__tests__/")) return false;
  if (normalized.includes("/fixtures/")) return false;
  if (normalized.includes("/test-fixtures/")) return false;
  if (normalized.includes(".test.")) return false;
  if (normalized.includes(".spec.")) return false;
  if (normalized.includes(".stories.")) return false;
  if (normalized.includes(".test-data.")) return false;

  return true;
}

function lineAndColumn(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

function tagNameMatchesFrameworkForm(tagName, frameworkFormLocalNames, frameworkFormNamespaces) {
  if (ts.isIdentifier(tagName)) {
    return frameworkFormLocalNames.has(tagName.text);
  }

  if (ts.isPropertyAccessExpression(tagName) && ts.isIdentifier(tagName.expression) && tagName.name.text === "Form") {
    return frameworkFormNamespaces.has(tagName.expression.text);
  }

  return false;
}

function importedNameFor(importSpecifier) {
  return importSpecifier.propertyName?.text ?? importSpecifier.name.text;
}

function isCreateElementExpression(expression) {
  if (ts.isIdentifier(expression) && expression.text === "createElement") {
    return true;
  }

  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "React" &&
    expression.name.text === "createElement"
  );
}

function isFormStringLiteral(node) {
  return ts.isStringLiteral(node) && node.text === "form";
}

function report(violations, sourceFile, relativeFile, node, kind, detail) {
  const position = lineAndColumn(sourceFile, node);
  violations.push({
    kind,
    file: relativeFile,
    line: position.line,
    column: position.column,
    detail,
  });
}

function collectFileViolations(filePath, rootDir) {
  const relativeFile = normalizeRelative(filePath, rootDir);
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindFor(filePath));
  const frameworkFormLocalNames = new Set();
  const frameworkFormNamespaces = new Set();
  const violations = [];

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      const importClause = node.importClause;

      if (frameworkFormModules.has(moduleName) && importClause && !importClause.isTypeOnly) {
        if (importClause.name?.text === "Form") {
          frameworkFormLocalNames.add(importClause.name.text);
          if (!approvedFrameworkFormAdapterFiles.has(relativeFile)) {
            report(violations, sourceFile, relativeFile, importClause.name, "frameworkFormImport", moduleName);
          }
        }

        if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
          for (const element of importClause.namedBindings.elements) {
            if (element.isTypeOnly) {
              continue;
            }

            if (importedNameFor(element) === "Form") {
              frameworkFormLocalNames.add(element.name.text);
              if (!approvedFrameworkFormAdapterFiles.has(relativeFile)) {
                report(violations, sourceFile, relativeFile, element.name, "frameworkFormImport", moduleName);
              }
            }
          }
        }

        if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
          frameworkFormNamespaces.add(importClause.namedBindings.name.text);
        }
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;

      if (
        frameworkFormModules.has(moduleName) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        !approvedFrameworkFormAdapterFiles.has(relativeFile)
      ) {
        for (const element of node.exportClause.elements) {
          if (importedNameFor(element) === "Form") {
            report(violations, sourceFile, relativeFile, element.name, "frameworkFormImport", moduleName);
          }
        }
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (
        ts.isIdentifier(node.tagName) &&
        node.tagName.text === "form" &&
        !approvedRawFormImplementationFiles.has(relativeFile)
      ) {
        report(violations, sourceFile, relativeFile, node.tagName, "rawJsxForm", "lowercase <form>");
      }

      if (
        tagNameMatchesFrameworkForm(node.tagName, frameworkFormLocalNames, frameworkFormNamespaces) &&
        !approvedFrameworkFormAdapterFiles.has(relativeFile)
      ) {
        report(violations, sourceFile, relativeFile, node.tagName, "frameworkFormUsage", "framework Form JSX");
      }
    }

    if (
      ts.isCallExpression(node) &&
      isCreateElementExpression(node.expression) &&
      node.arguments.length > 0 &&
      isFormStringLiteral(node.arguments[0]) &&
      !approvedRawFormImplementationFiles.has(relativeFile)
    ) {
      report(violations, sourceFile, relativeFile, node.arguments[0], "rawCreateElementForm", 'createElement("form")');
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.name.text === "Form" &&
      frameworkFormNamespaces.has(node.expression.text) &&
      !approvedFrameworkFormAdapterFiles.has(relativeFile)
    ) {
      report(violations, sourceFile, relativeFile, node.name, "frameworkFormUsage", "framework Form member usage");
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

export async function collectLegacyFormViolations(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const files = [];

  for (const root of checkedRoots) {
    files.push(
      ...(await collectFiles(path.join(rootDir, root), {
        extensions: checkedExtensions,
        skippedDirectories: defaultSkippedDirectories,
      })),
    );
  }

  return files
    .map((filePath) => normalizeRelative(filePath, rootDir))
    .filter(isCheckedProductionFile)
    .flatMap((relativeFile) => collectFileViolations(path.join(rootDir, relativeFile), rootDir))
    .sort((left, right) => {
      if (left.file !== right.file) return left.file.localeCompare(right.file);
      if (left.line !== right.line) return left.line - right.line;
      if (left.column !== right.column) return left.column - right.column;
      return left.kind.localeCompare(right.kind);
    });
}

export function summarizeViolations(violations) {
  const entriesByFile = new Map();

  for (const violation of violations) {
    const existing = entriesByFile.get(violation.file) ?? {
      file: violation.file,
      rawJsxForm: 0,
      rawCreateElementForm: 0,
      frameworkFormImport: 0,
      frameworkFormUsage: 0,
    };
    existing[violation.kind] += 1;
    entriesByFile.set(violation.file, existing);
  }

  return [...entriesByFile.values()].sort((left, right) => left.file.localeCompare(right.file));
}

function violationCount(entry, kind) {
  return typeof entry?.[kind] === "number" ? entry[kind] : 0;
}

export async function checkLegacyForms(options = {}) {
  const mode = "final";
  const violations = await collectLegacyFormViolations(options);
  const entries = summarizeViolations(violations);

  return {
    mode,
    passed: entries.length === 0,
    entries,
    newViolations: entries.flatMap((entry) =>
      violationKinds
        .filter((kind) => violationCount(entry, kind) > 0)
        .map((kind) => ({
          file: entry.file,
          kind,
          currentCount: violationCount(entry, kind),
          allowedCount: 0,
        })),
    ),
  };
}

function formatCount(kind, count) {
  const labels = {
    rawJsxForm: "raw <form>",
    rawCreateElementForm: 'createElement("form")',
    frameworkFormImport: "framework Form import",
    frameworkFormUsage: "framework Form usage",
  };
  return `${count} ${labels[kind] ?? kind}`;
}

function printCheckResult(result) {
  if (result.newViolations.length > 0) {
    console.error("Legacy form guardrail failed.");
    console.error("Use the shared design-system Form pattern instead of raw <form> or direct framework Form usage.");
    for (const violation of result.newViolations) {
      console.error(
        `- ${violation.file}: ${formatCount(violation.kind, violation.currentCount)} exceeds baseline ${violation.allowedCount}`,
      );
    }
  }

  if (result.passed) {
    console.log(`Legacy form guardrail passed in ${result.mode} mode with zero legacy form file(s).`);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const unsupportedArgs = [...args].filter((arg) => arg !== "--final");
  if (unsupportedArgs.length > 0) {
    throw new Error("Usage: node ./scripts/check-no-legacy-forms.mjs [--final]");
  }

  const result = await checkLegacyForms();
  printCheckResult(result);

  if (!result.passed) {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
