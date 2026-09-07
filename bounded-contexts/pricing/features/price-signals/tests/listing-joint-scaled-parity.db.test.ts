import { describe, expect, it } from "vitest";
import { mapProviderObservationCapture } from "../domain/provider-observation-mapper";
import { PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE } from "../domain/provider-observation-policy";
import type { TcgplayerSecondaryObservation } from "../integrations/tcgplayer/market-client";

describe("capture-local seller/condition/amount joint", () => {
  it("preserves the R4 scale-first/dedupe-second discriminator", () => {
    const one = asksFor({ A: { NM: 10, MP: 5 }, B: { NM: 20, MP: 6 } });
    const two = asksFor({ A: { NM: 10, MP: 6 }, B: { NM: 20, MP: 5 } });
    expect(marginals(one)).toEqual(marginals(two));
    expect(scaledCount(one, { NM: 1, MP: 2 }, 11)).toBe(1);
    expect(scaledCount(two, { NM: 1, MP: 2 }, 11)).toBe(2);
    expect(storeWinShare(1)).toBe(0.5);
    expect(storeWinShare(2)).toBe(0.3333);
  });

  it("keeps raw cumulative depth controls distinct", () => {
    expect([5, 6, 100].filter((amount) => amount <= 10)).toHaveLength(2);
    expect([5, 6, 7].filter((amount) => amount <= 10)).toHaveLength(3);
  });
});

type Config = Readonly<Record<"A" | "B", Readonly<Record<"NM" | "MP", number>>>>;

function asksFor(config: Config) {
  const listings = Object.entries(config).flatMap(([sellerKey, byCondition]) =>
    Object.entries(byCondition).map(([condition, price], index) => ({
      condition,
      printing: "Normal",
      language: "English",
      verifiedSeller: true,
      sellerKey,
      sellerId: "",
      sellerName: "",
      listingId: index + 1,
      price,
      sellerShippingPrice: 0,
    })),
  );
  const emptyEndpoint = {
    status: "observed" as const,
    requestedAt: "2026-09-01T15:00:00.000Z",
    responseObservedAt: "2026-09-01T15:00:00.100Z",
    rejectedRows: 0,
    httpStatusClass: "none" as const,
  };
  const observation: TcgplayerSecondaryObservation = {
    sales: {
      ...emptyEndpoint,
      rows: [],
      coverage: "complete",
      pagesFetched: 1,
      returnedCount: 0,
      firstReportedTotal: 0,
      lastReportedTotal: 0,
      firstResultCount: 0,
      lastResultCount: 0,
      lastNextPage: "",
    },
    listings: {
      ...emptyEndpoint,
      rows: listings,
      coverage: "complete",
      pagesFetched: 1,
      returnedCount: 4,
      reportedTotal: 4,
      ownSellerExclusionApplied: false,
    },
    history: { ...emptyEndpoint, rows: [], coverage: "observed", resultCount: 0, bucketCount: 0 },
  };
  return mapProviderObservationCapture({
    providerKey: "tcgplayer",
    catalogItemId: "cat_synthetic",
    productExternalKey: "product:7001",
    catalogProductKeysBySku: new Map(),
    signalPassStartedAt: "2026-09-01T14:59:00.000Z",
    signalPolicy: { revisionId: "synthetic-signal-r1", value: { productsPerPass: 1 } },
    captureStartedAt: "2026-09-01T15:00:00.000Z",
    captureCompletedAt: "2026-09-01T15:00:01.000Z",
    observationPolicy: { revisionId: "synthetic-observation-r1", value: PROVIDER_OBSERVATION_LAUNCH_POLICY_VALUE },
    statHygienePolicyRevisionId: "synthetic-stat-r1",
    authenticatedRequest: false,
    recordedSignalCount: 1,
    unresolvedSignalCount: 0,
    observation,
  }).askDepth;
}

function marginals(rows: ReturnType<typeof asksFor>) {
  return [...rows]
    .sort(
      (a, b) =>
        a.providerCondition.localeCompare(b.providerCondition) || Number(a.deliveredAmount) - Number(b.deliveredAmount),
    )
    .map((row) => [row.providerCondition, row.deliveredAmount]);
}

function scaledCount(rows: ReturnType<typeof asksFor>, multipliers: Record<string, number>, target: number) {
  return new Set(
    rows
      .filter((row) => Number(row.deliveredAmount) * multipliers[row.providerCondition]! <= target)
      .map((row) => row.anonymousCaptureSellerOrdinal),
  ).size;
}

function storeWinShare(competingSellers: number) {
  return Number((1 / (competingSellers + 1)).toFixed(4));
}
