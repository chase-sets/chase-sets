import { vi } from "vitest";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { type ProductMeasureSnapshot } from "@chase-sets/product-measures";
import { createOrderingOrderRuntime } from "./runtime";
import type { OrderingInventoryCleanupAuthorityCapability } from "./cleanup-authority";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";

export function createCheckpointStore(): ProjectionCheckpointStore {
  const checkpoints = new Map<string, GlobalPosition>();

  return {
    loadCheckpoint: async (projectorName) => checkpoints.get(projectorName) ?? ZERO_GLOBAL_POSITION,
    saveCheckpoint: async (projectorName, checkpoint) => {
      checkpoints.set(projectorName, checkpoint);
    },
  };
}

export const context = {
  tenantId: "tnt_test" as TenantId,
  audit: {
    performedByUserId: "usr_test" as UserId,
    forAccountId: "acc_buyer" as AccountId,
  },
};

/**
 * Test constructor for suites that are not about cleanup authority.
 *
 * The production dependency stays nonoptional: this harness states the
 * `not-mounted` variant explicitly for suites that never observe cleanup
 * authority, and cleanup-authority suites pass their own `available`
 * capability. No caller ever leaves the port undefined.
 */
export function createOrderingOrderRuntimeForTest(
  deps: Omit<Parameters<typeof createOrderingOrderRuntime>[0], "inventoryCleanupAuthority"> &
    Readonly<{ carts?: unknown; inventoryCleanupAuthority?: OrderingInventoryCleanupAuthorityCapability }>,
) {
  return createOrderingOrderRuntime({
    ...deps,
    inventoryCleanupAuthority: deps.inventoryCleanupAuthority ?? { kind: "not-mounted" },
  });
}

export const shippingAddress = {
  name: "Jane Smith",
  company: null,
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: null,
  email: "jane@example.com",
} as const;

export const shipFromAddress = {
  name: "Seller Shipping",
  company: "Chase Sets",
  line1: "1 Warehouse Way",
  line2: null,
  city: "Austin",
  state: "TX",
  postalCode: "78701",
  country: "US",
  phone: "5125550100",
  email: "shipping@example.com",
} as const;

export const taxSnapshot = {
  taxableAmount: "24.99",
  salesTaxAmount: "0.00",
  jurisdictionCountry: "US",
  jurisdictionState: "IL",
  rateBps: 0,
  providerName: "local-tax-stub",
  providerQuoteReference: null,
  quotedAt: "2026-03-31T00:00:00.000Z",
} as const;

export type SupplyCandidate = Readonly<{
  listingId: string;
  sellerAccountId: string;
  inventoryItemId: string;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly unknown[];
  productSummary: string | null;
  storageLocationName: string | null;
  shipFromCode: string | null;
  shipFromAddress?: typeof shipFromAddress;
  priceAmount: string;
  marketplaceSalesFeeUnitAmount?: string;
  sellerNetUnitAmount?: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId?: string | null;
  termsAgreementId?: string | null;
  termsResolvedAt?: string;
  feeLocks?: readonly Readonly<{
    unitCount: number;
    terms: Readonly<{
      shippingAllowancePercentageBps: number;
      termsScheduleId: string | null;
      termsAgreementId: string | null;
      termsResolvedAt: string;
    }>;
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
  }>[];
  availableQuantity: number;
  maxUnitsPerOrder?: number | null;
  maxUnitsPerDay?: number | null;
  maxUnitsPerCustomerAccount?: number | null;
  productMeasureSnapshot?: ProductMeasureSnapshot | null;
  updatedAt: string;
}>;

export function productMeasureForCandidate(candidate: SupplyCandidate): ProductMeasureSnapshot {
  return {
    catalogItemId: candidate.catalogItemId,
    productId: candidate.productId,
    selectedOptions: [],
    measureVersion: "test-raw-card-v1",
    unitLengthInches: 3.5,
    unitWidthInches: 2.5,
    unitHeightInches: 0.012,
    unitWeightOunces: 0.064,
    physicalFlags: ["raw-card"],
    stackBehavior: "stackable-thickness",
    source: "profile",
    confidence: "measured",
  };
}

export function createSupplyDb(resolver: (params: readonly unknown[] | undefined) => readonly SupplyCandidate[]) {
  const sourceClaims = new Map<
    string,
    {
      source_type: "cart-checkout" | "buy-now" | "offer-acceptance";
      source_reference_id: string;
      buyer_account_id: string;
      order_ids: string[];
      status: "pending" | "created";
    }
  >();

  return {
    query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      const sourceClaimKey = `${String(params?.[0] ?? "")}|${String(params?.[1] ?? "")}`;
      if (sql.includes("INSERT INTO ordering_order_source_claims")) {
        if (sourceClaims.has(sourceClaimKey)) {
          return { rows: [], rowCount: 0 };
        }
        const claim = {
          source_type: String(params?.[0]) as "cart-checkout" | "buy-now" | "offer-acceptance",
          source_reference_id: String(params?.[1]),
          buyer_account_id: String(params?.[2]),
          order_ids: JSON.parse(String(params?.[3])) as string[],
          status: "pending" as const,
        };
        sourceClaims.set(sourceClaimKey, claim);
        return { rows: [claim], rowCount: 1 };
      }

      if (sql.includes("UPDATE ordering_order_source_claims")) {
        const claim = sourceClaims.get(sourceClaimKey);
        if (!claim || claim.buyer_account_id !== String(params?.[2]) || claim.status !== "pending") {
          return { rows: [], rowCount: 0 };
        }
        sourceClaims.set(sourceClaimKey, {
          ...claim,
          order_ids: JSON.parse(String(params?.[3])) as string[],
          status: "created",
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("DELETE FROM ordering_order_source_claims")) {
        const claim = sourceClaims.get(sourceClaimKey);
        if (claim?.buyer_account_id === String(params?.[2]) && claim.status === "pending") {
          sourceClaims.delete(sourceClaimKey);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("FROM ordering_order_source_claims")) {
        const claim = sourceClaims.get(sourceClaimKey);
        return { rows: claim ? [claim] : [], rowCount: claim ? 1 : 0 };
      }

      if (sql.includes("FROM ordering_order_pages")) {
        return { rows: [] };
      }

      // Order Capacity enforcement (m127): the standalone capacity-cap and
      // open-claims-count lookups (order-capacity.ts) are unrelated to
      // supply-candidate resolution and must be checked before the supply
      // query passthrough below -- the supply-candidate SQL itself also
      // references `ordering_seller_open_order_claims` in its exclusion
      // join, so this can only key off queries that are NOT also a supply
      // query. Empty rows mean no cap is set (unlimited), so the claim
      // path stays a no-op and every existing supply-candidate scenario
      // here is unaffected.
      if (
        !sql.includes("FROM ordering_market_listing_inputs") &&
        (sql.includes("ordering_seller_order_capacity_inputs") || sql.includes("ordering_seller_open_order_claims"))
      ) {
        return { rows: [], rowCount: 0 };
      }

      return {
        rows: resolver(params).map((candidate) => ({
          listing_id: candidate.listingId,
          seller_account_id: candidate.sellerAccountId,
          inventory_item_id: candidate.inventoryItemId,
          catalog_catalog_item_id: candidate.catalogItemId,
          product_id: candidate.productId,
          item_title: candidate.itemTitle,
          item_subtitle: candidate.itemSubtitle,
          selected_options: candidate.selectedOptions,
          product_summary: candidate.productSummary,
          storage_location_name: candidate.storageLocationName,
          ship_from_code: candidate.shipFromCode,
          ship_from_address: candidate.shipFromAddress ?? shipFromAddress,
          price_amount: candidate.priceAmount,
          marketplace_sales_fee_unit_amount: candidate.marketplaceSalesFeeUnitAmount ?? "1.00",
          seller_net_unit_amount: candidate.sellerNetUnitAmount ?? "19.00",
          shipping_allowance_percentage_bps: candidate.shippingAllowancePercentageBps ?? 500,
          terms_schedule_id: candidate.termsScheduleId ?? "cts_default",
          terms_agreement_id: candidate.termsAgreementId ?? null,
          terms_resolved_at: candidate.termsResolvedAt ?? "2026-03-31T00:00:00.000Z",
          fee_locks: candidate.feeLocks ?? [],
          available_quantity: candidate.availableQuantity,
          max_units_per_order: candidate.maxUnitsPerOrder ?? null,
          max_units_per_day: candidate.maxUnitsPerDay ?? null,
          max_units_per_customer_account: candidate.maxUnitsPerCustomerAccount ?? null,
          product_measure_snapshot: candidate.productMeasureSnapshot ?? productMeasureForCandidate(candidate),
          updated_at: candidate.updatedAt,
        })),
      };
    }),
  };
}
