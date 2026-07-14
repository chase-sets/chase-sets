import { HiddenInput } from "@chase-sets/design-system";
import type { OfferMatchListItem } from "./contracts";

export function OfferMatchSellListSnapshotFields({ offer }: { offer: OfferMatchListItem }) {
  return (
    <>
      <HiddenInput type="hidden" name="offerId" value={offer.offer_id} />
      <HiddenInput type="hidden" name="listingId" value={offer.listing_id} />
      <HiddenInput type="hidden" name="buyerDisplayName" value={offer.buyer_display_name ?? ""} />
      <HiddenInput type="hidden" name="offerPriceAmount" value={offer.price_amount} />
      <HiddenInput type="hidden" name="catalogItemId" value={offer.catalog_catalog_item_id} />
      <HiddenInput type="hidden" name="productId" value={offer.product_id} />
      <HiddenInput type="hidden" name="itemTitle" value={offer.item_title} />
      <HiddenInput type="hidden" name="itemSubtitle" value={offer.item_subtitle ?? ""} />
      <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(offer.selected_options)} />
      <HiddenInput type="hidden" name="productSummary" value={offer.product_summary ?? ""} />
      <HiddenInput type="hidden" name="quantity" value={String(offer.quantity_requested)} />
    </>
  );
}
