import { t } from "@chase-sets/localization";

export function inventoryCapacityRecoveryAction(block: string): string {
  switch (block) {
    case "evidence-incomplete":
      return t("marketplace.features.listings.capacityRecovery.evidence");
    case "seller-away":
      return t("marketplace.features.listings.capacityRecovery.away");
    case "native-visibility-disabled":
      return t("marketplace.features.listings.capacityRecovery.visibility");
    case "shipping-measure-missing":
      return t("marketplace.features.listings.capacityRecovery.measure");
    case "price-incomplete":
      return t("marketplace.features.listings.capacityRecovery.price");
    default:
      return t("marketplace.features.listings.capacityRecovery.unavailable");
  }
}
