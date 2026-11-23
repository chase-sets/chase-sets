import { t as compatibilityTranslate } from "@chase-sets/localization";
import { createTranslator } from "@chase-sets/localization/core";
import { expect, it } from "vitest";
import { surveyDefinitionRegistry } from "../../domain/survey";
import { csatEnglishTranslations } from "./locales/en";

it("covers every versioned survey question, anchor and rating label in the compatibility catalog", () => {
  const { t } = createTranslator({ catalogs: { en: csatEnglishTranslations } });
  const keys = new Set(
    surveyDefinitionRegistry.flatMap(({ questionCopyKey, ratingScale }) => [
      questionCopyKey,
      ...Object.values(ratingScale.anchors),
      ...Object.values(ratingScale.valueLabelKeys),
    ]),
  );
  expect([...keys].sort()).toEqual(Object.keys(csatEnglishTranslations).sort());
  for (const key of keys) {
    expect(t(key)).not.toContain("[missing:");
    expect(t(key)).toBe(compatibilityTranslate(key));
  }
});
