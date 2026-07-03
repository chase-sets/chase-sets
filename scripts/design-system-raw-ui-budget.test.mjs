import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDesignSystemRawUiBudget,
  collectDesignSystemRawUiBudgetDocument,
  createDesignSystemRawUiBudgetDocument,
  defaultRawUiAllowList,
  printDesignSystemRawUiBudgetCheckResult,
} from "./design-system-raw-ui-budget.mjs";

const tempDirs = [];

function createRepo() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "design-system-raw-ui-budget-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function writeSource(rootDir, relativeFile, source) {
  const filePath = path.join(rootDir, relativeFile);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, "utf8");
}

function writeBudgetLedger(rootDir, { budgets = {}, allowList = defaultRawUiAllowList } = {}) {
  writeSource(
    rootDir,
    "packages/design-system/DESIGN_SYSTEM_RAW_UI_BUDGET.json",
    `${JSON.stringify({
      ...createDesignSystemRawUiBudgetDocument([], allowList),
      allowList,
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
    printDesignSystemRawUiBudgetCheckResult(result);
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

describe("design-system raw UI budget", () => {
  it("fails when a new bounded-context ui file introduces raw className and host elements", async () => {
    const rootDir = createRepo();
    const relativeFile = "bounded-contexts/catalog/features/items/ui/raw-page.tsx";
    writeSource(
      rootDir,
      relativeFile,
      `
export function RawPage() {
  return <div className="grid gap-2"><button type="button">Save</button></div>;
}
`,
    );
    writeBudgetLedger(rootDir);

    const result = await checkDesignSystemRawUiBudget({ rootDir });
    const output = captureCheckOutput(result);

    expect(result.passed).toBe(false);
    expect(result.missingBudgetFiles).toEqual([
      {
        file: relativeFile,
        rawClassNameCount: 1,
        rawElementCount: 2,
      },
    ]);
    expect(output.errors.join("\n")).toContain(relativeFile);
    expect(output.errors.join("\n")).toContain("Use design-system primitives/components");
  });

  it("allows raw UI counts to decrease below the committed budget", async () => {
    const rootDir = createRepo();
    const relativeFile = "bounded-contexts/catalog/features/items/ui/item-page.tsx";
    writeSource(
      rootDir,
      relativeFile,
      `
import { Page } from "@chase-sets/design-system";

export function ItemPage() {
  return <Page title="Items" />;
}
`,
    );
    writeBudgetLedger(rootDir, {
      budgets: {
        [relativeFile]: {
          rawClassNameCount: 1,
          rawElementCount: 2,
        },
      },
    });

    const result = await checkDesignSystemRawUiBudget({ rootDir });
    const output = captureCheckOutput(result);

    expect(result.passed).toBe(true);
    expect(output.logs.join("\n")).toContain("Design-system raw UI budget check passed");
    expect(output.errors).toEqual([]);
  });

  it("fails when a budgeted file increases raw UI usage", async () => {
    const rootDir = createRepo();
    const relativeFile = "bounded-contexts/catalog/features/items/ui/item-page.tsx";
    writeSource(
      rootDir,
      relativeFile,
      `
export function ItemPage() {
  return (
    <section>
      <div className="grid gap-2">Items</div>
    </section>
  );
}
`,
    );
    writeBudgetLedger(rootDir, {
      budgets: {
        [relativeFile]: {
          rawClassNameCount: 0,
          rawElementCount: 1,
        },
      },
    });

    const result = await checkDesignSystemRawUiBudget({ rootDir });
    const output = captureCheckOutput(result);

    expect(result.passed).toBe(false);
    expect(result.exceededBudgetFiles).toEqual([
      {
        file: relativeFile,
        current: {
          rawClassNameCount: 1,
          rawElementCount: 2,
        },
        budget: {
          rawClassNameCount: 0,
          rawElementCount: 1,
        },
      },
    ]);
    expect(output.errors.join("\n")).toContain("exceed raw UI budget");
  });

  it("ignores tests and bounded-context files outside ui folders", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/catalog/features/items/routes/item-route.tsx",
      `
export function ItemRoute() {
  return <div className="route">Route-owned adapter</div>;
}
`,
    );
    writeSource(
      rootDir,
      "bounded-contexts/catalog/features/items/ui/item-page.test.tsx",
      `
export function TestFixture() {
  return <div className="fixture">Fixture</div>;
}
`,
    );
    writeBudgetLedger(rootDir);

    const result = await checkDesignSystemRawUiBudget({ rootDir });

    expect(result.passed).toBe(true);
    expect(result.document.summary.governedFileCount).toBe(0);
  });

  it("honors justified allowList entries from the ledger", async () => {
    const rootDir = createRepo();
    const relativeFile = "bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx";
    writeSource(
      rootDir,
      relativeFile,
      `
export function PublicPages({ children }) {
  return <main id="main-content">{children}</main>;
}
`,
    );
    writeBudgetLedger(rootDir, {
      allowList: [
        {
          path: relativeFile,
          tagName: "main",
          markers: ["id", "main-content"],
          reason: "Skip-link target.",
        },
      ],
    });

    const result = await checkDesignSystemRawUiBudget({ rootDir });

    expect(result.passed).toBe(true);
    expect(result.document.summary.totalRawElementCount).toBe(0);
  });

  it("collects deployable production files while allowing composition-root main landmarks", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "deployables/marketplace/app/root.tsx",
      `
export function Root() {
  return <main><Outlet /></main>;
}
`,
    );
    writeBudgetLedger(rootDir);

    const result = await checkDesignSystemRawUiBudget({ rootDir });

    expect(result.passed).toBe(true);
    expect(result.document.summary.governedFileCount).toBe(1);
    expect(result.document.summary.totalRawElementCount).toBe(0);
  });

  it("creates a budget document with current raw UI counts only", async () => {
    const rootDir = createRepo();
    const rawFile = "bounded-contexts/catalog/features/items/ui/raw-page.tsx";
    writeSource(
      rootDir,
      rawFile,
      `
export function RawPage() {
  return <p className="text-sm">Raw</p>;
}
`,
    );
    writeSource(
      rootDir,
      "bounded-contexts/catalog/features/items/ui/clean-page.tsx",
      `
import { Text } from "@chase-sets/design-system";

export function CleanPage() {
  return <Text>Clean</Text>;
}
`,
    );

    const document = await collectDesignSystemRawUiBudgetDocument({ rootDir });

    expect(document.summary).toMatchObject({
      governedFileCount: 2,
      budgetedFileCount: 1,
      totalRawClassNameCount: 1,
      totalRawElementCount: 1,
    });
    expect(document.budgets).toEqual({
      [rawFile]: {
        rawClassNameCount: 1,
        rawElementCount: 1,
      },
    });
  });
});
