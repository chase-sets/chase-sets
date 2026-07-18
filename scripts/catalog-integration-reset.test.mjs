import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { stagingRefreshOverlapWorkflowFiles } from "./staging-refresh-preflight-config.mjs";
import {
  CATALOG_INTEGRATION_RESET_CONFIRMATION,
  CATALOG_INTEGRATION_RESET_WORKFLOW_FILE,
  STAGING_CATALOG_DATABASE_NAME,
  assertStagingCatalogDatabaseIdentity,
  catalogIntegrationResetExitCode,
  parseCatalogIntegrationResetArgs,
  runCatalogIntegrationReset,
  validateCatalogIntegrationResetOptions,
} from "./catalog-integration-reset.ts";

const workflow = readFileSync(resolve(".github/workflows/catalog-integration-staging-reset.yml"), "utf8");
const overlapWorkflowSources = stagingRefreshOverlapWorkflowFiles.map((file) => readFileSync(resolve(file), "utf8"));
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(scriptsDir, "run-catalog-integration-reset.mjs");

const targetTables = [
  "catalog_source_observation_integration_work_units",
  "catalog_source_observation_integration_job_events",
  "catalog_source_observation_integration_durable_jobs",
  "catalog_source_observation_bulk_review_work_units",
  "catalog_source_observation_bulk_review_job_events",
  "catalog_source_observation_bulk_review_jobs",
  "catalog_source_observations",
  "catalog_provider_option_query_cache",
  "catalog_tcgplayer_automation_domain_rate_limits",
  "catalog_provider_integration_profile_versions",
  "event_store_streams / event_store_events WHERE stream_id LIKE 'catalog.source-observation-%'",
];

function verification(overrides = {}) {
  return {
    providerProfileVersions: 3,
    adminAuthoredProfileVersions: 0,
    referencedProfileVersions: 0,
    activeProviderProfiles: 3,
    sourceObservations: 0,
    sourceObservationEventStreams: 0,
    sourceObservationEvents: 0,
    legacySourceObservationReferences: 0,
    integrationDurableJobs: 0,
    activeIntegrationDurableJobs: 0,
    integrationWorkUnits: 0,
    bulkReviewJobs: 0,
    activeBulkReviewJobs: 0,
    bulkReviewWorkUnits: 0,
    profileSections: 12,
    profileSectionDiagnostics: 0,
    providerOptionQueryCacheEntries: 0,
    providerOptionRateLimits: 0,
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    action: "dry-run",
    environment: "staging",
    databaseUrl: "postgresql://must-not-appear.example/catalog",
    operator: null,
    approvalReference: null,
    confirmation: null,
    backupDecision: null,
    smokeVerificationReference: null,
    outPath: null,
    ...overrides,
  };
}

function applyOptions(overrides = {}) {
  return options({
    action: "apply",
    operator: "catalog-release-operator",
    approvalReference: "https://github.com/chase-sets/chase-sets/issues/5715#approved",
    confirmation: CATALOG_INTEGRATION_RESET_CONFIRMATION,
    backupDecision: {
      kind: "skip-backup-accepted-data-loss",
      approver: "Todd",
      rationale: "Approved staging rehearsal against prelaunch-only QA data.",
      targetDataSet: "staging Catalog integration prelaunch QA data",
    },
    smokeVerificationReference: "https://github.com/chase-sets/chase-sets/actions/runs/123",
    ...overrides,
  });
}

function database(actualDatabaseName = STAGING_CATALOG_DATABASE_NAME) {
  return {
    query: vi.fn(async (sql) => {
      if (sql.includes("current_database()")) return { rows: [{ database_name: actualDatabaseName }] };
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
}

function passingOverlapGate() {
  return {
    schemaVersion: "staging-refresh-preflight/v1",
    generatedAt: "2026-07-18T20:00:00.000Z",
    environment: "staging",
    result: "pass",
    overlaps: [],
    blockers: [],
    humanGates: [],
  };
}

function authenticatedIdentity() {
  return { repository: "chase-sets/chase-sets", currentRunId: "123" };
}

describe("catalog integration reset argument and environment gates", () => {
  it("defaults to a non-destructive staging dry run and reads the Catalog URL without emitting it", () => {
    const parsed = parseCatalogIntegrationResetArgs([], {
      DATABASE_URL_CATALOG: "postgresql://secret:password@example.invalid/catalog",
    });

    expect(parsed.action).toBe("dry-run");
    expect(parsed.environment).toBe("staging");
    expect(parsed.databaseUrl).toContain("secret:password");
    expect(JSON.stringify({ ...parsed, databaseUrl: undefined })).not.toContain("secret:password");
    expect(parsed).not.toHaveProperty("repository");
    expect(parsed).not.toHaveProperty("currentRunId");
  });

  it("refuses production/prelaunch even when apply confirmations are complete", () => {
    expect(validateCatalogIntegrationResetOptions(applyOptions({ environment: "production-prelaunch" }))).toContain(
      "Production/prelaunch is refused by this staging operator entry point; create separately reviewed production machinery after a successful staging rehearsal.",
    );
  });

  it("requires exact confirmation, operator, approval, and complete backup evidence for apply", () => {
    const errors = validateCatalogIntegrationResetOptions(
      options({
        action: "apply",
        confirmation: "yes",
        backupDecision: { kind: "skip-backup-accepted-data-loss", approver: "", rationale: "", targetDataSet: "" },
      }),
    );

    expect(errors).toContain(`--confirm must exactly equal "${CATALOG_INTEGRATION_RESET_CONFIRMATION}".`);
    expect(errors).toContain("--operator is required for apply.");
    expect(errors).toContain("--approval-reference is required for apply.");
    expect(errors).toContain("--backup-approver is required for the selected backup decision.");
    expect(errors).toContain("--backup-rationale is required for the selected backup decision.");
    expect(errors).toContain("--backup-target-data-set is required for the selected backup decision.");
  });

  it("fails closed when the connected database is not the exact staging Catalog database", async () => {
    await expect(assertStagingCatalogDatabaseIdentity(database("chase_sets_production_catalog"))).rejects.toThrow(
      "did not match required staging Catalog database",
    );
  });

  it("runs through the retained Node ops wrapper and fails before connection when the URL env is absent", () => {
    const env = { ...process.env };
    delete env.DATABASE_URL_CATALOG;
    const result = spawnSync(process.execPath, [runnerPath, "--action", "dry-run"], {
      encoding: "utf8",
      env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL_CATALOG is required.");
  }, 40_000);
});

describe("catalog integration reset execution", () => {
  it("collects dry-run counts and exact scope without preflight or destructive execution", async () => {
    const db = database();
    const collectVerificationReport = vi.fn(async () => verification({ sourceObservations: 41 }));
    const resetPreLaunchData = vi.fn();
    const runOverlapGate = vi.fn();

    const record = await runCatalogIntegrationReset(options(), db, {
      collectVerificationReport,
      resetPreLaunchData,
      runOverlapGate,
      now: () => "2026-07-18T20:00:00.000Z",
    });

    expect(record.result).toBe("dry-run-complete");
    expect(record.dryRun.sourceObservations).toBe(41);
    expect(record.targetTables).toEqual(targetTables);
    expect(record.targetTables.length).toBeGreaterThan(0);
    expect(record.reset).toBeNull();
    expect(record.overlapPreflight).toBeNull();
    expect(resetPreLaunchData).not.toHaveBeenCalled();
    expect(runOverlapGate).not.toHaveBeenCalled();
    expect(JSON.stringify(record)).not.toContain("must-not-appear.example");
  });

  it("blocks active jobs before overlap preflight and keeps forced reset disabled", async () => {
    const resetPreLaunchData = vi.fn();
    const runOverlapGate = vi.fn();

    await expect(
      runCatalogIntegrationReset(applyOptions(), database(), {
        collectVerificationReport: vi.fn(async () =>
          verification({ activeIntegrationDurableJobs: 1, activeBulkReviewJobs: 2 }),
        ),
        resetPreLaunchData,
        runOverlapGate,
      }),
    ).rejects.toThrow("blocked by 3 queued or running job(s); active-job reset is disabled");
    expect(runOverlapGate).not.toHaveBeenCalled();
    expect(resetPreLaunchData).not.toHaveBeenCalled();
  });

  it("blocks apply when the fresh #5639 overlap gate does not pass", async () => {
    const resetPreLaunchData = vi.fn();
    await expect(
      runCatalogIntegrationReset(applyOptions(), database(), {
        collectVerificationReport: vi.fn(async () => verification()),
        resetPreLaunchData,
        resolveGitHubIdentity: vi.fn(async () => authenticatedIdentity()),
        runOverlapGate: vi.fn(async () => ({
          ...passingOverlapGate(),
          result: "blocked",
          blockers: ["overlap:Platform Staging Reset:in_progress"],
        })),
      }),
    ).rejects.toThrow("Fresh staging overlap preflight blocked apply");
    expect(resetPreLaunchData).not.toHaveBeenCalled();
  });

  it("applies the bounded-context policy with active-job reset disabled and emits complete evidence", async () => {
    const before = verification({ sourceObservations: 19, providerOptionQueryCacheEntries: 4 });
    const after = verification();
    const reset = {
      mode: "pre-launch-wipe-and-rebuild",
      before,
      after,
      steps: targetTables.map((tableName) => ({ tableName, action: "delete", rowsAffected: 0 })),
      backfillDecisions: [
        { key: "profile-section-projections", required: true, reason: "Rebuilt from seeded profiles." },
      ],
      seedProfilesRebuilt: true,
    };
    const resetPreLaunchData = vi.fn(async () => reset);
    const db = database();

    const record = await runCatalogIntegrationReset(applyOptions(), db, {
      collectVerificationReport: vi.fn(async () => before),
      resetPreLaunchData,
      resolveGitHubIdentity: vi.fn(async (identityOptions) => {
        expect(identityOptions.workflowFile).toBe(CATALOG_INTEGRATION_RESET_WORKFLOW_FILE);
        return authenticatedIdentity();
      }),
      runOverlapGate: vi.fn(async () => passingOverlapGate()),
      now: () => "2026-07-18T20:00:00.000Z",
    });

    expect(resetPreLaunchData).toHaveBeenCalledWith(db, {
      mode: "pre-launch-wipe-and-rebuild",
      allowActiveJobReset: false,
    });
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(record.reset).toEqual(reset);
    expect(record.reset.before).toEqual(before);
    expect(record.reset.after).toEqual(after);
    expect(record.reset.steps).toHaveLength(targetTables.length);
    expect(record.reset.backfillDecisions).toHaveLength(1);
    expect(record.reset.seedProfilesRebuilt).toBe(true);
    expect(record.evidenceFindings).toEqual([]);
    expect(record.result).toBe("applied");
    expect(catalogIntegrationResetExitCode(record)).toBe(0);
  });

  it("returns failed with a non-zero exit code and exact P0 residue when postconditions are incomplete", async () => {
    const after = verification({ sourceObservationEventStreams: 2, sourceObservationEvents: 7 });
    const record = await runCatalogIntegrationReset(applyOptions(), database(), {
      collectVerificationReport: vi.fn(async () => verification()),
      resetPreLaunchData: vi.fn(async () => ({
        mode: "pre-launch-wipe-and-rebuild",
        before: verification(),
        after,
        steps: [],
        backfillDecisions: [],
        seedProfilesRebuilt: true,
      })),
      resolveGitHubIdentity: vi.fn(async () => authenticatedIdentity()),
      runOverlapGate: vi.fn(async () => passingOverlapGate()),
      now: () => "2026-07-18T20:00:00.000Z",
    });

    expect(record.result).toBe("failed");
    expect(catalogIntegrationResetExitCode(record)).toBe(2);
    expect(record.evidenceFindings).toEqual([
      expect.objectContaining({
        code: "post-reset-source-observation-event-streams-remain",
        severity: "p0",
        message: "Post-reset verification still has 2 Source Observation event stream row(s) and 7 event row(s).",
      }),
    ]);
  });
});

describe("Catalog Integration Staging Reset workflow", () => {
  it("pins staging scope, exact destructive confirmation, production refusal, and retained evidence", () => {
    expect(workflow).toContain("name: Catalog Integration Staging Reset");
    expect(workflow).toContain("environment: staging");
    expect(workflow).toContain("inputs.environment != 'staging'");
    expect(workflow).toContain(`inputs.confirm != '${CATALOG_INTEGRATION_RESET_CONFIRMATION}'`);
    expect(workflow).toContain("pnpm run ops catalog:integration-reset");
    expect(workflow).toContain("--approval-reference");
    expect(workflow).toContain("--connection-mode pooled");
    expect(workflow).toContain("retention-days: 30");
    expect(workflow).toContain("group: platform-staging-mutating-operations");
    expect(
      overlapWorkflowSources.every((source) => source.includes("group: platform-staging-mutating-operations")),
    ).toBe(true);
  });
});
