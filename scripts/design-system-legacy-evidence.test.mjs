import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESIGN_SYSTEM_LEGACY_EVIDENCE_VERSION,
  checkDesignSystemLegacyEvidence,
  collectDesignSystemLegacyEvidence,
  parseDesignSystemLegacyEvidenceArgs,
  writeDesignSystemLegacyEvidence,
} from "./design-system-legacy-evidence.mjs";
import {
  collectDesignSystemLegacyInventoryDocument,
  createDesignSystemLegacyInventoryDocument,
} from "./design-system-legacy-inventory.mjs";

const tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "design-system-legacy-evidence-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeEmptyLegacyInventory(tempDir) {
  const ledgerPath = path.join(tempDir, "legacy-inventory.json");
  await writeFile(ledgerPath, JSON.stringify(createDesignSystemLegacyInventoryDocument([])));
  return ledgerPath;
}

const scopedFixtureCheck = {
  id: "fixture-workspace",
  owner: "Fixture",
  scope: "bounded-contexts/example/features/workspace/ui",
  visualEvidence: ["Fixture workspace composes design-system primitives."],
  accessibilityEvidence: ["Fixture workspace keeps dialog affordances on shared primitives."],
  mustInclude: ["DataTable", "SideSheet"],
  mustNotInclude: ["className="],
};

describe("design system legacy visual/accessibility evidence", () => {
  it("collects retained visual and accessibility evidence for representative migrated surfaces", async () => {
    const report = await collectDesignSystemLegacyEvidence({
      checkedAt: "2026-06-08T00:00:00.000Z",
    });

    expect(report).toMatchObject({
      schemaVersion: DESIGN_SYSTEM_LEGACY_EVIDENCE_VERSION,
      milestone: 12,
      checkedAt: "2026-06-08T00:00:00.000Z",
      passesDesignSystemLegacyEvidence: true,
    });
    expect(report.summary.legacyInventoryGatingFileCount).toBe(0);
    expect(report.checks.map((check) => check.status)).toEqual(report.checks.map(() => "passed"));
    expect(report.checks.map((check) => check.id)).toContain("discovery-commerce-comparison-list");
    expect(report.checks.map((check) => check.id)).toContain("public-waitlist-mobile-cta");
  }, 60_000);

  it("writes the retained evidence artifact", async () => {
    const tempDir = await makeTempDir();
    const out = path.join(tempDir, "evidence.json");
    const report = await collectDesignSystemLegacyEvidence({
      checkedAt: "2026-06-08T00:00:00.000Z",
      out,
    });

    writeDesignSystemLegacyEvidence(report, out);

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.schemaVersion).toBe(DESIGN_SYSTEM_LEGACY_EVIDENCE_VERSION);
    expect(written.retainedArtifact).toContain("evidence.json");
  }, 30000);

  it("passes the committed evidence self-diff when the fresh scan matches the artifact", async () => {
    const tempDir = await makeTempDir();
    const out = path.join(tempDir, "evidence.json");
    const ledgerPath = await writeEmptyLegacyInventory(tempDir);
    const report = await collectDesignSystemLegacyEvidence({
      checkedAt: "2026-06-08T00:00:00.000Z",
      rootDir: tempDir,
      ledgerPath,
      out,
      surfaceChecks: [],
    });
    writeDesignSystemLegacyEvidence(report, out);

    await expect(
      checkDesignSystemLegacyEvidence({
        rootDir: tempDir,
        ledgerPath,
        out,
        surfaceChecks: [],
      }),
    ).resolves.toMatchObject({
      passed: true,
      artifactInSync: true,
    });
  });

  it("fails the committed evidence self-diff when the artifact is stale", async () => {
    const tempDir = await makeTempDir();
    const out = path.join(tempDir, "evidence.json");
    const ledgerPath = await writeEmptyLegacyInventory(tempDir);
    const report = await collectDesignSystemLegacyEvidence({
      checkedAt: "2026-06-08T00:00:00.000Z",
      rootDir: tempDir,
      ledgerPath,
      out,
      surfaceChecks: [],
    });
    writeDesignSystemLegacyEvidence(
      {
        ...report,
        summary: {
          ...report.summary,
          representativeSurfaceCount: 99,
        },
      },
      out,
    );

    await expect(
      checkDesignSystemLegacyEvidence({
        rootDir: tempDir,
        ledgerPath,
        out,
        surfaceChecks: [],
      }),
    ).resolves.toMatchObject({
      passed: false,
      artifactInSync: false,
    });
  });

  it("fails closed when the fresh legacy inventory scan is not empty", async () => {
    const tempDir = await makeTempDir();
    const scopeDir = path.join(tempDir, "bounded-contexts/example/features/workspace/ui");
    await mkdir(scopeDir, { recursive: true });
    await writeFile(path.join(scopeDir, "page.tsx"), 'export function Page() { return <div className="local" />; }\n');

    const report = await collectDesignSystemLegacyEvidence({
      checkedAt: "2026-06-08T00:00:00.000Z",
      rootDir: tempDir,
      ledgerPath: await writeEmptyLegacyInventory(tempDir),
      surfaceChecks: [],
    });

    expect(report.passesDesignSystemLegacyEvidence).toBe(false);
    expect(report.summary.legacyInventoryFileCount).toBe(1);
    expect(report.summary.legacyInventoryGatingFileCount).toBe(1);
    expect(report.errors).toContain("Fresh legacy inventory scan summary.gatingFileCount must be 0.");
    expect(report.errors).toContain(
      "Legacy inventory ledger legacy-inventory.json must match a fresh design-system legacy inventory scan.",
    );
  });

  it("passes evidence validation when the fresh inventory contains only warning-tier findings", async () => {
    const tempDir = await makeTempDir();
    const scopeDir = path.join(tempDir, "bounded-contexts/example/features/workspace/ui");
    await mkdir(scopeDir, { recursive: true });
    await writeFile(path.join(scopeDir, "page.tsx"), "export function Page() { return <span>Warning</span>; }\n");
    const freshLedger = await collectDesignSystemLegacyInventoryDocument({ rootDir: tempDir });
    const ledgerPath = path.join(tempDir, "legacy-inventory.json");
    await writeFile(ledgerPath, JSON.stringify(freshLedger));

    const report = await collectDesignSystemLegacyEvidence({
      checkedAt: "2026-06-08T00:00:00.000Z",
      rootDir: tempDir,
      ledgerPath,
      surfaceChecks: [],
    });

    expect(report.passesDesignSystemLegacyEvidence).toBe(true);
    expect(report.summary.legacyInventoryFileCount).toBe(1);
    expect(report.summary.legacyInventoryGatingFileCount).toBe(0);
  });

  it("fails closed when a required symbol is absent from the entire scope", async () => {
    const tempDir = await makeTempDir();
    const scopeDir = path.join(tempDir, "bounded-contexts/example/features/workspace/ui");
    await mkdir(scopeDir, { recursive: true });
    await writeFile(
      path.join(scopeDir, "workspace-table.tsx"),
      "export function Workspace() { return <DataTable />; }\n",
    );

    const report = await collectDesignSystemLegacyEvidence({
      checkedAt: "2026-06-08T00:00:00.000Z",
      rootDir: tempDir,
      ledgerPath: await writeEmptyLegacyInventory(tempDir),
      surfaceChecks: [scopedFixtureCheck],
    });

    expect(report.passesDesignSystemLegacyEvidence).toBe(false);
    expect(report.errors).toContain(
      'fixture-workspace: bounded-contexts/example/features/workspace/ui must include "SideSheet" in at least one scoped file.',
    );
    expect(report.checks[0].requiredSignalFiles.SideSheet).toEqual([]);
  });

  it("passes when a pinned file is decomposed but required symbols remain in scope", async () => {
    const tempDir = await makeTempDir();
    const scopeDir = path.join(tempDir, "bounded-contexts/example/features/workspace/ui");
    await mkdir(scopeDir, { recursive: true });
    await writeFile(
      path.join(scopeDir, "workspace-table.tsx"),
      "export function WorkspaceTable() { return <DataTable />; }\n",
    );
    await writeFile(
      path.join(scopeDir, "workspace-sheet.tsx"),
      "export function WorkspaceSheet() { return <SideSheet />; }\n",
    );

    const report = await collectDesignSystemLegacyEvidence({
      checkedAt: "2026-06-08T00:00:00.000Z",
      rootDir: tempDir,
      ledgerPath: await writeEmptyLegacyInventory(tempDir),
      surfaceChecks: [scopedFixtureCheck],
    });

    expect(report.passesDesignSystemLegacyEvidence).toBe(true);
    expect(report.checks[0]).toMatchObject({
      scope: "bounded-contexts/example/features/workspace/ui",
      discoveredFiles: [
        "bounded-contexts/example/features/workspace/ui/workspace-sheet.tsx",
        "bounded-contexts/example/features/workspace/ui/workspace-table.tsx",
      ],
      status: "passed",
    });
  });

  it("parses write, out, and checked-at arguments", () => {
    expect(
      parseDesignSystemLegacyEvidenceArgs(
        ["--write", "--out", "packages/design-system/evidence.json", "--checked-at", "2026-06-08T00:00:00.000Z"],
        {},
      ),
    ).toMatchObject({
      check: false,
      write: true,
      out: "packages/design-system/evidence.json",
      checkedAt: "2026-06-08T00:00:00.000Z",
    });
  });

  it("parses check mode arguments", () => {
    expect(parseDesignSystemLegacyEvidenceArgs(["--check"], {})).toMatchObject({
      check: true,
      write: false,
    });
  });
});
