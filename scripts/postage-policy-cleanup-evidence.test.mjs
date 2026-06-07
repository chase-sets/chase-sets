import { describe, expect, it } from "vitest";
import {
  POSTAGE_POLICY_CLEANUP_EVIDENCE_VERSION,
  buildPostagePolicyCleanupEvidence,
  parsePostagePolicyCleanupEvidenceArgs,
  validatePostagePolicyCleanupEvidenceOptions,
} from "./postage-policy-cleanup-evidence.mjs";

describe("postage policy cleanup evidence", () => {
  it("passes when one active policy exists and active order/shipment snapshots are migrated", () => {
    const report = buildPostagePolicyCleanupEvidence({
      environment: "staging",
      checkedAt: "2026-06-07T00:00:00.000Z",
      ordering: {
        policyPagesByStatus: [
          { status: "active", count: 1, latestUpdatedAt: "2026-06-07T00:00:00.000Z" },
          { status: "retired", count: 1, latestUpdatedAt: "2026-06-06T00:00:00.000Z" },
        ],
        orderPolicySnapshotsByStatus: [
          {
            status: "pending",
            count: 3,
            missingPolicySnapshotCount: 0,
            policySnapshotCount: 3,
            latestUpdatedAt: "2026-06-07T00:00:00.000Z",
          },
          {
            status: "delivered",
            count: 5,
            missingPolicySnapshotCount: 5,
            policySnapshotCount: 0,
            latestUpdatedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
      },
      fulfillment: {
        shipmentPolicySnapshotsByStatus: [
          {
            status: "awaiting-label",
            count: 2,
            missingPolicySnapshotCount: 0,
            policySnapshotCount: 2,
            latestUpdatedAt: "2026-06-07T00:00:00.000Z",
          },
          {
            status: "delivered",
            count: 4,
            missingPolicySnapshotCount: 4,
            policySnapshotCount: 0,
            latestUpdatedAt: "2026-05-01T00:00:00.000Z",
          },
        ],
        labelErrorsByCode: [
          {
            errorCode: "postage_provider_capability_failure",
            count: 1,
            latestUpdatedAt: "2026-06-07T00:00:00.000Z",
          },
        ],
      },
    });

    expect(report).toMatchObject({
      schemaVersion: POSTAGE_POLICY_CLEANUP_EVIDENCE_VERSION,
      environment: "staging",
      cleanupStatus: {
        activePolicyCount: 1,
        activeOrdersWithoutSnapshots: 0,
        activeShipmentsWithoutSnapshots: 0,
        capabilityFailureCount: 1,
        readyToRetireLegacyCompatibility: true,
        remainingCleanupGaps: [],
      },
      cleanupPolicy: {
        historicalSnapshotsRetained: true,
        temporaryMigrationArtifactsAllowedAfterCleanup: false,
        runtimePackagePlanningRequiresResolvedPolicy: true,
      },
    });
  });

  it("reports active compatibility gaps before legacy cleanup can close", () => {
    const report = buildPostagePolicyCleanupEvidence({
      checkedAt: "2026-06-07T00:00:00.000Z",
      ordering: {
        policyPagesByStatus: [{ status: "active", count: 2 }],
        orderPolicySnapshotsByStatus: [
          { status: "pending", count: 2, missingPolicySnapshotCount: 1, policySnapshotCount: 1 },
        ],
      },
      fulfillment: {
        shipmentPolicySnapshotsByStatus: [
          { status: "awaiting-package", count: 1, missingPolicySnapshotCount: 1, policySnapshotCount: 0 },
        ],
        labelErrorsByCode: [],
      },
    });

    expect(report.cleanupStatus.readyToRetireLegacyCompatibility).toBe(false);
    expect(report.cleanupStatus.remainingCleanupGaps).toEqual([
      "Expected exactly one active postage policy; found 2.",
      "Ordering has 1 active order(s) without postagePolicySnapshot metadata.",
      "Fulfillment has 1 active shipment(s) without postagePolicySnapshot metadata.",
    ]);
  });

  it("parses database URL fallbacks and validates required inputs", () => {
    const parsed = parsePostagePolicyCleanupEvidenceArgs(["--checked-at", "2026-06-07T00:00:00.000Z"], {
      DATABASE_URL: "postgres://shared",
      DEPLOYMENT_ENVIRONMENT: "production",
    });

    expect(parsed).toMatchObject({
      environment: "production",
      orderingDatabaseUrl: "postgres://shared",
      fulfillmentDatabaseUrl: "postgres://shared",
    });
    expect(validatePostagePolicyCleanupEvidenceOptions(parsed)).toEqual([]);
    expect(
      validatePostagePolicyCleanupEvidenceOptions({
        checkedAt: "not-a-date",
        orderingDatabaseUrl: "",
        fulfillmentDatabaseUrl: "",
      }),
    ).toEqual([
      "ORDERING_DATABASE_URL, DATABASE_URL, --ordering-database-url, or --database-url is required.",
      "FULFILLMENT_DATABASE_URL, DATABASE_URL, --fulfillment-database-url, or --database-url is required.",
      "Postage policy cleanup checkedAt must be an ISO timestamp.",
    ]);
  });
});
