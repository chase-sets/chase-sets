/**
 * Design-system HOC raw-className budget lens.
 *
 * Classification:
 * - Governed: packages/design-system/src/components/**
 * - Exempt: packages/design-system/src/primitives/**
 * - Exempt marker: put @ds-leaf in a leading file comment for genuinely leaf
 *   components that intentionally own raw host-element classes.
 *
 * Regenerate the ratcheted ledger after migrations lower counts:
 *   node ./scripts/design-system-hoc-budget.mjs --write
 *
 * CI check:
 *   pnpm run check:design-system-hoc-budget
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import prettier from "prettier";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "./lib/files.mjs";
import { normalizeRelative, repoRoot } from "./lib/repo.mjs";
import {
  checkedExtensions,
  isCheckedProductionFile,
  rawClassNameHostElementFinding,
  sourceKindFor,
} from "./design-system-legacy-inventory.mjs";

export const designSystemHocBudgetLedgerPath = path.join(
  repoRoot,
  "packages",
  "design-system",
  "DESIGN_SYSTEM_HOC_BUDGET.json",
);

export const dsLeafMarker = "@ds-leaf";

const governedComponentsPrefix = "packages/design-system/src/components/";
const primitivePrefix = "packages/design-system/src/primitives/";
const designSystemLayerRoots = ["packages/design-system/src/components", "packages/design-system/src/primitives"];

function hasDsLeafMarker(sourceText) {
  const leadingText = sourceText.split(/\r?\n/).slice(0, 8).join("\n");
  return new RegExp(`(?:\\/\\/|\\/\\*)\\s*${dsLeafMarker}\\b`).test(leadingText);
}

export function classifyDesignSystemHocBudgetFile(relativeFile, sourceText = "") {
  if (relativeFile.startsWith(primitivePrefix)) {
    return {
      governed: false,
      reason: "primitive",
    };
  }

  if (!relativeFile.startsWith(governedComponentsPrefix)) {
    return {
      governed: false,
      reason: "out-of-scope",
    };
  }

  if (hasDsLeafMarker(sourceText)) {
    return {
      governed: false,
      reason: "ds-leaf-marker",
    };
  }

  return {
    governed: true,
    reason: "design-system-hoc",
  };
}

async function collectDesignSystemLayerFiles(rootDir) {
  const files = [];

  for (const root of designSystemLayerRoots) {
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
    .sort((left, right) => left.localeCompare(right));
}

export function countRawClassNameOccurrencesInSource(filePath, sourceText) {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, sourceKindFor(filePath));
  let count = 0;

  function visit(node) {
    if (rawClassNameHostElementFinding(sourceFile, node)) {
      count += 1;
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return count;
}

function summarizeBudgetEntries(entries, exemptFiles) {
  const totalRawClassNameCount = entries.reduce((total, entry) => total + entry.rawClassNameCount, 0);
  const exemptByReason = {};

  for (const file of exemptFiles) {
    exemptByReason[file.reason] = (exemptByReason[file.reason] ?? 0) + 1;
  }

  return {
    governedFileCount: entries.length,
    exemptFileCount: exemptFiles.length,
    exemptByReason: Object.fromEntries(
      Object.entries(exemptByReason).sort(([left], [right]) => left.localeCompare(right)),
    ),
    totalRawClassNameCount,
    topBudgets: entries
      .filter((entry) => entry.rawClassNameCount > 0)
      .sort((left, right) => right.rawClassNameCount - left.rawClassNameCount || left.file.localeCompare(right.file))
      .slice(0, 8)
      .map((entry) => ({
        file: entry.file,
        budget: entry.rawClassNameCount,
      })),
  };
}

export function createDesignSystemHocBudgetDocument(entries, exemptFiles = []) {
  return {
    version: 1,
    milestone: 28,
    phase: "Phase B",
    generatedBy: "node ./scripts/design-system-hoc-budget.mjs --write",
    description:
      "Per-file raw-className budgets for governed design-system HOC components. Counts may fall below budget; new governed files and increases over budget fail the CI check.",
    classification: {
      governed: "packages/design-system/src/components/**",
      exempt: ["packages/design-system/src/primitives/**", `leading ${dsLeafMarker} marker comment`],
    },
    summary: summarizeBudgetEntries(entries, exemptFiles),
    budgets: Object.fromEntries(entries.map((entry) => [entry.file, entry.rawClassNameCount])),
  };
}

export async function collectDesignSystemHocBudgetDocument(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const entries = [];
  const exemptFiles = [];

  for (const relativeFile of await collectDesignSystemLayerFiles(rootDir)) {
    const filePath = path.join(rootDir, relativeFile);
    const sourceText = readFileSync(filePath, "utf8");
    const classification = classifyDesignSystemHocBudgetFile(relativeFile, sourceText);

    if (!classification.governed) {
      exemptFiles.push({
        file: relativeFile,
        reason: classification.reason,
      });
      continue;
    }

    entries.push({
      file: relativeFile,
      rawClassNameCount: countRawClassNameOccurrencesInSource(filePath, sourceText),
    });
  }

  entries.sort((left, right) => left.file.localeCompare(right.file));
  exemptFiles.sort((left, right) => left.file.localeCompare(right.file));

  return createDesignSystemHocBudgetDocument(entries, exemptFiles);
}

function hocBudgetLedgerPathForRoot(rootDir) {
  return path.join(rootDir, "packages", "design-system", "DESIGN_SYSTEM_HOC_BUDGET.json");
}

function readBudgetLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) {
    return {
      ledger: null,
      error: `Design-system HOC budget ledger is missing at ${normalizeRelative(ledgerPath)}.`,
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
      error: `Design-system HOC budget ledger is not valid JSON at ${normalizeRelative(ledgerPath)}: ${error.message}`,
    };
  }
}

function budgetEntriesForLedger(ledger) {
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return null;
  if (!ledger.budgets || typeof ledger.budgets !== "object" || Array.isArray(ledger.budgets)) return null;
  return ledger.budgets;
}

function invalidBudgetReason(value) {
  if (!Number.isInteger(value)) return "budget is not an integer";
  if (value < 0) return "budget is negative";
  return null;
}

export async function checkDesignSystemHocBudget(options = {}) {
  const rootDir = options.rootDir ?? repoRoot;
  const ledgerPath = options.ledgerPath ?? hocBudgetLedgerPathForRoot(rootDir);
  const document = await collectDesignSystemHocBudgetDocument({ rootDir });
  const ledgerResult = readBudgetLedger(ledgerPath);
  const committedBudgets = budgetEntriesForLedger(ledgerResult.ledger);
  const missingBudgetFiles = [];
  const invalidBudgetFiles = [];
  const exceededBudgetFiles = [];

  if (!ledgerResult.error && !committedBudgets) {
    ledgerResult.error = `Design-system HOC budget ledger is missing a top-level budgets object at ${normalizeRelative(
      ledgerPath,
    )}.`;
  }

  if (committedBudgets) {
    for (const [file, rawClassNameCount] of Object.entries(document.budgets)) {
      if (!(file in committedBudgets)) {
        missingBudgetFiles.push({
          file,
          rawClassNameCount,
        });
        continue;
      }

      const budget = committedBudgets[file];
      const invalidReason = invalidBudgetReason(budget);

      if (invalidReason) {
        invalidBudgetFiles.push({
          file,
          budget,
          reason: invalidReason,
        });
        continue;
      }

      if (rawClassNameCount > budget) {
        exceededBudgetFiles.push({
          file,
          rawClassNameCount,
          budget,
        });
      }
    }
  }

  return {
    passed:
      !ledgerResult.error &&
      missingBudgetFiles.length === 0 &&
      invalidBudgetFiles.length === 0 &&
      exceededBudgetFiles.length === 0,
    document,
    ledgerPath,
    ledgerError: ledgerResult.error,
    missingBudgetFiles,
    invalidBudgetFiles,
    exceededBudgetFiles,
  };
}

function formatExceededBudgetFile(entry) {
  return `- ${entry.file}: current ${entry.rawClassNameCount} > budget ${entry.budget}`;
}

function formatMissingBudgetFile(entry) {
  return `- ${entry.file}: missing budget entry (current ${entry.rawClassNameCount})`;
}

function formatInvalidBudgetFile(entry) {
  return `- ${entry.file}: ${entry.reason} (${JSON.stringify(entry.budget)})`;
}

export function printDesignSystemHocBudgetCheckResult(result) {
  const relativeLedgerPath = normalizeRelative(result.ledgerPath);

  if (result.ledgerError) {
    console.error(result.ledgerError);
    console.error("Run node ./scripts/design-system-hoc-budget.mjs --write to regenerate it.");
  }

  if (result.missingBudgetFiles.length > 0) {
    console.error(
      `Design-system HOC budget check failed: ${result.missingBudgetFiles.length} governed file(s) have no budget entry.`,
    );
    for (const entry of result.missingBudgetFiles) {
      console.error(formatMissingBudgetFile(entry));
    }
  }

  if (result.invalidBudgetFiles.length > 0) {
    console.error(
      `Design-system HOC budget check failed: ${result.invalidBudgetFiles.length} budget entry(s) are invalid.`,
    );
    for (const entry of result.invalidBudgetFiles) {
      console.error(formatInvalidBudgetFile(entry));
    }
  }

  if (result.exceededBudgetFiles.length > 0) {
    console.error(
      `Design-system HOC budget check failed: ${result.exceededBudgetFiles.length} governed file(s) exceed budget.`,
    );
    for (const entry of result.exceededBudgetFiles) {
      console.error(formatExceededBudgetFile(entry));
    }
  }

  if (result.passed) {
    console.log(
      `Design-system HOC budget check passed: ${result.document.summary.governedFileCount} governed file(s), ${result.document.summary.totalRawClassNameCount} raw className occurrence(s), all at or under ${relativeLedgerPath}.`,
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
    const result = await checkDesignSystemHocBudget();
    printDesignSystemHocBudgetCheckResult(result);
    if (!result.passed) {
      process.exit(1);
    }
    return;
  }

  const document = await collectDesignSystemHocBudgetDocument();
  const formattedDocument = await formattedBudgetDocument(document, designSystemHocBudgetLedgerPath);

  if (args.has("--write")) {
    mkdirSync(path.dirname(designSystemHocBudgetLedgerPath), { recursive: true });
    writeFileSync(designSystemHocBudgetLedgerPath, formattedDocument, "utf8");
    console.log(
      `Wrote ${normalizeRelative(designSystemHocBudgetLedgerPath)} with ${document.summary.governedFileCount} governed file(s) and ${document.summary.totalRawClassNameCount} raw className occurrence(s).`,
    );
    return;
  }

  console.log(formattedDocument);
}

if (typeof process !== "undefined" && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
