import {
  bindInventoryDraftListingConsumer,
  type InventoryDraftListingConsumer,
  type MarketplaceServices,
} from "@chase-sets/marketplace/server";

export function createPlatformApiInventoryDraftListingConsumer(
  services: () => Pick<MarketplaceServices, "inventoryDraftListingConsumer"> | undefined,
): InventoryDraftListingConsumer {
  return bindInventoryDraftListingConsumer(() => services()?.inventoryDraftListingConsumer);
}
