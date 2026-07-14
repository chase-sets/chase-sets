import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import prettier from "prettier";
import ts from "@chase-sets/typescript-compiler-api";
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
    severity: "error",
    phase: "Phase 2",
    issueTargets: ["#945", "#959", "#950", "#951", "#956"],
    outcome: "relocate-or-remove",
    prerequisites: ["#945"],
    evidence: ["relocated exports", "typecheck", "design-system tests", "final audit"],
  },
  embeddedStyle: {
    severity: "error",
    phase: "Phase 3",
    issueTargets: ["#945", "#946", "#947", "#953", "#956"],
    outcome: "migrate-or-promote-to-design-system",
    prerequisites: ["#946"],
    evidence: ["print primitive migration", "visual artifact", "guardrail"],
  },
  hiddenInput: {
    severity: "error",
    phase: "Phase 4",
    issueTargets: ["#945", "#953", "#956"],
    outcome: "policy-matrix",
    prerequisites: ["#945", "#953 policy matrix"],
    evidence: ["policy matrix", "guardrail classification"],
  },
  inlineStyle: {
    severity: "warning",
    phase: "Phase G3",
    issueTargets: ["#1666"],
    outcome: "migrate-or-promote-to-design-system",
    prerequisites: ["#1665"],
    evidence: ["inline style inventory", "documented exception allow-list", "warning-tier guardrail"],
  },
  legacyAliasImport: {
    severity: "error",
    phase: "Phase 3",
    issueTargets: ["#945", "#948", "#949", "#950", "#951", "#956"],
    outcome: "migrate",
    prerequisites: ["#945"],
    evidence: ["consumer migration", "legacy alias guardrail"],
  },
  legacyAliasJsxUsage: {
    severity: "error",
    phase: "Phase 3",
    issueTargets: ["#945", "#948", "#949", "#950", "#951", "#956"],
    outcome: "migrate",
    prerequisites: ["#945"],
    evidence: ["consumer migration", "legacy alias guardrail"],
  },
  legacyAliasMemberUsage: {
    severity: "error",
    phase: "Phase 3",
    issueTargets: ["#945", "#948", "#949", "#950", "#951", "#956"],
    outcome: "migrate",
    prerequisites: ["#945"],
    evidence: ["consumer migration", "legacy alias guardrail"],
  },
  legacyResponsiveTableCellMissingLabel: {
    severity: "error",
    phase: "Phase 4",
    issueTargets: ["#945", "#948", "#952", "#957", "#956"],
    outcome: "migrate",
    prerequisites: ["#945", "#948"],
    evidence: ["mobile table labels", "responsive table guardrail", "mobile visual evidence"],
  },
  legacyUiEntrypointExport: {
    severity: "error",
    phase: "Phase 4",
    issueTargets: ["#945", "#950", "#951", "#956"],
    outcome: "delete",
    prerequisites: ["#947", "#948", "#949", "#954", "#955", "#959"],
    evidence: ["removed exports", "absence tests", "guardrail"],
  },
  legacyUiSourceImport: {
    severity: "error",
    phase: "Phase 4",
    issueTargets: ["#945", "#959", "#950", "#951", "#956"],
    outcome: "relocate-or-delete",
    prerequisites: ["#959"],
    evidence: ["source relocation", "guardrail"],
  },
  rawControl: {
    severity: "error",
    phase: "Phase 4",
    issueTargets: ["#945", "#953", "#956"],
    outcome: "migrate-or-promote-to-design-system",
    prerequisites: ["#945", "#953 policy matrix"],
    evidence: ["design-system primitive", "guardrail classification"],
  },
  rawStructuralElement: {
    severity: "warning",
    phase: "Phase G3",
    issueTargets: ["#1666"],
    outcome: "migrate-or-promote-to-design-system",
    prerequisites: ["#1665"],
    evidence: ["structural element inventory", "documented exception allow-list", "warning-tier guardrail"],
  },
  rawTable: {
    severity: "error",
    phase: "Phase 4",
    issueTargets: ["#945", "#952", "#953", "#956"],
    outcome: "migrate-or-promote-to-design-system",
    prerequisites: ["#945"],
    evidence: ["DataTable/table primitive migration", "mobile evidence"],
  },
  routeLocalClassName: {
    severity: "error",
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

export function sourceKindFor(filePath) {
  if (filePath.endsWith(".tsx") || filePath.endsWith(".jsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function isCheckedProductionFile(relativeFile) {
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

function isFeatureUiFile(relativeFile) {
  return isAppProductionFile(relativeFile);
}

function isDesignSystemPrintContractFile(relativeFile) {
  return relativeFile.startsWith("packages/design-system/src/components/print/");
}

const rawStructuralElementTags = new Set([
  "div",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "li",
  "a",
  "main",
  "img",
]);

const inlineStyleAllowList = [
  {
    path: "bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx",
    markers: ["--step-count"],
    reason: "Dynamic CSS variable bridges runtime step count into an existing design-system layout contract.",
  },
  {
    path: "bounded-contexts/discovery/features/item-detail/ui",
    markers: ["aspectRatio", "style"],
    reason: "Product media placeholders may inject runtime gallery aspect ratios until image primitives own the value.",
  },
];

const rawStructuralElementAllowList = [
  {
    path: "bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx",
    tagName: "main",
    markers: ["id", "main-content"],
    reason: "The public waitlist keeps one raw main landmark with an id for skip-link targeting.",
  },
  {
    path: "deployables/",
    tagName: "main",
    markers: [],
    reason: "Deployable composition roots may expose a single raw main landmark while apps compose bounded-context UI.",
  },
  {
    path: "bounded-contexts/",
    tagName: "img",
    markers: [],
    reason: "Raw product/media img tags remain tolerated until the design-system Image migration is complete.",
  },
];

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

function jsxAttribute(node, name) {
  return node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.text === name);
}

const responsiveDimensionStyleKeys = new Set(["width", "height", "minWidth", "maxWidth"]);

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function isPixelStyleValue(node) {
  if (ts.isNumericLiteral(node)) return Number(node.text) !== 0;
  if (
    ts.isPrefixUnaryExpression(node) &&
    (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(node.operand)
  ) {
    return Number(node.operand.text) !== 0;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)px$/i.test(node.text.trim());
  }
  return false;
}

/**
 * Responsive safety owns pixel-valued dimension styles so the legacy inventory
 * does not report the same JSX style attribute a second time.
 */
export function inlineStyleHasPixelDimension(node) {
  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
  const attribute = jsxAttribute(node, "style");
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return false;
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) return false;

  const expression = attribute.initializer.expression;
  if (!ts.isObjectLiteralExpression(expression)) return false;

  return expression.properties.some((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const name = propertyNameText(property.name);
    return name !== null && responsiveDimensionStyleKeys.has(name) && isPixelStyleValue(property.initializer);
  });
}

export function rawClassNameJsxElementFinding(sourceFile, node) {
  if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return null;
  if (!hasJsxAttribute(node, "className")) return null;

  const tagName = jsxTagName(node);

  return {
    node: node.tagName,
    detail: tagName ?? "member JSX tag",
  };
}

export function rawClassNameHostElementFinding(sourceFile, node) {
  const finding = rawClassNameJsxElementFinding(sourceFile, node);
  if (!finding) return null;

  const tagName = jsxTagName(node);
  if (!tagName || !/^[a-z]/.test(tagName)) return null;

  return finding;
}

function jsxNodeText(sourceFile, node) {
  return node.getText(sourceFile);
}

function matchesAllowListEntry(entry, relativeFile, tagName, sourceFile, node) {
  if (entry.tagName && entry.tagName !== tagName) return false;
  if (entry.path.endsWith("/")) {
    if (!relativeFile.startsWith(entry.path)) return false;
  } else if (relativeFile !== entry.path && !relativeFile.startsWith(`${entry.path}/`)) {
    return false;
  }

  const nodeText = jsxNodeText(sourceFile, node);
  return entry.markers.every((marker) => nodeText.includes(marker));
}

function isInlineStyleAllowed(relativeFile, tagName, sourceFile, node) {
  return inlineStyleAllowList.some((entry) => matchesAllowListEntry(entry, relativeFile, tagName, sourceFile, node));
}

function isRawStructuralElementAllowed(relativeFile, tagName, sourceFile, node) {
  return rawStructuralElementAllowList.some((entry) =>
    matchesAllowListEntry(entry, relativeFile, tagName, sourceFile, node),
  );
}

function categorySeverity(category) {
  return categoryMetadata[category]?.severity ?? "error";
}

function hasErrorSeverityCategory(entry) {
  return Object.keys(entry.categories).some((category) => categorySeverity(category) === "error");
}

function hasWarningSeverityCategory(entry) {
  return Object.keys(entry.categories).some((category) => categorySeverity(category) === "warning");
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

      const rawClassNameFinding = rawClassNameJsxElementFinding(sourceFile, node);

      if (isAppProductionFile(relativeFile) && rawClassNameFinding) {
        addFinding(fileResult, sourceFile, rawClassNameFinding.node, "routeLocalClassName", rawClassNameFinding.detail);
      }

      if (
        isFeatureUiFile(relativeFile) &&
        hasJsxAttribute(node, "style") &&
        !inlineStyleHasPixelDimension(node) &&
        !isInlineStyleAllowed(relativeFile, tagName, sourceFile, node)
      ) {
        addFinding(fileResult, sourceFile, node.tagName, "inlineStyle", tagName ?? "member JSX tag");
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

      if (
        isFeatureUiFile(relativeFile) &&
        rawStructuralElementTags.has(tagName ?? "") &&
        !isRawStructuralElementAllowed(relativeFile, tagName, sourceFile, node)
      ) {
        addFinding(fileResult, sourceFile, node.tagName, "rawStructuralElement", tagName);
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
  const severity = {
    error: 0,
    warning: 0,
  };
  let gatingFileCount = 0;
  let warningFileCount = 0;

  for (const entry of entries) {
    owners[entry.owner] = (owners[entry.owner] ?? 0) + 1;
    if (hasErrorSeverityCategory(entry)) {
      gatingFileCount += 1;
    }
    if (hasWarningSeverityCategory(entry)) {
      warningFileCount += 1;
    }
    for (const [category, count] of Object.entries(entry.categories)) {
      categories[category] = (categories[category] ?? 0) + count;
      severity[categorySeverity(category)] = (severity[categorySeverity(category)] ?? 0) + count;
    }
    for (const issue of entry.issueTargets) {
      issues[issue] = (issues[issue] ?? 0) + 1;
    }
  }

  return {
    fileCount: entries.length,
    gatingFileCount,
    warningFileCount,
    categories: Object.fromEntries(Object.entries(categories).sort(([left], [right]) => left.localeCompare(right))),
    severity: Object.fromEntries(Object.entries(severity).sort(([left], [right]) => left.localeCompare(right))),
    owners: Object.fromEntries(Object.entries(owners).sort(([left], [right]) => left.localeCompare(right))),
    issues: Object.fromEntries(Object.entries(issues).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function inventoryLedgerPathForRoot(rootDir) {
  return path.join(rootDir, "packages", "design-system", "DESIGN_SYSTEM_LEGACY_INVENTORY.json");
}

export function createDesignSystemLegacyInventoryDocument(entries) {
  return {
    version: 1,
    milestone: 12,
    generatedBy: "pnpm run ops design-system:legacy-inventory --write-ledger",
    description:
      "Design-system legacy pattern inventory for milestone #12. Entries are file/category level and must map to a milestone issue with no permanent exceptions.",
    summary: summarizeInventory(entries),
    entries,
  };
}

export async function collectDesignSystemLegacyInventoryDocument(options = {}) {
  const entries = await collectDesignSystemLegacyInventory(options);
  return createDesignSystemLegacyInventoryDocument(entries);
}

function meaningfulLedgerContent(document) {
  return {
    summary: document?.summary ?? null,
    entries: Array.isArray(document?.entries) ? document.entries : null,
  };
}

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJsonValue(value[key])]),
    );
  }

  return value;
}

export function compareDesignSystemLegacyInventoryLedger(currentDocument, committedDocument) {
  return (
    JSON.stringify(stableJsonValue(meaningfulLedgerContent(currentDocument))) ===
    JSON.stringify(stableJsonValue(meaningfulLedgerContent(committedDocument)))
  );
}

function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) {
    return {
      ledger: null,
      error: `Design-system legacy inventory ledger is missing at ${normalizeRelative(ledgerPath)}.`,
    };
  }

  try {
    return {
      ledger: JSON.parse(readFileSync(ledgerPath, "utf8")),
      error: null,
    };
  } catch (error) {
    return {
      ledger: null,
      error: `Design-system legacy inventory ledger is not valid JSON at ${normalizeRelative(ledgerPath)}: ${error.message}`,
    };
  }
}

export async function checkDesignSystemLegacyInventory(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const ledgerPath = options.ledgerPath ?? inventoryLedgerPathForRoot(rootDir);
  const document = await collectDesignSystemLegacyInventoryDocument({ rootDir });
  const ledgerResult = readLedger(ledgerPath);
  const ledgerInSync =
    ledgerResult.ledger !== null && compareDesignSystemLegacyInventoryLedger(document, ledgerResult.ledger);

  return {
    passed: document.summary.gatingFileCount === 0 && ledgerInSync,
    document,
    ledgerPath,
    ledgerError: ledgerResult.error,
    ledgerInSync,
  };
}

function lineListForCategory(entry, category) {
  return [...new Set(entry.details.filter((detail) => detail.category === category).map((detail) => detail.line))].sort(
    (left, right) => left - right,
  );
}

function formatInventoryFinding(entry) {
  const categoryNames = Object.keys(entry.categories).sort();
  const categorySummary = categoryNames.map((category) => `${category}(${entry.categories[category]})`).join(", ");
  const lineSummary = categoryNames
    .map((category) => `${category}: lines ${lineListForCategory(entry, category).join(", ")}`)
    .join("; ");

  return `- ${entry.file}: ${categorySummary}; ${lineSummary}`;
}

export function printDesignSystemLegacyInventoryCheckResult(result) {
  const relativeLedgerPath = normalizeRelative(result.ledgerPath);

  if (result.document.summary.gatingFileCount !== 0) {
    console.error(
      `Design-system legacy inventory check failed: fresh scan found ${result.document.summary.gatingFileCount} error-gated file(s) and ${result.document.summary.warningFileCount} warning-bearing file(s).`,
    );
    for (const entry of result.document.entries.filter(hasErrorSeverityCategory)) {
      console.error(formatInventoryFinding(entry));
    }
  }

  if (result.ledgerError) {
    console.error(result.ledgerError);
    console.error("Run pnpm run ops design-system:legacy-inventory --write-ledger to regenerate it.");
  } else if (!result.ledgerInSync) {
    console.error(`Design-system legacy inventory ledger is stale: ${relativeLedgerPath} differs from a fresh scan.`);
    console.error("Run pnpm run ops design-system:legacy-inventory --write-ledger to regenerate it.");
  }

  if (result.passed) {
    console.log(
      `Design-system legacy inventory check passed: fresh scan found ${result.document.summary.gatingFileCount} error-gated file(s) and ${result.document.summary.warningFileCount} warning-bearing file(s), and ${relativeLedgerPath} is in sync.`,
    );
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const document = await collectDesignSystemLegacyInventoryDocument();
  const prettierOptions = (await prettier.resolveConfig(defaultLedgerPath)) ?? {};
  const formattedDocument = await prettier.format(JSON.stringify(document), {
    ...prettierOptions,
    filepath: defaultLedgerPath,
    parser: "json",
  });

  if (args.has("--write-ledger")) {
    mkdirSync(path.dirname(defaultLedgerPath), { recursive: true });
    writeFileSync(defaultLedgerPath, formattedDocument, "utf8");
    console.log(`Wrote ${normalizeRelative(defaultLedgerPath)} with ${document.entries.length} file(s).`);
    return;
  }

  if (args.has("--check")) {
    const result = await checkDesignSystemLegacyInventory();
    printDesignSystemLegacyInventoryCheckResult(result);
    if (!result.passed) {
      process.exit(1);
    }
    return;
  }

  console.log(formattedDocument);
}

if (typeof process !== "undefined" && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
