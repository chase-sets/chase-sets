import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { MarketplaceOfferAcceptedPayload } from "@chase-sets/event-core";
import { catalogScenarioItems, catalogSeedIds } from "@chase-sets/catalog-seed";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { marketplaceReservedSeedIds, reputationReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import { defaultPostagePolicy } from "@chase-sets/product-measures";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { OrderingDomainError } from "../../features/orders/domain/common";
import { orderingReservedSeedIds } from "../seed-support/ids";
import { createOrderingServices, type OrderingServices } from "./services";

const rawExcellentVersionSelection = [
  {
    dimensionId: catalogSeedIds.dimensions.form.dimensionId,
    optionId: catalogSeedIds.dimensions.form.optionIds.raw,
  },
  {
    dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
    optionId: catalogSeedIds.dimensions.condition.optionIds.excellent,
  },
] as const;

const checkoutCartLines = [
  {
    catalogItemId: catalogScenarioItems.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    quantity: 2,
  },
] as const;

const cancelledCartLines = [
  {
    catalogItemId: catalogScenarioItems.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    quantity: 1,
  },
] as const;

const acceptedOfferSeed = {
  offerId: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
  catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
  itemTitle: "Twilight Masquerade Elite Trainer Box",
  itemSubtitle: "Sealed elite trainer box",
  selectedOptions: [] as const,
  productSummary: null,
  priceAmount: "44.00",
  quantityRequested: 1,
} as const;

// Backs the review-eligible delivered order: it never receives a support
// request, so review eligibility survives for the marketplace reviews seed.
const reviewEligibleOfferSeed = {
  offerId: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerEncore,
  catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
  itemTitle: "Twilight Masquerade Elite Trainer Box",
  itemSubtitle: "Sealed elite trainer box",
  selectedOptions: [] as const,
  productSummary: null,
  priceAmount: "44.50",
  quantityRequested: 1,
} as const;

const seedShippingAddress = {
  name: "Chase Sets Demo Buyer",
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: "3125550199",
  email: "buyer@chasesets.test",
} as const;

function createSeedContextFor(accountId: AccountId, userId: string) {
  return {
    tenantId: "tnt_identity" as TenantId,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId,
    },
  };
}

async function hasOrderPage(db: PgQueryable, orderId: string) {
  const result = await db.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM ordering_order_pages WHERE order_id = $1) AS exists",
    [orderId],
  );
  return result.rows[0]?.exists ?? false;
}

async function hasPostagePolicyPage(db: PgQueryable, policyId: string) {
  const result = await db.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM ordering_postage_policy_pages WHERE policy_id = $1) AS exists",
    [policyId],
  );
  return result.rows[0]?.exists ?? false;
}

async function getOrderPageStatus(db: PgQueryable, orderId: string) {
  const result = await db.query<{ status: string }>("SELECT status FROM ordering_order_pages WHERE order_id = $1", [
    orderId,
  ]);
  return result.rows[0]?.status ?? null;
}

async function listOrderPagesForSource(
  db: PgQueryable,
  sourceType: "cart-checkout" | "offer-acceptance" | "buy-now",
  sourceReferenceId: string,
) {
  const result = await db.query<{ order_id: string }>(
    `SELECT order_id
     FROM ordering_order_pages
     WHERE source_type = $1
       AND source_reference_id = $2
     ORDER BY order_id ASC`,
    [sourceType, sourceReferenceId],
  );

  return result.rows.map((row) => row.order_id);
}

async function buildCheckoutLine(
  services: ReturnType<typeof createOrderingServices>,
  line: (typeof checkoutCartLines)[number] | (typeof cancelledCartLines)[number],
) {
  const result = await services.db.query<{
    product_id: string;
    product_summary: string | null;
    selected_options: unknown;
  }>(
    `SELECT product_id, product_summary, selected_options
     FROM ordering_market_listing_inputs
     WHERE catalog_catalog_item_id = $1
       AND selected_options @> $2::jsonb
       AND selected_options <@ $2::jsonb
       AND status = 'active'
     ORDER BY price_amount ASC, listing_id ASC
     LIMIT 1`,
    [line.catalogItemId, JSON.stringify(line.selectedOptions)],
  );
  const snapshot = result.rows[0];
  if (!snapshot) {
    return null;
  }

  return {
    listingId: null,
    cartLineId: null,
    catalogItemId: line.catalogItemId,
    productId: snapshot.product_id,
    itemTitle: line.itemTitle,
    itemSubtitle: line.itemSubtitle,
    selectedOptions: Array.isArray(snapshot.selected_options)
      ? (snapshot.selected_options as {
          dimensionId: string;
          optionId: string;
        }[])
      : [...line.selectedOptions],
    productSummary: snapshot.product_summary ?? line.productSummary,
    quantity: line.quantity,
  };
}

function logWaitingForActiveSupply(itemTitle: string, dependentOrder: "checkout order" | "accepted-offer order") {
  console.log(
    `Ordering seed is waiting for active Marketplace supply for ${itemTitle}. Skipping the dependent ${dependentOrder} for this pass.`,
  );
}

async function getAcceptedOfferInput(services: ReturnType<typeof createOrderingServices>, offerId: string) {
  const result = await services.db.query<{
    listing_id: string;
    inventory_item_id: string;
    listing_version: number;
    product_id: string;
    marketplace_sales_fee_percentage_bps: number;
    marketplace_sales_fee_fixed_amount: string;
    marketplace_sales_fee_cap_amount: string | null;
    marketplace_sales_fee_unit_amount: string;
    seller_net_unit_amount: string;
    terms_schedule_id: string | null;
    terms_agreement_id: string | null;
    terms_resolved_at: string;
    fee_quote_fingerprint: string;
    listing_evidence_policy_id: string | null;
    listing_evidence_policy_version: number | null;
    listing_evidence_policy_hash: string;
    listing_evidence_snapshot: MarketplaceOfferAcceptedPayload["listingEvidenceSnapshot"];
  }>(
    `SELECT
       listing_id,
       inventory_item_id,
       listing_version,
       product_id,
       marketplace_sales_fee_percentage_bps,
       marketplace_sales_fee_fixed_amount::text AS marketplace_sales_fee_fixed_amount,
       marketplace_sales_fee_cap_amount::text AS marketplace_sales_fee_cap_amount,
       marketplace_sales_fee_unit_amount::text AS marketplace_sales_fee_unit_amount,
       seller_net_unit_amount::text AS seller_net_unit_amount,
       terms_schedule_id,
       terms_agreement_id,
       terms_resolved_at::text AS terms_resolved_at,
       fee_quote_fingerprint,
       listing_evidence_policy_id,
       listing_evidence_policy_version,
       listing_evidence_policy_hash,
       listing_evidence_snapshot
     FROM ordering_offer_acceptance_inputs
     WHERE offer_id = $1`,
    [offerId],
  );

  return result.rows[0] ?? null;
}

function isWaitingForActiveSupply(error: unknown) {
  return (
    error instanceof OrderingDomainError &&
    error.message.startsWith("Not enough active supply is available for ") &&
    error.message.endsWith(".")
  );
}

async function createSupplyBackedSeedOrder(
  itemTitle: string,
  dependentOrder: "checkout order" | "accepted-offer order",
  createOrder: () => Promise<void>,
) {
  try {
    await createOrder();
    return true;
  } catch (error) {
    if (isWaitingForActiveSupply(error)) {
      logWaitingForActiveSupply(itemTitle, dependentOrder);
      return false;
    }
    throw error;
  }
}

export async function seedOrderingDatabase(
  pool: PgTransactionalPool,
  ordering: OrderingServices = createOrderingServices(pool),
) {
  const buyerAccountId = identitySeedIds.collector.accountId;

  try {
    const [hasCheckoutPending, cancelledOrderStatus, hasAcceptedOfferOrder, hasReviewEligibleOrder] = await Promise.all(
      [
        hasOrderPage(ordering.db, orderingReservedSeedIds.orders.checkoutPending),
        getOrderPageStatus(ordering.db, orderingReservedSeedIds.orders.cancelled),
        hasOrderPage(ordering.db, orderingReservedSeedIds.orders.acceptedOfferReady),
        hasOrderPage(ordering.db, reputationReservedSeedIds.orders.reviewEligibleDelivered),
      ],
    );

    if (hasCheckoutPending && cancelledOrderStatus === "cancelled" && hasAcceptedOfferOrder && hasReviewEligibleOrder) {
      console.log("Ordering already contains seed data. Skipping seed.");
      return;
    }
  } catch {
    // Tables may not exist yet. Proceed with seeding.
  }

  console.log("Starting ordering development seed...\n");

  const buyerContext = createSeedContextFor(identitySeedIds.collector.accountId, identitySeedIds.collector.userId);
  const sellerContext = createSeedContextFor(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);
  const systemContext = createSeedContextFor(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);

  if (!(await hasPostagePolicyPage(ordering.db, orderingReservedSeedIds.postagePolicies.default))) {
    await ordering.postagePolicies.commandHandler({
      streamId: `ordering.postage-policy-${orderingReservedSeedIds.postagePolicies.default}`,
      command: {
        type: "CreatePostagePolicy",
        policyId: orderingReservedSeedIds.postagePolicies.default,
        label: "Default postage policy",
        payload: defaultPostagePolicy,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
        createdByUserId: identitySeedIds.demo.userId,
      },
      context: systemContext,
    });
    await ordering.postagePolicies.commandHandler({
      streamId: `ordering.postage-policy-${orderingReservedSeedIds.postagePolicies.default}`,
      command: {
        type: "ActivatePostagePolicy",
        activatedByUserId: identitySeedIds.demo.userId,
        activationReason: "Seed default postage policy.",
      },
      context: systemContext,
    });
    console.log(`  Default postage policy seeded (${orderingReservedSeedIds.postagePolicies.default})`);
  }

  if (!(await hasOrderPage(ordering.db, orderingReservedSeedIds.orders.checkoutPending))) {
    const checkoutLine = await buildCheckoutLine(ordering, checkoutCartLines[0]!);
    if (checkoutLine) {
      await createSupplyBackedSeedOrder(checkoutCartLines[0]!.itemTitle, "checkout order", async () => {
        const checkoutResult = await ordering.orders.createOrdersFromCheckout(
          {
            buyerAccountId,
            checkoutSessionId: "chk_seed_checkout_pending",
            sourceType: "cart-checkout",
            shippingOption: "standard",
            shippingAddress: seedShippingAddress,
            lines: [checkoutLine],
            orderIdsOverride: [orderingReservedSeedIds.orders.checkoutPending],
          },
          buyerContext,
        );
        console.log(`  Pending checkout order seeded (${checkoutResult.orderIds.join(", ")})`);
      });
    } else {
      logWaitingForActiveSupply(checkoutCartLines[0]!.itemTitle, "checkout order");
    }
  }

  const cancelledOrderStatus = await getOrderPageStatus(ordering.db, orderingReservedSeedIds.orders.cancelled);
  if (!cancelledOrderStatus) {
    const cancelledLine = await buildCheckoutLine(ordering, cancelledCartLines[0]!);
    if (cancelledLine) {
      await createSupplyBackedSeedOrder(cancelledCartLines[0]!.itemTitle, "checkout order", async () => {
        const cancelledOrderResult = await ordering.orders.createOrdersFromCheckout(
          {
            buyerAccountId,
            checkoutSessionId: "chk_seed_cancelled",
            sourceType: "cart-checkout",
            shippingOption: "expedited",
            shippingAddress: seedShippingAddress,
            lines: [cancelledLine],
            orderIdsOverride: [orderingReservedSeedIds.orders.cancelled],
          },
          buyerContext,
        );

        const cancelledOrderId = cancelledOrderResult.orderIds[0];
        if (!cancelledOrderId) {
          throw new Error("Ordering demo seed could not create the cancellable order.");
        }

        console.log(`  Cancellable order seeded (${cancelledOrderId})`);
      });
    } else {
      logWaitingForActiveSupply(cancelledCartLines[0]!.itemTitle, "checkout order");
    }
  } else if (cancelledOrderStatus !== "cancelled") {
    await ordering.orders.cancelPurchase(
      {
        orderId: orderingReservedSeedIds.orders.cancelled,
        buyerAccountId,
      },
      buyerContext,
    );
    console.log(`  Cancelled order seeded (${orderingReservedSeedIds.orders.cancelled})`);
  }

  if (!(await hasOrderPage(ordering.db, orderingReservedSeedIds.orders.acceptedOfferReady))) {
    const existingAcceptedOfferOrderIds = await listOrderPagesForSource(
      ordering.db,
      "offer-acceptance",
      acceptedOfferSeed.offerId,
    );
    if (existingAcceptedOfferOrderIds.length > 0) {
      console.log(`  Accepted-offer order already seeded (${existingAcceptedOfferOrderIds.join(", ")})`);
    } else {
      const acceptedOfferInput = await getAcceptedOfferInput(ordering, acceptedOfferSeed.offerId);

      if (acceptedOfferInput) {
        await createSupplyBackedSeedOrder(acceptedOfferSeed.itemTitle, "accepted-offer order", async () => {
          await ordering.orders.createOrdersFromAcceptedOffer(
            {
              offerId: acceptedOfferSeed.offerId,
              buyerAccountId,
              sellerAccountId: identitySeedIds.demo.accountId,
              listingId: acceptedOfferInput.listing_id,
              inventoryItemId: acceptedOfferInput.inventory_item_id,
              listingVersion: acceptedOfferInput.listing_version,
              catalogItemId: acceptedOfferSeed.catalogItemId,
              productId: acceptedOfferInput.product_id,
              itemTitle: acceptedOfferSeed.itemTitle,
              itemSubtitle: acceptedOfferSeed.itemSubtitle,
              selectedOptions: [...acceptedOfferSeed.selectedOptions],
              productSummary: acceptedOfferSeed.productSummary,
              priceAmount: acceptedOfferSeed.priceAmount,
              marketplaceSalesFeePercentageBps: acceptedOfferInput.marketplace_sales_fee_percentage_bps,
              marketplaceSalesFeeFixedAmount: acceptedOfferInput.marketplace_sales_fee_fixed_amount,
              marketplaceSalesFeeCapAmount: acceptedOfferInput.marketplace_sales_fee_cap_amount,
              marketplaceSalesFeeUnitAmount: acceptedOfferInput.marketplace_sales_fee_unit_amount,
              sellerNetUnitAmount: acceptedOfferInput.seller_net_unit_amount,
              termsScheduleId: acceptedOfferInput.terms_schedule_id,
              termsAgreementId: acceptedOfferInput.terms_agreement_id,
              termsResolvedAt: acceptedOfferInput.terms_resolved_at,
              feeQuoteFingerprint: acceptedOfferInput.fee_quote_fingerprint,
              listingEvidencePolicyId: acceptedOfferInput.listing_evidence_policy_id,
              listingEvidencePolicyVersion: acceptedOfferInput.listing_evidence_policy_version,
              listingEvidencePolicyHash: acceptedOfferInput.listing_evidence_policy_hash,
              listingEvidenceSnapshot: acceptedOfferInput.listing_evidence_snapshot,
              shippingDestinationSnapshot: seedShippingAddress,
              quantityRequested: acceptedOfferSeed.quantityRequested,
              orderIdsOverride: [orderingReservedSeedIds.orders.acceptedOfferReady],
            },
            sellerContext,
          );
          console.log(`  Accepted-offer order seeded (${orderingReservedSeedIds.orders.acceptedOfferReady})`);
        });
      } else {
        logWaitingForActiveSupply(acceptedOfferSeed.itemTitle, "accepted-offer order");
      }
    }
  }

  if (!(await hasOrderPage(ordering.db, reputationReservedSeedIds.orders.reviewEligibleDelivered))) {
    const existingReviewEligibleOrderIds = await listOrderPagesForSource(
      ordering.db,
      "offer-acceptance",
      reviewEligibleOfferSeed.offerId,
    );
    if (existingReviewEligibleOrderIds.length > 0) {
      console.log(`  Review-eligible order already seeded (${existingReviewEligibleOrderIds.join(", ")})`);
    } else {
      const reviewEligibleOfferInput = await getAcceptedOfferInput(ordering, reviewEligibleOfferSeed.offerId);

      if (reviewEligibleOfferInput) {
        await createSupplyBackedSeedOrder(reviewEligibleOfferSeed.itemTitle, "accepted-offer order", async () => {
          await ordering.orders.createOrdersFromAcceptedOffer(
            {
              offerId: reviewEligibleOfferSeed.offerId,
              buyerAccountId,
              sellerAccountId: identitySeedIds.demo.accountId,
              listingId: reviewEligibleOfferInput.listing_id,
              inventoryItemId: reviewEligibleOfferInput.inventory_item_id,
              listingVersion: reviewEligibleOfferInput.listing_version,
              catalogItemId: reviewEligibleOfferSeed.catalogItemId,
              productId: reviewEligibleOfferInput.product_id,
              itemTitle: reviewEligibleOfferSeed.itemTitle,
              itemSubtitle: reviewEligibleOfferSeed.itemSubtitle,
              selectedOptions: [...reviewEligibleOfferSeed.selectedOptions],
              productSummary: reviewEligibleOfferSeed.productSummary,
              priceAmount: reviewEligibleOfferSeed.priceAmount,
              marketplaceSalesFeePercentageBps: reviewEligibleOfferInput.marketplace_sales_fee_percentage_bps,
              marketplaceSalesFeeFixedAmount: reviewEligibleOfferInput.marketplace_sales_fee_fixed_amount,
              marketplaceSalesFeeCapAmount: reviewEligibleOfferInput.marketplace_sales_fee_cap_amount,
              marketplaceSalesFeeUnitAmount: reviewEligibleOfferInput.marketplace_sales_fee_unit_amount,
              sellerNetUnitAmount: reviewEligibleOfferInput.seller_net_unit_amount,
              termsScheduleId: reviewEligibleOfferInput.terms_schedule_id,
              termsAgreementId: reviewEligibleOfferInput.terms_agreement_id,
              termsResolvedAt: reviewEligibleOfferInput.terms_resolved_at,
              feeQuoteFingerprint: reviewEligibleOfferInput.fee_quote_fingerprint,
              listingEvidencePolicyId: reviewEligibleOfferInput.listing_evidence_policy_id,
              listingEvidencePolicyVersion: reviewEligibleOfferInput.listing_evidence_policy_version,
              listingEvidencePolicyHash: reviewEligibleOfferInput.listing_evidence_policy_hash,
              listingEvidenceSnapshot: reviewEligibleOfferInput.listing_evidence_snapshot,
              shippingDestinationSnapshot: seedShippingAddress,
              quantityRequested: reviewEligibleOfferSeed.quantityRequested,
              orderIdsOverride: [reputationReservedSeedIds.orders.reviewEligibleDelivered],
            },
            sellerContext,
          );
          console.log(`  Review-eligible order seeded (${reputationReservedSeedIds.orders.reviewEligibleDelivered})`);
        });
      } else {
        logWaitingForActiveSupply(reviewEligibleOfferSeed.itemTitle, "accepted-offer order");
      }
    }
  }

  console.log("\nOrdering seed complete!");
}
