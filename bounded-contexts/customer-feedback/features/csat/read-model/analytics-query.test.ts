import { describe, expect, it, vi } from "vitest";
import type { CsatProjectionReadiness } from "../api/analytics-contract";
import { readCsatAnalytics } from "./analytics-query";

const caughtUp: CsatProjectionReadiness = {
  complete: true,
  stale: false,
  lastProjectedAt: "2024-03-12T00:00:00.000Z",
  projectionLagMs: 0,
  rejectedEventCount: 0,
};

function row(
  invitationId: string,
  overrides: Partial<Record<string, string | number | null>> = {},
): Record<string, string | number | null> {
  return {
    invitation_id: invitationId,
    survey_kind: "transactional-csat",
    survey_version: "csat.v1",
    question_version: "csat.q.v1",
    outcome_code: "checkout.completed",
    customer_role: "buyer",
    sampling_cohort: "checkout-completion",
    eligible_at: null,
    issued_at: null,
    presented_at: null,
    dismissed_at: null,
    expired_at: null,
    submitted_at: null,
    rating: null,
    ...overrides,
  };
}

describe("CSAT analytics query", () => {
  it("calculates exact CSAT, presentation-cohort response rate, distributions, and UTC windows", async () => {
    const rows = [
      row("a", {
        eligible_at: "2024-03-05T00:00:00.000Z",
        issued_at: "2024-03-05T00:01:00.000Z",
        presented_at: "2024-03-05T00:02:00.000Z",
        submitted_at: "2024-03-10T08:00:00.000Z",
        rating: 5,
      }),
      row("b", {
        presented_at: "2024-03-11T08:00:00.000Z",
        dismissed_at: "2024-03-11T08:01:00.000Z",
        submitted_at: "2024-03-11T09:00:00.000Z",
        rating: 3,
      }),
      row("c", {
        presented_at: "2024-03-04T23:59:59.999Z",
        submitted_at: "2024-03-06T09:00:00.000Z",
        rating: 4,
      }),
      row("expired", { presented_at: "2024-03-07T10:00:00.000Z", expired_at: "2024-03-08T10:00:00.000Z" }),
    ];
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return { rows };
      }),
    };

    const result = await readCsatAnalytics(
      db as never,
      {
        asOf: "2024-03-12T00:00:00.000Z",
        trendFrom: "2024-03-09T00:00:00.000Z",
        trendTo: "2024-03-12T00:00:00.000Z",
        minimumSampleSize: 3,
      },
      caughtUp,
    );

    expect(result.windows["trailing-7d"]).toMatchObject({
      from: "2024-03-05T00:00:00.000Z",
      to: "2024-03-12T00:00:00.000Z",
      csat: 2 / 3,
      csatAvailability: "available",
      satisfiedCount: 2,
      submittedCount: 3,
      responseRate: 2 / 3,
      presentedCount: 3,
      respondedPresentedCount: 2,
      ratingDistribution: { 1: 0, 2: 0, 3: 1, 4: 1, 5: 1 },
      volume: { eligible: 1, issued: 1, presented: 3, dismissed: 1, expired: 1, submitted: 3 },
    });
    expect(result.health.invitationToSubmissionLatency.sampleCount).toBe(3);
    expect(result.timezone).toBe("UTC");
    expect(calls[0]?.sql).toContain("survey_kind = $1");
    expect(calls[0]?.params.slice(0, 3)).toEqual(["transactional-csat", "csat.v1", "csat.q.v1"]);
  });

  it("reports honest zero, incomplete, stale, anomaly, and insufficient-sample states", async () => {
    const db = {
      query: vi.fn(async () => ({
        rows: [row("orphan", { submitted_at: "2024-03-11T09:00:00.000Z", rating: 5 })],
      })),
    };
    const query = { asOf: "2024-03-12T00:00:00.000Z", minimumSampleSize: 20 } as const;

    const complete = await readCsatAnalytics(db as never, query, caughtUp);
    expect(complete.windows["trailing-7d"].csatAvailability).toBe("insufficient-sample");
    expect(complete.windows["trailing-7d"].responseRateAvailability).toBe("zero-denominator");
    expect(complete.windows["trailing-7d"].responseRate).toBeNull();
    expect(complete.health.denominatorAnomalyCount).toBe(1);

    const incomplete = await readCsatAnalytics(db as never, query, { ...caughtUp, complete: false });
    expect(incomplete.windows["trailing-7d"].csatAvailability).toBe("incomplete");
    const stale = await readCsatAnalytics(db as never, query, { ...caughtUp, stale: true });
    expect(stale.windows["trailing-7d"].csatAvailability).toBe("stale");
  });

  it("uses stable bucket cursors and remains UTC-stable across leap day and daylight saving", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const first = await readCsatAnalytics(
      db as never,
      {
        asOf: "2024-03-12T00:00:00.000Z",
        trendFrom: "2024-02-28T12:00:00.000Z",
        trendTo: "2024-03-12T00:00:00.000Z",
        trendGranularity: "week",
        limit: 2,
      },
      caughtUp,
    );

    expect(first.trend.items.map((item) => item.bucketStart)).toEqual([
      "2024-02-26T00:00:00.000Z",
      "2024-03-04T00:00:00.000Z",
    ]);
    expect(first.trend.nextCursor).not.toBeNull();

    const second = await readCsatAnalytics(
      db as never,
      {
        asOf: "2024-03-12T00:00:00.000Z",
        trendFrom: "2024-02-28T12:00:00.000Z",
        trendTo: "2024-03-12T00:00:00.000Z",
        trendGranularity: "week",
        limit: 2,
        cursor: first.trend.nextCursor,
      },
      caughtUp,
    );
    expect(second.trend.items.map((item) => item.bucketStart)).toEqual(["2024-03-11T00:00:00.000Z"]);
    expect(second.trend.nextCursor).toBeNull();
  });
});
