import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { catalogEnglishTranslations } from "./locales/en/catalog";

// Tripwire for unintended catalog locale key changes. Rebaseline this fingerprint
// in the same PR whenever you intentionally add/remove/rename catalog keys.
const englishCatalogKeySet = {
  count: 3169,
  sha256: "2baf4f94efeb255323d038b37863b401c310d7c1cd15c91fab766d8703d4be23",
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
