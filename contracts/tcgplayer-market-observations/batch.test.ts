import { describe, expect, it } from "vitest";
import { parseTcgplayerMarketObservationBatch, parseTcgplayerMarketObservationRequest } from "./index";

const request = parseTcgplayerMarketObservationRequest({
  contractVersion: 1,
  requestId: "123e4567-e89b-12d3-a456-426614174000",
  phase: "price-points",
  issuedAt: "2026-10-17T00:00:00.000Z",
  products: [{ productId: 1, skuIds: [1], skuTargetCount: 1 }],
  posture: null,
});
const batch = { contractVersion: 1, requestId: request.requestId, phase: request.phase, posture: null, products: [{ productId: 1, pricePoints: [{ skuId: 1, marketPrice: "1.00", lowestPrice: null, highestPrice: null, priceCount: 1, calculatedAt: "2026-10-17T00:00:00.000Z" }] }] };

describe("TCGplayer market observation batch", () => {
  it("accepts canonical text", () => expect(parseTcgplayerMarketObservationBatch(JSON.stringify(batch), request)).toEqual(batch));
  it.each([
    ["non-canonical whitespace", `${JSON.stringify(batch)} `],
    ["unknown nested key", JSON.stringify({ ...batch, products: [{ ...batch.products[0], sellerName: "forbidden" }] })],
    ["duplicate sku", JSON.stringify({ ...batch, products: [{ productId: 1, pricePoints: [{ ...batch.products[0]!.pricePoints[0], skuId: 1 }, { ...batch.products[0]!.pricePoints[0], skuId: 1 }] }] })],
  ])("rejects %s", (_name, text) => expect(() => parseTcgplayerMarketObservationBatch(text, request)).toThrow());
});
