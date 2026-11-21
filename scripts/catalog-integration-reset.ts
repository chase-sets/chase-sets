#!/usr/bin/env node
// Support-safe operator entry point for the one-time Catalog Integration
// Control Plane pre-launch wipe/rebuild policy.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  createPgPool,
  type PgQueryable,
  type PgTransactionalPool,
} from "../infrastructure/event-core-postgres/index.ts";
import {
  PRODUCTION_CATALOG_DATABASE_NAME,
  catalogIntegrationProductionResetTargetTables,
  catalogIntegrationDataResetTargetTables,
  collectCatalogIntegrationDataVerificationReport,
  evaluateCatalogIntegrationDataResetEvidence,
  resetCatalogIntegrationPreLaunchData,
  runCatalogIntegrationProductionReset,
  type CatalogIntegrationDataBackupDecision,
  type CatalogIntegrationDataResetEnvironment,
  type CatalogIntegrationDataResetEvidenceFinding,
  type CatalogIntegrationDataResetReport,
  type CatalogIntegrationDataVerificationReport,
} from "../bounded-contexts/catalog/features/source-observations/api/catalog-integration-data-migration-reset.ts";
import {
  resolveAuthenticatedGitHubActionsIdentity,
  runStagingRefreshOverlapGate,
} from "./staging-refresh-preflight.mjs";

export const CATALOG_INTEGRATION_RESET_VERSION = "catalog-integration-reset/v1";
export const CATALOG_INTEGRATION_RESET_CONFIRMATION = "reset staging catalog integration data";
export const PRODUCTION_CATALOG_INTEGRATION_RESET_CONFIRMATION = "reset production catalog integration data";
export const STAGING_CATALOG_DATABASE_NAME = "chase_sets_staging_catalog";
export const CATALOG_INTEGRATION_RESET_WORKFLOW_FILE = ".github/workflows/catalog-integration-staging-reset.yml";

export type CatalogIntegrationResetAction = "dry-run" | "apply";

export type CatalogIntegrationResetOptions = Readonly<{
  action: CatalogIntegrationResetAction;
  environment: CatalogIntegrationDataResetEnvironment;
  databaseUrl: string | null;
  operator: string | null;
  approvalReference: string | null;
  confirmation: string | null;
  backupDecision: CatalogIntegrationDataBackupDecision | null;
  dryRunFingerprint?: string | null;
  stagingRehearsalReference?: string | null;
  smokeVerificationReference: string | null;
  outPath: string | null;
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
  result: "dry-run-complete" | "applied" | "already-applied" | "failed";
  operator: string | null;
  approvalReference: string | null;
  databaseIdentity: DatabaseIdentity;
  targetTables: readonly string[];
  dryRun: CatalogIntegrationDataVerificationReport;
  overlapPreflight: OverlapGateReport | null;
  reset: CatalogIntegrationDataResetReport | null;
  evidenceFindings: readonly CatalogIntegrationDataResetEvidenceFinding[];
  production?: Awaited<ReturnType<typeof runCatalogIntegrationProductionReset>>;
}>;

type CatalogIntegrationResetDependencies = Readonly<{
  collectVerificationReport?: typeof collectCatalogIntegrationDataVerificationReport;
  resetPreLaunchData?: typeof resetCatalogIntegrationPreLaunchData;
  evaluateEvidence?: typeof evaluateCatalogIntegrationDataResetEvidence;
  runOverlapGate?: (
    options: Readonly<{ environment: string; repository: string; currentRunId: string | null }>,
  ) => Promise<OverlapGateReport>;
  resolveGitHubIdentity?: (
    options: Readonly<{
      workflowFile: string;
      runIdHint: string | null;
    }>,
  ) => Promise<Readonly<{ repository: string; currentRunId: string | null }>>;
  now?: () => string;
}>;

function readOption(argv: readonly string[], name: string, normalize = true): string | null {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  const found = inline ? inline.slice(name.length + 1) : value?.startsWith("--") ? undefined : value;
  return (normalize ? found?.trim() : found) || null;
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
    confirmation:
      environment === "production-prelaunch"
        ? readOption(argv, "--confirm", false)
        : (readOption(argv, "--confirm") ?? readEnv(env, "CATALOG_INTEGRATION_RESET_CONFIRM")),
    backupDecision: parseBackupDecision(argv),
    dryRunFingerprint: readOption(argv, "--dry-run-fingerprint"),
    stagingRehearsalReference: readOption(argv, "--staging-rehearsal-reference"),
    smokeVerificationReference:
      readOption(argv, "--smoke-verification-reference") ??
      readEnv(env, "CATALOG_INTEGRATION_RESET_SMOKE_VERIFICATION_REFERENCE"),
    outPath: readOption(argv, "--out"),
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
  const production = options.environment === "production-prelaunch";
  if (!production && options.environment !== "staging") {
    errors.push("--environment must be staging or production-prelaunch.");
  }
  if (!options.databaseUrl) {
    errors.push("DATABASE_URL_CATALOG is required.");
  }
  if (options.action === "apply") {
    const confirmation = production
      ? PRODUCTION_CATALOG_INTEGRATION_RESET_CONFIRMATION
      : CATALOG_INTEGRATION_RESET_CONFIRMATION;
    if (options.confirmation !== confirmation) {
      errors.push(`--confirm must exactly equal "${confirmation}".`);
    }
    if (!(production ? options.operator?.trim() : options.operator)) errors.push("--operator is required for apply.");
    if (!(production ? options.approvalReference?.trim() : options.approvalReference))
      errors.push("--approval-reference is required for apply.");
    if (production) {
      if (options.backupDecision?.kind !== "create-backup-snapshot-export") {
        errors.push(
          "Production apply requires a managed Postgres backup or restore point; skipping backup is not allowed.",
        );
      }
      if (!options.dryRunFingerprint?.trim()) errors.push("--dry-run-fingerprint is required for production apply.");
      if (!options.stagingRehearsalReference?.trim())
        errors.push("--staging-rehearsal-reference is required for production apply.");
      if (!options.smokeVerificationReference?.trim())
        errors.push("--smoke-verification-reference is required for production apply.");
    }
    errors.push(...validateBackupDecision(options.backupDecision, production));
  }
  return errors;
}

function validateBackupDecision(
  decision: CatalogIntegrationDataBackupDecision | null,
  production: boolean,
): readonly string[] {
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
    ].filter(([value]) => !(production ? value.trim() : value));
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

  if (options.environment === "production-prelaunch") {
    return runProductionReset(options, db, dependencies.now ?? (() => new Date().toISOString()));
  }

  const collectVerificationReport =
    dependencies.collectVerificationReport ?? collectCatalogIntegrationDataVerificationReport;
  const resetPreLaunchData = dependencies.resetPreLaunchData ?? resetCatalogIntegrationPreLaunchData;
  const evaluateEvidence = dependencies.evaluateEvidence ?? evaluateCatalogIntegrationDataResetEvidence;
  const runOverlapGate = dependencies.runOverlapGate ?? runStagingRefreshOverlapGate;
  const resolveGitHubIdentity = dependencies.resolveGitHubIdentity ?? resolveAuthenticatedGitHubActionsIdentity;
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
  // its transaction. Repository identity comes from the authenticated gh
  // context, and a workflow run hint is accepted only after gh verifies that
  // it names this active reset workflow. The policy then locks both job tables
  // and re-reads active jobs in-transaction.
  const githubIdentity = await resolveGitHubIdentity({
    workflowFile: CATALOG_INTEGRATION_RESET_WORKFLOW_FILE,
    runIdHint: readEnv(process.env, "GITHUB_RUN_ID"),
  });
  const overlapPreflight = await runOverlapGate({
    environment: "staging",
    repository: githubIdentity.repository,
    currentRunId: githubIdentity.currentRunId,
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
  const hasP0Finding = evidenceFindings.some((finding) => finding.severity === "p0");

  return {
    schemaVersion: CATALOG_INTEGRATION_RESET_VERSION,
    generatedAt,
    action: options.action,
    environment: options.environment,
    mode: reset.mode,
    result: hasP0Finding ? "failed" : "applied",
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

async function runProductionReset(
  options: CatalogIntegrationResetOptions,
  db: PgTransactionalPool,
  now: () => string,
): Promise<CatalogIntegrationResetRecord> {
  const generatedAt = now();
  const {
    action,
    approvalReference,
    backupDecision,
    dryRunFingerprint,
    operator,
    smokeVerificationReference,
    stagingRehearsalReference,
  } = options;
  const targetTables = catalogIntegrationProductionResetTargetTables();
  const databaseIdentity = {
    expectedDatabaseName: PRODUCTION_CATALOG_DATABASE_NAME,
    actualDatabaseName: PRODUCTION_CATALOG_DATABASE_NAME,
    matched: true,
  } as const;
  const base = {
    schemaVersion: CATALOG_INTEGRATION_RESET_VERSION,
    generatedAt,
    action,
    environment: "production-prelaunch",
    mode: "pre-launch-wipe-and-rebuild",
    operator,
    approvalReference,
    databaseIdentity,
    targetTables,
    overlapPreflight: null,
  } as const;
  if (action === "dry-run") {
    const production = await runCatalogIntegrationProductionReset(db, { action }, now);
    return {
      ...base,
      result: "dry-run-complete",
      dryRun: production.before.verification,
      reset: null,
      evidenceFindings: [],
      production,
    };
  }
  if (
    !approvalReference ||
    backupDecision?.kind !== "create-backup-snapshot-export" ||
    !dryRunFingerprint ||
    !operator
  ) {
    throw new Error("Production apply is missing required evidence.");
  }
  const production = await runCatalogIntegrationProductionReset(
    db,
    { action, approvalReference, backupReference: backupDecision.reference, fingerprint: dryRunFingerprint },
    now,
  );
  const { reset } = production;
  const evidenceFindings = evaluateCatalogIntegrationDataResetEvidence({
    ...base,
    operator,
    backupDecision,
    smokeVerificationReference,
    stagingRehearsalReference,
    dryRun: production.before.verification,
    before: reset?.before ?? null,
    after: reset?.after ?? null,
  });
  return {
    ...base,
    result: production.rollbackReasons ? "failed" : production.alreadyApplied ? "already-applied" : "applied",
    dryRun: production.before.verification,
    reset,
    evidenceFindings,
    production,
  };
}

export function catalogIntegrationResetExitCode(record: CatalogIntegrationResetRecord): number {
  return record.result === "failed" ? 2 : 0;
}

function redactFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-database-url]")
    .replace(/([?&](?:password|token|key)=)[^&\s]+/gi, "$1[redacted]");
}

export function createCatalogIntegrationResetPool(databaseUrl: string): PgTransactionalPool {
  return createPgPool(databaseUrl, { max: 1, applicationName: "chase_sets_catalog_integration_reset" });
}

async function main(): Promise<void> {
  const options = parseCatalogIntegrationResetArgs(process.argv.slice(2));
  const errors = validateCatalogIntegrationResetOptions(options);
  if (errors.length > 0) throw new Error(errors.join(" "));

  const pool = createCatalogIntegrationResetPool(options.databaseUrl ?? "");
  try {
    const record = await runCatalogIntegrationReset(options, pool);
    const serialized = JSON.stringify(record, null, 2);
    if (options.outPath) {
      mkdirSync(dirname(options.outPath), { recursive: true });
      writeFileSync(options.outPath, `${serialized}\n`);
    }
    process.stdout.write(`${serialized}\n`);
    process.exitCode = catalogIntegrationResetExitCode(record);
  } finally {
    await (pool as PgTransactionalPool & { end: () => Promise<void> }).end();
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
