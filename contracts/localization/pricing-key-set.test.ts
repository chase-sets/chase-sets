import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pricingEnglishTranslations } from "./locales/en/pricing";

// Tripwire for unintended Pricing locale key changes. Rebaseline this fingerprint
// in the same PR whenever you intentionally add/remove/rename Pricing keys.
const englishPricingKeySet = {
  count: 597,
  sha256: "de8a7fd67472e029afd85d3a400f82d8410641cd325f47308b02bb45db9d223b",
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
