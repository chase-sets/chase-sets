import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDesignSystemLegacyInventory,
  collectDesignSystemLegacyInventory,
  createDesignSystemLegacyInventoryDocument,
  printDesignSystemLegacyInventoryCheckResult,
  summarizeInventory,
} from "./design-system-legacy-inventory.mjs";

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

function writeLedger(rootDir, document) {
  writeSource(rootDir, "packages/design-system/DESIGN_SYSTEM_LEGACY_INVENTORY.json", `${JSON.stringify(document)}\n`);
}

function captureCheckOutput(result) {
  const logs = [];
  const errors = [];
  const originalLog = console.log;
  const originalError = console.error;

  try {
    console.log = (message) => logs.push(message);
    console.error = (message) => errors.push(message);
    printDesignSystemLegacyInventoryCheckResult(result);
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

  it("detects warning-tier inline styles and raw structural elements in feature UI", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/example/features/workspace/ui/workspace-page.tsx",
      `
export function WorkspacePage() {
  return (
    <section style={{ color: "red" }}>
      <h2>Workspace</h2>
      <ul>
        <li><a href="/workspace">Open</a></li>
      </ul>
    </section>
  );
}
`,
    );

    const entries = await collectDesignSystemLegacyInventory({ rootDir });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      file: "bounded-contexts/example/features/workspace/ui/workspace-page.tsx",
      categories: {
        inlineStyle: 1,
        rawStructuralElement: 4,
      },
    });
    expect(entries[0].issueTargets).toEqual(["#1666"]);
  });

  it("leaves pixel-valued dimension styles to the responsive-safety guard", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/example/features/workspace/ui/fixed-workspace-page.tsx",
      `
export function FixedWorkspacePage() {
  return <div style={{ width: "500px", height: 300 }}>Workspace</div>;
}
`,
    );

    const entries = await collectDesignSystemLegacyInventory({ rootDir });

    expect(entries).toHaveLength(1);
    expect(entries[0].categories).toEqual({ rawStructuralElement: 1 });
  });

  it("does not flag sanctioned mount primitives or documented permanent structural exceptions", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/settlement/features/payout-readiness/ui/payout-setup-page.tsx",
      `
export function PayoutSetupPage({ containerRef }) {
  return <MountPoint ref={containerRef} purpose="provider" aria-label="Stripe" data-testid="stripe-connect-embedded-component" />;
}
`,
    );
    writeSource(
      rootDir,
      "bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx",
      `
export function PublicPages({ children, steps }) {
  return (
    <main id="main-content">
      <section style={{ "--step-count": steps.length }}>{children}</section>
    </main>
  );
}
`,
    );

    const entries = await collectDesignSystemLegacyInventory({ rootDir });

    expect(entries).toEqual([]);
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
      gatingFileCount: 1,
      warningFileCount: 0,
      categories: {
        legacyAliasMemberUsage: 1,
      },
      severity: {
        error: 1,
        warning: 0,
      },
      owners: {
        Identity: 1,
      },
    });
    expect(summary.issues["#949"]).toBe(1);
  });

  it("passes check mode for a clean tree with an in-sync ledger", async () => {
    const rootDir = createRepo();
    writeLedger(rootDir, createDesignSystemLegacyInventoryDocument([]));

    const result = await checkDesignSystemLegacyInventory({ rootDir });
    const output = captureCheckOutput(result);

    expect(result.passed).toBe(true);
    expect(result.document.summary.fileCount).toBe(0);
    expect(result.document.summary.gatingFileCount).toBe(0);
    expect(output.logs.join("\n")).toContain("Design-system legacy inventory check passed");
    expect(output.errors).toEqual([]);
  });

  it("passes check mode when warning-tier findings are present and the ledger is in sync", async () => {
    const rootDir = createRepo();
    writeSource(
      rootDir,
      "bounded-contexts/example/features/workspace/ui/workspace-page.tsx",
      `
export function WorkspacePage() {
  return <span>Advisory markup</span>;
}
`,
    );
    writeLedger(
      rootDir,
      createDesignSystemLegacyInventoryDocument(await collectDesignSystemLegacyInventory({ rootDir })),
    );

    const result = await checkDesignSystemLegacyInventory({ rootDir });
    const output = captureCheckOutput(result);

    expect(result.passed).toBe(true);
    expect(result.document.summary.fileCount).toBe(1);
    expect(result.document.summary.gatingFileCount).toBe(0);
    expect(result.document.summary.warningFileCount).toBe(1);
    expect(output.logs.join("\n")).toContain("0 error-gated file(s)");
    expect(output.errors).toEqual([]);
  });

  it("fails check mode and lists offending files when the fresh scan has error-tier findings", async () => {
    const rootDir = createRepo();
    const relativeFile = "bounded-contexts/support/features/support-requests/ui/support-request-list-page.tsx";
    writeSource(
      rootDir,
      relativeFile,
      `
export function SupportRequestListPage() {
  return <button type="button">Open</button>;
}
`,
    );
    writeLedger(rootDir, createDesignSystemLegacyInventoryDocument([]));

    const result = await checkDesignSystemLegacyInventory({ rootDir });
    const output = captureCheckOutput(result);

    expect(result.passed).toBe(false);
    expect(result.document.summary.gatingFileCount).toBe(1);
    expect(output.errors.join("\n")).toContain(relativeFile);
    expect(output.errors.join("\n")).toContain("rawControl");
  });

  it("fails check mode when the committed ledger diverges from a fresh scan", async () => {
    const rootDir = createRepo();
    writeLedger(
      rootDir,
      createDesignSystemLegacyInventoryDocument([
        {
          file: "bounded-contexts/example/features/workspace/ui/stale-page.tsx",
          owner: "Example",
          categories: { rawControl: 1 },
          details: [{ category: "rawControl", line: 1, column: 1, detail: "button" }],
          phase: "Phase 4",
          issueTargets: ["#953"],
          outcome: "migrate-or-promote-to-design-system",
          prerequisites: [],
          closureEvidence: [],
          status: "open",
          ownerStatus: "unassigned until scheduled by #960",
        },
      ]),
    );

    const result = await checkDesignSystemLegacyInventory({ rootDir });
    const output = captureCheckOutput(result);

    expect(result.passed).toBe(false);
    expect(result.document.summary.fileCount).toBe(0);
    expect(output.errors.join("\n")).toContain("ledger is stale");
    expect(output.errors.join("\n")).toContain("--write-ledger");
  });
});
