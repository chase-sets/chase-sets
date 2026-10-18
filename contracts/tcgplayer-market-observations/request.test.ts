import { describe, expect, it } from "vitest";
import { parseTcgplayerMarketObservationRequest } from "./index";

const base = {
  contractVersion: 1,
  requestId: "123e4567-e89b-12d3-a456-426614174000",
  phase: "price-points" as const,
  issuedAt: "2026-10-17T00:00:00.000Z",
  products: [{ productId: 1, skuIds: [1, 2], skuTargetCount: 3 }],
  posture: null,
};

describe("TCGplayer market observation request", () => {
  it("accepts the bounded request and preserves truncation target", () => {
    expect(parseTcgplayerMarketObservationRequest(base).products[0]?.skuTargetCount).toBe(3);
  });
  it.each([
    ["nested unknown key", { products: [{ ...base.products[0], extra: true }] }],
    ["uppercase request id", { requestId: base.requestId.toUpperCase() }],
    ["posture on price points", { posture: {} }],
    ["duplicate sku", { products: [{ ...base.products[0], skuIds: [1, 1] }] }],
  ])("rejects %s", (_name, change) => {
    expect(() => parseTcgplayerMarketObservationRequest({ ...base, ...change })).toThrow();
  });
});
