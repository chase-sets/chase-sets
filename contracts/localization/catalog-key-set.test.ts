import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { catalogEnglishTranslations } from "./locales/en/catalog";

// Tripwire for unintended catalog locale key changes. Rebaseline this fingerprint
// in the same PR whenever you intentionally add/remove/rename catalog keys.
const englishCatalogKeySet = {
  count: 3121,
  sha256: "995ac81f0699c6f7e25b00da38162f3a6f49d320d6211b5ef1efd021cbd338d2",
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
