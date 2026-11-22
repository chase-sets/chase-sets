import { checkoutEnglishTranslations } from "@chase-sets/localization/locales/en/checkout";

// Temporary data-only bridge until the deployable supplies the Checkout copy.
const prepaid = "checkout.features.sellList.ui.guestSellCheckoutPage.label.prepaid";
const later = "checkout.features.sellList.ui.guestSellCheckoutPage.label.later";

export const sellerShippingSetupCheckoutCopy = {
  [prepaid]: checkoutEnglishTranslations[prepaid],
  [later]: checkoutEnglishTranslations[later],
};
