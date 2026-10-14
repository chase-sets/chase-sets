import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { discoveryEnglishTranslations } from "./locales/en/discovery";

const englishDiscoveryKeySet = {
  count: 1046,
  sha256: "110ba9b2dcd16bdf0636ae2835a417d26a4fd3e43d61583ec8926499be006ec9",
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
