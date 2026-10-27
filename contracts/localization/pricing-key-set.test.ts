import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pricingEnglishTranslations } from "./locales/en/pricing";

// Tripwire for unintended Pricing locale key changes. Rebaseline this fingerprint
// in the same PR whenever you intentionally add/remove/rename Pricing keys.
const englishPricingKeySet = {
  count: 671,
  sha256: "e45903ca6a26b33192f5eaa33cd36b6bbbb79e2933d2c6afb7f462804b87e575",
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
