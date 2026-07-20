import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { catalogEnglishTranslations } from "./locales/en/catalog";

// Tripwire for unintended catalog locale key changes. Rebaseline this fingerprint
// in the same PR whenever you intentionally add/remove/rename catalog keys.
const englishCatalogKeySet = {
  count: 2839,
  sha256: "2e83947e65932d5494e8c9c5fc9eabfca3f0d472d159f5e2985c08337275bd5f",
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
