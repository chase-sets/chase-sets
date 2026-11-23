import { t as legacyTranslate } from "@chase-sets/localization";
import { describe, expect, it } from "vitest";
import { notificationCenterEnglishTranslations } from "./locales/en";
import { t } from "./translator";

describe("notification center localization", () => {
  it("resolves every owned key as the compatibility translator does", () => {
    for (const [key, template] of Object.entries(notificationCenterEnglishTranslations)) {
      expect(t(key), key).toBe(template);
      expect(legacyTranslate(key), key).toBe(template);
    }
  });
});
