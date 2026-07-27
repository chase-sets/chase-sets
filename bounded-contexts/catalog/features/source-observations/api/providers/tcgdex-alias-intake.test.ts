import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@chase-sets/primitives/json";
import { ingestTcgdexAliasCandidates, type TcgdexEnglishMirrorLoader } from "./tcgdex-alias-intake";
import type { CatalogProviderIntegrationProfile } from "../provider-integration-profiles";
import type { CatalogAliasCandidate } from "../../../alias-equivalence/domain/alias";

const profile = {} as CatalogProviderIntegrationProfile;

function observation(payload: JsonValue, overrides: Record<string, string> = {}) {
  return {
    observationId: "obs_1",
    sourceProfileKey: "pokemon-tcg",
    sourceProfileVersion: "2026.06.03",
    mappingFingerprint: "fp-1",
    payload,
    ...overrides,
  };
}

function japaneseCardPayload(): JsonValue {
  return {
    languageCode: "ja",
    card: { id: "sv1a-001", name: "ニャオハ", category: "Pokemon", dexId: [906] },
    set: { id: "sv1a", name: "トリプレットビート" },
    seriesId: "sv",
    seriesName: "スカーレット&バイオレット",
  };
}

describe("ingestTcgdexAliasCandidates", () => {
  it("fetches same-id English mirrors and persists the produced candidates", async () => {
    const persisted: CatalogAliasCandidate[][] = [];
    const loadEnglishMirrorEntity: TcgdexEnglishMirrorLoader = vi.fn(async ({ entity, id }) => {
      if (entity === "card" && id === "sv1a-001") {
        return { id: "sv1a-001", name: "Sprigatito" };
      }
      if (entity === "set" && id === "sv1a") {
        return { id: "sv1a", name: "Triplet Beat" };
      }
      if (entity === "series" && id === "sv") {
        return { id: "sv", name: "Scarlet & Violet" };
      }
      return null;
    });

    const candidates = await ingestTcgdexAliasCandidates({
      profile,
      observations: [observation(japaneseCardPayload())],
      persist: async (c) => {
        persisted.push([...c]);
      },
      observedAt: "2026-06-16T00:00:00.000Z",
      loadEnglishMirrorEntity,
    });

    expect(loadEnglishMirrorEntity).toHaveBeenCalledTimes(3);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(candidates);
    // The native card name plus the English official equivalent are both present.
    expect(candidates.some((c) => c.aliasType === "provider-localized-name" && c.aliasText === "ニャオハ")).toBe(true);
    expect(candidates.some((c) => c.aliasType === "official-equivalent" && c.aliasText === "Sprigatito")).toBe(true);
  });

  it("does not fetch English mirrors when the source language is already English", async () => {
    const loadEnglishMirrorEntity: TcgdexEnglishMirrorLoader = vi.fn(async () => null);
    await ingestTcgdexAliasCandidates({
      profile,
      observations: [
        observation({
          languageCode: "en",
          card: { id: "sv01-001", name: "Sprigatito", category: "Pokemon", dexId: [906] },
          set: { id: "sv01", name: "Scarlet & Violet" },
          seriesId: "sv",
          seriesName: "Scarlet & Violet",
        }),
      ],
      persist: async () => undefined,
      observedAt: "2026-06-16T00:00:00.000Z",
      loadEnglishMirrorEntity,
    });

    expect(loadEnglishMirrorEntity).not.toHaveBeenCalled();
  });

  it("persists native-only candidates when the English endpoint is missing", async () => {
    const persisted: CatalogAliasCandidate[] = [];
    await ingestTcgdexAliasCandidates({
      profile,
      observations: [observation(japaneseCardPayload())],
      persist: async (c) => {
        persisted.push(...c);
      },
      observedAt: "2026-06-16T00:00:00.000Z",
      // Every mirror lookup misses (Japanese-only set).
      loadEnglishMirrorEntity: async () => null,
    });

    expect(persisted.some((c) => c.aliasLanguageCode === "en")).toBe(false);
    expect(persisted.some((c) => c.aliasType === "provider-localized-name")).toBe(true);
  });

  it("never persists an English alias sourced from the Indonesian id text", async () => {
    const persisted: CatalogAliasCandidate[] = [];
    await ingestTcgdexAliasCandidates({
      profile,
      observations: [
        observation({
          languageCode: "id",
          // Indonesian species name reads like English.
          card: { id: "sv1a-001", name: "Sprigatito", category: "Pokemon", dexId: [906] },
          set: { id: "sv1a", name: "Triplet Beat" },
          seriesId: "sv",
          seriesName: "Scarlet & Violet",
        }),
      ],
      persist: async (c) => {
        persisted.push(...c);
      },
      observedAt: "2026-06-16T00:00:00.000Z",
      loadEnglishMirrorEntity: async () => null,
    });

    // No candidate is both English-language and sourced from the localized name.
    const englishLocalized = persisted.filter(
      (c) => c.aliasLanguageCode === "en" && c.provenance.sourceCategory === "provider-localized-name",
    );
    expect(englishLocalized).toHaveLength(0);
    // The Indonesian name is recorded as Indonesian, not English.
    const localized = persisted.filter((c) => c.provenance.sourceCategory === "provider-localized-name");
    expect(localized.every((c) => c.aliasLanguageCode === "id")).toBe(true);
  });

  it("returns no candidates and skips persist for an unparseable payload", async () => {
    const persist = vi.fn(async () => undefined);
    const candidates = await ingestTcgdexAliasCandidates({
      profile,
      observations: [observation({ languageCode: "ja" })],
      persist,
      observedAt: "2026-06-16T00:00:00.000Z",
      loadEnglishMirrorEntity: async () => null,
    });

    expect(candidates).toHaveLength(0);
    expect(persist).not.toHaveBeenCalled();
  });
});
