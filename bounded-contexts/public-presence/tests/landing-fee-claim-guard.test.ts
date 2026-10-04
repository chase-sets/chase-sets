import { describe, expect, it } from "vitest";
import { publicPresenceEnglishTranslations } from "@chase-sets/localization/locales/en/public-presence";
import {
  findSellerFeeClaimViolations,
  LANDING_COPY_NAMESPACE_PREFIXES,
  landingCopyEntries,
} from "../features/waitlist/ui/landing-copy-guard";

// #8606: landing seller-fee claims conform to the published sales-fee schedule
// and the Founders offer terms. The guard runs over the real landing
// namespaces (LANDING_COPY_NAMESPACE_PREFIXES), not a fixture.
describe("landing seller-fee claim guard (#8606)", () => {
  it("finds zero unbounded 0% or 100%-retention claims in the current landing copy (AC1)", () => {
    expect(findSellerFeeClaimViolations(publicPresenceEnglishTranslations)).toEqual([]);
  });

  it("names the founder 60-day window on every current landing 0% claim (AC1)", () => {
    const zeroFeeEntries = landingCopyEntries(publicPresenceEnglishTranslations).filter(([, value]) =>
      /(?<![\d.])0%/.test(value),
    );
    // The hero, FAQ and founders copy all carry a 0% claim; if this drops to
    // zero the pattern stopped matching real copy and the guard is inert.
    expect(zeroFeeEntries.length).toBeGreaterThanOrEqual(3);
    for (const [key, value] of zeroFeeEntries) {
      expect(value, key).toMatch(/\b60[- ]days?\b/i);
    }
  });

  it.each([
    ["publicPresence.home.heroHighlight.lowValue.value", "Keep 100% of the sale"],
    ["publicPresence.faq.fees.answer", "Listings created during beta keep a 0% seller fee until sold."],
    ["publicPresence.home.heroHighlight.lowValue.label", "0% beta seller fees"],
    ["publicPresence.home.description", "list yours with 0% fees during beta."],
    ["publicPresence.welcome.referral.share.message", "Sellers keep 100% of the sale on Chase Sets right now."],
    ["publicPresence.waitlist.promise", "You keep the whole sale."],
  ])("flags the retired claim shape when it returns at %s", (key, value) => {
    const violations = findSellerFeeClaimViolations({ ...publicPresenceEnglishTranslations, [key]: value });
    expect(violations.map((violation) => violation.key)).toEqual([key]);
  });

  it("accepts a 0% claim that names the founder 60-day window", () => {
    const probe = {
      "publicPresence.home.title": "0% sales fee on listings you create in your first 60 days of beta.",
      "publicPresence.faq.fees.answer": "Listings created during a founder's 60-day window lock 0% seller fees.",
    };
    expect(findSellerFeeClaimViolations(probe)).toEqual([]);
  });

  it("does not mistake rates, caps, or money amounts for a 0% claim", () => {
    const probe = {
      "publicPresence.faq.fees.answer": "2.9% + $0.30 by card, 0.5% by bank account, $0.00 with balance, capped at 10%.",
    };
    expect(findSellerFeeClaimViolations(probe)).toEqual([]);
  });

  it("ignores claims outside the landing-visible namespaces", () => {
    const probe = { "publicPresence.syntheticOutOfScope.body": "Keep 100% of the sale with 0% fees." };
    expect(findSellerFeeClaimViolations(probe)).toEqual([]);
    expect(LANDING_COPY_NAMESPACE_PREFIXES.some((prefix) => "publicPresence.syntheticOutOfScope.body".startsWith(prefix))).toBe(
      false,
    );
  });
});
