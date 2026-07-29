/**
 * Design-system consumer raw-UI budget lens.
 *
 * Governed consumers:
 * - production TSX files below bounded-context ui directories
 * - production TSX files below deployables
 *
 * Escape hatch:
 * - Add a per-file allowList entry to DESIGN_SYSTEM_RAW_UI_BUDGET.json with a
 *   tagName, markers that identify the intended JSX node, and a reason.
 *
 * Regenerate the ratcheted ledger after migrations lower counts:
 *   node ./scripts/design-system-raw-ui-budget.mjs --write
 *
 * CI check:
 *   pnpm run check:design-system-raw-ui-budget
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import prettier from "prettier";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";
import { checkedExtensions, isCheckedProductionFile, sourceKindFor } from "./design-system-source-analysis.mjs";

export const designSystemRawUiBudgetLedgerPath = path.join(
  repoRoot,
  "packages",
  "design-system",
  "DESIGN_SYSTEM_RAW_UI_BUDGET.json",
);

const checkedRoots = ["bounded-contexts", "deployables"];

const rawUiHostElementTags = new Set([
  "a",
  "article",
  "aside",
  "button",
  "div",
  "fieldset",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "img",
  "input",
  "label",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "select",
  "span",
  "table",
  "tbody",
  "td",
  "textarea",
  "th",
  "thead",
  "tr",
  "ul",
]);

export const defaultRawUiAllowList = [
  {
    path: "bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx",
    tagName: "main",
    markers: ["id", "main-content"],
    reason: "The public waitlist owns one raw main landmark id for skip-link targeting.",
  },
  {
    path: "deployables/",
    tagName: "main",
    markers: [],
    reason: "Deployable composition roots may expose raw main landmarks while composing bounded-context UI.",
  },
];

function jsxTagName(node) {
  if (ts.isIdentifier(node.tagName)) return node.tagName.text;
  return null;
}

function hasJsxAttribute(node, name) {
  return node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.text === name);
}

function isHostTag(tagName) {
  return typeof tagName === "string" && /^[a-z]/.test(tagName);
}

function nodeText(sourceFile, node) {
  return node.getText(sourceFile);
}

function entryMatchesPath(entry, relativeFile) {
  if (typeof entry.path !== "string") return false;
  if (entry.path.endsWith("/")) return relativeFile.startsWith(entry.path);
  return relativeFile === entry.path || relativeFile.startsWith(`${entry.path}/`);
}

function allowListEntryApplies(entry, relativeFile, tagName, sourceFile, node) {
  if (!entryMatchesPath(entry, relativeFile)) return false;
  if (entry.tagName !== tagName) return false;

  const markers = Array.isArray(entry.markers) ? entry.markers : [];
  const text = nodeText(sourceFile, node);
  return markers.every((marker) => text.includes(marker));
}

function isAllowedRawUiNode(relativeFile, tagName, sourceFile, node, allowList) {
  return allowList.some((entry) => allowListEntryApplies(entry, relativeFile, tagName, sourceFile, node));
}

function isGovernedConsumerFile(relativeFile) {
  if (!isCheckedProductionFile(relativeFile)) return false;
  if (!relativeFile.endsWith(".tsx") && !relativeFile.endsWith(".jsx")) return false;
  if (relativeFile.startsWith("bounded-contexts/")) return relativeFile.includes("/ui/");
  return relativeFile.startsWith("deployables/");
}

async function collectGovernedConsumerFiles(rootDir) {
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
    .filter(isGovernedConsumerFile)
    .sort((left, right) => left.localeCompare(right));
}

function countRawUiOccurrencesInSource(relativeFile, filePath, sourceText, allowList) {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindFor(filePath));
  const details = [];
  let rawClassNameCount = 0;
  let rawElementCount = 0;

  function addDetail(node, category, detail) {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    details.push({
      category,
      line: position.line + 1,
      column: position.character + 1,
      detail,
    });
  }

  function visit(node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = jsxTagName(node);

      if (isHostTag(tagName) && !isAllowedRawUiNode(relativeFile, tagName, sourceFile, node, allowList)) {
        if (hasJsxAttribute(node, "className")) {
          rawClassNameCount += 1;
          addDetail(node.tagName, "rawClassName", `${tagName} with className`);
        }

        if (rawUiHostElementTags.has(tagName)) {
          rawElementCount += 1;
          addDetail(node.tagName, "rawElement", tagName);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    rawClassNameCount,
    rawElementCount,
    details,
  };
}

function normalizeAllowList(allowList) {
  return allowList.map((entry) => ({
    path: String(entry.path ?? ""),
    tagName: String(entry.tagName ?? ""),
    markers: Array.isArray(entry.markers) ? entry.markers.map(String) : [],
    reason: String(entry.reason ?? ""),
  }));
}

function summarizeBudgetEntries(entries, allowList) {
  const filesWithRawUi = entries.filter((entry) => entry.rawClassNameCount > 0 || entry.rawElementCount > 0);
  return {
    governedFileCount: entries.length,
    budgetedFileCount: filesWithRawUi.length,
    allowListEntryCount: allowList.length,
    totalRawClassNameCount: entries.reduce((total, entry) => total + entry.rawClassNameCount, 0),
    totalRawElementCount: entries.reduce((total, entry) => total + entry.rawElementCount, 0),
  };
}

export function createDesignSystemRawUiBudgetDocument(entries, allowList = defaultRawUiAllowList) {
  const normalizedAllowList = normalizeAllowList(allowList);
  const budgetEntries = entries
    .filter((entry) => entry.rawClassNameCount > 0 || entry.rawElementCount > 0)
    .map((entry) => [
      entry.file,
      {
        rawClassNameCount: entry.rawClassNameCount,
        rawElementCount: entry.rawElementCount,
      },
    ]);

  return {
    version: 1,
    milestone: 82,
    issue: 3531,
    generatedBy: "node ./scripts/design-system-raw-ui-budget.mjs --write",
    description:
      "Ratcheted raw-UI budgets for bounded-context ui/ and deployable production TSX consumers. Counts may fall below budget; new raw host UI or increases over budget fail verify:static.",
    classification: {
      governed: ["bounded-contexts/**/ui/**/*.tsx", "deployables/**/*.tsx"],
      ignored: ["tests, specs, stories, fixtures, and non-production files"],
      preferredAlternative:
        "Use @chase-sets/design-system primitives/components such as Page, Stack/Cluster, Text, Button, TextInput, and DataTable/Table.",
      escapeHatch: "Add an allowList entry with path, tagName, node markers, and reason.",
    },
    allowList: normalizedAllowList,
    summary: summarizeBudgetEntries(entries, normalizedAllowList),
    budgets: Object.fromEntries(budgetEntries),
  };
}

export async function collectDesignSystemRawUiBudgetDocument(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const allowList = normalizeAllowList(options.allowList ?? defaultRawUiAllowList);
  const entries = [];

  for (const relativeFile of await collectGovernedConsumerFiles(rootDir)) {
    const filePath = path.join(rootDir, relativeFile);
    const sourceText = readFileSync(filePath, "utf8");
    const counts = countRawUiOccurrencesInSource(relativeFile, filePath, sourceText, allowList);
    entries.push({
      file: relativeFile,
      ...counts,
    });
  }

  return createDesignSystemRawUiBudgetDocument(entries, allowList);
}

function rawUiBudgetLedgerPathForRoot(rootDir) {
  return path.join(rootDir, "packages", "design-system", "DESIGN_SYSTEM_RAW_UI_BUDGET.json");
}

function readBudgetLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) {
    return {
      ledger: null,
      error: `Design-system raw UI budget ledger is missing at ${normalizeRelative(ledgerPath)}.`,
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
      error: `Design-system raw UI budget ledger is not valid JSON at ${normalizeRelative(
        ledgerPath,
      )}: ${error.message}`,
    };
  }
}

function budgetEntriesForLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return null;
  if (!ledger.budgets || typeof ledger.budgets !== "object" || Array.isArray(ledger.budgets)) return null;
  return ledger.budgets;
}

function allowListForLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return null;
  if (!Array.isArray(ledger.allowList)) return null;
  return normalizeAllowList(ledger.allowList);
}

function invalidBudgetReason(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "budget is not an object";
  if (!Number.isInteger(value.rawClassNameCount)) return "rawClassNameCount is not an integer";
  if (!Number.isInteger(value.rawElementCount)) return "rawElementCount is not an integer";
  if (value.rawClassNameCount < 0 || value.rawElementCount < 0) return "budget count is negative";
  return null;
}

function invalidAllowListReason(entry) {
  if (!entry.path) return "path is required";
  if (!entry.tagName) return "tagName is required";
  if (!rawUiHostElementTags.has(entry.tagName)) return "tagName is not a guarded raw UI host element";
  if (!entry.reason) return "reason is required";
  return null;
}

export async function checkDesignSystemRawUiBudget(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const ledgerPath = options.ledgerPath ?? rawUiBudgetLedgerPathForRoot(rootDir);
  const ledgerResult = readBudgetLedger(ledgerPath);
  const committedBudgets = budgetEntriesForLedger(ledgerResult.ledger);
  const committedAllowList = allowListForLedger(ledgerResult.ledger);
  const invalidBudgetFiles = [];
  const invalidAllowListEntries = [];
  const missingBudgetFiles = [];
  const exceededBudgetFiles = [];

  if (!ledgerResult.error && !committedBudgets) {
    ledgerResult.error = `Design-system raw UI budget ledger is missing a top-level budgets object at ${normalizeRelative(
      ledgerPath,
    )}.`;
  }

  if (!ledgerResult.error && !committedAllowList) {
    ledgerResult.error = `Design-system raw UI budget ledger is missing a top-level allowList array at ${normalizeRelative(
      ledgerPath,
    )}.`;
  }

  if (committedAllowList) {
    committedAllowList.forEach((entry, index) => {
      const reason = invalidAllowListReason(entry);
      if (reason) invalidAllowListEntries.push({ index, entry, reason });
    });
  }

  const document = await collectDesignSystemRawUiBudgetDocument({
    rootDir,
    allowList: committedAllowList ?? defaultRawUiAllowList,
  });

  if (committedBudgets) {
    for (const [file, budget] of Object.entries(committedBudgets)) {
      const invalidReason = invalidBudgetReason(budget);
      if (invalidReason) invalidBudgetFiles.push({ file, budget, reason: invalidReason });
    }

    for (const [file, current] of Object.entries(document.budgets)) {
      if (!(file in committedBudgets)) {
        missingBudgetFiles.push({ file, ...current });
        continue;
      }

      const budget = committedBudgets[file];
      if (invalidBudgetReason(budget)) continue;

      if (current.rawClassNameCount > budget.rawClassNameCount || current.rawElementCount > budget.rawElementCount) {
        exceededBudgetFiles.push({
          file,
          current,
          budget,
        });
      }
    }
  }

  return {
    passed:
      !ledgerResult.error &&
      invalidAllowListEntries.length === 0 &&
      invalidBudgetFiles.length === 0 &&
      missingBudgetFiles.length === 0 &&
      exceededBudgetFiles.length === 0,
    document,
    ledgerPath,
    ledgerError: ledgerResult.error,
    invalidAllowListEntries,
    invalidBudgetFiles,
    missingBudgetFiles,
    exceededBudgetFiles,
  };
}

function formatCounts(entry) {
  return `rawClassName ${entry.rawClassNameCount}, rawElement ${entry.rawElementCount}`;
}

function formatMissingBudgetFile(entry) {
  return `- ${entry.file}: missing raw UI budget entry (${formatCounts(entry)}). Use design-system primitives/components or add a justified allowList entry.`;
}

function formatExceededBudgetFile(entry) {
  return `- ${entry.file}: current ${formatCounts(entry.current)} > budget ${formatCounts(
    entry.budget,
  )}. Use design-system primitives/components or add a justified allowList entry.`;
}

function formatInvalidBudgetFile(entry) {
  return `- ${entry.file}: ${entry.reason} (${JSON.stringify(entry.budget)})`;
}

function formatInvalidAllowListEntry(entry) {
  return `- allowList[${entry.index}]: ${entry.reason} (${JSON.stringify(entry.entry)})`;
}

export function printDesignSystemRawUiBudgetCheckResult(result) {
  const relativeLedgerPath = normalizeRelative(result.ledgerPath);

  if (result.ledgerError) {
    console.error(result.ledgerError);
    console.error("Run node ./scripts/design-system-raw-ui-budget.mjs --write to regenerate it.");
  }

  if (result.invalidAllowListEntries.length > 0) {
    console.error(
      `Design-system raw UI budget check failed: ${result.invalidAllowListEntries.length} allowList entr(y/ies) are invalid.`,
    );
    for (const entry of result.invalidAllowListEntries) {
      console.error(formatInvalidAllowListEntry(entry));
    }
  }

  if (result.invalidBudgetFiles.length > 0) {
    console.error(
      `Design-system raw UI budget check failed: ${result.invalidBudgetFiles.length} budget entr(y/ies) are invalid.`,
    );
    for (const entry of result.invalidBudgetFiles) {
      console.error(formatInvalidBudgetFile(entry));
    }
  }

  if (result.missingBudgetFiles.length > 0) {
    console.error(
      `Design-system raw UI budget check failed: ${result.missingBudgetFiles.length} governed consumer file(s) introduced raw UI without budget.`,
    );
    for (const entry of result.missingBudgetFiles) {
      console.error(formatMissingBudgetFile(entry));
    }
  }

  if (result.exceededBudgetFiles.length > 0) {
    console.error(
      `Design-system raw UI budget check failed: ${result.exceededBudgetFiles.length} governed consumer file(s) exceed raw UI budget.`,
    );
    for (const entry of result.exceededBudgetFiles) {
      console.error(formatExceededBudgetFile(entry));
    }
  }

  if (result.passed) {
    console.log(
      `Design-system raw UI budget check passed: ${result.document.summary.governedFileCount} governed consumer file(s), ${result.document.summary.totalRawClassNameCount} raw className occurrence(s), ${result.document.summary.totalRawElementCount} raw element occurrence(s), all at or under ${relativeLedgerPath}.`,
    );
  }
}

async function formattedBudgetDocument(document, filepath) {
  const prettierOptions = (await prettier.resolveConfig(filepath)) ?? {};
  return prettier.format(JSON.stringify(document), {
    ...prettierOptions,
    filepath,
    parser: "json",
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has("--check")) {
    const result = await checkDesignSystemRawUiBudget();
    printDesignSystemRawUiBudgetCheckResult(result);
    if (!result.passed) {
      process.exit(1);
    }
    return;
  }

  const document = await collectDesignSystemRawUiBudgetDocument();
  const formattedDocument = await formattedBudgetDocument(document, designSystemRawUiBudgetLedgerPath);

  if (args.has("--write")) {
    mkdirSync(path.dirname(designSystemRawUiBudgetLedgerPath), { recursive: true });
    writeFileSync(designSystemRawUiBudgetLedgerPath, formattedDocument, "utf8");
    console.log(
      `Wrote ${normalizeRelative(designSystemRawUiBudgetLedgerPath)} with ${document.summary.budgetedFileCount} budgeted raw UI file(s).`,
    );
    return;
  }

  console.log(formattedDocument);
}

if (typeof process !== "undefined" && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
