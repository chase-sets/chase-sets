import { describe, expect, it } from "vitest";
import {
  createTranslator,
  defaultLocale,
  resolveLocale,
  supportedLocales,
  translationCatalogs,
} from "./index";

function interpolationTokens(value: string) {
  return [...value.matchAll(/\{([A-Za-z0-9_.-]+)\}/g)]
    .map((match) => match[1])
    .sort();
}

describe("localization", () => {
  it("uses English as the launch locale", () => {
    expect(defaultLocale).toBe("en");
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("fr")).toBe("en");
  });

  it("interpolates named values", () => {
    const translator = createTranslator();

    expect(
      translator.t("localization.testGreeting", { name: "Ada" }),
    ).toBe("Hello, Ada.");
  });

  it("reports missing translations", () => {
    const missing: string[] = [];
    const translator = createTranslator({
      onMissingTranslation: ({ key }) => missing.push(key),
    });

    expect(translator.t("missing.key")).toBe("[missing:en:missing.key]");
    expect(missing).toEqual(["missing.key"]);
  });

  it("keeps every supported locale key-complete with English", () => {
    const englishKeys = Object.keys(translationCatalogs.en).sort();

    for (const locale of supportedLocales) {
      expect(Object.keys(translationCatalogs[locale]).sort()).toEqual(
        englishKeys,
      );
    }
  });

  it("keeps interpolation tokens aligned with English", () => {
    const englishCatalog = translationCatalogs.en;

    for (const locale of supportedLocales) {
      const catalog = translationCatalogs[locale];

      for (const key of Object.keys(englishCatalog)) {
        expect(interpolationTokens(catalog[key]), `${locale}:${key}`).toEqual(
          interpolationTokens(englishCatalog[key]),
        );
      }
    }
  });
});
