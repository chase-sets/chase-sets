import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pricingEnglishTranslations } from "./locales/en/pricing";

// Tripwire for unintended Pricing locale key changes. Rebaseline this fingerprint
// in the same PR whenever you intentionally add/remove/rename Pricing keys.
const englishPricingKeySet = {
  count: 627,
  sha256: "55b4d1855fc77d48c5fd92999d86334f3f6cdd1ad145c274392ef5066005e9fb",
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
