import { describe, expect, it } from "vitest";
import {
  DISCOVERY_EMBEDDING_DESCRIPTION_MAX_CHARACTERS,
  buildDiscoveryEmbeddingDocument,
  estimateDiscoveryEmbeddingTokens,
} from "./embedding-document";

describe("Discovery embedding document", () => {
  it("is deterministic across unordered locale, alias, and category input", () => {
    const first = buildDiscoveryEmbeddingDocument({
      title: "Charizard",
      titleI18n: { values: { ja: "リザードン", en: "Charizard" } },
      subtitle: "Base Set",
      resolvedAliases: {
        ja: [{ aliasText: "かえんポケモン" }],
        fr: [{ aliasText: "Dracaufeu" }],
      },
      categoryNames: ["Cards", "Pokémon"],
      keyFieldValues: ["4/102", "Rare Holo"],
      descriptionI18n: { values: { ja: "ほのおを はく。", en: "Spits fire." } },
      description: "Spits fire.",
    });
    const second = buildDiscoveryEmbeddingDocument({
      title: "Charizard",
      titleI18n: { values: { en: "Charizard", ja: "リザードン" } },
      subtitle: "Base Set",
      resolvedAliases: {
        fr: [{ aliasText: "Dracaufeu" }],
        ja: [{ aliasText: "かえんポケモン" }],
      },
      categoryNames: ["Pokémon", "Cards"],
      keyFieldValues: ["Rare Holo", "4/102"],
      descriptionI18n: { values: { en: "Spits fire.", ja: "ほのおを はく。" } },
      description: "Spits fire.",
    });

    expect(second).toEqual(first);
    expect(first.text).toContain("リザードン");
    expect(first.text).toContain("かえんポケモン");
    expect(first.text).toContain("ほのおを はく。");
  });

  it("changes the hash only when embedded text changes", () => {
    const original = buildDiscoveryEmbeddingDocument({ title: "Pikachu", description: "Mouse Pokémon" });
    const unchanged = buildDiscoveryEmbeddingDocument({
      title: " Pikachu ",
      titleI18n: { values: { en: "Pikachu" } },
      description: "Mouse Pokémon",
    });
    const revised = buildDiscoveryEmbeddingDocument({ title: "Pikachu ex", description: "Mouse Pokémon" });

    expect(unchanged.hash).toBe(original.hash);
    expect(revised.hash).not.toBe(original.hash);
  });

  it("bounds description text without stripping CJK and estimates its tokens", () => {
    const description = "炎".repeat(DISCOVERY_EMBEDDING_DESCRIPTION_MAX_CHARACTERS + 20);
    const document = buildDiscoveryEmbeddingDocument({ title: "カード", description });

    expect(document.text).toContain("炎".repeat(DISCOVERY_EMBEDDING_DESCRIPTION_MAX_CHARACTERS));
    expect(document.text).not.toContain("炎".repeat(DISCOVERY_EMBEDDING_DESCRIPTION_MAX_CHARACTERS + 1));
    expect(estimateDiscoveryEmbeddingTokens("abcd炎")).toBe(2);
  });
});
