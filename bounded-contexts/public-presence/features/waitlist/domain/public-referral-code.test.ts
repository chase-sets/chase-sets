import { describe, expect, it } from "vitest";
import {
  assertReferralLinkProvisioningReceipt,
  buildReferralLink,
  createReferralLinkProvisioningReceipt,
  generatePublicReferralCode,
  generateReferralLinkProvisioningId,
  publicReferralCodeDigest,
  publicReferralCodeReservationStreamId,
  sha256Jcs,
} from "./public-referral-code";

const code = generatePublicReferralCode((length) => new Uint8Array(length).fill(7));
const tuple = { utm_source: "creator" as const, utm_medium: "YouTube + Shorts", utm_campaign: "launch%20week" };

function receipt(overrides: Partial<{ issuedAt: string }> = {}) {
  return createReferralLinkProvisioningReceipt({
    provisioningId: generateReferralLinkProvisioningId((length) => new Uint8Array(length).fill(9)),
    publicReferralCode: code,
    tuple,
    referralLink: buildReferralLink(code, tuple),
    issuedAt: overrides.issuedAt ?? "2026-08-02T12:34:56.789Z",
  });
}

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
    expect(() => generatePublicReferralCode(() => new Uint8Array(23))).toThrow("at least 24 bytes");
    expect(() => generateReferralLinkProvisioningId(() => new Uint8Array(15))).toThrow("at least 16 bytes");
  });

  it("is the single definition of the canonical digest-only reservation stream identity", () => {
    const streamId = publicReferralCodeReservationStreamId(code);
    expect(streamId).toBe(`public-presence.waitlist-referral-code-${publicReferralCodeDigest(code)}`);
    expect(streamId).not.toContain(code);
    expect(streamId).not.toContain("wlr_");
    expect(() => publicReferralCodeReservationStreamId("wlr_short")).toThrow("Public Referral Code is invalid.");
  });

  it("builds the exact four-member ordered WHATWG URL and frozen JCS receipt", () => {
    const referralLink = buildReferralLink(code, tuple);
    expect(referralLink).toBe(
      `https://chasesets.com/?ref=${code}&utm_source=creator&utm_medium=YouTube+%2B+Shorts&utm_campaign=launch%2520week`,
    );
    const parsed = new URL(referralLink);
    expect([...parsed.searchParams.keys()]).toEqual(["ref", "utm_source", "utm_medium", "utm_campaign"]);
    expect(parsed.hash).toBe("");

    const provisioning = receipt();
    expect(provisioning.receiptSha256).toBe(sha256Jcs(provisioning.payload));
    expect(assertReferralLinkProvisioningReceipt(provisioning)).toEqual(provisioning);
  });

  it("recursively closes request and receipt schemas and rejects date-only, range, and digest mutations", () => {
    const provisioning = receipt();
    expect(() => assertReferralLinkProvisioningReceipt({ ...provisioning, extra: true })).toThrow();
    expect(() =>
      assertReferralLinkProvisioningReceipt({
        ...provisioning,
        payload: { ...provisioning.payload, tuple: { ...tuple, unknown: true } },
      }),
    ).toThrow();
    expect(() =>
      assertReferralLinkProvisioningReceipt({
        ...provisioning,
        payload: { ...provisioning.payload, issuedAt: "2026-08-02" },
      }),
    ).toThrow("UTC millisecond instant");
    expect(() =>
      assertReferralLinkProvisioningReceipt({
        ...provisioning,
        payload: { ...provisioning.payload, issuedAt: "2026-02-30T00:00:00.000Z" },
      }),
    ).toThrow("valid UTC millisecond instant");
    expect(() =>
      assertReferralLinkProvisioningReceipt({
        ...provisioning,
        payload: { ...provisioning.payload, issuedAt: "9999-99-99T99:99:99.999Z" },
      }),
    ).toThrow();
    expect(() => assertReferralLinkProvisioningReceipt({ ...provisioning, receiptSha256: "0".repeat(64) })).toThrow(
      "does not match its payload",
    );
    // The link is not free text: it must be exactly the code-and-tuple join.
    expect(() =>
      assertReferralLinkProvisioningReceipt({
        ...provisioning,
        payload: { ...provisioning.payload, referralLink: "https://chasesets.com/?ref=wlr_other" },
      }),
    ).toThrow("does not match the code and tuple");
  });
});
