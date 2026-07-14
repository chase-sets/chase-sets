import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collectionsEnglishTranslations } from "./locales/en/collections";

const englishCollectionsKeySet = {
  count: 51,
  sha256: "9ec199bf7f644f081174ba5bb3052de43d7d39a07a673415dc4f5fc98d4eb076",
} as const;

describe("collections locale key set", () => {
  it("matches the committed English collections key set", () => {
    expect(keySetFingerprint(Object.keys(collectionsEnglishTranslations))).toEqual(englishCollectionsKeySet);
  });
});

function keySetFingerprint(keys: readonly string[]) {
  const sortedKeys = [...keys].sort();

  return {
    count: sortedKeys.length,
    sha256: createHash("sha256").update(JSON.stringify(sortedKeys)).digest("hex"),
  };
}
