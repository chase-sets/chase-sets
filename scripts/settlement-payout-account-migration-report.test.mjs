import { describe, expect, it } from "vitest";
import {
  SETTLEMENT_PAYOUT_ACCOUNT_MIGRATION_REPORT_VERSION,
  buildPayoutAccountMigrationReport,
  parsePayoutAccountMigrationReportArgs,
  runPayoutAccountMigrationReport,
} from "./settlement-payout-account-migration-report.mjs";

function rows() {
  return [
    {
      account_id: "acc_custom",
      provider_reference: "acct_custom",
      status: "ready",
      payout_account_dashboard: "none",
      losses_collector: "application",
      fees_collector: "application",
      requirements_collector: "application",
      updated_at: "2026-06-01T17:00:00.000Z",
    },
    {
      account_id: "acc_express_ready",
      provider_reference: "acct_express_ready",
      status: "ready",
      payout_account_dashboard: "express",
      losses_collector: "application",
      fees_collector: "application",
      requirements_collector: "stripe",
      updated_at: "2026-06-01T16:00:00.000Z",
    },
    {
      account_id: "acc_unknown",
      provider_reference: "acct_unknown",
      status: "pending",
      payout_account_dashboard: null,
      losses_collector: null,
      fees_collector: "application",
      requirements_collector: null,
      updated_at: "2026-06-01T15:00:00.000Z",
    },
    {
      account_id: "acc_mismatch",
      provider_reference: "acct_mismatch",
      status: "restricted",
      payout_account_dashboard: "none",
      losses_collector: "stripe",
      fees_collector: "stripe",
      requirements_collector: "stripe",
      updated_at: "2026-06-01T14:00:00.000Z",
    },
    {
      account_id: "acc_not_started",
      provider_reference: null,
      status: "not-started",
      payout_account_dashboard: "unknown",
      losses_collector: "unknown",
      fees_collector: "unknown",
      requirements_collector: "unknown",
      updated_at: null,
    },
  ];
}

describe("settlement payout account migration report", () => {
  it("classifies custom, legacy, unknown, and responsibility-mismatch provider accounts", () => {
    const report = buildPayoutAccountMigrationReport({
      rows: rows(),
      environment: "staging",
      checkedAt: "2026-06-01T18:00:00.000Z",
    });

    expect(report).toMatchObject({
      schemaVersion: SETTLEMENT_PAYOUT_ACCOUNT_MIGRATION_REPORT_VERSION,
      environment: "staging",
      checkedAt: "2026-06-01T18:00:00.000Z",
      summary: {
        totalProviderAccounts: 4,
        targetCustomAccountCount: 1,
        legacyHostedAccountCount: 1,
        manualReviewAccountCount: 1,
        responsibilityMismatchAccountCount: 1,
        migrationCandidateCount: 3,
        payoutReadyLegacyAccountCount: 1,
      },
      migrationPolicy: {
        defaultAction: "grandfather-existing-hosted-dashboard-accounts",
        targetDashboard: "none",
        targetCollectors: "application",
        automaticReplacementAllowed: false,
        existingPayoutReadyAccountsKeepCompatibilityPath: true,
      },
    });
    expect(report.migrationCandidates).toEqual([
      expect.objectContaining({
        accountId: "acc_express_ready",
        providerReference: "acct_express_ready",
        classification: "legacy-hosted-dashboard",
        reviewReasons: ["dashboard:express", "requirements_collector:stripe"],
        recommendedAction:
          "Keep Express compatibility available; schedule support-reviewed migration without interrupting payouts.",
      }),
      expect.objectContaining({
        accountId: "acc_unknown",
        classification: "manual-review-provider-posture",
      }),
      expect.objectContaining({
        accountId: "acc_mismatch",
        classification: "responsibility-mismatch",
      }),
    ]);
  });

  it("reads report options from flags and environment", () => {
    expect(
      parsePayoutAccountMigrationReportArgs(
        [
          "--database-url",
          "postgresql://staging/settlement",
          "--environment",
          "staging",
          "--checked-at",
          "2026-06-01T18:00:00.000Z",
        ],
        {},
      ),
    ).toEqual({
      databaseUrl: "postgresql://staging/settlement",
      environment: "staging",
      checkedAt: "2026-06-01T18:00:00.000Z",
    });
    expect(
      parsePayoutAccountMigrationReportArgs([], {
        SETTLEMENT_DATABASE_URL: "postgresql://settlement",
        SETTLEMENT_ENVIRONMENT: "preview",
      }),
    ).toMatchObject({
      databaseUrl: "postgresql://settlement",
      environment: "preview",
    });
  });

  it("queries the Settlement read model without mutating provider state", async () => {
    const queries = [];
    class ClientStub {
      constructor(config) {
        this.config = config;
      }
      async connect() {
        queries.push(["connect", this.config.connectionString]);
      }
      async query(sql) {
        queries.push(["query", sql]);
        return { rows: rows() };
      }
      async end() {
        queries.push(["end"]);
      }
    }

    const report = await runPayoutAccountMigrationReport(
      {
        databaseUrl: "postgresql://staging/settlement",
        environment: "staging",
        checkedAt: "2026-06-01T18:00:00.000Z",
      },
      ClientStub,
    );

    expect(report.summary.migrationCandidateCount).toBe(3);
    expect(queries[0]).toEqual(["connect", "postgresql://staging/settlement"]);
    expect(String(queries[1][1])).toContain("FROM settlement_payout_readiness_pages");
    expect(String(queries[1][1])).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b/i);
    expect(queries[2]).toEqual(["end"]);
  });
});
