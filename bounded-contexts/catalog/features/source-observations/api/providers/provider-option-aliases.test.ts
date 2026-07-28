import { describe, expect, it } from "vitest";
import { matchTcgdexEnglishEndpointEntity } from "./tcgdex-alias-extraction";
import {
  buildEnglishEndpointOptionAlias,
  optionDisplayLabelFromAliases,
  parseProviderOptionAliasesFromJson,
  selectDisplayEnglishAlias,
  type OptionAliasShape,
} from "./provider-option-aliases";

describe("provider option aliases", () => {
  describe("buildEnglishEndpointOptionAlias", () => {
    it("wraps a same-id English match in the shared alias vocabulary, held for review", () => {
      // The alignment decision comes from the #1906 reusable matcher; the builder
      // only types the result. This proves the two compose without duplication.
      const englishName = matchTcgdexEnglishEndpointEntity({
        sourceId: "SV8",
        englishEntity: { id: "SV8", name: "Surging Sparks" },
      });
      const alias = buildEnglishEndpointOptionAlias({
        englishName,
        aliasType: "set-equivalent",
        sourceLanguageCode: "ja",
        providerId: "SV8",
        evidenceKind: "set-id",
      });

      expect(alias).toEqual({
        aliasText: "Surging Sparks",
        aliasLanguageCode: "en",
        aliasType: "set-equivalent",
        confidence: "high",
        // The same-id endpoint is strong evidence but never auto-accepted without
        // recorded legal/source approval, so it is held pending review.
        reviewStatus: "pending",
        sourceCategory: "provider-same-id-localized-endpoint",
        evidence: expect.objectContaining({
          providerId: "SV8",
          sharedProviderId: "SV8",
          evidenceKind: "set-id",
          sourceLanguageCode: "ja",
          englishEndpointLanguageCode: "en",
        }),
      });
    });

    it("returns null when there is no English match", () => {
      const englishName = matchTcgdexEnglishEndpointEntity({
        sourceId: "SV8",
        englishEntity: { id: "different-id", name: "Surging Sparks" },
      });
      expect(
        buildEnglishEndpointOptionAlias({
          englishName,
          aliasType: "set-equivalent",
          sourceLanguageCode: "ja",
          providerId: "SV8",
          evidenceKind: "set-id",
        }),
      ).toBeNull();
    });

    it("rejects an alias type the source category cannot produce", () => {
      expect(() =>
        buildEnglishEndpointOptionAlias({
          englishName: "Pikachu",
          aliasType: "species-name",
          sourceLanguageCode: "ja",
          providerId: "x",
          evidenceKind: "card-id",
        }),
      ).toThrow(/cannot produce/);
    });
  });

  describe("selectDisplayEnglishAlias", () => {
    const high: OptionAliasShape = {
      aliasText: "Surging Sparks",
      aliasLanguageCode: "en",
      confidence: "high",
      reviewStatus: "pending",
    };
    const candidate: OptionAliasShape = {
      aliasText: "Maybe Sparks",
      aliasLanguageCode: "en",
      confidence: "candidate",
      reviewStatus: "pending",
    };

    it("prefers an accepted alias over a pending high-confidence one", () => {
      const accepted: OptionAliasShape = {
        aliasText: "Accepted Sparks",
        aliasLanguageCode: "en",
        confidence: "candidate",
        reviewStatus: "accepted",
      };
      expect(selectDisplayEnglishAlias([high, accepted])?.aliasText).toBe("Accepted Sparks");
    });

    it("falls back to a high-confidence pending English alias", () => {
      expect(selectDisplayEnglishAlias([candidate, high])?.aliasText).toBe("Surging Sparks");
    });

    it("ignores low-confidence pending evidence and non-English aliases", () => {
      const french: OptionAliasShape = {
        aliasText: "Étincelles Déferlantes",
        aliasLanguageCode: "fr",
        confidence: "high",
        reviewStatus: "pending",
      };
      expect(selectDisplayEnglishAlias([candidate, french])).toBeNull();
    });
  });

  describe("optionDisplayLabelFromAliases", () => {
    it("renders English alias (native name) when a trustworthy English alias exists", () => {
      expect(
        optionDisplayLabelFromAliases({
          value: "SV8",
          nativeLabel: "超電ブレイカー",
          aliases: [
            { aliasText: "Surging Sparks", aliasLanguageCode: "en", confidence: "high", reviewStatus: "pending" },
          ],
        }),
      ).toBe("Surging Sparks (超電ブレイカー)");
    });

    it("returns the native label when no trustworthy English alias exists", () => {
      expect(optionDisplayLabelFromAliases({ value: "SV8", nativeLabel: "超電ブレイカー", aliases: [] })).toBe(
        "超電ブレイカー",
      );
    });

    it("falls back to the provider id when there is no native label", () => {
      expect(optionDisplayLabelFromAliases({ value: "SV8", nativeLabel: null, aliases: null })).toBe("SV8");
    });

    it("does not duplicate when the English alias equals the native label", () => {
      expect(
        optionDisplayLabelFromAliases({
          value: "sv",
          nativeLabel: "Scarlet & Violet",
          aliases: [
            { aliasText: "Scarlet & Violet", aliasLanguageCode: "en", confidence: "high", reviewStatus: "accepted" },
          ],
        }),
      ).toBe("Scarlet & Violet");
    });
  });

  describe("parseProviderOptionAliasesFromJson", () => {
    it("parses well-formed alias records and drops malformed entries", () => {
      const parsed = parseProviderOptionAliasesFromJson([
        {
          aliasText: "Surging Sparks",
          aliasLanguageCode: "en",
          aliasType: "set-equivalent",
          confidence: "high",
          reviewStatus: "pending",
          sourceCategory: "provider-same-id-localized-endpoint",
          evidence: { providerId: "SV8" },
        },
        { aliasText: "missing-fields" },
        "not-an-object",
      ]);

      expect(parsed).toEqual([
        {
          aliasText: "Surging Sparks",
          aliasLanguageCode: "en",
          aliasType: "set-equivalent",
          confidence: "high",
          reviewStatus: "pending",
          sourceCategory: "provider-same-id-localized-endpoint",
          evidence: { providerId: "SV8" },
        },
      ]);
    });

    it("returns an empty list for non-array input", () => {
      expect(parseProviderOptionAliasesFromJson(undefined)).toEqual([]);
      expect(parseProviderOptionAliasesFromJson({} as never)).toEqual([]);
    });
  });
});
