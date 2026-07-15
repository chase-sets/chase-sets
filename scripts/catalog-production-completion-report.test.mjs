import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CATALOG_PRODUCTION_COMPLETION_REPORT_VERSION,
  buildCatalogCompletionRecord,
  catalogCompletionExitCode,
  parseCatalogCompletionArgs,
} from "./catalog-production-completion-report.ts";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(scriptsDir, "run-catalog-production-completion-report.mjs");

function completeManifest() {
  return {
    manifestVersion: "production-catalog-completion-manifest-v1",
    frozenAt: "2026-08-01T00:00:00.000Z",
    launchCutoff: "2026-08-01T00:00:00.000Z",
    batch: { batchId: "batch-1", planFingerprint: "fp-1", status: "completed" },
    providerUnits: [
      { providerKey: "scrydex", unitKey: "cards", productionClass: "production", lifecycle: "active", active: true },
    ],
    scopes: [
      { scopeRecordId: "scope-1", eligible: true, acceptedMappings: [{ providerKey: "scrydex", unitKey: "cards" }] },
    ],
    expectedUnits: [{ scopeRecordId: "scope-1", providerKey: "scrydex", unitKey: "cards" }],
    observedUnits: [
      {
        scopeRecordId: "scope-1",
        providerKey: "scrydex",
        unitKey: "cards",
        state: "settled",
        lastCompletedAt: "2026-08-02T00:00:00.000Z",
        syncRunId: "run-1",
        observedCount: 10,
        changedCount: 1,
        failedCount: 0,
      },
    ],
    mergeCandidates: [
      {
        candidateId: "cand-1",
        scopeRecordId: "scope-1",
        status: "promoted",
        blockingConflictCount: 0,
        duplicatePreventionBlocked: false,
      },
    ],
    promotions: { create: 1, update: 0, ignore: 0, defer: 0 },
    catalogItems: { draft: 0, published: 10 },
    sourceObservations: { total: 10, observed: 0, changed: 0, promoted: 10, rejected: 0, terminalJobFailures: 0 },
    assetProcessing: { approvedFailures: 0, exclusions: 0 },
    providerUsage: [],
    exclusions: [],
  };
}

describe("catalog completion verifier core", () => {
  it("parses manifest and accepted paths", () => {
    const options = parseCatalogCompletionArgs(
      ["--manifest", "m.json", "--accepted", "a.json", "--environment", "staging"],
      {},
    );
    expect(options.manifestPath).toBe("m.json");
    expect(options.acceptedManifestPath).toBe("a.json");
    expect(options.environment).toBe("staging");
  });

  it("builds a support-safe complete record with exit code 0", () => {
    const { record, report, repeatRun } = buildCatalogCompletionRecord({
      manifest: completeManifest(),
      environment: "test",
      checkedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(record.schemaVersion).toBe(CATALOG_PRODUCTION_COMPLETION_REPORT_VERSION);
    expect(record.result).toBe("complete");
    expect(catalogCompletionExitCode({ report, repeatRun })).toBe(0);
  });

  it("marks a never-synced manifest incomplete with exit code 2", () => {
    const manifest = { ...completeManifest(), observedUnits: [] };
    const { report, repeatRun } = buildCatalogCompletionRecord({
      manifest,
      environment: "test",
      checkedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(report.result).toBe("incomplete");
    expect(catalogCompletionExitCode({ report, repeatRun })).toBe(2);
  });

  it("exits nonzero when a repeat run is not convergent", () => {
    const accepted = completeManifest();
    const repeat = { ...completeManifest(), batch: { ...accepted.batch, planFingerprint: "fp-2" } };
    const { report, repeatRun } = buildCatalogCompletionRecord({
      manifest: repeat,
      acceptedManifest: accepted,
      environment: "test",
      checkedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(repeatRun.convergent).toBe(false);
    expect(catalogCompletionExitCode({ report, repeatRun })).toBe(2);
  });
});

describe("catalog completion verifier process behavior", () => {
  let dir;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "catalog-completion-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function runVerifier(manifest) {
    const manifestPath = join(dir, `manifest-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    return spawnSync(process.execPath, [runnerPath, "--manifest", manifestPath, "--environment", "test"], {
      encoding: "utf8",
    });
  }

  it("exits 0 and prints a complete report for a complete manifest", () => {
    const result = runVerifier(completeManifest());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"result": "complete"');
    expect(result.stderr).toContain("result: COMPLETE");
  });

  it("exits 2 with launch blockers for an incomplete manifest", () => {
    const result = runVerifier({ ...completeManifest(), observedUnits: [] });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("never-synced-unit");
  });

  it("exits 1 when no manifest path is given", () => {
    const result = spawnSync(process.execPath, [runnerPath, "--environment", "test"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--manifest");
  });
});
