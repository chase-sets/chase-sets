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

function capacityEvidence(overrides = {}) {
  return {
    schemaVersion: "push-wake-capacity-evidence/v1",
    checkedAt: "2026-05-31T13:00:00.000Z",
    environments: {
      staging: {
        deployOverlap: { headroom: 8 },
      },
      production: {
        deployOverlap: { headroom: 12 },
      },
    },
    expansionDecision: {
      posture: "wave-2-direct-listeners-fit-current-tier",
    },
    ...overrides,
  };
}

function buyNowFreshnessProbe(overrides = {}) {
  return {
    schemaVersion: "guest-buy-now-freshness-probe/v2",
    environment: "production",
    checkedAt: "2026-05-31T13:00:00.000Z",
    flow: "account",
    promotionDecision: "promote",
    failureReason: null,
    readyLatencyMs: 1200,
    segments: { writeToCheckoutReadyMs: 900, documentToReadyMs: 300 },
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
          gates: [
            {
              id: "production-smoke-and-marker",
              severity: "blocking",
              status: "fail",
              owner: "ops",
            },
            {
              id: "post-deploy-projection-readiness",
              severity: "advisory",
              status: "warn",
              owner: "platform-runtime",
            },
            {
              id: "exposure-posture-proof",
              severity: "deferred-proof",
              status: "pass",
              owner: "ops",
            },
          ],
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
      gates: {
        blockingFailures: 1,
        advisoryWarnings: 1,
        deferredProof: 1,
      },
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
    expect(result.markdown).toContain("## Production Gate Posture");
    expect(result.markdown).toContain("| production-smoke-and-marker | 1 | 0 | 0 |");
    expect(result.markdown).toContain("| post-deploy-projection-readiness | 0 | 1 | 0 |");
    expect(result.markdown).toContain("| exposure-posture-proof | 0 | 0 | 1 |");
    expect(result.markdown).toContain("## Projection Freshness Evidence");
    expect(result.markdown).toContain("Projection freshness evidence posture: not-provided");
    expect(result.markdown).toContain("## Release Process Review Checklist");
    expect(result.markdown).toContain("## Capacity and Image Review");
    expect(result.markdown).toContain("Capacity review posture: hold-current-capacity");
    expect(result.markdown).toContain(
      "| Refresh or fix push-wake capacity evidence | Connection-budget evidence is missing or failing. |",
    );
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
    const capacity = capacityEvidence();
    const verification = {
      schemaVersion: "ephemeral-verification/v1",
      releaseCommit: "a".repeat(40),
      result: "success",
    };
    const classified = classifyReleaseHealthArtifacts([
      { file: "release.json", record: release },
      { file: "guest-buy-now-freshness-probe.json", record: probe },
      { file: "push-wake-capacity-evidence.json", record: capacity },
      { file: "ephemeral-verification.json", record: verification },
      { file: "production-readiness-gate.json", record: { schemaVersion: "marketplace-production-readiness/v1" } },
    ]);

    expect(classified.releaseRecords).toEqual([release]);
    expect(classified.evidenceArtifacts.map((artifact) => artifact.record)).toEqual([probe]);
    expect(classified.capacityArtifacts.map((artifact) => artifact.record)).toEqual([capacity]);
    expect(classified.verificationArtifacts.map((artifact) => artifact.record)).toEqual([verification]);
    expect(classified.ignoredArtifacts).toHaveLength(1);
  });

  it("reports the persistent staging-only catch rate and keeps retirement explicit", () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      record({
        releaseCommit: index.toString(16).repeat(40).slice(0, 40),
      }),
    );
    const result = buildReleaseHealthReport({
      checkedAt: "2026-07-12T12:00:00.000Z",
      records,
      evidenceArtifacts: [],
      capacityArtifacts: [],
      verificationArtifacts: [{ record: { schemaVersion: "ephemeral-verification/v1", result: "success" } }],
    });

    expect(result.summary.stagingElimination).toMatchObject({
      measuredReleaseCount: 10,
      persistentStagingCatchCount: 0,
      persistentStagingCatchRate: 0,
      verificationSuccessCount: 1,
      decision: "eligible-for-explicit-retirement-review",
    });
    expect(result.markdown).toContain("Persistent staging-only catch rate: 0%");
    expect(result.markdown).toContain("Staging retirement decision: eligible-for-explicit-retirement-review");
  });

  it("marks capacity review eligible only with enough healthy releases and passing evidence", () => {
    const result = buildReleaseHealthReport({
      checkedAt: "2026-05-31T13:00:00.000Z",
      records: Array.from({ length: 10 }, (_, index) =>
        record({
          releaseCommit: `${String(index).repeat(40)}`.padEnd(40, "0").slice(0, 40),
        }),
      ),
      evidenceArtifacts: [{ record: buyNowFreshnessProbe() }],
      capacityArtifacts: [{ record: capacityEvidence() }],
    });

    expect(result.summary.capacityEvidence).toMatchObject({
      posture: "pass",
      productionDeployOverlapHeadroom: 12,
      stagingHeadroom: 8,
    });
    expect(result.summary.capacityReview).toMatchObject({
      stagingCapacityDecision: "eligible-for-staging-capacity-downsize-review",
      imageGroupDecision: "deferred-shared-image",
      connectionBudgetCheck: "pass",
      productionProofCheck: "pass",
    });
    expect(result.summary.capacityReview.followUpIssues).toEqual([]);
    expect(result.markdown).toContain("Capacity evidence posture: pass");
    expect(result.markdown).toContain("Production rolling-overlap headroom: 12");
    expect(result.markdown).toContain("| none | no follow-up issue trigger in current evidence |");
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
            checkedAt: "2026-05-31T13:00:00.000Z",
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
            checkedAt: "2026-06-29T13:00:00.000Z",
            drillKind: "load",
            verdict: "pass",
            segmentSlo: {
              browser: {
                singleWrite: { sloStatus: "pass", readyLatencyMs: { p95: 1200 } },
                load: { sloStatus: "pass", readyLatencyMs: { p95: 2500 } },
              },
              durableConvergence: { status: "pass", convergedAfterMs: 900 },
            },
          },
        },
        {
          record: {
            schemaVersion: "account-cart-consistency-probe/v1",
            environment: "staging",
            checkedAt: "2026-06-15T13:00:00.000Z",
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
            checkedAt: "2026-06-30T13:00:00.000Z",
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
      sustainedWindow: {
        status: "meets-window",
        spanDays: 30,
        artifactCountWithTimestamps: 4,
        readyLatencyP95Ms: 14000,
        durableConvergenceP95Ms: 900,
      },
    });
    expect(result.markdown).toContain("Projection freshness evidence posture: fail");
    expect(result.markdown).toContain("Projection freshness sustained window: meets-window");
    expect(result.markdown).toContain("Projection freshness sustained span: 30d (4 timestamped artifacts;");
    expect(result.markdown).toContain("Projection freshness ready p95: 14000ms");
    expect(result.markdown).toContain("Projection freshness durable convergence p95: 900ms");
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

  it("summarizes support-safe route-matrix wake evidence per route", () => {
    const result = buildReleaseHealthReport({
      checkedAt: "2026-06-29T13:00:00.000Z",
      records: [record()],
      evidenceArtifacts: [
        {
          file: "route-matrix.json",
          record: {
            schemaVersion: "read-consistency-route-matrix-evidence/v1",
            environment: "staging",
            checkedAt: "2026-06-29T13:00:00.000Z",
            routes: [
              {
                routeTemplate: "/checkout/buy/session/:sessionId",
                targetContext: "checkout",
                projectionName: "checkout.session-projection",
                wakeBeforeWait: {
                  status: "pass",
                  sampleCount: 24,
                  p95Ms: 420,
                  p99Ms: 710,
                  timeoutRate: 0,
                  workSignalErrorRate: 0,
                },
              },
              {
                routeTemplate: "/account/cart",
                targetContext: "checkout",
                projectionName: "checkout.cart-projection",
                wakeBeforeWait: {
                  status: "pass",
                  sampleCount: 24,
                  p95Ms: 300,
                  p99Ms: 500,
                  timeoutRate: 0,
                  workSignalErrorRate: 0,
                },
              },
              {
                routeTemplate: "/account/sell-list",
                targetContext: "checkout",
                projectionName: "checkout.sell-list-projection",
                wakeBeforeWait: {
                  status: "pass",
                  sampleCount: 24,
                  p95Ms: 510,
                  p99Ms: 900,
                  timeoutRate: 0,
                  workSignalErrorRate: 0,
                },
              },
              {
                routeTemplate: "/account/payouts/:payoutId",
                targetContext: "settlement",
                projectionName: "settlement.payout-projection",
                wakeBeforeWait: {
                  status: "pass",
                  sampleCount: 24,
                  p95Ms: 610,
                  p99Ms: 950,
                  timeoutRate: 0,
                  workSignalErrorRate: 0,
                },
              },
              {
                routeTemplate: "/account/payments/:paymentId",
                targetContext: "payments",
                projectionName: "payments.payment-projection",
                wakeBeforeWait: {
                  status: "pass",
                  sampleCount: 24,
                  p95Ms: 450,
                  p99Ms: 720,
                  timeoutRate: 0,
                  workSignalErrorRate: 0,
                },
              },
              {
                routeTemplate: "/account/listings/:listingId",
                targetContext: "marketplace",
                projectionName: "marketplace.listing-projection",
                wakeBeforeWait: {
                  status: "pass",
                  sampleCount: 24,
                  p95Ms: 380,
                  p99Ms: 680,
                  timeoutRate: 0,
                  workSignalErrorRate: 0,
                },
              },
            ],
          },
        },
      ],
    });

    expect(result.summary.freshness).toMatchObject({
      artifactCount: 1,
      posture: "pass",
      routeMatrixFailureCount: 0,
      sustainedWindow: {
        artifactCountWithTimestamps: 1,
        readyLatencyP95Ms: 610,
      },
    });
    expect(result.markdown).toContain("Route matrix failures: 0");
    expect(result.markdown).toContain(
      "| wake-route-matrix | staging | /checkout/buy/session/:sessionid | pass | wake pass; samples 24; p95 420ms; p99 710ms; timeout 0%; errors 0%; missing-receipt 0; plain-read-missing-receipt 0; missing-target 0; fallback 0; target checkout; projection checkout.session-projection | pass |",
    );
    expect(result.markdown).toContain(
      "| wake-route-matrix | staging | coverage | complete | 6/6 required routes | pass |",
    );
  });

  it("fails route-matrix evidence without observed samples or exact target labels", () => {
    const routes = [
      ["/checkout/buy/session/:sessionId", "checkout", "checkout.session-projection", 12],
      ["/account/cart", "checkout", "checkout.cart-projection", 12],
      ["/account/sell-list", "checkout", "checkout.sell-list-projection", 12],
      ["/account/payouts/:payoutId", "settlement", "settlement.payout-projection", 0],
      ["/account/payments/:paymentId", "payments", "payments.payment-projection", 12],
      ["/account/listings/:listingId", "marketplace", "marketplace.listing-projection", 12],
    ].map(([routeTemplate, targetContext, projectionName, sampleCount]) => ({
      routeTemplate,
      targetContext,
      projectionName,
      wakeBeforeWait: { status: "pass", sampleCount, p95Ms: 420, p99Ms: 710, timeoutRate: 0, workSignalErrorRate: 0 },
    }));

    const result = buildReleaseHealthReport({
      checkedAt: "2026-06-29T13:00:00.000Z",
      records: [record()],
      evidenceArtifacts: [
        {
          record: {
            schemaVersion: "read-consistency-route-matrix-evidence/v1",
            environment: "staging",
            checkedAt: "2026-06-29T13:00:00.000Z",
            routes,
          },
        },
      ],
    });

    expect(result.summary.freshness).toMatchObject({
      posture: "fail",
      routeMatrixFailureCount: 1,
    });
    expect(result.markdown).toContain(
      "| wake-route-matrix | staging | /account/payouts/:payoutid | pass | wake pass; samples 0; p95 420ms; p99 710ms; timeout 0%; errors 0%; missing-receipt 0; plain-read-missing-receipt 0; missing-target 0; fallback 0; target settlement; projection settlement.payout-projection | fail |",
    );
    expect(result.markdown).toContain(
      "| wake-route-matrix | staging | coverage | complete | 6/6 required routes | pass |",
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

  it("fails route-matrix evidence when required routes are missing or raw identifiers leak", () => {
    const result = buildReleaseHealthReport({
      checkedAt: "2026-06-29T13:00:00.000Z",
      records: [record()],
      evidenceArtifacts: [
        {
          record: {
            schemaVersion: "read-consistency-route-matrix-evidence/v1",
            environment: "staging",
            checkedAt: "2026-06-29T13:00:00.000Z",
            note: "https://staging.example.test/account/payments/pay_123",
            routes: [
              {
                routeTemplate: "/account/cart",
                projectionName: "checkout.cart-projection",
                wakeBeforeWait: { status: "pass", p95Ms: 300, p99Ms: 500, timeoutRate: 0, workSignalErrorRate: 0 },
              },
            ],
          },
        },
      ],
    });

    expect(result.summary.freshness).toMatchObject({
      posture: "fail",
      redactionFailureCount: 1,
      routeMatrixFailureCount: 2,
      sustainedWindow: {
        artifactCountWithTimestamps: 1,
      },
    });
    expect(result.markdown).toContain(
      "| wake-route-matrix | staging | coverage | redaction-failed | 1/6 required routes; missing checkout,sell-list,payout,payment,listing | fail |",
    );
    expect(result.markdown).not.toContain("https://staging.example.test");
    expect(result.markdown).not.toContain("pay_123");
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
