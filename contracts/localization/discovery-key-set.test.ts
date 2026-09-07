import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { discoveryEnglishTranslations } from "./locales/en/discovery";

const englishDiscoveryKeySet = {
  count: 1015,
  sha256: "cba0864db0362151b44ce015f19be1ab2f12cb695829635872e3363d0f72dd41",
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
