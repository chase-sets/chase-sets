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
          releaseLock: { locked: true, bypassed: true, emergencyReference: "FIX-1" },
        }),
      ],
    });

    expect(result.summary).toMatchObject({
      releaseCount: 2,
      successCount: 1,
      failureCount: 1,
      emergencyCount: 1,
      lockedCount: 1,
      rollbackCount: 0,
      canaryAbortCount: 0,
    });
    expect(result.markdown).toContain("# Release Health Report");
    expect(result.markdown).toContain("| bbbbbbbb | ordinary-deploy | emergency | success | skipped | failure |");
    expect(result.markdown).toContain("bypassed FIX-1");
    expect(result.markdown).toContain("5m");
    expect(result.markdown).toContain("Batch-size posture");
    expect(result.markdown).toContain("| productionFailureRate | <= 2% | 50% | fail |");
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
