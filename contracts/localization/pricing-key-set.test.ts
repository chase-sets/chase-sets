import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pricingEnglishTranslations } from "./locales/en/pricing";

// Tripwire for unintended Pricing locale key changes. Rebaseline this fingerprint
// in the same PR whenever you intentionally add/remove/rename Pricing keys.
const englishPricingKeySet = {
  count: 589,
  sha256: "3499a7f5471e9b6f19260e3bbf09b6b452122530bc7fa4a9dd038d49c4c505be",
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
