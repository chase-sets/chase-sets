import { describe, expect, it } from "vitest";
import {
  buildReleaseHealthReport,
  classifyReleaseHealthArtifacts,
  parseReleaseHealthReportArgs,
} from "./release-health-report.mjs";

function record(overrides = {}) {
  return {
    schemaVersion: "release-health/v1",
    releaseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    checkedAt: "2026-05-31T12:00:00.000Z",
    releaseMode: "normal",
    releaseCategory: { primary: "ordinary-deploy", exposurePostureCategories: [] },
    mainToProductionDrift: { commits: 1, seconds: 180 },
    queue: {
      queuedAt: "2026-05-31T11:50:00.000Z",
      mergedAt: "2026-05-31T11:55:00.000Z",
    },
    staging: {
      startedAt: "2026-05-31T11:56:00.000Z",
      completedAt: "2026-05-31T12:05:00.000Z",
      result: "success",
    },
    canary: { startedAt: null, completedAt: null, result: "skipped" },
    production: {
      startedAt: "2026-05-31T12:06:00.000Z",
      completedAt: "2026-05-31T12:12:00.000Z",
      result: "success",
    },
    releaseLock: { locked: false, bypassed: false, reference: null },
    recovery: { mode: "none", reference: null, targetCommit: null, rollbackReadinessResult: "unknown" },
    ...overrides,
  };
}

describe("release health report", () => {
  it("builds a markdown dashboard from release records", () => {
    const result = buildReleaseHealthReport({
      checkedAt: "2026-05-31T13:00:00.000Z",
      records: [
        record(),
        record({
          releaseCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          releaseMode: "emergency",
          production: { result: "failure", completedAt: "2026-05-31T12:30:00.000Z" },
          ci: {
            retryCount: 1,
            flakyFailureCount: 1,
            topFlakyJobs: [{ name: "verify:static", retryCount: 1, flakyFailureCount: 1 }],
          },
          releaseLock: { locked: true, bypassed: true, emergencyReference: "FIX-1" },
        }),
        record({
          releaseCommit: "cccccccccccccccccccccccccccccccccccccccc",
          staging: { result: "skipped" },
          canary: { result: "skipped", skippedReason: "staging-not-deployed" },
          production: { result: "skipped" },
          attempt: { phase: "staging", result: "skipped", reason: "staging-not-deployed" },
        }),
      ],
    });

    expect(result.summary).toMatchObject({
      releaseCount: 3,
      deployableReleaseCount: 3,
      successCount: 1,
      failureCount: 1,
      emergencyCount: 1,
      lockedCount: 1,
      rollbackCount: 0,
      canaryAbortCount: 0,
      stagingAbortCount: 0,
      staleSkipCount: 1,
      ci: {
        releaseCountWithTelemetry: 1,
        affectedReleaseCount: 1,
        retryCount: 1,
        flakyFailureCount: 1,
      },
    });
    expect(result.markdown).toContain("# Release Health Report");
    expect(result.markdown).toContain("| bbbbbbbb | ordinary-deploy | emergency | success | skipped | failure |");
    expect(result.markdown).toContain("bypassed FIX-1");
    expect(result.markdown).toContain("5m");
    expect(result.markdown).toContain("Batch-size posture");
    expect(result.markdown).toContain("## CI Flake Posture");
    expect(result.markdown).toContain("| verify:static | 1 | 1 |");
    expect(result.markdown).toContain("## Projection Freshness Evidence");
    expect(result.markdown).toContain("Projection freshness evidence posture: not-provided");
    expect(result.markdown).toContain("## Release Process Review Checklist");
    expect(result.markdown).toContain("## Image Group Decision Inputs");
    expect(result.markdown).toContain("| productionFailureRate | <= 2% | 33.3% | fail |");
  });

  it("classifies mixed release-health directories without treating probe artifacts as releases", () => {
    const release = record();
    const probe = {
      schemaVersion: "guest-buy-now-freshness-probe/v2",
      environment: "staging",
      flow: "guest",
      promotionDecision: "promote",
      failureReason: null,
      readyLatencyMs: 1200,
      segments: { writeToCheckoutReadyMs: 1200, documentToReadyMs: 300 },
    };
    const classified = classifyReleaseHealthArtifacts([
      { file: "release.json", record: release },
      { file: "guest-buy-now-freshness-probe.json", record: probe },
      { file: "production-readiness-gate.json", record: { schemaVersion: "marketplace-production-readiness/v1" } },
    ]);

    expect(classified.releaseRecords).toEqual([release]);
    expect(classified.evidenceArtifacts.map((artifact) => artifact.record)).toEqual([probe]);
    expect(classified.ignoredArtifacts).toHaveLength(1);
  });

  it("summarizes projection freshness evidence with low-cardinality segment rows", () => {
    const result = buildReleaseHealthReport({
      checkedAt: "2026-05-31T13:00:00.000Z",
      records: [record()],
      evidenceArtifacts: [
        {
          record: {
            schemaVersion: "guest-buy-now-freshness-probe/v2",
            environment: "production",
            flow: "account",
            promotionDecision: "abort",
            failureReason: "checkout-ready-slo-exceeded",
            readyLatencyMs: 14000,
            segments: { writeToCheckoutReadyMs: 14000, documentToReadyMs: 12000 },
          },
        },
        {
          record: {
            schemaVersion: "staging-wake-drills/v1",
            environment: "staging",
            drillKind: "load",
            verdict: "pass",
            segmentSlo: {
              browser: { singleWrite: { sloStatus: "pass" }, load: { sloStatus: "pass" } },
              durableConvergence: { status: "pass" },
            },
          },
        },
        {
          record: {
            schemaVersion: "account-cart-consistency-probe/v1",
            environment: "staging",
            routeTemplate: "/account/cart",
            promotionDecision: "promote",
            observedOutcomes: ["optimistic_applied", "reconciliation", "stale_response_discard"],
            blockers: [],
          },
        },
        {
          record: {
            schemaVersion: "non-buy-now-post-write-freshness-uat/v1",
            environment: "staging",
            flows: [
              { name: "account-cart", routeTemplate: "/account/cart", outcome: "promote" },
              { name: "sell-list-accept-to-checkout", routeTemplate: "/account/sell", outcome: "fresh" },
              { name: "payout-ready-return", routeTemplate: "/account/sell", outcome: "fresh" },
              {
                name: "listing-freshness",
                routeTemplate: "/account/listings/:id",
                outcome: "fresh-or-owned-temporary",
              },
            ],
            telemetry: {
              "account-cart-post-write-consistency": "zero",
              "sell-rail-accept-checkout-handoff": "zero",
              "payout-ready-handoff": "zero",
              "marketplace-listing-freshness-slo": "within-slo",
              "settlement-payout-errors": "zero",
              "projection-lag-poison-events": "zero",
            },
          },
        },
      ],
    });

    expect(result.summary.freshness).toMatchObject({
      artifactCount: 4,
      posture: "fail",
      buyNowAbortCount: 1,
      wakeDrillFailureCount: 0,
      accountCartFailureCount: 0,
      nonBuyNowUatFailureCount: 0,
    });
    expect(result.markdown).toContain("Projection freshness evidence posture: fail");
    expect(result.markdown).toContain(
      "| buy-now-checkout | production | account | abort | ready 14000ms; write-ready 14000ms; doc-ready 12000ms; failure checkout-ready-slo-exceeded | fail |",
    );
    expect(result.markdown).toContain(
      "| wake-before-wait | staging | load | pass | single-write pass; load pass; durable pass | pass |",
    );
    expect(result.markdown).toContain(
      "| account-cart | staging | /account/cart | promote | 3 outcomes; 0 blockers | pass |",
    );
    expect(result.markdown).toContain(
      "| chrome-uat | staging | account-cart/sell-list/payout/listing | complete | 4/4 flows; 6/6 telemetry | pass |",
    );
  });

  it("fails freshness evidence when UAT coverage is incomplete or support-safe redaction fails", () => {
    const result = buildReleaseHealthReport({
      checkedAt: "2026-05-31T13:00:00.000Z",
      records: [record()],
      evidenceArtifacts: [
        {
          record: {
            schemaVersion: "non-buy-now-post-write-freshness-uat/v1",
            environment: "staging",
            evidenceReference: "STAGING-NON-BUY-NOW-FRESHNESS-2026-06-24",
            note: "operator@example.com",
            flows: [{ name: "account-cart", routeTemplate: "/account/cart", outcome: "promote" }],
            telemetry: {
              "account-cart-post-write-consistency": "zero",
              "sell-rail-accept-checkout-handoff": "missing",
            },
          },
        },
      ],
    });

    expect(result.summary.freshness).toMatchObject({
      posture: "fail",
      redactionFailureCount: 1,
      nonBuyNowUatFailureCount: 1,
    });
    expect(result.markdown).toContain(
      "| chrome-uat | staging | account-cart/sell-list/payout/listing | redaction-failed |",
    );
    expect(result.markdown).not.toContain("operator@example.com");
  });

  it("recommends a batch increase only after enough healthy deployable attempts", () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      record({
        releaseCommit: `${String(index).repeat(40)}`.slice(0, 40).padEnd(40, "0"),
        ci: { retryCount: 0, flakyFailureCount: 0, topFlakyJobs: [] },
      }),
    );

    const result = buildReleaseHealthReport({
      checkedAt: "2026-05-31T13:00:00.000Z",
      records,
    });

    expect(result.summary.slo.batchSizeRecommendation).toBe("increase-to-2");
    expect(result.markdown).toContain("| deployableSampleSize | >= 10 deployable attempts | 10 | pass |");
    expect(result.markdown).toContain("| p95QueueWait | <= 30m | 5m | pass |");
  });

  it("parses repeated file flags and environment defaults", () => {
    const parsed = parseReleaseHealthReportArgs(["--file", "a.json", "--file", "b.json"], {
      RELEASE_HEALTH_DIR: "artifacts/release-health",
      RELEASE_HEALTH_REPORT_OUT: "artifacts/release-health/summary.md",
    });

    expect(parsed).toMatchObject({
      files: ["a.json", "b.json"],
      dir: "artifacts/release-health",
      outPath: "artifacts/release-health/summary.md",
    });
  });
});
