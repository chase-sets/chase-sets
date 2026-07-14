import { adminWebEnglishTranslations } from "./en/admin-web";
import { authEnglishTranslations } from "./en/auth";
import { authenticityEnglishTranslations } from "./en/authenticity";
import { catalogEnglishTranslations } from "./en/catalog";
import { fulfillmentEnglishTranslations } from "./en/fulfillment";
import { orderingEnglishTranslations } from "./en/ordering";
import { checkoutEnglishTranslations } from "./en/checkout";
import { commercialTermsEnglishTranslations } from "./en/commercial-terms";
import { collectionsEnglishTranslations } from "./en/collections";
import { customerFeedbackEnglishTranslations } from "./en/customer-feedback";
import { discoveryEnglishTranslations } from "./en/discovery";
import { identityEnglishTranslations } from "./en/identity";
import { inventoryEnglishTranslations } from "./en/inventory";
import { localizationEnglishTranslations } from "./en/localization";
import { marketplaceEnglishTranslations } from "./en/marketplace";
import { notificationsEnglishTranslations } from "./en/notifications";
import { paymentsEnglishTranslations } from "./en/payments";
import { pricingEnglishTranslations } from "./en/pricing";
import { reputationEnglishTranslations } from "./en/reputation";
import { settlementEnglishTranslations } from "./en/settlement";
import { platformOperationsEnglishTranslations } from "./en/platform-operations";
import { experienceEnglishTranslations } from "./en/experience";
import { publicPresenceEnglishTranslations } from "./en/public-presence";
import { supportEnglishTranslations } from "./en/support";

export const englishTranslations = {
  ...adminWebEnglishTranslations,
  ...authEnglishTranslations,
  ...authenticityEnglishTranslations,
  ...catalogEnglishTranslations,
  ...fulfillmentEnglishTranslations,
  ...orderingEnglishTranslations,
  ...checkoutEnglishTranslations,
  ...commercialTermsEnglishTranslations,
  ...collectionsEnglishTranslations,
  ...customerFeedbackEnglishTranslations,
  ...discoveryEnglishTranslations,
  ...identityEnglishTranslations,
  ...inventoryEnglishTranslations,
  ...localizationEnglishTranslations,
  ...marketplaceEnglishTranslations,
  ...notificationsEnglishTranslations,
  ...paymentsEnglishTranslations,
  ...pricingEnglishTranslations,
  ...reputationEnglishTranslations,
  ...settlementEnglishTranslations,
  ...platformOperationsEnglishTranslations,
  ...experienceEnglishTranslations,
  ...publicPresenceEnglishTranslations,
  ...supportEnglishTranslations,
} as const;

export type EnglishTranslationKey = keyof typeof englishTranslations;
