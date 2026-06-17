import { describe, expect, it } from "vitest";
import { aliasTextByWeight, resolveAliasWeight, weightedAliasTexts, type ResolvedAlias } from "./alias-weighting";

function alias(overrides: Partial<ResolvedAlias> & Pick<ResolvedAlias, "aliasType">): ResolvedAlias {
  return {
    aliasHash: overrides.aliasHash ?? `hash-${overrides.aliasText ?? overrides.aliasType}`,
    aliasText: overrides.aliasText ?? "Alias",
    normalizedAliasText: overrides.normalizedAliasText ?? (overrides.aliasText ?? "alias").toLowerCase(),
    aliasType: overrides.aliasType,
    confidence: overrides.confidence ?? "high",
    broad: overrides.broad ?? false,
    providerKey: overrides.providerKey,
    sourceCategory: overrides.sourceCategory,
  };
}

describe("resolveAliasWeight", () => {
  it("weights an official equivalent at the top tier (A)", () => {
    expect(resolveAliasWeight(alias({ aliasType: "official-equivalent", confidence: "high" }))).toBe("A");
  });

  it("weights an exact set/series equivalent high (A) and a non-exact one medium (B)", () => {
    expect(resolveAliasWeight(alias({ aliasType: "set-equivalent", confidence: "exact" }))).toBe("A");
    expect(resolveAliasWeight(alias({ aliasType: "series-equivalent", confidence: "high" }))).toBe("B");
  });

  it("weights a species name medium (B)", () => {
    expect(resolveAliasWeight(alias({ aliasType: "species-name", confidence: "high" }))).toBe("B");
  });

  it("weights romanization and generated translation low (D)", () => {
    expect(resolveAliasWeight(alias({ aliasType: "romanization", confidence: "manual" }))).toBe("D");
    expect(resolveAliasWeight(alias({ aliasType: "generated-translation", confidence: "manual" }))).toBe("D");
  });

  it("pins any generated-confidence alias to the lowest tier regardless of type", () => {
    expect(resolveAliasWeight(alias({ aliasType: "official-equivalent", confidence: "generated" }))).toBe("D");
  });

  it("demotes a broad alias one tier so it cannot outrank a specific one", () => {
    // A broad species name (base B) demotes to C; it can never reach the title's A.
    expect(resolveAliasWeight(alias({ aliasType: "species-name", broad: true }))).toBe("C");
    // A broad official equivalent (rare) demotes A -> B, still below the title's A.
    expect(resolveAliasWeight(alias({ aliasType: "official-equivalent", broad: true }))).toBe("B");
  });
});

describe("weightedAliasTexts", () => {
  it("dedupes by alias hash so the same alias contributes once", () => {
    const result = weightedAliasTexts([
      alias({ aliasHash: "h1", aliasText: "Dracaufeu", aliasType: "official-equivalent" }),
      alias({ aliasHash: "h1", aliasText: "Dracaufeu", aliasType: "official-equivalent" }),
    ]);
    expect(result).toEqual([{ weight: "A", text: "Dracaufeu" }]);
  });

  it("keeps the strongest weight when one text appears at multiple weights", () => {
    const result = weightedAliasTexts([
      alias({ aliasHash: "h1", aliasText: "Pikachu", aliasType: "species-name", broad: true }), // C
      alias({ aliasHash: "h2", aliasText: "Pikachu", aliasType: "official-equivalent" }), // A
    ]);
    expect(result).toEqual([{ weight: "A", text: "Pikachu" }]);
  });

  it("ignores empty alias text", () => {
    expect(weightedAliasTexts([alias({ aliasText: "  ", aliasType: "official-equivalent" })])).toEqual([]);
  });
});

describe("aliasTextByWeight", () => {
  it("groups alias text into weight tiers", () => {
    const buckets = aliasTextByWeight([
      alias({ aliasHash: "a", aliasText: "Cacnea", aliasType: "official-equivalent" }),
      alias({ aliasHash: "b", aliasText: "Cactus Pokemon", aliasType: "species-name", broad: true }),
      alias({ aliasHash: "c", aliasText: "Sabonea", aliasType: "romanization" }),
    ]);
    expect(buckets.A).toBe("Cacnea");
    expect(buckets.C).toBe("Cactus Pokemon");
    expect(buckets.D).toBe("Sabonea");
    expect(buckets.B).toBe("");
  });
});
