import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoveryEnglishTranslations } from "./locales/en/discovery";

const englishDiscoveryKeySet = {
  count: 1045,
  sha256: "dec1344853efbaa5d1cb25e88a3ddb528c315898513ca5065c90b597553d3aaf",
} as const;

describe("discovery locale key set", () => {
  it("matches the committed English discovery key set", () => {
    expect(keySetFingerprint(Object.keys(discoveryEnglishTranslations))).toEqual(englishDiscoveryKeySet);
  });

  it("labels every GoogleShoppingExclusionReason union member", () => {
    const source = readFileSync(
      new URL(
        "../../bounded-contexts/discovery/features/google-shopping-operations/api/export-row.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const union = source.match(/export type GoogleShoppingExclusionReason =([^;]+);/)?.[1];
    expect(union).toBeDefined();
    const reasons = [...union!.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]!);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      const key = `discovery.googleShoppingOperations.exclusionReason.${reason}`;
      expect(Object.hasOwn(discoveryEnglishTranslations, key), reason).toBe(true);
      expect(Reflect.get(discoveryEnglishTranslations, key), reason).toEqual(expect.any(String));
    }
  });
});

function keySetFingerprint(keys: readonly string[]) {
  const sortedKeys = [...keys].sort();

  return {
    count: sortedKeys.length,
    sha256: createHash("sha256").update(JSON.stringify(sortedKeys)).digest("hex"),
  };
}
