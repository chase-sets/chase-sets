import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { catalogEnglishTranslations } from "./locales/en/catalog";

// Tripwire for unintended catalog locale key changes. Rebaseline this fingerprint
// in the same PR whenever you intentionally add/remove/rename catalog keys.
const englishCatalogKeySet = {
  count: 2245,
  sha256: "bc504a982b756e08d40a2092b3717086722336c2299fd7c182ebdb10c9698b4a",
} as const;

describe("catalog locale key set", () => {
  it("matches the committed English catalog key set", () => {
    expect(keySetFingerprint(Object.keys(catalogEnglishTranslations))).toEqual(englishCatalogKeySet);
  });
});

function keySetFingerprint(keys: readonly string[]) {
  const sortedKeys = [...keys].sort();

  return {
    count: sortedKeys.length,
    sha256: createHash("sha256").update(JSON.stringify(sortedKeys)).digest("hex"),
  };
}
