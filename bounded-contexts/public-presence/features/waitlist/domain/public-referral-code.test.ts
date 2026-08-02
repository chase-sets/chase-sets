import { describe, expect, it } from "vitest";
import {
  assertPublicReferralCodeCoverageReceipt,
  assertReferralLinkProvisioningReceipt,
  buildReferralLink,
  createPublicReferralCodeCoverageReceipt,
  createReferralLinkProvisioningReceipt,
  generatePublicReferralCode,
  generateReferralLinkProvisioningId,
  jcsStringify,
  normalizeReferralLinkProvisioningRequest,
  publicReferralCodeDigest,
  sha256Jcs,
} from "./public-referral-code";

const code = generatePublicReferralCode((length) => new Uint8Array(length).fill(7));
const tuple = { utm_source: "creator" as const, utm_medium: "YouTube + Shorts", utm_campaign: "launch%20week" };

describe("Public Referral Code contracts", () => {
  it("generates immutable-shape opaque identities from the required entropy sizes", () => {
    const requested: number[] = [];
    expect(generatePublicReferralCode((length) => (requested.push(length), new Uint8Array(length)))).toMatch(
      /^wlr_[A-Za-z0-9_-]{32}$/,
    );
    expect(generateReferralLinkProvisioningId((length) => (requested.push(length), new Uint8Array(length)))).toMatch(
      /^wlp_[A-Za-z0-9_-]{22}$/,
    );
    expect(requested).toEqual([24, 16]);
    expect(publicReferralCodeDigest(code)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("builds the exact four-member ordered WHATWG URL and frozen JCS receipt", () => {
    const referralLink = buildReferralLink(code, tuple);
    expect(referralLink).toBe(
      `https://chasesets.com/?ref=${code}&utm_source=creator&utm_medium=YouTube+%2B+Shorts&utm_campaign=launch%2520week`,
    );
    const parsed = new URL(referralLink);
    expect([...parsed.searchParams.keys()]).toEqual(["ref", "utm_source", "utm_medium", "utm_campaign"]);
    expect(parsed.hash).toBe("");

    const receipt = createReferralLinkProvisioningReceipt({
      provisioningId: generateReferralLinkProvisioningId((length) => new Uint8Array(length).fill(9)),
      publicReferralCode: code,
      tuple,
      referralLink,
      issuedAt: "2026-08-02T12:34:56.789Z",
    });
    expect(receipt.receiptSha256).toBe(sha256Jcs(receipt.payload));
    expect(assertReferralLinkProvisioningReceipt(receipt)).toEqual(receipt);
  });

  it("recursively closes request and receipt schemas and rejects date-only, range, and digest mutations", () => {
    expect(() =>
      normalizeReferralLinkProvisioningRequest({ signupId: "wls_x", tuple: { ...tuple, extra: true } }),
    ).toThrow();
    const receipt = createReferralLinkProvisioningReceipt({
      provisioningId: generateReferralLinkProvisioningId((length) => new Uint8Array(length).fill(9)),
      publicReferralCode: code,
      tuple,
      referralLink: buildReferralLink(code, tuple),
      issuedAt: "2026-08-02T12:34:56.789Z",
    });
    expect(() => assertReferralLinkProvisioningReceipt({ ...receipt, extra: true })).toThrow();
    expect(() =>
      assertReferralLinkProvisioningReceipt({ ...receipt, payload: { ...receipt.payload, issuedAt: "2026-08-02" } }),
    ).toThrow();
    expect(() =>
      assertReferralLinkProvisioningReceipt({
        ...receipt,
        payload: { ...receipt.payload, issuedAt: "9999-99-99T99:99:99.999Z" },
      }),
    ).toThrow();
    expect(() => assertReferralLinkProvisioningReceipt({ ...receipt, receiptSha256: "0".repeat(64) })).toThrow();
  });

  it("issue-6418-ac-3 binds exact code-free coverage and turns the 501st missing issuance red", () => {
    const green = createPublicReferralCodeCoverageReceipt({
      horizonGlobalPosition: "501",
      completeSignupCount: 501,
      validIssuedCount: 501,
      validReservedCount: 501,
      refusalCounts: {
        missingRecorded: 0,
        missingIssued: 0,
        missingReservation: 0,
        mismatched: 0,
        duplicate: 0,
        unexpected: 0,
      },
      cutoverEligible: true,
      startedAt: "2026-08-02T00:00:00.000Z",
      completedAt: "2026-08-02T00:00:01.000Z",
    });
    expect(assertPublicReferralCodeCoverageReceipt(green)).toEqual(green);
    expect(jcsStringify(green)).not.toContain("wlr_");

    const red = createPublicReferralCodeCoverageReceipt({
      ...green.payload,
      validIssuedCount: 500,
      validReservedCount: 500,
      refusalCounts: { ...green.payload.refusalCounts, missingIssued: 1, missingReservation: 1 },
      cutoverEligible: false,
    });
    expect(red.payload.cutoverEligible).toBe(false);
    expect(red.receiptSha256).not.toBe(green.receiptSha256);
    expect(() =>
      assertPublicReferralCodeCoverageReceipt({
        ...green,
        payload: {
          ...green.payload,
          refusalCounts: { ...green.payload.refusalCounts, unknown: 0 },
        },
      }),
    ).toThrow();
    expect(() =>
      assertPublicReferralCodeCoverageReceipt({
        ...green,
        payload: { ...green.payload, completedAt: "2026-08-02" },
      }),
    ).toThrow();
    expect(() =>
      createPublicReferralCodeCoverageReceipt({
        ...green.payload,
        completeSignupCount: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
  });
});
