import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { discoveryEnglishTranslations } from "./locales/en/discovery";

const englishDiscoveryKeySet = {
  count: 1009,
  sha256: "8fa477a59ff0b738c67ad4e0eb1f7fa8a2ac25d1ee9e27471ba0054aad928603",
} as const;

describe("discovery locale key set", () => {
  it("matches the committed English discovery key set", () => {
    expect(keySetFingerprint(Object.keys(discoveryEnglishTranslations))).toEqual(englishDiscoveryKeySet);
  });
});

function keySetFingerprint(keys: readonly string[]) {
  const sortedKeys = [...keys].sort();

  return {
    count: sortedKeys.length,
    sha256: createHash("sha256").update(JSON.stringify(sortedKeys)).digest("hex"),
  };
}
