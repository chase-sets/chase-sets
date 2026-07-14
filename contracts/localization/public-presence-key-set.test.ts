import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicPresenceEnglishTranslations } from "./locales/en/public-presence";

// Tripwire for unintended public-presence locale key changes. Rebaseline this
// fingerprint in the same PR whenever you intentionally add/remove/rename keys.
const englishPublicPresenceKeySet = {
  count: 726,
  sha256: "56197176d869d44ccd5b9796337e68dd9eff4e8230cf7200e6e3e92e97acf587",
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
