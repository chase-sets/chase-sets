import type { MarketplaceListingEvidenceCoverage } from "../../../support/request-support/marketplace-listing-evidence";

export type SellListOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  terms: SellListTermsPreview | null;
  comparison: SellListOfferTermsComparison | null;
  message: string | null;
  evidence?: MarketplaceListingEvidenceCoverage | null;
}>;

export type SellListOfferTermsComparisonField =
  | "seller-net"
  | "marketplace-fee"
  | "shipping-allowance"
  | "terms-source";

export type SellListOfferTermsComparison = Readonly<{
  status: "same" | "changed" | "standard-preview-unavailable" | "final-unavailable";
  standardPreview: SellListTermsPreview | null;
  changedFields: readonly SellListOfferTermsComparisonField[];
}>;

export type SellListTermsPreview = Readonly<{
  account_type?: string;
  basis_amount: string;
  marketplace_sales_fee_unit_amount: string;
  seller_net_unit_amount: string;
  shipping_allowance_percentage_bps: number;
  fee_quote_fingerprint?: string;
  resolved_at?: string;
  source_kind?: "public-standard-seller-terms";
  source_label?: string;
  source_updated_at?: string;
  schedule_label?: string;
  schedule_id?: string | null;
  agreement_id?: string | null;
}>;

export type SellListProductOfferReview = Readonly<{
  lineId: string;
  status: "ready" | "unavailable";
  offers: readonly Readonly<{
    offer: Readonly<{
      offer_id: string;
      buyer_display_name: string | null;
      buyer_account_id: string;
      price_amount: string;
      quantity_requested: number;
      offer_to_listing_price_bps: number;
      buyer_average_rating?: string | null;
      buyer_review_count?: number;
      seller_available_quantity?: number;
      can_fulfill?: boolean;
      created_at?: string;
    }>;
    terms: Readonly<{
      marketplace_sales_fee_unit_amount: string;
      seller_net_unit_amount: string;
      fee_quote_fingerprint: string;
    }>;
    evidence?: MarketplaceListingEvidenceCoverage | null;
  }>[];
  message: string | null;
}>;

export type PayoutReadiness = Readonly<{
  status: "not-started" | "pending" | "ready" | "restricted";
  missing_requirements: readonly string[];
}>;

export type SellListInventoryItem = Readonly<{
  item_id: string;
  product_id: string;
  item_title: string | null;
  product_summary: string | null;
  storage_location_name: string;
  ship_from_code: string;
  available_quantity: number;
}>;

export type LineReadiness = Readonly<{
  ready: boolean;
  label: string;
  detail: string;
  tone: "success" | "warning";
}>;

export type SellListRecoveryState = Readonly<
  | {
      kind: "pending-fresh-write";
      message: string;
      refreshHref: string;
      isAutoRevalidating?: boolean;
    }
  | {
      kind: "missing-after-fresh-write";
      message: string;
      refreshHref: string;
    }
>;
