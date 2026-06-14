import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { catalogEnglishTranslations } from "./locales/en/catalog";

// Tripwire for unintended catalog locale key changes. Rebaseline this fingerprint
// in the same PR whenever you intentionally add/remove/rename catalog keys.
const englishCatalogKeySet = {
  count: 2212,
  sha256: "972f803a16642d62705dcb121d74432360bee2ba3c1cc4c9a86cd6a97255ae0c",
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
