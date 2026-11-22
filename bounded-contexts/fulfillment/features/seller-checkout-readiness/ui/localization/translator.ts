import { createTranslator } from "@chase-sets/localization/core";
import { sellerCheckoutReadinessEnglishTranslations } from "./locales/en";
import { sellerShippingSetupCheckoutCopy } from "./checkout-copy";

export const { t } = createTranslator({
  catalogs: { en: { ...sellerCheckoutReadinessEnglishTranslations, ...sellerShippingSetupCheckoutCopy } },
});
