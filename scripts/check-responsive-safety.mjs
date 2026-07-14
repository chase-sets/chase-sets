/**
 * Responsive-safety ratchet for production TSX.
 *
 * Regenerate after reviewing and reducing findings:
 *   node ./scripts/check-responsive-safety.mjs --write
 *
 * CI check:
 *   pnpm run check:responsive-safety
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import prettier from "prettier";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";

export const responsiveSafetyLedgerPath = path.join(repoRoot, "packages", "design-system", "RESPONSIVE_SAFETY.json");

export const responsiveExemptMarker = "@responsive-exempt";

const responsiveSafetyRoots = ["bounded-contexts", "deployables", "packages/design-system/src"];
const tsxExtension = new Set([".tsx"]);
const tokenBreakpoints = ["sm", "md", "lg", "xl", "2xl"];
const dimensionStyleKeys = new Set(["width", "height", "minWidth", "maxWidth"]);
const interactiveHtmlTags = new Set(["a", "button", "input", "select", "textarea", "summary"]);
const interactiveRoles = new Set(["button", "checkbox", "link", "menuitem", "radio", "switch", "tab"]);

export const responsiveSafetyCategories = {
  arbitraryPixelDimensionUtility: {
    severity: "error",
    description: "Arbitrary pixel width, height, basis, or grid-column utility",
  },
  inlinePixelDimensionStyle: {
    severity: "error",
    description: "Inline pixel-valued width, height, minWidth, or maxWidth style",
  },
  bareHiddenInteractiveContent: {
    severity: "warning",
    description: "Bare hidden utility removes interactive content without a token-breakpoint display counterpart",
  },
  customPixelBreakpoint: {
    severity: "warning",
    description: "Custom pixel breakpoint bypasses the design-system breakpoint token scale",
  },
};

function normalizedFile(relativeFile) {
  return relativeFile.replaceAll("\\", "/");
}

export function isResponsiveSafetyProductionFile(relativeFile) {
  const normalized = normalizedFile(relativeFile);
  if (!normalized.endsWith(".tsx")) return false;
  if (
    !normalized.startsWith("bounded-contexts/") &&
    !normalized.startsWith("deployables/") &&
    !normalized.startsWith("packages/design-system/src/")
  ) {
    return false;
  }
  if (normalized.includes("/__tests__/")) return false;
  if (normalized.includes("/tests/")) return false;
  if (normalized.includes("/fixtures/") || normalized.includes("/test-fixtures/")) return false;
  if (/\.(?:test|spec|stories|test-data)\.[^/]+$/i.test(normalized)) return false;
  return true;
}

function exemptionReason(sourceText) {
  const leadingText = sourceText.split(/\r?\n/).slice(0, 8).join("\n");
  const match = leadingText.match(/(?:\/\/|\/\*)\s*@responsive-exempt\s+([^\r\n*]+)/);
  return match?.[1]?.trim() || null;
}

export function classifyResponsiveSafetyFile(relativeFile, sourceText = "") {
  if (!isResponsiveSafetyProductionFile(relativeFile)) {
    return { governed: false, reason: "out-of-scope" };
  }
  const reason = exemptionReason(sourceText);
  if (reason) {
    return { governed: false, reason: "responsive-exempt-marker", exemptionReason: reason };
  }
  return { governed: true, reason: "production-tsx" };
}

function sourceKindFor(filePath) {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function lineAndColumn(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: position.line + 1, column: position.character + 1 };
}

function jsxAttribute(node, name) {
  return node.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.text === name);
}

function jsxTagName(node) {
  return ts.isIdentifier(node.tagName) ? node.tagName.text : node.tagName.getText();
}

function staticTextFragments(node) {
  const fragments = [];

  function visit(current) {
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current) ||
      current.kind === ts.SyntaxKind.TemplateHead ||
      current.kind === ts.SyntaxKind.TemplateMiddle ||
      current.kind === ts.SyntaxKind.TemplateTail
    ) {
      fragments.push({ node: current, text: current.text });
      return;
    }
    ts.forEachChild(current, visit);
  }

  visit(node);
  return fragments;
}

function classTokens(node) {
  const attribute = jsxAttribute(node, "className");
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return [];

  return staticTextFragments(attribute.initializer).flatMap((fragment) =>
    fragment.text
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => ({ ...fragment, token })),
  );
}

const pixelNumberPattern = "[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)px";
const arbitraryDimensionUtilityPattern = new RegExp(
  `(?:^|:)(?:w|h|min-w|max-w|min-h|basis)-\\[${pixelNumberPattern}\\]$`,
  "i",
);
const pixelGridColumnsPattern = new RegExp(`(?:^|:)grid-cols-\\[[^\\]]*${pixelNumberPattern}[^\\]]*\\]$`, "i");
const customPixelBreakpointPattern = new RegExp(`(?:^|:)(?:min|max)-\\[${pixelNumberPattern}\\]:`, "i");
const responsiveDisplayPattern = new RegExp(
  `^(?:(?:${tokenBreakpoints.join("|")})|max-(?:${tokenBreakpoints.join(
    "|",
  )})):!?(?:block|inline|inline-block|flex|inline-flex|grid|table|table-row|table-cell|contents)$`,
);

function stringLiteralJsxAttribute(node, name) {
  const attribute = jsxAttribute(node, name);
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return null;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression &&
    (ts.isStringLiteral(attribute.initializer.expression) ||
      ts.isNoSubstitutionTemplateLiteral(attribute.initializer.expression))
  ) {
    return attribute.initializer.expression.text;
  }
  return null;
}

function isInteractiveOpeningElement(node) {
  const tagName = jsxTagName(node);
  if (interactiveHtmlTags.has(tagName)) return true;
  if (/(?:Button|Link|Input|Select|Checkbox|Radio|Switch|Toggle|Trigger|MenuItem|Action)$/.test(tagName)) {
    return true;
  }
  if (["onClick", "onSubmit", "href"].some((name) => jsxAttribute(node, name))) return true;
  return interactiveRoles.has(stringLiteralJsxAttribute(node, "role") ?? "");
}

function containsInteractiveContent(node) {
  let interactive = false;
  function visit(current) {
    if (interactive) return;
    if (
      (ts.isJsxOpeningElement(current) || ts.isJsxSelfClosingElement(current)) &&
      isInteractiveOpeningElement(current)
    ) {
      interactive = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return interactive;
}

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

function inlinePixelDimensionFindings(node) {
  const attribute = jsxAttribute(node, "style");
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) return [];
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) return [];
  if (!ts.isObjectLiteralExpression(attribute.initializer.expression)) return [];

  return attribute.initializer.expression.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    const name = propertyNameText(property.name);
    if (name === null || !dimensionStyleKeys.has(name) || !isPixelStyleValue(property.initializer)) return [];
    return [{ node: property.name, detail: `${name}: ${property.initializer.getText()}` }];
  });
}

function addFinding(findings, sourceFile, node, category, detail) {
  findings.push({
    category,
    severity: responsiveSafetyCategories[category].severity,
    ...lineAndColumn(sourceFile, node),
    detail,
  });
}

export function collectResponsiveSafetyFindingsFromSource(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindFor(filePath));
  const findings = [];

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tokens = classTokens(node);

      for (const { node: tokenNode, token } of tokens) {
        if (arbitraryDimensionUtilityPattern.test(token) || pixelGridColumnsPattern.test(token)) {
          addFinding(findings, sourceFile, tokenNode, "arbitraryPixelDimensionUtility", token);
        }
        if (customPixelBreakpointPattern.test(token)) {
          addFinding(findings, sourceFile, tokenNode, "customPixelBreakpoint", token);
        }
      }

      for (const finding of inlinePixelDimensionFindings(node)) {
        addFinding(findings, sourceFile, finding.node, "inlinePixelDimensionStyle", finding.detail);
      }

      const hasBareHidden = tokens.some(({ token }) => token === "hidden");
      const hasResponsiveDisplay = tokens.some(({ token }) => responsiveDisplayPattern.test(token));
      const interactiveRoot = ts.isJsxOpeningElement(node) && ts.isJsxElement(node.parent) ? node.parent : node;
      if (hasBareHidden && !hasResponsiveDisplay && containsInteractiveContent(interactiveRoot)) {
        addFinding(
          findings,
          sourceFile,
          node.tagName,
          "bareHiddenInteractiveContent",
          `${jsxTagName(node)} with hidden interactive content`,
        );
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

async function collectResponsiveSafetyFiles(rootDir) {
  const files = [];
  for (const root of responsiveSafetyRoots) {
    files.push(
      ...(await collectFiles(path.join(rootDir, root), {
        extensions: tsxExtension,
        skippedDirectories: defaultSkippedDirectories,
      })),
    );
  }
  return [...new Set(files.map((filePath) => normalizeRelative(filePath, rootDir)))]
    .filter(isResponsiveSafetyProductionFile)
    .sort((left, right) => left.localeCompare(right));
}

function countsForFindings(findings) {
  const counts = {};
  for (const finding of findings) counts[finding.category] = (counts[finding.category] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function summarize(entries, exemptFiles, scannedFileCount) {
  const categories = {};
  const severity = { error: 0, warning: 0 };
  for (const entry of entries) {
    for (const [category, count] of Object.entries(countsForFindings(entry.findings))) {
      categories[category] = (categories[category] ?? 0) + count;
      const level = responsiveSafetyCategories[category].severity;
      severity[level] += count;
    }
  }
  return {
    scannedFileCount,
    exemptFileCount: exemptFiles.length,
    findingFileCount: entries.length,
    findingCount: Object.values(categories).reduce((total, count) => total + count, 0),
    severity,
    categories: Object.fromEntries(Object.entries(categories).sort(([left], [right]) => left.localeCompare(right))),
  };
}

export function createResponsiveSafetyDocument(entries, exemptFiles = [], scannedFileCount = 0) {
  return {
    version: 1,
    generatedBy: "node ./scripts/check-responsive-safety.mjs --write",
    description:
      "Ratcheted responsive-safety findings for production TSX. Error findings must remain zero; warning findings may only decrease until reviewed and rewritten.",
    classification: {
      governed: ["bounded-contexts/**/*.tsx", "deployables/**/*.tsx", "packages/design-system/src/**/*.tsx"],
      excluded: ["tests", "stories", "fixtures"],
      exempt: `leading ${responsiveExemptMarker} <reason> marker comment`,
      breakpointTokens: tokenBreakpoints,
    },
    categories: responsiveSafetyCategories,
    summary: summarize(entries, exemptFiles, scannedFileCount),
    budgets: Object.fromEntries(entries.map((entry) => [entry.file, countsForFindings(entry.findings)])),
    inventory: entries,
    exemptions: exemptFiles,
  };
}

export async function collectResponsiveSafetyDocument(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const entries = [];
  const exemptFiles = [];
  const files = await collectResponsiveSafetyFiles(rootDir);

  for (const relativeFile of files) {
    const filePath = path.join(rootDir, relativeFile);
    const sourceText = readFileSync(filePath, "utf8");
    const classification = classifyResponsiveSafetyFile(relativeFile, sourceText);
    if (!classification.governed) {
      exemptFiles.push({ file: relativeFile, reason: classification.exemptionReason });
      continue;
    }
    const findings = collectResponsiveSafetyFindingsFromSource(filePath, sourceText);
    if (findings.length > 0) entries.push({ file: relativeFile, findings });
  }

  return createResponsiveSafetyDocument(entries, exemptFiles, files.length);
}

function ledgerPathForRoot(rootDir) {
  return path.join(rootDir, "packages", "design-system", "RESPONSIVE_SAFETY.json");
}

function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath))
    return { ledger: null, error: `Responsive-safety ledger is missing at ${normalizeRelative(ledgerPath)}.` };
  try {
    return { ledger: JSON.parse(readFileSync(ledgerPath, "utf8")), error: null };
  } catch (error) {
    return {
      ledger: null,
      error: `Responsive-safety ledger is not valid JSON at ${normalizeRelative(ledgerPath)}: ${error.message}`,
    };
  }
}

function ledgerBudgets(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return null;
  if (!ledger.budgets || typeof ledger.budgets !== "object" || Array.isArray(ledger.budgets)) return null;
  return ledger.budgets;
}

function invalidBudgetReason(value) {
  if (!Number.isInteger(value)) return "budget is not an integer";
  if (value < 0) return "budget is negative";
  return null;
}

export async function checkResponsiveSafety(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const ledgerPath = options.ledgerPath ?? ledgerPathForRoot(rootDir);
  const document = await collectResponsiveSafetyDocument({ rootDir });
  const ledgerResult = readLedger(ledgerPath);
  const committedBudgets = ledgerBudgets(ledgerResult.ledger);
  const missingBudgets = [];
  const invalidBudgets = [];
  const exceededBudgets = [];

  if (!ledgerResult.error && !committedBudgets) {
    ledgerResult.error = `Responsive-safety ledger is missing a top-level budgets object at ${normalizeRelative(ledgerPath)}.`;
  }

  if (committedBudgets) {
    for (const [file, categories] of Object.entries(document.budgets)) {
      for (const [category, count] of Object.entries(categories)) {
        if (!committedBudgets[file] || !(category in committedBudgets[file])) {
          missingBudgets.push({ file, category, count });
          continue;
        }
        const budget = committedBudgets[file][category];
        const reason = invalidBudgetReason(budget);
        if (reason) invalidBudgets.push({ file, category, budget, reason });
        else if (count > budget) exceededBudgets.push({ file, category, count, budget });
      }
    }
  }

  return {
    passed:
      !ledgerResult.error && missingBudgets.length === 0 && invalidBudgets.length === 0 && exceededBudgets.length === 0,
    document,
    ledgerPath,
    ledgerError: ledgerResult.error,
    missingBudgets,
    invalidBudgets,
    exceededBudgets,
  };
}

export function printResponsiveSafetyCheckResult(result) {
  if (result.ledgerError) {
    console.error(result.ledgerError);
    console.error("Run node ./scripts/check-responsive-safety.mjs --write to regenerate it.");
  }
  for (const entry of result.missingBudgets) {
    console.error(
      `Responsive-safety check failed: ${entry.file} has ${entry.count} unbudgeted ${entry.category} finding(s).`,
    );
  }
  for (const entry of result.invalidBudgets) {
    console.error(
      `Responsive-safety check failed: ${entry.file} ${entry.category} ${entry.reason} (${JSON.stringify(entry.budget)}).`,
    );
  }
  for (const entry of result.exceededBudgets) {
    console.error(
      `Responsive-safety check failed: ${entry.file} ${entry.category} current ${entry.count} > budget ${entry.budget}.`,
    );
  }
  if (result.passed) {
    console.log(
      `Responsive-safety check passed: ${result.document.summary.scannedFileCount} production TSX file(s), ${result.document.summary.findingCount} ratcheted finding(s), all at or under ${normalizeRelative(result.ledgerPath)}.`,
    );
  }
}

async function formattedDocument(document, filepath) {
  const prettierOptions = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(JSON.stringify(document), { ...prettierOptions, filepath, parser: "json" });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--check")) {
    const result = await checkResponsiveSafety();
    printResponsiveSafetyCheckResult(result);
    if (!result.passed) process.exit(1);
    return;
  }

  const document = await collectResponsiveSafetyDocument();
  const formatted = await formattedDocument(document, responsiveSafetyLedgerPath);
  if (args.has("--write")) {
    mkdirSync(path.dirname(responsiveSafetyLedgerPath), { recursive: true });
    writeFileSync(responsiveSafetyLedgerPath, formatted, "utf8");
    console.log(
      `Wrote ${normalizeRelative(responsiveSafetyLedgerPath)} with ${document.summary.findingCount} finding(s).`,
    );
    return;
  }
  console.log(formatted);
}

if (typeof process !== "undefined" && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
