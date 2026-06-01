import { describe, expect, it } from "vitest";
import { buildReleaseHealthReport, parseReleaseHealthReportArgs } from "./release-health-report.mjs";

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
    expect(result.markdown).toContain("## Release Process Review Checklist");
    expect(result.markdown).toContain("## Image Group Decision Inputs");
    expect(result.markdown).toContain("| productionFailureRate | <= 2% | 33.3% | fail |");
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
