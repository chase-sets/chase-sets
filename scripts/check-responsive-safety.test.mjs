import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkResponsiveSafety,
  classifyResponsiveSafetyFile,
  collectResponsiveSafetyDocument,
  collectResponsiveSafetyFindingsFromSource,
  createResponsiveSafetyDocument,
  printResponsiveSafetyCheckResult,
} from "./check-responsive-safety.mjs";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "responsive-safety");
const tempDirs = [];

function createRepo() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "responsive-safety-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function fixture(name) {
  return readFileSync(path.join(fixtureDir, name), "utf8");
}

function writeSource(rootDir, relativeFile, source) {
  const filePath = path.join(rootDir, relativeFile);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, "utf8");
}

function writeLedger(rootDir, budgets) {
  writeSource(
    rootDir,
    "packages/design-system/RESPONSIVE_SAFETY.json",
    `${JSON.stringify({ ...createResponsiveSafetyDocument([]), budgets })}\n`,
  );
}

function captureOutput(result) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = (message) => logs.push(message);
    console.error = (message) => errors.push(message);
    printResponsiveSafetyCheckResult(result);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { logs, errors };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
});

describe("responsive-safety guard", () => {
  it("classifies production TSX, exclusions, and reasoned leading exemptions", () => {
    expect(classifyResponsiveSafetyFile("bounded-contexts/catalog/src/listing.tsx").governed).toBe(true);
    expect(classifyResponsiveSafetyFile("deployables/marketplace/src/listing.test.tsx").governed).toBe(false);
    expect(classifyResponsiveSafetyFile("packages/other/src/listing.tsx").governed).toBe(false);
    expect(
      classifyResponsiveSafetyFile(
        "packages/design-system/src/components/print-label.tsx",
        fixture("responsive-exempt.tsx"),
      ),
    ).toEqual({
      governed: false,
      reason: "responsive-exempt-marker",
      exemptionReason: "Print layout uses a fixed paper contract.",
    });
  });

  it.each([
    ["arbitrary-pixel-dimensions.tsx", { arbitraryPixelDimensionUtility: 2 }],
    ["inline-pixel-dimensions.tsx", { inlinePixelDimensionStyle: 2 }],
    ["bare-hidden-interactive.tsx", { bareHiddenInteractiveContent: 1 }],
    ["custom-pixel-breakpoint.tsx", { customPixelBreakpoint: 1 }],
  ])("collects the %s finding fixture", (fixtureName, expectedCategories) => {
    const findings = collectResponsiveSafetyFindingsFromSource(fixtureName, fixture(fixtureName));
    const categories = findings.reduce((counts, finding) => {
      counts[finding.category] = (counts[finding.category] ?? 0) + 1;
      return counts;
    }, {});
    expect(categories).toEqual(expectedCategories);
  });

  it("allows responsive arbitrary values, token breakpoints, paired hidden content, and non-pixel styles", () => {
    expect(
      collectResponsiveSafetyFindingsFromSource(
        "allowed-responsive-values.tsx",
        fixture("allowed-responsive-values.tsx"),
      ),
    ).toEqual([]);
  });

  it("fails the ratchet for new arbitrary and inline pixel dimensions", async () => {
    const rootDir = createRepo();
    const relativeFile = "bounded-contexts/catalog/src/listing-card.tsx";
    writeSource(
      rootDir,
      relativeFile,
      `${fixture("arbitrary-pixel-dimensions.tsx")}\n${fixture("inline-pixel-dimensions.tsx")}`,
    );
    writeLedger(rootDir, {});

    const result = await checkResponsiveSafety({ rootDir });
    const output = captureOutput(result);

    expect(result.passed).toBe(false);
    expect(result.missingBudgets).toEqual([
      { file: relativeFile, category: "arbitraryPixelDimensionUtility", count: 2 },
      { file: relativeFile, category: "inlinePixelDimensionStyle", count: 2 },
    ]);
    expect(output.errors.join("\n")).toContain("unbudgeted arbitraryPixelDimensionUtility");
    expect(output.errors.join("\n")).toContain("unbudgeted inlinePixelDimensionStyle");
  });

  it("passes at budget and fails when a warning count increases", async () => {
    const rootDir = createRepo();
    const relativeFile = "packages/design-system/src/components/responsive-actions.tsx";
    writeSource(rootDir, relativeFile, fixture("bare-hidden-interactive.tsx"));
    writeLedger(rootDir, { [relativeFile]: { bareHiddenInteractiveContent: 1 } });
    expect((await checkResponsiveSafety({ rootDir })).passed).toBe(true);

    writeSource(
      rootDir,
      relativeFile,
      `${fixture("bare-hidden-interactive.tsx")}\nexport const Second = () => <button className="hidden">Second</button>;`,
    );
    const result = await checkResponsiveSafety({ rootDir });
    expect(result.passed).toBe(false);
    expect(result.exceededBudgets).toEqual([
      { file: relativeFile, category: "bareHiddenInteractiveContent", count: 2, budget: 1 },
    ]);
  });

  it("writes warning inventory and reasoned exemptions into the document", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "packages/design-system/src/components/custom-breakpoint.tsx",
      fixture("custom-pixel-breakpoint.tsx"),
    );
    writeSource(rootDir, "packages/design-system/src/components/print-label.tsx", fixture("responsive-exempt.tsx"));

    const document = await collectResponsiveSafetyDocument({ rootDir });

    expect(document.summary).toMatchObject({
      scannedFileCount: 2,
      exemptFileCount: 1,
      findingFileCount: 1,
      severity: { error: 0, warning: 1 },
    });
    expect(document.exemptions).toEqual([
      {
        file: "packages/design-system/src/components/print-label.tsx",
        reason: "Print layout uses a fixed paper contract.",
      },
    ]);
  });
});
