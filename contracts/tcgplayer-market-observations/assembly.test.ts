import { describe, expect, it } from "vitest";
import { assembleAdmittedTcgplayerMarketObservationBatch, digestTcgplayerMarketObservationBatchText, parseTcgplayerMarketObservationRequest, splitTcgplayerMarketObservationBatchText } from "./index";

const request = parseTcgplayerMarketObservationRequest({ contractVersion: 1, requestId: "123e4567-e89b-12d3-a456-426614174000", phase: "price-points", issuedAt: "2026-10-17T00:00:00.000Z", products: [{ productId: 1, skuIds: [1], skuTargetCount: 1 }], posture: null });
const text = JSON.stringify({ contractVersion: 1, requestId: request.requestId, phase: request.phase, posture: null, products: [{ productId: 1, pricePoints: [{ skuId: 1, marketPrice: null, lowestPrice: null, highestPrice: null, priceCount: null, calculatedAt: null }] }] });
describe("admitted batch assembly", () => {
  it("requires all parts and the admission", async () => {
    const parts = splitTcgplayerMarketObservationBatchText(text);
    const digest = await digestTcgplayerMarketObservationBatchText(text);
    const history = [{ streamVersion: 1, data: { batchId: "123e4567-e89b-12d3-a456-426614174001", requestId: request.requestId, phase: request.phase, partIndex: 0, text: parts[0] } }, { streamVersion: 2, data: { batchId: "123e4567-e89b-12d3-a456-426614174001", requestId: request.requestId, phase: request.phase, contractVersion: 1, partCount: 1, textBytes: text.length, digest, grantId: "123e4567-e89b-12d3-a456-426614174002", creatorMembershipId: "membership", creatorUserId: "user", admittedAt: "2026-10-17T00:00:00.000Z" } }];
    await expect(assembleAdmittedTcgplayerMarketObservationBatch(history, request)).resolves.toMatchObject({ requestId: request.requestId });
    await expect(assembleAdmittedTcgplayerMarketObservationBatch(history.slice(1), request)).rejects.toThrow();
  });
});
