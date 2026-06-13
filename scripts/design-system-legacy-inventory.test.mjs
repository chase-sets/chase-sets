import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectDesignSystemLegacyInventory, summarizeInventory } from "./design-system-legacy-inventory.mjs";

const tempDirs = [];

function createRepo() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "design-system-legacy-"));
  tempDirs.push(rootDir);
  return rootDir;
}

function writeSource(rootDir, relativeFile, source) {
  const filePath = path.join(rootDir, relativeFile);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, "utf8");
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("design-system legacy inventory", () => {
  it("maps Ui alias imports and unlabeled mobile table cells to milestone issues", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/support/features/support-requests/ui/support-request-list-page.tsx",
      `
import { UiPage, UiTableCell } from "@chase-sets/design-system";

export function SupportRequestListPage() {
  return (
    <UiPage>
      <UiTableCell>Open</UiTableCell>
      <UiTableCell data-label="Status">Open</UiTableCell>
    </UiPage>
  );
}
`,
    );

    const entries = await collectDesignSystemLegacyInventory({ rootDir });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      file: "bounded-contexts/support/features/support-requests/ui/support-request-list-page.tsx",
      owner: "Support",
      categories: {
        legacyAliasImport: 2,
        legacyAliasJsxUsage: 3,
        legacyResponsiveTableCellMissingLabel: 1,
      },
    });
    expect(entries[0].issueTargets).toEqual(expect.arrayContaining(["#948", "#952"]));
  });

  it("captures design-system legacy source exports and canonical ui source files", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "packages/design-system/src/index.ts",
      `
export { Badge as UiBadge } from "./components/ui/badge";
export * from "./components/data-display";
`,
    );
    writeSource(
      rootDir,
      "packages/design-system/src/components/ui/marketplace.tsx",
      `
export function ProductCard() {
  return null;
}
`,
    );

    const entries = await collectDesignSystemLegacyInventory({ rootDir });

    expect(entries.map((entry) => [entry.file, entry.categories])).toEqual([
      [
        "packages/design-system/src/components/ui/marketplace.tsx",
        {
          canonicalUiSourceFile: 1,
        },
      ],
      [
        "packages/design-system/src/index.ts",
        {
          legacyUiEntrypointExport: 1,
        },
      ],
    ]);
  });

  it("keeps Ui alias exports visible until removal", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "packages/design-system/src/index.ts",
      `
export { Badge as UiBadge } from "./components/feedback/badge";
export { Card } from "./components/data-display/card";
`,
    );

    const entries = await collectDesignSystemLegacyInventory({ rootDir });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      file: "packages/design-system/src/index.ts",
      categories: {
        legacyUiEntrypointExport: 1,
      },
    });
  });

  it("classifies app-local style, raw control, hidden input, embedded style, and raw table usage", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/fulfillment/features/shipments/ui/packing-slip-page.tsx",
      `
export function PackingSlipPage() {
  return (
    <div className="packing-slip-page">
      <style dangerouslySetInnerHTML={{ __html: "body{}" }} />
      <input type="hidden" name="intent" value="print" />
      <select name="format" />
      <button type="button">Print</button>
      <table><tbody><tr><td>One</td></tr></tbody></table>
    </div>
  );
}
`,
    );

    const entries = await collectDesignSystemLegacyInventory({ rootDir });

    expect(entries[0]).toMatchObject({
      owner: "Fulfillment",
      categories: {
        embeddedStyle: 1,
        hiddenInput: 1,
        rawControl: 2,
        rawTable: 4,
        routeLocalClassName: 1,
      },
    });
    expect(entries[0].issueTargets).toEqual(expect.arrayContaining(["#947", "#953"]));
  });

  it("allows design-system print contract styles and ignores JSON-LD scripts", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "packages/design-system/src/components/print/packing-slip.tsx",
      `
export function PrintContract() {
  return <style dangerouslySetInnerHTML={{ __html: "@media print {}" }} />;
}
`,
    );
    writeSource(
      rootDir,
      "bounded-contexts/public-presence/routes/marketplace/home.tsx",
      `
export function HomePage() {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: "{}" }} />;
}
`,
    );

    const entries = await collectDesignSystemLegacyInventory({ rootDir });

    expect(entries).toEqual([]);
  });

  it("summarizes inventory by category, owner, and issue", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/identity/features/accounts/ui/account-profile-page.tsx",
      `
import * as DesignSystem from "@chase-sets/design-system";

export function AccountProfilePage() {
  return <DesignSystem.UiSurface />;
}
`,
    );

    const summary = summarizeInventory(await collectDesignSystemLegacyInventory({ rootDir }));

    expect(summary).toMatchObject({
      fileCount: 1,
      categories: {
        legacyAliasMemberUsage: 1,
      },
      owners: {
        Identity: 1,
      },
    });
    expect(summary.issues["#949"]).toBe(1);
  });
});
