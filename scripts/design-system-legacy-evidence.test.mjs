import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESIGN_SYSTEM_LEGACY_EVIDENCE_VERSION,
  collectDesignSystemLegacyEvidence,
  parseDesignSystemLegacyEvidenceArgs,
  writeDesignSystemLegacyEvidence,
} from "./design-system-legacy-evidence.mjs";

const tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "design-system-legacy-evidence-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("design system legacy visual/accessibility evidence", () => {
  it("collects retained visual and accessibility evidence for representative migrated surfaces", () => {
    const report = collectDesignSystemLegacyEvidence({
      checkedAt: "2026-06-08T00:00:00.000Z",
    });

    expect(report).toMatchObject({
      schemaVersion: DESIGN_SYSTEM_LEGACY_EVIDENCE_VERSION,
      milestone: 12,
      checkedAt: "2026-06-08T00:00:00.000Z",
      passesDesignSystemLegacyEvidence: true,
    });
    expect(report.summary.legacyInventoryFileCount).toBe(0);
    expect(report.summary.legacyInventoryEntryCount).toBe(0);
    expect(report.checks.map((check) => check.status)).toEqual(report.checks.map(() => "passed"));
    expect(report.checks.map((check) => check.id)).toContain("discovery-commerce-comparison-list");
    expect(report.checks.map((check) => check.id)).toContain("public-waitlist-mobile-cta");
  });

  it("writes the retained evidence artifact", async () => {
    const tempDir = await makeTempDir();
    const out = path.join(tempDir, "evidence.json");
    const report = collectDesignSystemLegacyEvidence({
      checkedAt: "2026-06-08T00:00:00.000Z",
      out,
    });

    writeDesignSystemLegacyEvidence(report, out);

    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.schemaVersion).toBe(DESIGN_SYSTEM_LEGACY_EVIDENCE_VERSION);
    expect(written.retainedArtifact).toContain("evidence.json");
  });

  it("fails closed when the generated legacy inventory is not empty", async () => {
    const tempDir = await makeTempDir();
    const ledgerPath = path.join(tempDir, "legacy-inventory.json");
    await writeFile(
      ledgerPath,
      JSON.stringify({
        summary: { fileCount: 1, categories: { routeLocalClassName: 1 } },
        entries: [{ file: "bounded-contexts/example/ui/page.tsx" }],
      }),
    );

    const report = collectDesignSystemLegacyEvidence({
      checkedAt: "2026-06-08T00:00:00.000Z",
      ledgerPath,
    });

    expect(report.passesDesignSystemLegacyEvidence).toBe(false);
    expect(report.errors).toContain("Legacy inventory ledger summary.fileCount must be 0.");
    expect(report.errors).toContain("Legacy inventory ledger entries must be an empty array.");
    expect(report.errors).toContain("Legacy inventory ledger summary.categories must be empty.");
  });

  it("parses write, out, and checked-at arguments", () => {
    expect(
      parseDesignSystemLegacyEvidenceArgs(
        ["--write", "--out", "packages/design-system/evidence.json", "--checked-at", "2026-06-08T00:00:00.000Z"],
        {},
      ),
    ).toMatchObject({
      write: true,
      out: "packages/design-system/evidence.json",
      checkedAt: "2026-06-08T00:00:00.000Z",
    });
  });
});
