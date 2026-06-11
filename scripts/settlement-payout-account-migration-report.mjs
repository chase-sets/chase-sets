#!/usr/bin/env node
import pg from "pg";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";

const { Client } = pg;

export const SETTLEMENT_PAYOUT_ACCOUNT_MIGRATION_REPORT_VERSION = "settlement-payout-account-migration-report/v1";

const TARGET_DASHBOARD = "none";
const TARGET_RESPONSIBILITY = "application";

export function parsePayoutAccountMigrationReportArgs(argv, env = process.env) {
  return {
    databaseUrl:
      readOption(argv, "--database-url") ?? readEnv("SETTLEMENT_DATABASE_URL", env) ?? readEnv("DATABASE_URL", env),
    environment: readOption(argv, "--environment") ?? readEnv("SETTLEMENT_ENVIRONMENT", env) ?? "unknown",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export function buildPayoutAccountMigrationReport(input) {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const rows = input.rows.map(normalizeRow).filter((row) => row.providerReference !== null);
  const accounts = rows.map((row) => ({
    ...row,
    classification: classifyRow(row),
    recommendedAction: recommendedAction(row),
    reviewReasons: reviewReasons(row),
  }));
  const migrationCandidates = accounts.filter((account) => account.classification !== "target-custom-account");

  return {
    schemaVersion: SETTLEMENT_PAYOUT_ACCOUNT_MIGRATION_REPORT_VERSION,
    environment: input.environment ?? "unknown",
    checkedAt,
    summary: {
      totalProviderAccounts: accounts.length,
      targetCustomAccountCount: accounts.filter((account) => account.classification === "target-custom-account").length,
      legacyHostedAccountCount: accounts.filter((account) => account.classification === "legacy-hosted-dashboard")
        .length,
      manualReviewAccountCount: accounts.filter(
        (account) => account.classification === "manual-review-provider-posture",
      ).length,
      responsibilityMismatchAccountCount: accounts.filter(
        (account) => account.classification === "responsibility-mismatch",
      ).length,
      migrationCandidateCount: migrationCandidates.length,
      payoutReadyLegacyAccountCount: accounts.filter(
        (account) => account.classification === "legacy-hosted-dashboard" && account.status === "ready",
      ).length,
    },
    migrationPolicy: {
      defaultAction: "grandfather-existing-hosted-dashboard-accounts",
      targetDashboard: TARGET_DASHBOARD,
      targetCollectors: TARGET_RESPONSIBILITY,
      automaticReplacementAllowed: false,
      existingPayoutReadyAccountsKeepCompatibilityPath: true,
    },
    migrationCandidates,
  };
}

export async function queryPayoutAccountRows(databaseUrl, ClientCtor = Client) {
  const client = new ClientCtor({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT
         account_id,
         provider_reference,
         status,
         payout_account_dashboard,
         losses_collector,
         fees_collector,
         requirements_collector,
         updated_at
       FROM settlement_payout_readiness_pages
       WHERE provider_reference IS NOT NULL
       ORDER BY updated_at DESC, account_id ASC`,
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

export async function runPayoutAccountMigrationReport(options, ClientCtor = Client) {
  if (!options.databaseUrl) {
    throw new Error("SETTLEMENT_DATABASE_URL, DATABASE_URL, or --database-url is required.");
  }
  const rows = await queryPayoutAccountRows(options.databaseUrl, ClientCtor);
  return buildPayoutAccountMigrationReport({
    rows,
    environment: options.environment,
    checkedAt: options.checkedAt,
  });
}

function normalizeRow(row) {
  return {
    accountId: stringOrNull(row.account_id),
    providerReference: stringOrNull(row.provider_reference),
    status: normalizeStatus(row.status),
    payoutAccountDashboard: normalizeDashboard(row.payout_account_dashboard),
    lossesCollector: normalizeResponsibility(row.losses_collector),
    feesCollector: normalizeResponsibility(row.fees_collector),
    requirementsCollector: normalizeResponsibility(row.requirements_collector),
    lastCheckedAt: stringOrNull(row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at),
  };
}

function classifyRow(row) {
  if (
    row.payoutAccountDashboard === TARGET_DASHBOARD &&
    row.lossesCollector === TARGET_RESPONSIBILITY &&
    row.feesCollector === TARGET_RESPONSIBILITY &&
    row.requirementsCollector === TARGET_RESPONSIBILITY
  ) {
    return "target-custom-account";
  }
  if (row.payoutAccountDashboard === "express" || row.payoutAccountDashboard === "full") {
    return "legacy-hosted-dashboard";
  }
  if (
    row.payoutAccountDashboard === "unknown" ||
    row.lossesCollector === "unknown" ||
    row.feesCollector === "unknown" ||
    row.requirementsCollector === "unknown"
  ) {
    return "manual-review-provider-posture";
  }
  return "responsibility-mismatch";
}

function recommendedAction(row) {
  switch (classifyRow(row)) {
    case "target-custom-account":
      return "No migration action required.";
    case "legacy-hosted-dashboard":
      return row.status === "ready"
        ? "Keep Express compatibility available; schedule support-reviewed migration without interrupting payouts."
        : "Keep Express compatibility available; ask the account operator to complete or restart setup after migration review.";
    case "manual-review-provider-posture":
      return "Refresh provider readiness or inspect the Stripe account before choosing a migration path.";
    case "responsibility-mismatch":
      return "Escalate to Finance and Engineering before payout expansion; the account does not match the target responsibility model.";
  }
}

function reviewReasons(row) {
  const reasons = [];
  if (row.payoutAccountDashboard !== TARGET_DASHBOARD) {
    reasons.push(`dashboard:${row.payoutAccountDashboard}`);
  }
  if (row.lossesCollector !== TARGET_RESPONSIBILITY) {
    reasons.push(`losses_collector:${row.lossesCollector}`);
  }
  if (row.feesCollector !== TARGET_RESPONSIBILITY) {
    reasons.push(`fees_collector:${row.feesCollector}`);
  }
  if (row.requirementsCollector !== TARGET_RESPONSIBILITY) {
    reasons.push(`requirements_collector:${row.requirementsCollector}`);
  }
  return reasons;
}

function normalizeStatus(value) {
  switch (String(value ?? "").trim()) {
    case "pending":
    case "ready":
    case "restricted":
      return String(value).trim();
    default:
      return "not-started";
  }
}

function normalizeDashboard(value) {
  switch (String(value ?? "").trim()) {
    case "none":
    case "express":
    case "full":
      return String(value).trim();
    default:
      return "unknown";
  }
}

function normalizeResponsibility(value) {
  switch (String(value ?? "").trim()) {
    case "application":
    case "stripe":
      return String(value).trim();
    default:
      return "unknown";
  }
}

function stringOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

async function main(argv, env = process.env) {
  try {
    const report = await runPayoutAccountMigrationReport(parsePayoutAccountMigrationReportArgs(argv, env));
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
