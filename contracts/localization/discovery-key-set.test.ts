import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { discoveryEnglishTranslations } from "./locales/en/discovery";

const englishDiscoveryKeySet = {
  count: 973,
  sha256: "85bef56804df665121804eb226aef7eb812512d61a27471da0821f604c9c9ea7",
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
