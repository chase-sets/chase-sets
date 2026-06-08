import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import prettier from "prettier";
import ts from "typescript";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";

export const checkedRoots = ["bounded-contexts", "deployables", "packages"];
export const checkedExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
export const defaultLedgerPath = path.join(
  repoRoot,
  "packages",
  "design-system",
  "DESIGN_SYSTEM_LEGACY_INVENTORY.json",
);

const designSystemEntrypoint = "packages/design-system/src/index.ts";
const designSystemUiSourcePrefix = "packages/design-system/src/components/ui/";

const categoryMetadata = {
  canonicalUiSourceFile: {
    phase: "Phase 2",
    issueTargets: ["#945", "#959", "#950", "#951", "#956"],
    outcome: "relocate-or-remove",
    prerequisites: ["#945"],
    evidence: ["relocated exports", "typecheck", "design-system tests", "final audit"],
  },
  embeddedStyle: {
    phase: "Phase 3",
    issueTargets: ["#945", "#946", "#947", "#953", "#956"],
    outcome: "migrate-or-promote-to-design-system",
    prerequisites: ["#946"],
    evidence: ["print primitive migration", "visual artifact", "guardrail"],
  },
  hiddenInput: {
    phase: "Phase 4",
    issueTargets: ["#945", "#953", "#956"],
    outcome: "policy-matrix",
    prerequisites: ["#945", "#953 policy matrix"],
    evidence: ["policy matrix", "guardrail classification"],
  },
  legacyAliasImport: {
    phase: "Phase 3",
    issueTargets: ["#945", "#948", "#949", "#950", "#951", "#956"],
    outcome: "migrate",
    prerequisites: ["#945"],
    evidence: ["consumer migration", "legacy alias guardrail"],
  },
  legacyAliasJsxUsage: {
    phase: "Phase 3",
    issueTargets: ["#945", "#948", "#949", "#950", "#951", "#956"],
    outcome: "migrate",
    prerequisites: ["#945"],
    evidence: ["consumer migration", "legacy alias guardrail"],
  },
  legacyAliasMemberUsage: {
    phase: "Phase 3",
    issueTargets: ["#945", "#948", "#949", "#950", "#951", "#956"],
    outcome: "migrate",
    prerequisites: ["#945"],
    evidence: ["consumer migration", "legacy alias guardrail"],
  },
  legacyResponsiveTableCellMissingLabel: {
    phase: "Phase 4",
    issueTargets: ["#945", "#948", "#952", "#957", "#956"],
    outcome: "migrate",
    prerequisites: ["#945", "#948"],
    evidence: ["mobile table labels", "responsive table guardrail", "mobile visual evidence"],
  },
  legacyUiEntrypointExport: {
    phase: "Phase 4",
    issueTargets: ["#945", "#950", "#951", "#956"],
    outcome: "delete",
    prerequisites: ["#947", "#948", "#949", "#954", "#955", "#959"],
    evidence: ["removed exports", "absence tests", "guardrail"],
  },
  legacyUiSourceImport: {
    phase: "Phase 4",
    issueTargets: ["#945", "#959", "#950", "#951", "#956"],
    outcome: "relocate-or-delete",
    prerequisites: ["#959"],
    evidence: ["source relocation", "guardrail"],
  },
  rawControl: {
    phase: "Phase 4",
    issueTargets: ["#945", "#953", "#956"],
    outcome: "migrate-or-promote-to-design-system",
    prerequisites: ["#945", "#953 policy matrix"],
    evidence: ["design-system primitive", "guardrail classification"],
  },
  rawTable: {
    phase: "Phase 4",
    issueTargets: ["#945", "#952", "#953", "#956"],
    outcome: "migrate-or-promote-to-design-system",
    prerequisites: ["#945"],
    evidence: ["DataTable/table primitive migration", "mobile evidence"],
  },
  routeLocalClassName: {
    phase: "Phase 4",
    issueTargets: ["#945", "#953", "#954", "#955", "#956"],
    outcome: "migrate-or-promote-to-design-system",
    prerequisites: ["#945"],
    evidence: ["design-system primitive or bounded-context helper", "guardrail classification"],
  },
};

const contextOwners = [
  ["deployables/", "Deployable composition"],
  ["packages/design-system/", "Design System"],
];

function sourceKindFor(filePath) {
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".js")) return ts.ScriptKind.JS;
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

function isAppProductionFile(relativeFile) {
  return relativeFile.startsWith("bounded-contexts/") || relativeFile.startsWith("deployables/");
}

function isDesignSystemPrintContractFile(relativeFile) {
  return relativeFile.startsWith("packages/design-system/src/components/print/");
}

function contextNameToOwner(contextName) {
  return contextName
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function ownerFor(relativeFile) {
  const explicitOwner = contextOwners.find(([prefix]) => relativeFile.startsWith(prefix))?.[1];
  if (explicitOwner) return explicitOwner;

  const boundedContextMatch = /^bounded-contexts\/([^/]+)\//.exec(relativeFile);
  if (boundedContextMatch) return contextNameToOwner(boundedContextMatch[1]);

  return "Unclassified";
}

function lineAndColumn(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

function importedNameFor(importSpecifier) {
  return importSpecifier.propertyName?.text ?? importSpecifier.name.text;
}

function moduleIsLegacyUiSource(moduleName, relativeFile) {
  if (moduleName.startsWith("@chase-sets/design-system/components/ui/")) {
    return true;
  }

  if (!moduleName.startsWith(".")) {
    return false;
  }

  const resolvedModule = path.posix.normalize(path.posix.join(path.posix.dirname(relativeFile), moduleName));
  return resolvedModule.startsWith("packages/design-system/src/components/ui/");
}

function isUiAliasName(name) {
  return /^Ui[A-Z]/.test(name);
}

function exportedUiAliasNames(node) {
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return [];

  return node.exportClause.elements
    .map((element) => element.name.text)
    .filter((exportedName) => isUiAliasName(exportedName));
}

function jsxTagName(node) {
  if (ts.isIdentifier(node.tagName)) return node.tagName.text;
  return null;
}

function jsxMemberTag(node) {
  if (
    ts.isPropertyAccessExpression(node.tagName) &&
    ts.isIdentifier(node.tagName.expression) &&
    ts.isIdentifier(node.tagName.name)
  ) {
    return {
      namespace: node.tagName.expression.text,
      member: node.tagName.name.text,
    };
  }

  return null;
}

function stringLiteralAttribute(node, name) {
  const attribute = node.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.text === name,
  );

  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return null;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  return null;
}

function hasJsxAttribute(node, name) {
  return node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.text === name);
}

function createFileResult(relativeFile) {
  return {
    file: relativeFile,
    owner: ownerFor(relativeFile),
    categories: {},
    details: [],
  };
}

function addFinding(fileResult, sourceFile, node, category, detail) {
  fileResult.categories[category] = (fileResult.categories[category] ?? 0) + 1;
  fileResult.details.push({
    category,
    ...lineAndColumn(sourceFile, node),
    detail,
  });
}

function collectFileInventory(filePath, rootDir) {
  const relativeFile = normalizeRelative(filePath, rootDir);
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindFor(filePath));
  const fileResult = createFileResult(relativeFile);
  const designSystemNamespaces = new Set();
  const uiAliasLocalNames = new Set();

  if (relativeFile.startsWith(designSystemUiSourcePrefix)) {
    fileResult.categories.canonicalUiSourceFile = 1;
    fileResult.details.push({
      category: "canonicalUiSourceFile",
      line: 1,
      column: 1,
      detail: "component implemented under legacy components/ui source layout",
    });
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;
      const importClause = node.importClause;

      if (moduleName === "@chase-sets/design-system" && importClause && !importClause.isTypeOnly) {
        if (importClause.namedBindings && ts.isNamespaceImport(importClause.namedBindings)) {
          designSystemNamespaces.add(importClause.namedBindings.name.text);
        }

        if (importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
          for (const element of importClause.namedBindings.elements) {
            if (element.isTypeOnly) continue;
            const importedName = importedNameFor(element);
            if (isUiAliasName(importedName)) {
              uiAliasLocalNames.add(element.name.text);
              addFinding(fileResult, sourceFile, element.name, "legacyAliasImport", importedName);
            }
          }
        }
      }

      if (moduleIsLegacyUiSource(moduleName, relativeFile)) {
        addFinding(fileResult, sourceFile, node.moduleSpecifier, "legacyUiSourceImport", moduleName);
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const moduleName = node.moduleSpecifier.text;

      if (relativeFile === designSystemEntrypoint && moduleIsLegacyUiSource(moduleName, relativeFile)) {
        addFinding(fileResult, sourceFile, node.moduleSpecifier, "legacyUiEntrypointExport", moduleName);
      } else if (relativeFile === designSystemEntrypoint) {
        for (const exportedName of exportedUiAliasNames(node)) {
          addFinding(fileResult, sourceFile, node.exportClause, "legacyUiEntrypointExport", exportedName);
        }
      }
    }

    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = jsxTagName(node);
      const memberTag = jsxMemberTag(node);

      if (tagName && (uiAliasLocalNames.has(tagName) || isUiAliasName(tagName))) {
        addFinding(fileResult, sourceFile, node.tagName, "legacyAliasJsxUsage", tagName);
      }

      if (memberTag && designSystemNamespaces.has(memberTag.namespace) && isUiAliasName(memberTag.member)) {
        addFinding(
          fileResult,
          sourceFile,
          node.tagName,
          "legacyAliasMemberUsage",
          `${memberTag.namespace}.${memberTag.member}`,
        );
      }

      if (tagName === "UiTableCell" && !hasJsxAttribute(node, "data-label")) {
        addFinding(
          fileResult,
          sourceFile,
          node.tagName,
          "legacyResponsiveTableCellMissingLabel",
          "UiTableCell without data-label",
        );
      }

      if (tagName === "style" && !isDesignSystemPrintContractFile(relativeFile)) {
        addFinding(fileResult, sourceFile, node.tagName, "embeddedStyle", tagName ?? "dangerouslySetInnerHTML");
      }

      if (isAppProductionFile(relativeFile) && hasJsxAttribute(node, "className")) {
        addFinding(fileResult, sourceFile, node.tagName, "routeLocalClassName", tagName ?? "member JSX tag");
      }

      if (isAppProductionFile(relativeFile)) {
        if (tagName === "input" && stringLiteralAttribute(node, "type") === "hidden") {
          addFinding(fileResult, sourceFile, node.tagName, "hiddenInput", "input[type=hidden]");
        } else if (["button", "select", "textarea", "input"].includes(tagName ?? "")) {
          addFinding(fileResult, sourceFile, node.tagName, "rawControl", tagName);
        }

        if (["table", "thead", "tbody", "tr", "th", "td"].includes(tagName ?? "")) {
          addFinding(fileResult, sourceFile, node.tagName, "rawTable", tagName);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return Object.keys(fileResult.categories).length > 0 ? fileResult : null;
}

function mergeCategoryMetadata(entry) {
  const categoryNames = Object.keys(entry.categories).sort();
  const phases = new Set();
  const issueTargets = new Set();
  const outcomes = new Set();
  const prerequisites = new Set();
  const evidence = new Set();

  for (const category of categoryNames) {
    const metadata = categoryMetadata[category];
    if (!metadata) continue;
    phases.add(metadata.phase);
    metadata.issueTargets.forEach((issue) => issueTargets.add(issue));
    outcomes.add(metadata.outcome);
    metadata.prerequisites.forEach((prerequisite) => prerequisites.add(prerequisite));
    metadata.evidence.forEach((item) => evidence.add(item));
  }

  return {
    ...entry,
    phase: [...phases].sort().join(", "),
    issueTargets: [...issueTargets].sort(),
    outcome: [...outcomes].sort().join(", "),
    prerequisites: [...prerequisites].sort(),
    closureEvidence: [...evidence].sort(),
    status: "open",
    ownerStatus: "unassigned until scheduled by #960",
  };
}

export async function collectDesignSystemLegacyInventory(options = {}) {
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
    .map((relativeFile) => collectFileInventory(path.join(rootDir, relativeFile), rootDir))
    .filter(Boolean)
    .map(mergeCategoryMetadata)
    .sort((left, right) => left.file.localeCompare(right.file));
}

export function summarizeInventory(entries) {
  const categories = {};
  const owners = {};
  const issues = {};

  for (const entry of entries) {
    owners[entry.owner] = (owners[entry.owner] ?? 0) + 1;
    for (const [category, count] of Object.entries(entry.categories)) {
      categories[category] = (categories[category] ?? 0) + count;
    }
    for (const issue of entry.issueTargets) {
      issues[issue] = (issues[issue] ?? 0) + 1;
    }
  }

  return {
    fileCount: entries.length,
    categories: Object.fromEntries(Object.entries(categories).sort(([left], [right]) => left.localeCompare(right))),
    owners: Object.fromEntries(Object.entries(owners).sort(([left], [right]) => left.localeCompare(right))),
    issues: Object.fromEntries(Object.entries(issues).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function ledgerDocument(entries) {
  return {
    version: 1,
    milestone: 12,
    generatedBy: "pnpm run design-system:legacy-inventory -- --write-ledger",
    description:
      "Design-system legacy pattern inventory for milestone #12. Entries are file/category level and must map to a milestone issue with no permanent exceptions.",
    summary: summarizeInventory(entries),
    entries,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const entries = await collectDesignSystemLegacyInventory();
  const document = ledgerDocument(entries);
  const prettierOptions = (await prettier.resolveConfig(defaultLedgerPath)) ?? {};
  const formattedDocument = await prettier.format(JSON.stringify(document), {
    ...prettierOptions,
    filepath: defaultLedgerPath,
    parser: "json",
  });

  if (args.has("--write-ledger")) {
    mkdirSync(path.dirname(defaultLedgerPath), { recursive: true });
    writeFileSync(defaultLedgerPath, formattedDocument, "utf8");
    console.log(`Wrote ${normalizeRelative(defaultLedgerPath)} with ${entries.length} file(s).`);
    return;
  }

  console.log(formattedDocument);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
