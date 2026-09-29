import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { withSyntheticListingPrincipal } from "@chase-sets/event-core/test-support";
import { createMarketplaceListingRuntime } from "../../features/listings/api/runtime";
import { createSyntheticListingAuthority } from "../../features/listings/api/authority-test-support";
import { createListingEvidenceRequirementSnapshot } from "../../features/listings/domain/evidence-requirement-snapshot";
import type { ListingTargetAuthority } from "../../features/listings/api/target-contracts";

/** Synthetic remote business facts; every Marketplace read/write and terminal uses PostgreSQL. */
export function createListingSqlFixture(pool: PgTransactionalPool) {
  const eventStore = createPostgresEventStore({ pool });
  const participants = createSyntheticListingAuthority(eventStore);
  const context = withSyntheticListingPrincipal({
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  });
  const productMeasureSnapshot = {
    catalogItemId: "cat_synthetic",
    productId: "cat_synthetic::",
    selectedOptions: [],
    measureVersion: "synthetic-measure",
    unitLengthInches: 3.5,
    unitWidthInches: 2.5,
    unitHeightInches: 0.01,
    unitWeightOunces: 0.1,
    physicalFlags: ["raw-card"],
    stackBehavior: "stackable-thickness",
    source: "profile",
    confidence: "measured",
  } as const;
  const evidenceRequirements = createListingEvidenceRequirementSnapshot(
    {
      policyId: "synthetic-evidence-policy",
      policyVersion: 1,
      policyHash: "synthetic-hash",
      matchedRuleIds: [],
      explanationCodes: [],
      effectiveInterval: { from: null, until: null },
      requirements: {
        minimumPhotoCount: 0,
        requiredSlots: [],
        sellerTrustRequirements: [],
        buyerAcknowledgment: "none",
      },
    },
    new Date().toISOString(),
  );
  const authority: ListingTargetAuthority = {
    ...participants.authority,
    readCatalogProduct: async (operation) => ({
      value: {
        catalogItemId: "cat_synthetic",
        productId: "cat_synthetic::",
        selectedOptions: [],
        blueprintId: "bpt_synthetic",
        categoryIds: [],
        productMeasureSnapshot: null,
        productMeasureRevision: 0,
      },
      reservations: await participants.reserve("product-measures", operation),
    }),
    readInventory: async (_input, operation) => [
      {
        value: {
          accountId: "acc_synthetic",
          inventoryItemId: "inv_synthetic",
          catalogItemId: "cat_synthetic",
          productId: "cat_synthetic::",
          availableQuantity: 3,
        },
        reservations: await participants.reserve("stock-allocation", operation),
      },
    ],
    verifyNativeFeeQuote: async (_input, operation) => ({
      value: true,
      reservations: await participants.reserve("native-fee", operation),
    }),
    readNativeReadiness: async (_input, operation) => [
      {
        value: {
          listingId: operation.listingId,
          accountId: "acc_synthetic",
          productMeasureSnapshot,
          productMeasureRevision: 1,
          evidenceRequirements,
          seller: { reviewCount: 0, badgeKeys: [] },
        },
        reservations: [
          ...(await participants.reserve("product-measures", operation)),
          ...(await participants.reserve("native-readiness", operation)),
        ],
      },
    ],
  };
  const db: PgQueryable = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      if (!sql.includes("FROM marketplace_supply_items AS item")) return pool.query<Row>(sql, values);
      return {
        rows: [
          {
            item_id: "inv_synthetic",
            account_id: "acc_synthetic",
            catalog_catalog_item_id: "cat_synthetic",
            product_id: "cat_synthetic::",
            selected_options: [],
            item_title: "Synthetic SQL fixture",
            item_subtitle: null,
            item_language_code: null,
            product_summary: null,
            product_measure_snapshot: null,
            graded_card: null,
            storage_location_name: null,
            ship_from_code: null,
            ship_from_address: {
              name: "Synthetic Seller",
              company: null,
              line1: "1 Test St",
              line2: null,
              city: "Austin",
              state: "TX",
              postalCode: "78701",
              country: "US",
              phone: null,
              email: null,
            },
            available_quantity: 3,
          },
        ] as Row[],
      };
    },
  };
  const services = createMarketplaceListingRuntime({
    eventStore,
    db,
    checkpointStore: createPostgresProjectionStore({ db: pool }),
    listingTargetAuthority: authority,
    commercialTermsResolver: {
      resolveListingTerms: async () => ({
        accountType: "personal",
        basisAmount: "10.00",
        marketplaceSalesFeeUnitAmount: "0.50",
        sellerNetUnitAmount: "9.50",
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: null,
        shippingAllowancePercentageBps: 500,
        scheduleId: "synthetic-terms",
        agreementId: null,
        resolvedAt: "2026-09-27T12:00:00.000Z",
      }),
    } as never,
  });
  const input = {
    publicationScope: "channel-only" as const,
    accountId: context.audit.forAccountId,
    inventoryItemId: "inv_synthetic",
    listingIdOverride: "lst_synthetic" as never,
    priceAmount: "10.00",
    priceCurrencyCode: "CAD",
    quantityCap: 2,
  };
  const enable = {
    accountId: input.accountId,
    listingId: input.listingIdOverride,
    expectedListingVersion: 1,
    idempotencyKey: "synthetic-enable",
    nativeVisibility: "enabled" as const,
    feeQuoteFingerprint: "10.00|0.50|9.50|500|synthetic-terms|",
  };
  return { services, context, input, enable, eventStore, participants, authority, productMeasureSnapshot };
}
