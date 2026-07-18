#!/usr/bin/env node
// Support-safe operator entry point for the one-time Catalog Integration
// Control Plane pre-launch wipe/rebuild policy. Production/prelaunch is
// deliberately refused until it has separate release machinery.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  normalizePgPoolConnectionString,
  resolvePgPoolSslConfig,
  type PgQueryable,
  type PgTransactionalPool,
} from "../infrastructure/event-core-postgres/index.ts";
import {
  catalogIntegrationDataResetTargetTables,
  collectCatalogIntegrationDataVerificationReport,
  evaluateCatalogIntegrationDataResetEvidence,
  resetCatalogIntegrationPreLaunchData,
  type CatalogIntegrationDataBackupDecision,
  type CatalogIntegrationDataResetEnvironment,
  type CatalogIntegrationDataResetEvidenceFinding,
  type CatalogIntegrationDataResetReport,
  type CatalogIntegrationDataVerificationReport,
} from "../bounded-contexts/catalog/features/source-observations/api/catalog-integration-data-migration-reset.ts";
import { runStagingRefreshOverlapGate } from "./staging-refresh-preflight.mjs";

const { Pool } = pg;

export const CATALOG_INTEGRATION_RESET_VERSION = "catalog-integration-reset/v1";
export const CATALOG_INTEGRATION_RESET_CONFIRMATION = "reset staging catalog integration data";
export const STAGING_CATALOG_DATABASE_NAME = "chase_sets_staging_catalog";

export type CatalogIntegrationResetAction = "dry-run" | "apply";

export type CatalogIntegrationResetOptions = Readonly<{
  action: CatalogIntegrationResetAction;
  environment: CatalogIntegrationDataResetEnvironment;
  databaseUrl: string | null;
  operator: string | null;
  approvalReference: string | null;
  confirmation: string | null;
  backupDecision: CatalogIntegrationDataBackupDecision | null;
  smokeVerificationReference: string | null;
  outPath: string | null;
  repository: string;
  currentRunId: string | null;
}>;

type DatabaseIdentity = Readonly<{
  expectedDatabaseName: string;
  actualDatabaseName: string;
  matched: true;
}>;

type OverlapGateReport = Readonly<{
  schemaVersion: string;
  generatedAt: string;
  environment: string;
  result: "pass" | "blocked";
  overlaps: readonly Readonly<{ name: string; status: string; url: string; databaseId: number | string }>[];
  blockers: readonly string[];
  humanGates: readonly string[];
}>;

export type CatalogIntegrationResetRecord = Readonly<{
  schemaVersion: typeof CATALOG_INTEGRATION_RESET_VERSION;
  generatedAt: string;
  action: CatalogIntegrationResetAction;
  environment: CatalogIntegrationDataResetEnvironment;
  mode: "pre-launch-wipe-and-rebuild";
  result: "dry-run-complete" | "applied";
  operator: string | null;
  approvalReference: string | null;
  databaseIdentity: DatabaseIdentity;
  targetTables: readonly string[];
  dryRun: CatalogIntegrationDataVerificationReport;
  overlapPreflight: OverlapGateReport | null;
  reset: CatalogIntegrationDataResetReport | null;
  evidenceFindings: readonly CatalogIntegrationDataResetEvidenceFinding[];
}>;

type CatalogIntegrationResetDependencies = Readonly<{
  collectVerificationReport?: typeof collectCatalogIntegrationDataVerificationReport;
  resetPreLaunchData?: typeof resetCatalogIntegrationPreLaunchData;
  evaluateEvidence?: typeof evaluateCatalogIntegrationDataResetEvidence;
  runOverlapGate?: (
    options: Readonly<{ environment: string; repository: string; currentRunId: string | null }>,
  ) => Promise<OverlapGateReport>;
  now?: () => string;
}>;

function readOption(argv: readonly string[], name: string): string | null {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim() || null;
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value.trim() || null : null;
}

function readEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  return value?.trim() || null;
}

export function parseCatalogIntegrationResetArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CatalogIntegrationResetOptions {
  const action = readOption(argv, "--action") ?? "dry-run";
  const environment = readOption(argv, "--environment") ?? "staging";
  return {
    action: action as CatalogIntegrationResetAction,
    environment: environment as CatalogIntegrationDataResetEnvironment,
    databaseUrl: readEnv(env, "DATABASE_URL_CATALOG"),
    operator: readOption(argv, "--operator") ?? readEnv(env, "CATALOG_INTEGRATION_RESET_OPERATOR"),
    approvalReference:
      readOption(argv, "--approval-reference") ?? readEnv(env, "CATALOG_INTEGRATION_RESET_APPROVAL_REFERENCE"),
    confirmation: readOption(argv, "--confirm") ?? readEnv(env, "CATALOG_INTEGRATION_RESET_CONFIRM"),
    backupDecision: parseBackupDecision(argv),
    smokeVerificationReference:
      readOption(argv, "--smoke-verification-reference") ??
      readEnv(env, "CATALOG_INTEGRATION_RESET_SMOKE_VERIFICATION_REFERENCE"),
    outPath: readOption(argv, "--out"),
    repository: readOption(argv, "--repository") ?? readEnv(env, "GITHUB_REPOSITORY") ?? "chase-sets/chase-sets",
    currentRunId: readEnv(env, "GITHUB_RUN_ID"),
  };
}

function parseBackupDecision(argv: readonly string[]): CatalogIntegrationDataBackupDecision | null {
  const kind = readOption(argv, "--backup-decision");
  if (kind === "create-backup-snapshot-export") {
    return {
      kind,
      reference: readOption(argv, "--backup-reference") ?? "",
      owner: readOption(argv, "--backup-owner") ?? "",
      retentionUntil: readOption(argv, "--backup-retention-until") ?? "",
      restoreVerificationReference: readOption(argv, "--backup-restore-verification-reference") ?? "",
    };
  }
  if (kind === "skip-backup-accepted-data-loss") {
    return {
      kind,
      approver: readOption(argv, "--backup-approver") ?? "",
      rationale: readOption(argv, "--backup-rationale") ?? "",
      targetDataSet: readOption(argv, "--backup-target-data-set") ?? "",
    };
  }
  if (kind === "retain-data-reset-unsafe") {
    return {
      kind,
      owner: readOption(argv, "--backup-owner") ?? "",
      expiresAt: readOption(argv, "--retained-data-expires-at") ?? "",
      reason: readOption(argv, "--retained-data-reason") ?? "",
    };
  }
  return null;
}

export function validateCatalogIntegrationResetOptions(options: CatalogIntegrationResetOptions): readonly string[] {
  const errors: string[] = [];
  if (options.action !== "dry-run" && options.action !== "apply") {
    errors.push("--action must be dry-run or apply.");
  }
  if (options.environment === "production-prelaunch") {
    errors.push(
      "Production/prelaunch is refused by this staging operator entry point; create separately reviewed production machinery after a successful staging rehearsal.",
    );
  } else if (options.environment !== "staging") {
    errors.push("--environment must be staging or production-prelaunch.");
  }
  if (!options.databaseUrl) {
    errors.push("DATABASE_URL_CATALOG is required.");
  }
  if (options.action === "apply") {
    if (options.confirmation !== CATALOG_INTEGRATION_RESET_CONFIRMATION) {
      errors.push(`--confirm must exactly equal \"${CATALOG_INTEGRATION_RESET_CONFIRMATION}\".`);
    }
    if (!options.operator) errors.push("--operator is required for apply.");
    if (!options.approvalReference) errors.push("--approval-reference is required for apply.");
    errors.push(...validateBackupDecision(options.backupDecision));
  }
  return errors;
}

function validateBackupDecision(decision: CatalogIntegrationDataBackupDecision | null): readonly string[] {
  if (!decision) return ["--backup-decision is required for apply."];
  if (decision.kind === "retain-data-reset-unsafe") {
    return ["Retained reset-unsafe data blocks destructive apply."];
  }
  if (decision.kind === "create-backup-snapshot-export") {
    const missing = [
      [decision.reference, "--backup-reference"],
      [decision.owner, "--backup-owner"],
      [decision.retentionUntil, "--backup-retention-until"],
      [decision.restoreVerificationReference, "--backup-restore-verification-reference"],
    ].filter(([value]) => !value);
    return missing.map(([, name]) => `${name} is required for the selected backup decision.`);
  }
  const missing = [
    [decision.approver, "--backup-approver"],
    [decision.rationale, "--backup-rationale"],
    [decision.targetDataSet, "--backup-target-data-set"],
  ].filter(([value]) => !value);
  return missing.map(([, name]) => `${name} is required for the selected backup decision.`);
}

export async function assertStagingCatalogDatabaseIdentity(db: PgQueryable): Promise<DatabaseIdentity> {
  const result = await db.query<Readonly<{ database_name: string }>>("SELECT current_database() AS database_name");
  const actualDatabaseName = result.rows[0]?.database_name ?? "unknown";
  if (actualDatabaseName !== STAGING_CATALOG_DATABASE_NAME) {
    throw new Error(
      `Connected database '${actualDatabaseName}' did not match required staging Catalog database '${STAGING_CATALOG_DATABASE_NAME}'.`,
    );
  }
  return { expectedDatabaseName: STAGING_CATALOG_DATABASE_NAME, actualDatabaseName, matched: true };
}

export async function runCatalogIntegrationReset(
  options: CatalogIntegrationResetOptions,
  db: PgTransactionalPool,
  dependencies: CatalogIntegrationResetDependencies = {},
): Promise<CatalogIntegrationResetRecord> {
  const errors = validateCatalogIntegrationResetOptions(options);
  if (errors.length > 0) throw new Error(errors.join(" "));

  const collectVerificationReport =
    dependencies.collectVerificationReport ?? collectCatalogIntegrationDataVerificationReport;
  const resetPreLaunchData = dependencies.resetPreLaunchData ?? resetCatalogIntegrationPreLaunchData;
  const evaluateEvidence = dependencies.evaluateEvidence ?? evaluateCatalogIntegrationDataResetEvidence;
  const runOverlapGate = dependencies.runOverlapGate ?? runStagingRefreshOverlapGate;
  const generatedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const databaseIdentity = await assertStagingCatalogDatabaseIdentity(db);
  const targetTables = catalogIntegrationDataResetTargetTables();
  if (targetTables.length === 0) throw new Error("Catalog integration reset target-table scope is empty.");
  const dryRun = await collectVerificationReport(db);

  if (options.action === "dry-run") {
    return {
      schemaVersion: CATALOG_INTEGRATION_RESET_VERSION,
      generatedAt,
      action: options.action,
      environment: options.environment,
      mode: "pre-launch-wipe-and-rebuild",
      result: "dry-run-complete",
      operator: options.operator,
      approvalReference: options.approvalReference,
      databaseIdentity,
      targetTables,
      dryRun,
      overlapPreflight: null,
      reset: null,
      evidenceFindings: [],
    };
  }

  const activeJobs = dryRun.activeIntegrationDurableJobs + dryRun.activeBulkReviewJobs;
  if (activeJobs > 0) {
    throw new Error(
      `Catalog integration reset is blocked by ${activeJobs} queued or running job(s); active-job reset is disabled.`,
    );
  }

  // This is intentionally the last external preflight before the policy opens
  // its transaction. The policy then re-reads active jobs in-transaction.
  const overlapPreflight = await runOverlapGate({
    environment: "staging",
    repository: options.repository,
    currentRunId: options.currentRunId,
  });
  if (overlapPreflight.result !== "pass") {
    throw new Error(`Fresh staging overlap preflight blocked apply: ${overlapPreflight.blockers.join(", ")}.`);
  }

  await assertStagingCatalogDatabaseIdentity(db);
  const reset = await resetPreLaunchData(db, {
    mode: "pre-launch-wipe-and-rebuild",
    allowActiveJobReset: false,
  });
  const evidenceFindings = evaluateEvidence({
    environment: "staging",
    generatedAt,
    operator: options.operator ?? "",
    approvalReference: options.approvalReference,
    backupDecision: options.backupDecision,
    smokeVerificationReference: options.smokeVerificationReference,
    targetTables,
    dryRun,
    before: reset.before,
    after: reset.after,
  });

  return {
    schemaVersion: CATALOG_INTEGRATION_RESET_VERSION,
    generatedAt,
    action: options.action,
    environment: options.environment,
    mode: reset.mode,
    result: "applied",
    operator: options.operator,
    approvalReference: options.approvalReference,
    databaseIdentity,
    targetTables,
    dryRun,
    overlapPreflight,
    reset,
    evidenceFindings,
  };
}

function redactFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
    .replace(/([?&](?:password|token|key)=)[^&\s]+/gi, "$1[redacted]");
}

async function main(): Promise<void> {
  const options = parseCatalogIntegrationResetArgs(process.argv.slice(2));
  const errors = validateCatalogIntegrationResetOptions(options);
  if (errors.length > 0) throw new Error(errors.join(" "));

  const normalizedConnectionString = normalizePgPoolConnectionString(options.databaseUrl ?? "");
  const pool = new Pool({
    connectionString: normalizedConnectionString,
    ssl: resolvePgPoolSslConfig(normalizedConnectionString),
    max: 1,
    application_name: "chase_sets_catalog_integration_reset",
  });
  try {
    const record = await runCatalogIntegrationReset(options, pool as unknown as PgTransactionalPool);
    const serialized = JSON.stringify(record, null, 2);
    if (options.outPath) {
      mkdirSync(dirname(options.outPath), { recursive: true });
      writeFileSync(options.outPath, `${serialized}\n`);
    }
    process.stdout.write(`${serialized}\n`);
  } finally {
    await pool.end();
  }
}

const entryPath = process.argv[1] ?? "";
const isCliEntry =
  entryPath === fileURLToPath(import.meta.url) || /run-catalog-integration-reset\.mjs$/.test(entryPath);
if (isCliEntry) {
  main().catch((error) => {
    process.stderr.write(`Catalog integration reset command failed: ${redactFailure(error)}\n`);
    process.exitCode = 1;
  });
}
