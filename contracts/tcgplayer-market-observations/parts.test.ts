import { describe, expect, it } from "vitest";
import {
  PART_TEXT_MAX_BYTES,
  digestTcgplayerMarketObservationBatchText,
  maxPartCount,
  maxBatchTextBytes,
  parseTcgplayerMarketObservationRequest,
  splitTcgplayerMarketObservationBatchText,
} from "./index";
import { sourceMutant } from "./mutants";

const request = parseTcgplayerMarketObservationRequest({
  contractVersion: 1,
  requestId: "123e4567-e89b-12d3-a456-426614174000",
  phase: "price-points",
  issuedAt: "2026-10-17T00:00:00.000Z",
  products: [{ productId: 1, skuIds: [1], skuTargetCount: 1 }],
  posture: null,
});
describe("canonical batch parts", () => {
  it("splits exact ASCII byte slices and digests in lowercase hex", async () => {
    const text = "x".repeat(PART_TEXT_MAX_BYTES + 1);
    const parts = splitTcgplayerMarketObservationBatchText(text);
    expect(parts).toEqual(["x".repeat(PART_TEXT_MAX_BYTES), "x"]);
    expect(await digestTcgplayerMarketObservationBatchText(text)).toMatch(/^[0-9a-f]{64}$/);
    expect(maxPartCount(request)).toBeGreaterThan(0);
  });
  it("derives policy caps from maximal grammar rows, not request JSON size", () => {
    const posture = {
      salesOffset: 0,
      salesLimit: 10000,
      salesPageSize: 250,
      salesPageBudget: 100,
      salesConditions: [],
      salesLanguages: [],
      salesVariants: [],
      salesListingType: "ListingWithoutPhotos" as const,
      listingsVerifiedOnly: true,
      listingsPageSize: 250,
      listingsPageBudget: 100,
      listingsDeliveredCeiling: "1000.00",
      historyRange: "annual" as const,
      timeoutMs: 120000,
    };
    const secondary = parseTcgplayerMarketObservationRequest({
      ...request,
      phase: "secondary",
      posture,
      products: [{ productId: 1, skuIds: [1], skuTargetCount: 1 }],
    });
    expect(maxBatchTextBytes(secondary)).toBeGreaterThan(12_285_260);
    expect(maxPartCount(secondary)).toBe(Math.ceil(maxBatchTextBytes(secondary) / PART_TEXT_MAX_BYTES));
    const mutant = sourceMutant<typeof maxBatchTextBytes>(
      [["Array.from({ length: cap }, maximalSale)", "[]"]],
      "maxBatchTextBytes",
    );
    expect(mutant(secondary)).toBeLessThan(maxBatchTextBytes(secondary));
  });
});
