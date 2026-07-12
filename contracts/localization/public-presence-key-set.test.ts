import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicPresenceEnglishTranslations } from "./locales/en/public-presence";

// Tripwire for unintended public-presence locale key changes. Rebaseline this
// fingerprint in the same PR whenever you intentionally add/remove/rename keys.
const englishPublicPresenceKeySet = {
  count: 420,
  sha256: "64354bc8dc91f63f2876088516fcd82af557a51c674c4d4901dab281dde176da",
} as const;

describe("public-presence locale key set", () => {
  it("matches the committed English public-presence key set", () => {
    expect(keySetFingerprint(Object.keys(publicPresenceEnglishTranslations))).toEqual(englishPublicPresenceKeySet);
  });
});

function keySetFingerprint(keys: readonly string[]) {
  const sortedKeys = [...keys].sort();

  return {
    count: sortedKeys.length,
    sha256: createHash("sha256").update(JSON.stringify(sortedKeys)).digest("hex"),
  };
}
