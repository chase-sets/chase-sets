import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pricingEnglishTranslations } from "./locales/en/pricing";

// Tripwire for unintended Pricing locale key changes. Rebaseline this fingerprint
// in the same PR whenever you intentionally add/remove/rename Pricing keys.
const englishPricingKeySet = {
  count: 601,
  sha256: "b7d12ce876b6a4e40dd36c61c38be8fa3499d371ade05da7d66355497c97438f",
} as const;

describe("pricing locale key set", () => {
  it("matches the committed English Pricing key set", () => {
    expect(keySetFingerprint(Object.keys(pricingEnglishTranslations))).toEqual(englishPricingKeySet);
  });
});

function keySetFingerprint(keys: readonly string[]) {
  const sortedKeys = [...keys].sort();
  return {
    count: sortedKeys.length,
    sha256: createHash("sha256").update(JSON.stringify(sortedKeys)).digest("hex"),
  };
}
