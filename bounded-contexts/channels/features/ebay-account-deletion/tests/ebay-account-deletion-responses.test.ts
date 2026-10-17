import { describe, expect, it } from "vitest";
import { decodeEbayReceiptMatches, decodeEbaySubjectDataCount } from "../domain/responses";

describe("eBay staff response boundary", () => {
  const row = {
    notificationId: "synthetic-notice",
    eventDate: "2026-10-11T00:00:00.000001Z",
    expiresAt: "2026-11-10T00:00:00.000Z",
  };
  it("accepts only the closed metadata/count responses", () => {
    expect(decodeEbayReceiptMatches({ matches: [row] })).toEqual([row]);
    expect(decodeEbaySubjectDataCount({ connections: 0, credentialEnvelopes: 0 })).toEqual({
      connections: 0,
      credentialEnvelopes: 0,
    });
  });
  it.each([
    { matches: [{}] },
    { matches: [{ ...row, userId: "synthetic-private-subject" }] },
    { matches: [{ ...row, eventDate: "2026-10-11" }] },
    { matches: [{ ...row, eventDate: "2026-02-30T00:00:00.000Z" }] },
    { matches: [row], extra: {} },
  ])("rejects malformed or subject-bearing metadata (%j)", (value) => {
    expect(() => decodeEbayReceiptMatches(value)).toThrow("invalid-ebay-receipt-response");
  });
  it.each([
    { connections: -1, credentialEnvelopes: 0 },
    { connections: 0, credentialEnvelopes: Number.MAX_SAFE_INTEGER + 1 },
    { connections: 0, credentialEnvelopes: 0, extra: {} },
  ])("rejects invalid counts (%j)", (value) => {
    expect(() => decodeEbaySubjectDataCount(value)).toThrow("invalid-ebay-receipt-response");
  });
});
