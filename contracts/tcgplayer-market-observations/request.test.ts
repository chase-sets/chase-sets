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
const secondaryBase = { ...base, phase: "secondary" as const, posture: validPosture };
const product = (productId: number, skuIds: number[] = [1]) => ({ productId, skuIds, skuTargetCount: skuIds.length });
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1);
const maximalProducts = range(5).map((productId) => product(productId, range(250)));
// Policy decoder bounds restated from provider-observation-policy.ts:66-98
// (contracts/ cannot import a bounded context).
const postureBounds: [field: string, min: number, max: number][] = [
  ["salesLimit", 1, 10000],
  ["salesPageSize", 1, 250],
  ["salesPageBudget", 1, 100],
  ["listingsPageSize", 1, 250],
  ["listingsPageBudget", 1, 100],
  ["timeoutMs", 1, 120000],
];
const boundCases: [name: string, field: string, value: number, expected: string][] = postureBounds.flatMap(
  ([field, min, max]) => [
    [`R15 ${field} ${min - 1} (below the decoder bound)`, field, min - 1, "invalid_posture"],
    [`R15 ${field} ${min} (lower bound)`, field, min, "accepted"],
    [`R15 ${field} ${max} (upper bound)`, field, max, "accepted"],
    [`R15 ${field} ${max + 1} (above the decoder bound)`, field, max + 1, "invalid_posture"],
  ],
);
const rejections: [name: string, change: Record<string, unknown>, expected: string][] = [
  ["R02 6 products", { products: range(6).map((id) => product(id)) }, "invalid_request_product_count"],
  ["R03 251 SKUs in one product", { products: [product(1, range(251))] }, "invalid_request_sku_count"],
  ["R04 duplicate product id", { products: [product(1), product(1)] }, "invalid_request_product_ids"],
  ["R05 non-ascending product ids", { products: [product(2), product(1)] }, "invalid_request_product_ids"],
  ["R06 duplicate SKU id", { products: [product(1, [1, 1])] }, "invalid_request_skus"],
  ["R07 non-ascending SKU ids", { products: [product(1, [2, 1])] }, "invalid_request_skus"],
  ["R08 product id 0", { products: [product(0)] }, "invalid_request_product_id"],
  ["R09 product id 2^31", { products: [product(2147483648)] }, "invalid_request_product_id"],
  [
    "R10 skuTargetCount below the SKU count",
    { products: [{ ...product(1, [1, 2]), skuTargetCount: 1 }] },
    "invalid_request_target",
  ],
  ["R11 uppercase requestId", { requestId: base.requestId.toUpperCase() }, "invalid_request"],
  ["R12 nested unknown key in a product", { products: [{ ...product(1), extra: true }] }, "invalid_request_product"],
  [
    "R12 nested unknown key in the posture",
    { ...secondaryBase, posture: { ...validPosture, extra: true } },
    "invalid_posture",
  ],
  ["R13 a valid posture on price-points", { posture: validPosture }, "invalid_request_posture_presence"],
  ["R14 null posture on secondary", { phase: "secondary", posture: null }, "invalid_request_posture_presence"],
];

describe("TCGplayer market observation request (AC1)", () => {
  it("accepts the bounded request and preserves truncation target", () =>
    expect(parseTcgplayerMarketObservationRequest(base).products[0]?.skuTargetCount).toBe(3));
  it("R01 accepts the five-product, 250-SKU maximum on secondary with a valid posture, and on price-points", () => {
    const secondary = parseTcgplayerMarketObservationRequest({ ...secondaryBase, products: maximalProducts });
    expect(secondary.products).toHaveLength(5);
    expect(secondary.products.every((p) => p.skuIds.length === 250)).toBe(true);
    expect(secondary.posture).toEqual(validPosture);
    expect(() => parseTcgplayerMarketObservationRequest({ ...base, products: maximalProducts })).not.toThrow();
  });
  it.each(rejections)("%s is rejected with its fixed code", (_name, change, expected) =>
    expect(code({ ...base, ...change })).toBe(expected),
  );
  it.each(boundCases)("%s", (_name, field, value, expected) =>
    expect(code({ ...secondaryBase, posture: { ...validPosture, [field]: value } })).toBe(expected),
  );
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
