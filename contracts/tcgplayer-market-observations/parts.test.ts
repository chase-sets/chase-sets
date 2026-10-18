import { describe, expect, it } from "vitest";
import {
  PART_TEXT_MAX_BYTES,
  digestTcgplayerMarketObservationBatchText,
  maxPartCount,
  parseTcgplayerMarketObservationRequest,
  splitTcgplayerMarketObservationBatchText,
} from "./index";

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
});
