import type { ReactNode } from "react";
import type {
  DiscoveryMarketListing,
  DiscoveryOffer,
  DiscoveryAccountOfferMatch,
} from "../../../support/client-support/contracts";
import type { MarketSelectionSource } from "../domain/item-detail-market";

export type ItemDetailMarketplaceSectionContext = Readonly<{
  itemId: string;
  selectedProductId: string | null;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedProductOptions: readonly { dimensionId: string; optionId: string }[];
  selectedProductSelectionDetails: readonly { label: string; value: string }[];
  selectedProductSummary: string | null;
  visibleListings: readonly DiscoveryMarketListing[];
  visibleOffers: readonly DiscoveryOffer[];
  visibleAccountOfferMatches: readonly DiscoveryAccountOfferMatch[];
  selectedListing: DiscoveryMarketListing | null;
  selectedOffer: DiscoveryOffer | null;
  selectedAccountOfferMatch: DiscoveryAccountOfferMatch | null;
  selectedListingSource: MarketSelectionSource;
  selectedOfferSource: MarketSelectionSource;
  staleSelectedListingId: string | null;
  staleSelectedOfferId: string | null;
  bestListing: DiscoveryMarketListing | null;
  bestOffer: DiscoveryOffer | null;
  bestAccountOfferMatch: DiscoveryAccountOfferMatch | null;
}>;

export type ItemDetailMobileCommerceSection = Readonly<{
  content: ReactNode;
  footer?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
}>;

export type ItemDetailCommerceSections = Readonly<{
  save?: ReactNode;
  buy: ReactNode;
  offer?: ReactNode;
  sell?: ReactNode;
  watch?: ReactNode;
  mobile?: Partial<Record<"buy" | "sell" | "watch", ItemDetailMobileCommerceSection>>;
  sellLabel?: string;
  watchLabel?: string;
}>;
