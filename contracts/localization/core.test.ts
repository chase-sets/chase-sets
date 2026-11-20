import { describe, expect, it, vi } from "vitest";
import {
  createTranslator,
  coerceLocalizedTextMap,
  formatDate,
  formatDateTime,
  formatBpsPercent,
  formatMoney,
  formatDisplayIdentity,
  formatLanguageCodeLabel,
  normalizeLocaleCode,
  resolveLocalizedTextMap,
  resolveLocale,
} from "@chase-sets/localization/core";

vi.mock("./index", () => {
  throw new Error("Core must not load the root facade");
});
vi.mock("./locales/en", () => {
  throw new Error("Core must not load a catalog");
});

describe("catalog-independent localization core", () => {
  it("loads the real core export without root or catalogs and composes owner-local copy", () => {
    const catalog = { "owner.greeting": "Hello, {name}: {count}, {enabled}; {nil}, {absent}, {unknown}." };
    const translator = createTranslator({ catalogs: { en: catalog } });
    expect(
      translator.t("owner.greeting", { name: "Ada", count: 2, enabled: false, nil: null, absent: undefined }),
    ).toBe("Hello, Ada: 2, false; {nil}, {absent}, {unknown}.");
    expect(translator.has("owner.greeting")).toBe(true);
    expect(translator.has("localization.testGreeting")).toBe(false);
    expect(translator.has("toString")).toBe(false);
    expect(translator.t("toString")).toBe("[missing:en:toString]");
    catalog["owner.greeting"] = "Changed";
    expect(translator.t("owner.greeting")).toContain("Hello,");
    expect(Object.isFrozen(translator)).toBe(true);
  });

  it.each([{}, { en: {} }])("handles empty and absent locale catalogs with missing behavior: %j", (catalogs) => {
    const missing = vi.fn();
    const translator = createTranslator({ catalogs, locale: "fr", onMissingTranslation: missing });
    expect(translator.locale).toBe("en");
    expect(translator.has("absent")).toBe(false);
    expect(missing).not.toHaveBeenCalled();
    expect(translator.t("absent")).toBe("[missing:en:absent]");
    expect(missing).toHaveBeenCalledExactlyOnceWith({ locale: "en", key: "absent" });
  });

  it("preserves normalization, localized text fallback and supplied-copy helpers", () => {
    expect(resolveLocale(null)).toBe("en");
    expect(normalizeLocaleCode("JA-jp")).toBe("ja-JP");
    expect(() => normalizeLocaleCode("jp")).toThrow("ja");
    expect(resolveLocalizedTextMap(coerceLocalizedTextMap(" Title "), "fr")).toBe("Title");
    const t = createTranslator({
      catalogs: {
        en: {
          "localization.displayIdentity.title.and.subtitle": "{title} / {subtitle}",
          "localization.displayIdentity.title": "{title}",
          "localization.languageCode.en": "Owner English",
        },
      },
    }).t;
    expect(formatDisplayIdentity(" Title ", " Detail ", t)).toBe("Title / Detail");
    expect(formatDisplayIdentity(null, " Detail ", t)).toBe("Detail");
    expect(formatLanguageCodeLabel("en", t)).toBe("Owner English");
    expect(formatLanguageCodeLabel("fr", t)).toBe("fr");
    expect(formatLanguageCodeLabel(null, t)).toBe("");
  });

  it("keeps browser-safe formatters available without catalogs", () => {
    expect(formatMoney("12.34", "USD")).toBe("$12.34");
    expect(formatDate("2026-01-02T00:00:00Z")).toBe("Jan 2, 2026");
    expect(formatDateTime("2026-01-02T00:00:00Z")).toContain("Jan 2, 2026");
    expect(formatBpsPercent(125)).toBe("1.25%");
  });
});
