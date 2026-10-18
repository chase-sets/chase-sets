import { describe, expect, it } from "vitest";
import { parseTcgplayerMarketObservationRequest, TcgplayerMarketObservationContractError } from "./index";
import { sourceMutant } from "./mutants";

const base = {
  contractVersion: 1,
  requestId: "123e4567-e89b-12d3-a456-426614174000",
  phase: "price-points" as const,
  issuedAt: "2026-10-17T00:00:00.000Z",
  products: [{ productId: 1, skuIds: [1, 2], skuTargetCount: 3 }],
  posture: null,
};
const code = (value: unknown) => {
  try {
    parseTcgplayerMarketObservationRequest(value);
    return "accepted";
  } catch (error) {
    return error instanceof TcgplayerMarketObservationContractError ? error.code : "unknown";
  }
};
const validPosture = {
  salesOffset: 0,
  salesLimit: 1,
  salesPageSize: 1,
  salesPageBudget: 1,
  salesConditions: [],
  salesLanguages: [],
  salesVariants: [],
  salesListingType: "ListingWithoutPhotos",
  listingsVerifiedOnly: true,
  listingsPageSize: 1,
  listingsPageBudget: 1,
  listingsDeliveredCeiling: "1000.00",
  historyRange: "annual",
  timeoutMs: 1000,
};

describe("TCGplayer market observation request", () => {
  it("accepts the bounded request and preserves truncation target", () =>
    expect(parseTcgplayerMarketObservationRequest(base).products[0]?.skuTargetCount).toBe(3));
  it("accepts the five-product and 250-SKU maxima", () => {
    const products = Array.from({ length: 5 }, (_, i) => ({
      productId: i + 1,
      skuIds: Array.from({ length: 250 }, (_, j) => j + 1),
      skuTargetCount: 250,
    }));
    expect(() => parseTcgplayerMarketObservationRequest({ ...base, products })).not.toThrow();
  });
  it.each([
    ["nested unknown key", { products: [{ ...base.products[0], extra: true }] }, "invalid_request_product"],
    ["uppercase request id", { requestId: base.requestId.toUpperCase() }, "invalid_request"],
    ["valid posture on price points", { posture: validPosture }, "invalid_request_posture_presence"],
    ["null posture on secondary", { phase: "secondary", posture: null }, "invalid_request_posture_presence"],
    ["duplicate sku", { products: [{ ...base.products[0], skuIds: [1, 1] }] }, "invalid_request_skus"],
    [
      "too many products",
      { products: Array.from({ length: 6 }, (_, i) => ({ productId: i + 1, skuIds: [1], skuTargetCount: 1 })) },
      "invalid_request_product_count",
    ],
  ])("rejects %s with %s", (_name, change, expected) => expect(code({ ...base, ...change })).toBe(expected));
  it("strictness/N2 mutant loses the fixed non-array SKU code", () => {
    const invalid = { ...base, products: [{ ...base.products[0], skuIds: "not-an-array" }] };
    const mutant = sourceMutant<(value: unknown) => unknown>(
      [[`arr(p.skuIds, "invalid_request_sku")`, "arr(p.skuIds, undefined as never)"]],
      "parseTcgplayerMarketObservationRequest",
    );
    expect(() => mutant(invalid)).toThrow();
    expect(code(invalid)).toBe("invalid_request_sku");
  });
});
