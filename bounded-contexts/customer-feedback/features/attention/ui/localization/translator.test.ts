import { t as compatibilityTranslate } from "@chase-sets/localization";
import { expect, it } from "vitest";
import { feedbackAttentionEnglishTranslations } from "./locales/en";
import { t } from "./translator";

it("keeps owner and compatibility translations equal, including interpolated tokens", () => {
  const variables = { caseId: "fbcase_test", count: 2 };
  for (const key of Object.keys(feedbackAttentionEnglishTranslations)) {
    expect(t(key, variables)).toBe(compatibilityTranslate(key, variables));
  }
  expect(t("customer-feedback.attention.caseFocus", variables)).toBe("Showing attention for case fbcase_test.");
  expect(t("customer-feedback.attention.duration.hours", variables)).toBe("2 hours");
  expect(t("customer-feedback.attention.missing")).toBe("[missing:en:customer-feedback.attention.missing]");
});
