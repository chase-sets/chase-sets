import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDesignSystemHocBudget,
  collectDesignSystemHocBudgetDocument,
  createDesignSystemHocBudgetDocument,
  printDesignSystemHocBudgetCheckResult,
} from "./design-system-hoc-budget.mjs";

const tempDirs = [];

function createRepo() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "design-system-hoc-budget-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function writeSource(rootDir, relativeFile, source) {
  const filePath = path.join(rootDir, relativeFile);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, "utf8");
}

function writeBudgetLedger(rootDir, budgets) {
  writeSource(
    rootDir,
    "packages/design-system/DESIGN_SYSTEM_HOC_BUDGET.json",
    `${JSON.stringify({
      ...createDesignSystemHocBudgetDocument([]),
      budgets,
    })}\n`,
  );
}

function captureCheckOutput(result) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;

  try {
    console.log = (message) => logs.push(message);
    console.error = (message) => errors.push(message);
    printDesignSystemHocBudgetCheckResult(result);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return { logs, errors };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("design-system HOC budget", () => {
  it("fails when a governed file exceeds its raw className budget", async () => {
    const rootDir = createRepo();
    const relativeFile = "packages/design-system/src/components/feedback/banner.tsx";
    writeSource(
      rootDir,
      relativeFile,
      `
export function Banner() {
  return (
    <div className="grid gap-2">
      <p className="text-sm">Message</p>
    </div>
  );
}
`,
    );
    writeBudgetLedger(rootDir, {
      [relativeFile]: 1,
    });

    const result = await checkDesignSystemHocBudget({ rootDir });
    const output = captureCheckOutput(result);

    expect(result.passed).toBe(false);
    expect(result.exceededBudgetFiles).toEqual([
      {
        file: relativeFile,
        rawClassNameCount: 2,
        budget: 1,
      },
    ]);
    expect(output.errors.join("\n")).toContain("current 2 > budget 1");
  });

  it("passes when governed files are at or under budget", async () => {
    const rootDir = createRepo();
    const relativeFile = "packages/design-system/src/components/data-display/stat.tsx";
    writeSource(
      rootDir,
      relativeFile,
      `
export function Stat() {
  return <div className="grid gap-1">Orders</div>;
}
`,
    );
    writeBudgetLedger(rootDir, {
      [relativeFile]: 2,
    });

    const result = await checkDesignSystemHocBudget({ rootDir });
    const output = captureCheckOutput(result);

    expect(result.passed).toBe(true);
    expect(result.document.summary.governedFileCount).toBe(1);
    expect(result.document.summary.totalRawClassNameCount).toBe(1);
    expect(output.logs.join("\n")).toContain("Design-system HOC budget check passed");
    expect(output.errors).toEqual([]);
  });

  it("exempts primitives from HOC budgets", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "packages/design-system/src/primitives/layout.tsx",
      `
export function Stack() {
  return <div className="grid gap-3" />;
}
`,
    );
    writeBudgetLedger(rootDir, {});

    const result = await checkDesignSystemHocBudget({ rootDir });

    expect(result.passed).toBe(true);
    expect(result.document.summary).toMatchObject({
      governedFileCount: 0,
      exemptFileCount: 1,
      exemptByReason: {
        primitive: 1,
      },
      totalRawClassNameCount: 0,
    });
  });

  it("exempts components with a leading ds-leaf marker", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "packages/design-system/src/components/data-display/image.tsx",
      `
// @ds-leaf
export function Image() {
  return <img alt="" className="block h-full w-full object-cover" />;
}
`,
    );
    writeBudgetLedger(rootDir, {});

    const result = await checkDesignSystemHocBudget({ rootDir });

    expect(result.passed).toBe(true);
    expect(result.document.summary).toMatchObject({
      governedFileCount: 0,
      exemptFileCount: 1,
      exemptByReason: {
        "ds-leaf-marker": 1,
      },
      totalRawClassNameCount: 0,
    });
  });

  it("fails when a new governed file has no budget entry", async () => {
    const rootDir = createRepo();
    const relativeFile = "packages/design-system/src/components/actions/new-action.tsx";
    writeSource(
      rootDir,
      relativeFile,
      `
export function NewAction() {
  return null;
}
`,
    );
    writeBudgetLedger(rootDir, {});

    const result = await checkDesignSystemHocBudget({ rootDir });
    const output = captureCheckOutput(result);

    expect(result.passed).toBe(false);
    expect(result.missingBudgetFiles).toEqual([
      {
        file: relativeFile,
        rawClassNameCount: 0,
      },
    ]);
    expect(output.errors.join("\n")).toContain("missing budget entry");
  });

  it("creates a budget document with current governed counts", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "packages/design-system/src/components/forms/text-input.tsx",
      `
export function TextInput() {
  return <input className="control" />;
}
`,
    );

    const document = await collectDesignSystemHocBudgetDocument({ rootDir });

    expect(document.budgets).toEqual({
      "packages/design-system/src/components/forms/text-input.tsx": 1,
    });
    expect(document.summary.topBudgets).toEqual([
      {
        file: "packages/design-system/src/components/forms/text-input.tsx",
        budget: 1,
      },
    ]);
  });
});
