import { vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { CheckoutSellerCheckoutOwners, SellerCheckoutRiskResult } from "../../../api";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createCheckoutSellListRuntime } from "./runtime";
import type { CheckoutCommercialTermsResolver, CheckoutSellListLineRow } from "../read-model/queries";

export const stamp = "2026-11-06T01:02:03.000Z";
export const origin = {
  name: "Synthetic Seller",
  line1: "1 Main St",
  line2: null,
  city: "Wichita",
  state: "KS",
  postalCode: "67202",
  country: "US",
};
export const choices = { shipFrom: origin, label: { preference: "prepaid-label" as const } };
export const ownedAbsentRisk = {
  schemaVersion: "settlement.seller-checkout-risk.v1",
  policyRevision: "seller-checkout-risk-v1",
  rowState: "absent",
  status: "clear",
  reasonCode: null,
  sourceRevision: 0,
  sourceTimestamp: null,
} as const satisfies SellerCheckoutRiskResult;
export const fixtureLine: CheckoutSellListLineRow = {
  seller_account_id: "acc_seller",
  line_id: "sll_fixture",
  line_type: "selected-offer",
  offer_id: "off_fixture",
  listing_id: "lst_fixture",
  buyer_account_id: "acc_buyer",
  buyer_display_name: "Synthetic Buyer",
  offer_price_amount: "10.00",
  offer_price_currency_code: "USD",
  offer_stream_version: 1,
  listing_price_amount: "10.00",
  listing_price_currency_code: "USD",
  listing_stream_version: 1,
  catalog_catalog_item_id: "cat_fixture",
  product_id: "cat_fixture::raw",
  item_title: "Synthetic Item",
  item_subtitle: null,
  selected_options: [],
  product_summary: null,
  quantity: 1,
  fallback_mode: "none",
  minimum_listing_price_amount: null,
  created_at: stamp,
  updated_at: stamp,
};

export function ownerPortsFixture() {
  const ports = {
    readRisk: vi.fn<CheckoutSellerCheckoutOwners["readRisk"]>().mockResolvedValue(ownedAbsentRisk),
    resolveOrigin: vi.fn<CheckoutSellerCheckoutOwners["resolveOrigin"]>().mockImplementation(async (owner, input) => {
      const setup = input as { origin?: unknown; labelPreference?: unknown };
      if (JSON.stringify(setup.origin) !== JSON.stringify(origin) || setup.labelPreference !== "prepaid-label")
        return { status: "blocked", fact: "conflicting" };
      return {
        status: "accepted",
        key: { owner, shipFromLocationId: "sfl_fixture", labelPreference: "prepaid-label" },
        sourceRevision: 2,
        sourceTimestamp: stamp as never,
      };
    }),
    readFulfillment: vi.fn<CheckoutSellerCheckoutOwners["readFulfillment"]>().mockResolvedValue({
      schemaVersion: "fulfillment.seller-checkout-readiness.v1",
      sourceRevision: 2,
      sourceTimestamp: stamp as never,
      label: { status: "ready", reason: "ready" },
      provider: { status: "ready", reason: "ready" },
    }),
    invalidateAnonymousOwner: vi
      .fn<CheckoutSellerCheckoutOwners["invalidateAnonymousOwner"]>()
      .mockResolvedValue({ revision: 3, recordedAt: stamp as never }),
  } satisfies CheckoutSellerCheckoutOwners;
  return ports;
}

export function checkoutOwnerRuntimeFixture(ownerId = "acc_seller") {
  const ports = ownerPortsFixture();
  const memory = createInMemoryEventStore();
  let lines: readonly CheckoutSellListLineRow[] = [{ ...fixtureLine, seller_account_id: ownerId }];
  let payoutStatus = "ready";
  let payoutTimestamp: unknown = stamp;
  let offerAvailable = true;
  let listingEvidence: {
    listing_id: string;
    status: string;
    evidence_requirements: {
      policyHash: string;
      policyVersion: number;
      requirements: { requiredSlots: []; minimumPhotoCount: number; sellerTrustRequirements: [] };
    };
    evidence: [];
    updated_at: string;
  } | null = {
    listing_id: "lst_fixture",
    status: "active",
    evidence_requirements: {
      policyHash: "synthetic_policy",
      policyVersion: 1,
      requirements: { requiredSlots: [], minimumPhotoCount: 0, sellerTrustRequirements: [] },
    },
    evidence: [],
    updated_at: stamp,
  };
  const address = {
    shipping_address_id: "adr_fixture",
    account_id: ownerId,
    recipient_name: origin.name,
    line1: origin.line1,
    line2: null,
    city: origin.city,
    state: origin.state,
    postal_code: origin.postalCode,
    country: origin.country,
  };
  const db = {
    query: vi.fn(async (query: unknown, args?: readonly unknown[]) => {
      const sql = String(query);
      if (sql.includes("checkout_sell_list_confirmation_pages")) return { rows: [] };
      if (sql.includes("checkout_sell_payout_readiness_pages"))
        return {
          rows: [{ account_id: ownerId, status: payoutStatus, missing_requirements: [], updated_at: payoutTimestamp }],
        };
      if (sql.includes("checkout_ship_from_addresses")) return { rows: [address] };
      if (sql.includes("checkout_sell_list_line_pages"))
        return { rows: lines.filter((row) => row.seller_account_id === args?.[0]) };
      if (sql.includes("checkout_marketplace_seller_options") && !sql.includes("checkout_sell_offer_pages"))
        return { rows: listingEvidence ? [listingEvidence] : [] };
      if (sql.includes("checkout_sell_offer_pages") && offerAvailable)
        return {
          rows: [
            {
              offer_id: "off_fixture",
              buyer_account_id: "acc_buyer",
              catalog_catalog_item_id: "cat_fixture",
              product_id: "cat_fixture::raw",
              selected_options: [],
              price_amount: "10.00",
              price_currency_code: "USD",
              last_stream_version: 1,
              quantity_requested: 1,
              status: "submitted",
              listing_id: "lst_fixture",
              listing_price_amount: "10.00",
              listing_price_currency_code: "USD",
              listing_stream_version: 1,
              listing_quantity_cap: 1,
              listing_visible_quantity: 1,
              seller_available_quantity: 1,
              seller_listing_availability_status: "available",
              created_at: stamp,
              updated_at: stamp,
            },
          ],
        };
      return { rows: [] };
    }),
  };
  const checkpointStore: ProjectionCheckpointStore = {
    loadCheckpoint: async () => ZERO_GLOBAL_POSITION,
    saveCheckpoint: async () => {},
  };
  const quote = (amount: string) => ({
    accountType: "personal" as const,
    basisAmount: amount,
    marketplaceSalesFeeUnitAmount: "0.00",
    sellerNetUnitAmount: amount,
    shippingAllowancePercentageBps: 0,
    scheduleId: "terms_synthetic",
    agreementId: null,
    resolvedAt: stamp,
    scheduleLabel: "Synthetic terms",
    scheduleUpdatedAt: stamp,
  });
  const commercialTermsResolver: CheckoutCommercialTermsResolver = {
    resolveListingTerms: async ({ amount }) => quote(amount),
    resolvePublicStandardListingTerms: async ({ amount }) => quote(amount),
  };
  const deps = {
    eventStore: memory.eventStore,
    checkpointStore,
    db: db as never,
    sellerCheckoutOwners: ports,
    commercialTermsResolver,
  };
  const services = createCheckoutSellListRuntime(deps);
  return {
    services,
    ports,
    memory,
    db,
    address,
    deps,
    setLines: (value: typeof lines) => {
      lines = value;
    },
    setPayout: (status: string, timestamp: unknown = stamp) => {
      payoutStatus = status;
      payoutTimestamp = timestamp;
    },
    setOfferAvailable: (value: boolean) => {
      offerAvailable = value;
    },
    getListingEvidence: () => listingEvidence,
    setListingEvidence: (value: typeof listingEvidence) => {
      listingEvidence = value;
    },
  };
}
