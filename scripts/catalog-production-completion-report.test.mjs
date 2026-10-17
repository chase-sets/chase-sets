import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CATALOG_PRODUCTION_COMPLETION_REPORT_VERSION,
  buildCatalogCompletionDatabaseRecord,
  buildCatalogCompletionRecord,
  catalogCompletionDatabaseConfig,
  catalogCompletionExitCode,
  parseCatalogCompletionArgs,
  runCatalogCompletionDatabaseVerifier,
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

// SYNTHETIC deployed-database coordinates: no password, reserved .invalid host.
const remoteCatalogUrl = "postgresql://report_reader@catalog-db.example.invalid:25060/catalog?sslmode=verify-full";

function databaseFacts(overrides = {}) {
  return {
    manifest: completeManifest(),
    unknownFacts: [],
    reportedFacts: {
      externalReferenceDuplicates: 0,
      legacyProfileMarkerCount: 0,
      nonTerminalIntegrationJobCount: 0,
      publicationCountsByStatus: { active: 10 },
    },
    completionProof: false,
    ...overrides,
  };
}

describe("catalog completion verifier database mode", () => {
  it("parses database facts options and the exported Catalog URL", () => {
    const options = parseCatalogCompletionArgs(["--facts", "database", "--batch-id", "batch-1"], {
      DATABASE_URL_CATALOG: remoteCatalogUrl,
    });
    expect(options).toMatchObject({ facts: "database", batchId: "batch-1", catalogDatabaseUrl: remoteCatalogUrl });
    expect(parseCatalogCompletionArgs([], {}).facts).toBe("file");
    expect(() => parseCatalogCompletionArgs(["--facts", "api"], {})).toThrow("[facts-source-invalid]");
  });

  it("fails by name when the Catalog credential or managed CA is withheld", () => {
    expect(() => catalogCompletionDatabaseConfig(null)).toThrow("[catalog-database-url-missing]");
    expect(() => catalogCompletionDatabaseConfig(remoteCatalogUrl)).toThrow("[managed-postgres-ca-missing]");
    const unreadable = () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    expect(() =>
      catalogCompletionDatabaseConfig(`${remoteCatalogUrl}&sslrootcert=/missing/ca.pem`, unreadable),
    ).toThrow("[managed-postgres-ca-missing]");
    const config = catalogCompletionDatabaseConfig(`${remoteCatalogUrl}&sslrootcert=/ca.pem`, () => "SYNTHETIC CA");
    expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: "SYNTHETIC CA" });
  });

  it("never opens a pool when the CA is withheld", async () => {
    let pools = 0;
    const options = parseCatalogCompletionArgs(["--facts", "database", "--batch-id", "batch-1"], {
      DATABASE_URL_CATALOG: remoteCatalogUrl,
    });
    await expect(
      runCatalogCompletionDatabaseVerifier(options, () => {
        pools += 1;
        throw new Error("pool must not be created");
      }),
    ).rejects.toThrow("[managed-postgres-ca-missing]");
    expect(pools).toBe(0);
  });

  it("marks unknown facts evidence-incomplete with exit code 2 and keeps the record parseable", () => {
    const { record, report, repeatRun, unknownFacts } = buildCatalogCompletionDatabaseRecord({
      facts: databaseFacts({ unknownFacts: ["provider-usage-check-state:scrydex"] }),
      environment: "staging",
      checkedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(report.result).toBe("complete");
    expect(record).toMatchObject({
      factsSource: "database",
      result: "evidence-incomplete",
      completionProof: false,
      unknownFacts: ["provider-usage-check-state:scrydex"],
    });
    expect(catalogCompletionExitCode({ report, repeatRun, unknownFacts })).toBe(2);
  });

  it("reports a complete observed state with exit code 0 but no completion proof", () => {
    const { record, report, repeatRun, unknownFacts } = buildCatalogCompletionDatabaseRecord({
      facts: databaseFacts(),
      environment: "staging",
      checkedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(record).toMatchObject({ result: "complete", completionProof: false, unknownFacts: [] });
    expect(record.reportedFacts.publicationCountsByStatus).toEqual({ active: 10 });
    expect(catalogCompletionExitCode({ report, repeatRun, unknownFacts })).toBe(0);
  });

  it("leaves the file-mode record shape unchanged", () => {
    const { record } = buildCatalogCompletionRecord({
      manifest: completeManifest(),
      environment: "test",
      checkedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(Object.keys(record)).toEqual([
      "schemaVersion",
      "environment",
      "checkedAt",
      "result",
      "convergent",
      "report",
    ]);
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

  // The child inherits no Catalog credential: database mode must refuse by name.
  function runDatabaseVerifier(env) {
    const scrubbed = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/DATABASE_URL|^PG/.test(name)));
    return spawnSync(
      process.execPath,
      [runnerPath, "--facts", "database", "--batch-id", "batch-1", "--environment", "test"],
      { encoding: "utf8", env: { ...scrubbed, ...env } },
    );
  }

  it("exits 1 naming the withheld Catalog credential", () => {
    const result = runDatabaseVerifier({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[catalog-database-url-missing]");
  });

  it("exits 1 naming the withheld managed CA", () => {
    const result = runDatabaseVerifier({ DATABASE_URL_CATALOG: remoteCatalogUrl });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[managed-postgres-ca-missing]");
    expect(result.stderr).not.toContain("catalog-db.example.invalid");
  });

  it("exits 1 when no manifest path is given", () => {
    const result = spawnSync(process.execPath, [runnerPath, "--environment", "test"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--manifest");
  });
});
