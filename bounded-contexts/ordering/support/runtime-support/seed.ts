import type { BcSeedAggregateStateReport } from "@chase-sets/bounded-context-module";
import {
  createSeedAggregateReconciler,
  loadSeedStreamEvents,
  reconcileSeedAggregates,
} from "@chase-sets/bounded-context-runtime";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { MarketplaceOfferAcceptedPayload } from "@chase-sets/event-core";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { catalogScenarioItems, catalogSeedIds } from "@chase-sets/catalog-seed";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { marketplaceReservedSeedIds, reputationReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import { defaultPostagePolicy } from "@chase-sets/product-measures";
import type { AccountId, OrderId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import { OrderingDomainError } from "../../features/orders/domain/common";
import {
  evolveOrderingOrder,
  initialOrderingOrderState,
  type OrderingOrderEvent,
} from "../../features/orders/domain/domain";
import {
  decidePostagePolicy,
  evolvePostagePolicy,
  initialPostagePolicyState,
  type PostagePolicyCommand,
  type PostagePolicyEvent,
  type PostagePolicyState,
} from "../../features/postage-policies/domain/domain";
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

const ORDERING_BOOTSTRAP_LABEL = "Ordering seed bootstrap";

const orderStreamId = (orderId: string) => `ordering.order-${orderId}`;
const postagePolicyStreamId = (policyId: string) => `ordering.postage-policy-${policyId}`;

/**
 * Folds one seeded order from its own `ordering.order-*` stream.
 *
 * `ordering_order_pages` and `ordering_postage_policy_pages` are UNLOGGED, so
 * PostgreSQL truncates them on crash recovery while the logged streams survive.
 * The projection-sourced guards this replaced answered one combined
 * all-or-nothing question across four independent orders plus a postage policy;
 * a partially seeded set was therefore either re-authored (duplicate create) or
 * skipped entirely. Each order is now decided on its own committed events.
 */
async function loadSeedOrderState(
  db: PgQueryable,
  orderId: string,
): Promise<Readonly<{ kind: "absent" | "draft" | "active"; status: string | null; eventCount: number }>> {
  const committed = await loadSeedStreamEvents<OrderingOrderEvent>(db, orderStreamId(orderId));
  const state = committed.reduce(evolveOrderingOrder, initialOrderingOrderState);
  return {
    kind: state.orderId === null ? "absent" : "active",
    status: state.status,
    eventCount: committed.length,
  };
}

/**
 * Finds every stream carrying an `ordering.order.created` for one source
 * reference. The offer-acceptance reaction can author an order with a generated
 * id before the seed pins its reserved id, so the seed must recognise that twin
 * from the authoritative streams rather than pick one silently.
 */
async function listOrderStreamsForSource(
  db: PgQueryable,
  sourceType: "cart-checkout" | "offer-acceptance" | "buy-now",
  sourceReferenceId: string,
): Promise<readonly string[]> {
  const result = await db.query<{ order_id: string }>(
    `SELECT payload->>'orderId' AS order_id
     FROM event_store_events
     WHERE event_type = 'ordering.order.created'
       AND payload->>'sourceType' = $1
       AND payload->>'sourceReferenceId' = $2
     ORDER BY 1 ASC`,
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

function buildSeedPostagePolicyReconciler(ordering: OrderingServices, context: EventStoreContext) {
  return createSeedAggregateReconciler<PostagePolicyState, PostagePolicyCommand, PostagePolicyEvent>({
    db: ordering.db,
    contextName: "ordering",
    bootstrapLabel: ORDERING_BOOTSTRAP_LABEL,
    aggregateName: "Postage Policy",
    id: orderingReservedSeedIds.postagePolicies.default,
    key: "Default postage policy",
    streamId: postagePolicyStreamId(orderingReservedSeedIds.postagePolicies.default),
    initialState: initialPostagePolicyState,
    decide: decidePostagePolicy,
    evolve: evolvePostagePolicy,
    steps: [
      {
        type: "CreatePostagePolicy",
        policyId: orderingReservedSeedIds.postagePolicies.default,
        label: "Default postage policy",
        payload: defaultPostagePolicy,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: null,
        createdByUserId: identitySeedIds.demo.userId,
      },
      {
        type: "ActivatePostagePolicy",
        activatedByUserId: identitySeedIds.demo.userId,
        activationReason: "Seed default postage policy.",
      },
    ],
    send: (streamId, command) => ordering.postagePolicies.commandHandler({ streamId, command, context }),
  });
}

const seedOrderInventory = [
  { id: orderingReservedSeedIds.orders.checkoutPending, key: "chk_seed_checkout_pending", expectedStatus: null },
  { id: orderingReservedSeedIds.orders.cancelled, key: "chk_seed_cancelled", expectedStatus: "cancelled" },
  {
    id: orderingReservedSeedIds.orders.acceptedOfferReady,
    key: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
    expectedStatus: null,
  },
  {
    id: reputationReservedSeedIds.orders.reviewEligibleDelivered,
    key: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerEncore,
    expectedStatus: null,
  },
] as const;

/**
 * Reports the Ordering seed's base aggregate state from the authoritative
 * `ordering.*` streams: the default postage policy plus each reserved order.
 */
export async function inspectOrderingSeedState(
  pool: PgTransactionalPool,
): Promise<readonly BcSeedAggregateStateReport[]> {
  const ordering = createOrderingServices(pool);
  const context = createSeedContextFor(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);
  const policyReports = await reconcileSeedAggregates([buildSeedPostagePolicyReconciler(ordering, context)], false);

  const orderReports: BcSeedAggregateStateReport[] = [];
  for (const order of seedOrderInventory) {
    const state = await loadSeedOrderState(ordering.db, order.id);
    const complete =
      state.kind === "active" && (order.expectedStatus === null || state.status === order.expectedStatus);
    orderReports.push({
      contextName: "ordering",
      aggregateName: "Order",
      id: order.id,
      key: order.key,
      streamId: orderStreamId(order.id),
      kind: state.kind === "absent" ? "absent" : complete ? "active" : "draft",
      status: state.status,
      eventCount: state.eventCount,
    });
  }

  return [...policyReports, ...orderReports];
}

export async function seedOrderingDatabase(
  pool: PgTransactionalPool,
  ordering: OrderingServices = createOrderingServices(pool),
) {
  const buyerAccountId = identitySeedIds.collector.accountId;

  console.log("Starting ordering development seed...\n");

  const buyerContext = createSeedContextFor(identitySeedIds.collector.accountId, identitySeedIds.collector.userId);
  const sellerContext = createSeedContextFor(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);
  const systemContext = createSeedContextFor(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);

  await buildSeedPostagePolicyReconciler(ordering, systemContext).reconcile(true);

  if ((await loadSeedOrderState(ordering.db, orderingReservedSeedIds.orders.checkoutPending)).kind === "absent") {
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

  const cancelledOrder = await loadSeedOrderState(ordering.db, orderingReservedSeedIds.orders.cancelled);
  if (cancelledOrder.kind === "absent") {
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
  } else if (cancelledOrder.status !== "cancelled") {
    await ordering.orders.cancelPurchase(
      {
        orderId: orderingReservedSeedIds.orders.cancelled,
        buyerAccountId,
      },
      buyerContext,
    );
    console.log(`  Cancelled order seeded (${orderingReservedSeedIds.orders.cancelled})`);
  }

  await seedAcceptedOfferOrder(ordering, sellerContext, {
    reservedOrderId: orderingReservedSeedIds.orders.acceptedOfferReady,
    offer: acceptedOfferSeed,
    label: "Accepted-offer order",
    buyerAccountId,
  });

  await seedAcceptedOfferOrder(ordering, sellerContext, {
    reservedOrderId: reputationReservedSeedIds.orders.reviewEligibleDelivered,
    offer: reviewEligibleOfferSeed,
    label: "Review-eligible order",
    buyerAccountId,
  });

  console.log("\nOrdering seed complete!");
}

async function seedAcceptedOfferOrder(
  ordering: OrderingServices,
  sellerContext: EventStoreContext,
  input: Readonly<{
    reservedOrderId: OrderId;
    offer: typeof acceptedOfferSeed | typeof reviewEligibleOfferSeed;
    label: string;
    buyerAccountId: AccountId;
  }>,
): Promise<void> {
  if ((await loadSeedOrderState(ordering.db, input.reservedOrderId)).kind !== "absent") {
    return;
  }

  // The offer-acceptance reaction may already have authored this order under a
  // generated id. Recognise that committed order from its own stream instead of
  // creating a second one under the reserved id.
  const existingOrderIds = await listOrderStreamsForSource(ordering.db, "offer-acceptance", input.offer.offerId);
  if (existingOrderIds.length > 0) {
    console.log(`  ${input.label} already seeded (${existingOrderIds.join(", ")})`);
    return;
  }

  const offerInput = await getAcceptedOfferInput(ordering, input.offer.offerId);
  if (!offerInput) {
    logWaitingForActiveSupply(input.offer.itemTitle, "accepted-offer order");
    return;
  }

  await createSupplyBackedSeedOrder(input.offer.itemTitle, "accepted-offer order", async () => {
    await ordering.orders.createOrdersFromAcceptedOffer(
      {
        offerId: input.offer.offerId,
        buyerAccountId: input.buyerAccountId,
        sellerAccountId: identitySeedIds.demo.accountId,
        listingId: offerInput.listing_id,
        inventoryItemId: offerInput.inventory_item_id,
        listingVersion: offerInput.listing_version,
        catalogItemId: input.offer.catalogItemId,
        productId: offerInput.product_id,
        itemTitle: input.offer.itemTitle,
        itemSubtitle: input.offer.itemSubtitle,
        selectedOptions: [...input.offer.selectedOptions],
        productSummary: input.offer.productSummary,
        priceAmount: input.offer.priceAmount,
        marketplaceSalesFeePercentageBps: offerInput.marketplace_sales_fee_percentage_bps,
        marketplaceSalesFeeFixedAmount: offerInput.marketplace_sales_fee_fixed_amount,
        marketplaceSalesFeeCapAmount: offerInput.marketplace_sales_fee_cap_amount,
        marketplaceSalesFeeUnitAmount: offerInput.marketplace_sales_fee_unit_amount,
        sellerNetUnitAmount: offerInput.seller_net_unit_amount,
        termsScheduleId: offerInput.terms_schedule_id,
        termsAgreementId: offerInput.terms_agreement_id,
        termsResolvedAt: offerInput.terms_resolved_at,
        feeQuoteFingerprint: offerInput.fee_quote_fingerprint,
        listingEvidencePolicyId: offerInput.listing_evidence_policy_id,
        listingEvidencePolicyVersion: offerInput.listing_evidence_policy_version,
        listingEvidencePolicyHash: offerInput.listing_evidence_policy_hash,
        listingEvidenceSnapshot: offerInput.listing_evidence_snapshot,
        shippingDestinationSnapshot: seedShippingAddress,
        quantityRequested: input.offer.quantityRequested,
        orderIdsOverride: [input.reservedOrderId],
      },
      sellerContext,
    );
    console.log(`  ${input.label} seeded (${input.reservedOrderId})`);
  });
}
