import { t } from "@chase-sets/localization";
import { LinkButton, Text } from "@chase-sets/design-system";
import type { InventoryOfferMatchListItem } from "./contracts";

function inventoryMatchCoversOffer(offer: InventoryOfferMatchListItem) {
  return offer.inventory_available_quantity >= offer.quantity_requested;
}

/** The new-Listing form prefilled with the inventory item and the Offer's unit price. */
function inventoryMatchListingHref(offer: InventoryOfferMatchListItem) {
  const search = new URLSearchParams({
    inventoryItemId: offer.inventory_item_id,
    recommendedPrice: offer.price_amount,
  });
  return `/account/listings/new?${search.toString()}`;
}

export function InventoryOfferMatchAction({ offer, size }: { offer: InventoryOfferMatchListItem; size?: "sm" }) {
  if (offer.status !== "submitted") return null;
  if (!inventoryMatchCoversOffer(offer)) {
    return (
      <Text size="sm" tone="secondary">
        {t("marketplace.features.offers.ui.matchSource.not.enough.stock")}
      </Text>
    );
  }
  return (
    <LinkButton href={inventoryMatchListingHref(offer)} size={size}>
      {t("marketplace.features.offers.ui.matchSource.list.to.fill.offer")}
    </LinkButton>
  );
}
