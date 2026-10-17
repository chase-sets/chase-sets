import { describe, expect, it } from "vitest";
import {
  createSellerMetricsApiClient,
  parseSellerBehavioralMetricsSummary,
  SellerMetricsApiError,
  SellerMetricsResponseError,
} from "./seller-metrics-client";

const populatedSummary = {
  seller_account_id: "acc_seller",
  window_days: 90,
  orders_created_count: 20,
  seller_cancelled_count: 1,
  cancellation_rate: "0.0500",
  shipments_dispatched_count: 18,
  shipments_on_time_count: 17,
  on_time_shipment_rate: "0.9444",
  disputes_resolved_count: 2,
  disputes_against_seller_count: 1,
  dispute_rate: "0.0500",
  missing_responsibility_count: 1,
  computed_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
};

// The API's canonical zero-history response (features/seller-metrics/api/route.ts).
const canonicalEmptySummary = {
  seller_account_id: "acc_seller",
  window_days: 0,
  orders_created_count: 0,
  seller_cancelled_count: 0,
  cancellation_rate: null,
  shipments_dispatched_count: 0,
  shipments_on_time_count: 0,
  on_time_shipment_rate: null,
  disputes_resolved_count: 0,
  disputes_against_seller_count: 0,
  dispute_rate: null,
  missing_responsibility_count: 0,
  computed_at: null,
  updated_at: null,
};

function without(field: keyof typeof populatedSummary) {
  const { [field]: _omitted, ...rest } = populatedSummary;
  return rest;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function clientReturning(fetchImpl: () => Promise<Response>) {
  return createSellerMetricsApiClient({ baseUrl: "http://localhost/api/marketplace", fetch: fetchImpl });
}

describe("seller-metrics client", () => {
  it("parses the closed Seller Reliability response contract", () => {
    expect(parseSellerBehavioralMetricsSummary(populatedSummary)).toEqual(populatedSummary);
    expect(parseSellerBehavioralMetricsSummary(canonicalEmptySummary)).toEqual(canonicalEmptySummary);
    // Null rates on a material window are insufficient history, not a failure.
    const nullRates = { ...populatedSummary, cancellation_rate: null, on_time_shipment_rate: null, dispute_rate: null };
    expect(parseSellerBehavioralMetricsSummary(nullRates)).toEqual(nullRates);
    // The SQL read returns `numeric::text` rates and `timestamptz::text` instants.
    for (const [computedAt, updatedAt] of [
      ["2026-07-01 00:00:00.123456+00", "2026-07-01 00:00:00+00"],
      ["2026-07-01 05:30:00+05:30", "2026-06-30T19:00:00-0500"],
      ["2026-07-01T00:00:00Z", "2026-07-01T00:00:00.5+00:00"],
    ]) {
      const pgText = {
        ...populatedSummary,
        cancellation_rate: "0",
        dispute_rate: "1.0000",
        computed_at: computedAt,
        updated_at: updatedAt,
      };
      expect(parseSellerBehavioralMetricsSummary(pgText)).toEqual(pgText);
    }
  });

  it.each<[string, unknown]>([
    ["a non-object body", null],
    ["an array body", [populatedSummary]],
    ["a list envelope", { items: [], total: 0, count: 0 }],
    ["missing missing_responsibility_count", without("missing_responsibility_count")],
    ["missing seller_account_id", without("seller_account_id")],
    ["missing dispute_rate", without("dispute_rate")],
    ["an unknown field", { ...populatedSummary, freshness: "stale" }],
    ["a blank seller id", { ...populatedSummary, seller_account_id: "  " }],
    ["a numeric seller id", { ...populatedSummary, seller_account_id: 42 }],
    ["a zero window on a material summary", { ...populatedSummary, window_days: 0 }],
    ["a negative window", { ...populatedSummary, window_days: -90 }],
    ["a fractional window", { ...populatedSummary, window_days: 90.5 }],
    ["a string window", { ...populatedSummary, window_days: "90" }],
    ["a negative count", { ...populatedSummary, orders_created_count: -1 }],
    ["a fractional count", { ...populatedSummary, shipments_on_time_count: 2.5 }],
    ["an unsafe count", { ...populatedSummary, disputes_resolved_count: 2 ** 53 }],
    ["a string count", { ...populatedSummary, seller_cancelled_count: "1" }],
    ["a null count", { ...populatedSummary, disputes_against_seller_count: null }],
    ["a negative missing responsibility count", { ...populatedSummary, missing_responsibility_count: -1 }],
    ["a numeric rate", { ...populatedSummary, cancellation_rate: 0.05 }],
    ["a NaN rate", { ...populatedSummary, on_time_shipment_rate: "NaN" }],
    ["an infinite rate", { ...populatedSummary, dispute_rate: "Infinity" }],
    ["an above-range rate", { ...populatedSummary, on_time_shipment_rate: "1.0001" }],
    ["a negative rate", { ...populatedSummary, cancellation_rate: "-0.1" }],
    ["an exponent rate", { ...populatedSummary, cancellation_rate: "5e-2" }],
    ["a blank rate", { ...populatedSummary, dispute_rate: "" }],
    ["only computed_at null", { ...populatedSummary, computed_at: null }],
    ["only updated_at null", { ...populatedSummary, updated_at: null }],
    ["null timestamps on a material summary", { ...populatedSummary, computed_at: null, updated_at: null }],
    ["a date-only instant", { ...populatedSummary, computed_at: "2026-07-01" }],
    ["a timezone-less instant", { ...populatedSummary, updated_at: "2026-07-01T00:00:00.000" }],
    ["a timezone-less SQL instant", { ...populatedSummary, computed_at: "2026-07-01 00:00:00" }],
    ["an impossible month", { ...populatedSummary, computed_at: "2026-13-01T00:00:00Z" }],
    ["an impossible day", { ...populatedSummary, updated_at: "2026-02-30T00:00:00Z" }],
    ["an unparseable instant", { ...populatedSummary, computed_at: "yesterday" }],
    ["an epoch-millisecond instant", { ...populatedSummary, updated_at: 1751328000000 }],
    ["a canonical-empty window with a count", { ...canonicalEmptySummary, orders_created_count: 1 }],
    ["a canonical-empty window with a rate", { ...canonicalEmptySummary, dispute_rate: "0" }],
    [
      "a canonical-empty window with timestamps",
      { ...canonicalEmptySummary, computed_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z" },
    ],
  ])("rejects %s", (_label, body) => {
    expect(parseSellerBehavioralMetricsSummary(body)).toBeNull();
  });

  it("fails unusable Seller Reliability reads to unavailable", async () => {
    await expect(
      clientReturning(async () => jsonResponse(populatedSummary)).getOwnBehavioralMetrics(),
    ).resolves.toEqual(populatedSummary);

    await expect(
      clientReturning(() => Promise.reject(new TypeError("fetch failed"))).getOwnBehavioralMetrics(),
    ).rejects.toThrow(TypeError);
    await expect(
      clientReturning(async () => jsonResponse({ error: "unavailable" }, 503)).getOwnBehavioralMetrics(),
    ).rejects.toBeInstanceOf(SellerMetricsApiError);
    // Mixed valid/invalid: every field is valid except one rate, and nothing partial survives.
    await expect(
      clientReturning(async () =>
        jsonResponse({ ...populatedSummary, cancellation_rate: 0.05 }),
      ).getOwnBehavioralMetrics(),
    ).rejects.toBeInstanceOf(SellerMetricsResponseError);
    await expect(
      clientReturning(async () => new Response("<html>", { status: 200 })).getOwnBehavioralMetrics(),
    ).rejects.toThrow();
  });
});
