import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicPresenceEnglishTranslations } from "./locales/en/public-presence";

// Tripwire for unintended public-presence locale key changes. Rebaseline this
// fingerprint in the same PR whenever you intentionally add/remove/rename keys.
const englishPublicPresenceKeySet = {
  count: 576,
  sha256: "6b1c08acc532aec46e02823dd59356a5e4cdf2c6a49b262a45c08aa1010508eb",
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
