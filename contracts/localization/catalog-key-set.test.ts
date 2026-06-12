import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { catalogEnglishTranslations } from "./locales/en/catalog";

const preSplitEnglishCatalogKeySet = {
  count: 2165,
  sha256: "75046889276fd2ce55688897bc8ee5260ea769809cbe1ab450e91be08908599b",
} as const;

describe("catalog locale key set", () => {
  it("preserves the pre-split English catalog key set", () => {
    expect(keySetFingerprint(Object.keys(catalogEnglishTranslations))).toEqual(preSplitEnglishCatalogKeySet);
  });
});

function keySetFingerprint(keys: readonly string[]) {
  const sortedKeys = [...keys].sort();

  return {
    count: sortedKeys.length,
    sha256: createHash("sha256").update(JSON.stringify(sortedKeys)).digest("hex"),
  };
}
