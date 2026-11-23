import { t as legacyTranslate } from "@chase-sets/localization";
import { expect, it } from "vitest";
import { savedListAdditionEnglishTranslations } from "./locales/en";
import { t } from "./translator";

it("keeps Add to List copy and interpolation compatible with legacy readers", () => {
  const values = { product: "Red dragon", lines: 2, quantity: 4, list: "Favorites" };
  for (const key of Object.keys(savedListAdditionEnglishTranslations)) {
    expect(t(key, values)).toBe(legacyTranslate(key, values));
  }
  expect(t("collections.features.savedLists.ui.addToList.list.summary", values)).toBe("2 lines · 4 tracked");
});
