import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicPresenceEnglishTranslations } from "./locales/en/public-presence";

// Tripwire for unintended changes to the remaining central catalog. Rebaseline
// when a key is intentionally added, removed, renamed, or moved to its owner.
const englishPublicPresenceKeySet = {
  count: 486,
  sha256: "6c58f88921caa083f294e0c0005dad61a41a1fe6caf1cc4a516999d9942b2955",
} as const;

describe("public-presence locale key set", () => {
  it("matches the remaining central English public-presence key set", () => {
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
