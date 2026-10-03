import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicPresenceEnglishTranslations } from "./locales/en/public-presence";

// Tripwire for unintended public-presence locale key changes. Rebaseline this
// fingerprint in the same PR whenever you intentionally add/remove/rename keys.
const englishPublicPresenceKeySet = {
  count: 516,
  sha256: "f662383f05254368fd4e83aadc9c7acbef8a22b29ccd1af832479b5bf4a665a3",
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
