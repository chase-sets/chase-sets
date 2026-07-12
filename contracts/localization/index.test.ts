import { describe, expect, it } from "vitest";
import {
  createTranslator,
  coerceLocalizedTextMap,
  defaultLocale,
  formatDisplayIdentity,
  formatLanguageCodeLabel,
  normalizeLocaleCode,
  normalizeLocalizedTextMap,
  resolveLocalizedTextMap,
  resolveLocale,
  supportedLocales,
  translationCatalogs,
} from "./index";

function interpolationTokens(value: string) {
  return [...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)].map((match) => match[1]).sort();
}

describe("localization", () => {
  it("uses English as the launch locale", () => {
    expect(defaultLocale).toBe("en");
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("fr")).toBe("en");
  });

  it("interpolates named values", () => {
    const translator = createTranslator();

    expect(translator.t("localization.testGreeting", { name: "Ada" })).toBe("Hello, Ada.");
  });

  it("reports missing translations", () => {
    const missing: string[] = [];
    const translator = createTranslator({
      onMissingTranslation: ({ key }) => missing.push(key),
    });

    expect(translator.t("missing.key")).toBe("[missing:en:missing.key]");
    expect(missing).toEqual(["missing.key"]);
  });

  it("resolves localized text maps with English fallback", () => {
    const text = coerceLocalizedTextMap({
      defaultLocale: "en",
      values: {
        en: "Charizard",
        ja: "リザードン",
      },
    });

    expect(resolveLocalizedTextMap(text, "ja")).toBe("リザードン");
    expect(resolveLocalizedTextMap(text, "fr")).toBe("Charizard");
  });

  it("normalizes BCP 47 locale codes and rejects jp", () => {
    expect(normalizeLocaleCode("JA-jp")).toBe("ja-JP");
    expect(() => normalizeLocaleCode("jp")).toThrow('Use the BCP 47 language code "ja" for Japanese.');
  });

  it("formats visible language code labels with code fallback", () => {
    expect(formatLanguageCodeLabel("en")).toBe("English");
    expect(formatLanguageCodeLabel("ja")).toBe("Japanese");
    expect(formatLanguageCodeLabel("fr")).toBe("fr");
    expect(formatLanguageCodeLabel(null)).toBe("");
  });

  it("formats display identities with a localized subtitle and title fallback", () => {
    expect(formatDisplayIdentity(" Bulbasaur 133/132 ", " Mega Evolution, Reverse Holo Rare ")).toBe(
      "Bulbasaur 133/132 — Mega Evolution, Reverse Holo Rare",
    );
    expect(formatDisplayIdentity("Bulbasaur 133/132", "  ")).toBe("Bulbasaur 133/132");
    expect(formatDisplayIdentity(null, "Reverse Holo Rare")).toBe("Reverse Holo Rare");
  });

  it("normalizes localized text maps and can require English", () => {
    expect(
      normalizeLocalizedTextMap({
        defaultLocale: "en",
        values: {
          "JA-jp": " リザードン ",
          en: " Charizard ",
        },
      }),
    ).toEqual({
      defaultLocale: "en",
      values: {
        en: "Charizard",
        "ja-JP": "リザードン",
      },
    });
    expect(() =>
      normalizeLocalizedTextMap({ defaultLocale: "en", values: { ja: "リザードン" } }, { requiredEnglish: true }),
    ).toThrow("Localized text maps require an English value.");
  });

  it("keeps every supported locale key-complete with English", () => {
    const englishKeys = Object.keys(translationCatalogs.en).sort();

    for (const locale of supportedLocales) {
      expect(Object.keys(translationCatalogs[locale]).sort()).toEqual(englishKeys);
    }
  });

  it("keeps interpolation tokens aligned with English", () => {
    const englishCatalog = translationCatalogs.en;

    for (const locale of supportedLocales) {
      const catalog = translationCatalogs[locale];

      for (const key of Object.keys(englishCatalog)) {
        expect(interpolationTokens(catalog[key]), `${locale}:${key}`).toEqual(interpolationTokens(englishCatalog[key]));
      }
    }
  });
});
