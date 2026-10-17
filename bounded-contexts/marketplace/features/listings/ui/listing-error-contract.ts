import { t } from "@chase-sets/localization";

export const listingErrorContract = {
  "unknown-field": {
    status: 400,
    code: "listing_request_unknown_field",
    copy: "marketplace.features.listings.api.route.error.unknownField",
  },
  "price-currency-invalid": {
    status: 400,
    code: "listing_price_currency_invalid",
    copy: "marketplace.features.listings.api.route.error.priceCurrencyInvalid",
  },
  "availability-reason-invalid": {
    status: 400,
    code: "listing_availability_reason_invalid",
    copy: "marketplace.features.listings.api.route.error.availabilityReasonInvalid",
  },
  "away-window-reason-required": {
    status: 400,
    code: "away_window_reason_required",
    copy: "marketplace.features.listings.api.route.error.awayWindowReasonRequired",
  },
  "away-window-instant-required": {
    status: 400,
    code: "away_window_instant_required",
    copy: "marketplace.features.listings.api.route.error.awayWindowInstantRequired",
  },
  "order-capacity-invalid": {
    status: 400,
    code: "order_capacity_invalid",
    copy: "marketplace.features.listings.api.route.error.orderCapacityInvalid",
  },
  "photo-multipart-required": {
    status: 400,
    code: "listing_photo_multipart_required",
    copy: "marketplace.features.listings.api.route.error.photoMultipartRequired",
  },
  "photo-replacement-required": {
    status: 400,
    code: "listing_photo_replacement_required",
    copy: "marketplace.features.listings.api.route.error.photoReplacementRequired",
  },
  "id-invalid": {
    status: 400,
    code: "listing_request_id_invalid",
    copy: "marketplace.features.listings.api.route.error.idInvalid",
  },
  "inventory-snapshot-invalid": {
    status: 400,
    code: "listing_inventory_snapshot_invalid",
    copy: "marketplace.features.listings.api.route.error.inventorySnapshotInvalid",
  },
  "listing-not-found": {
    status: 404,
    code: "listing_not_found",
    copy: "marketplace.features.listings.api.route.error.listingNotFound",
  },
  "inventory-item-not-found": {
    status: 400,
    code: "inventory_item_not_found",
    copy: "marketplace.features.listings.api.route.error.inventoryItemNotFound",
  },
  "command-rejected": {
    status: 400,
    code: "listing_command_rejected",
    copy: "marketplace.features.listings.api.route.error.commandRejected",
  },
  "bulk-price-update-invalid": {
    status: 400,
    code: "bulk_price_update_invalid",
    copy: "marketplace.features.listings.api.route.error.bulkPriceUpdateInvalid",
  },
  "evidence-invalid": {
    status: 400,
    code: "listing_evidence_invalid",
    copy: "marketplace.features.listings.api.route.error.evidenceInvalid",
  },
  "listing-gate-policy-invalid": {
    status: 400,
    code: "listing_gate_policy_invalid",
    copy: "marketplace.features.listings.api.listingGatePolicyRoute.error.invalid",
  },
  "evidence-incomplete": {
    status: 409,
    code: "listing_evidence_incomplete",
    copy: "marketplace.features.listings.api.route.error.evidenceIncomplete",
  },
  "fee-quote-stale": {
    status: 409,
    code: "fee_quote_stale",
    copy: "marketplace.features.listings.api.route.error.feeQuoteStale",
  },
} as const;

export type ListingErrorCode = keyof typeof listingErrorContract;

export function listingErrorFeedback(status: number | null, code: string | null): string | null {
  const entry = Object.values(listingErrorContract).find((entry) => entry.status === status && entry.code === code);
  return entry ? t(entry.copy) : null;
}
