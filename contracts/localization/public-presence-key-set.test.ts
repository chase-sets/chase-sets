import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicPresenceEnglishTranslations } from "./locales/en/public-presence";

// Tripwire for unintended changes to the remaining central catalog. Rebaseline
// when a key is intentionally added, removed, renamed, or moved to its owner.
const englishPublicPresenceKeySet = {
  count: 442,
  sha256: "d51a5a78735325d6fd06d347764838dc0b56cbee4b0676a60b90e4221ccb962a",
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
