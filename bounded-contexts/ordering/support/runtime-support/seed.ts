import type { Projector } from "@chase-sets/event-core/projector";
import type {
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { catalogSeedIds } from "@chase-sets/catalog/seed-support/ids";
import { catalogScenarioItems } from "@chase-sets/catalog/seed-support/scenario";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
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
  offerId:
    marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
  catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
  itemTitle: "Twilight Masquerade Elite Trainer Box",
  itemSubtitle: "Sealed elite trainer box",
  selectedOptions: [] as const,
  productSummary: null,
  priceAmount: "44.00",
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
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: userId as never,
      forAccountId: accountId,
    },
  };
}

async function drainProjectors(projectors: readonly Projector[]) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

async function hasOrderPage(db: PgQueryable, orderId: string) {
  const result = await db.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM ordering_order_pages WHERE order_id = $1) AS exists",
    [orderId],
  );
  return result.rows[0]?.exists ?? false;
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
  line:
    | (typeof checkoutCartLines)[number]
    | (typeof cancelledCartLines)[number],
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
    throw new Error(`No active ordering supply found for ${line.itemTitle}.`);
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

async function getAcceptedOfferInput(
  services: ReturnType<typeof createOrderingServices>,
  offerId: string,
) {
  const result = await services.db.query<{
    product_id: string;
    marketplace_sales_fee_unit_amount: string;
    seller_net_unit_amount: string;
    terms_schedule_id: string | null;
    terms_agreement_id: string | null;
    terms_resolved_at: string;
  }>(
    `SELECT
       product_id,
       marketplace_sales_fee_unit_amount::text AS marketplace_sales_fee_unit_amount,
       seller_net_unit_amount::text AS seller_net_unit_amount,
       terms_schedule_id,
       terms_agreement_id,
       terms_resolved_at::text AS terms_resolved_at
     FROM ordering_offer_acceptance_inputs
     WHERE offer_id = $1`,
    [offerId],
  );

  return result.rows[0] ?? null;
}

export async function seedOrderingDatabase(
  pool: PgTransactionalPool,
  ordering: OrderingServices = createOrderingServices(pool),
) {
  const buyerAccountId = identitySeedIds.collector.accountId;

  try {
    const [hasCheckoutPending, hasCancelledOrder, hasAcceptedOfferOrder] =
      await Promise.all([
        hasOrderPage(
          ordering.db,
          orderingReservedSeedIds.orders.checkoutPending,
        ),
        hasOrderPage(ordering.db, orderingReservedSeedIds.orders.cancelled),
        hasOrderPage(
          ordering.db,
          orderingReservedSeedIds.orders.acceptedOfferReady,
        ),
      ]);

    if (hasCheckoutPending && hasCancelledOrder && hasAcceptedOfferOrder) {
      console.log("Ordering already contains seed data. Skipping seed.");
      return;
    }
  } catch {
    // Tables may not exist yet. Proceed with seeding.
  }

  await drainProjectors(ordering.projectors);

  console.log("Starting ordering development seed...\n");

  const buyerContext = createSeedContextFor(
    identitySeedIds.collector.accountId,
    identitySeedIds.collector.userId,
  );
  const sellerContext = createSeedContextFor(
    identitySeedIds.demo.accountId,
    identitySeedIds.demo.userId,
  );

  if (
    !(await hasOrderPage(
      ordering.db,
      orderingReservedSeedIds.orders.checkoutPending,
    ))
  ) {
    const checkoutResult = await ordering.orders.createOrdersFromCheckout(
      {
        buyerAccountId,
        checkoutSessionId: "chk_seed_checkout_pending",
        sourceType: "cart-checkout",
        shippingOption: "standard",
        shippingAddress: seedShippingAddress,
        lines: [await buildCheckoutLine(ordering, checkoutCartLines[0]!)],
        orderIdsOverride: [orderingReservedSeedIds.orders.checkoutPending],
      },
      buyerContext,
    );
    await drainProjectors(ordering.projectors);
    console.log(
      `  Pending checkout order seeded (${checkoutResult.orderIds.join(", ")})`,
    );
  }

  if (
    !(await hasOrderPage(ordering.db, orderingReservedSeedIds.orders.cancelled))
  ) {
    const cancelledOrderResult = await ordering.orders.createOrdersFromCheckout(
      {
        buyerAccountId,
        checkoutSessionId: "chk_seed_cancelled",
        sourceType: "cart-checkout",
        shippingOption: "expedited",
        shippingAddress: seedShippingAddress,
        lines: [await buildCheckoutLine(ordering, cancelledCartLines[0]!)],
        orderIdsOverride: [orderingReservedSeedIds.orders.cancelled],
      },
      buyerContext,
    );
    await drainProjectors(ordering.projectors);

    const cancelledOrderId = cancelledOrderResult.orderIds[0];
    if (!cancelledOrderId) {
      throw new Error(
        "Ordering demo seed could not create the cancellable order.",
      );
    }

    await ordering.orders.cancelPurchase(
      {
        orderId: cancelledOrderId,
        buyerAccountId,
      },
      buyerContext,
    );
    await drainProjectors(ordering.projectors);
    console.log(`  Cancelled order seeded (${cancelledOrderId})`);
  }

  if (
    !(await hasOrderPage(
      ordering.db,
      orderingReservedSeedIds.orders.acceptedOfferReady,
    ))
  ) {
    const existingAcceptedOfferOrderIds = await listOrderPagesForSource(
      ordering.db,
      "offer-acceptance",
      acceptedOfferSeed.offerId,
    );
    if (existingAcceptedOfferOrderIds.length > 0) {
      console.log(
        `  Accepted-offer order already seeded (${existingAcceptedOfferOrderIds.join(", ")})`,
      );
    } else {
      const acceptedOfferInput = await getAcceptedOfferInput(
        ordering,
        acceptedOfferSeed.offerId,
      );

      await ordering.orders.createOrdersFromAcceptedOffer(
        {
          offerId: acceptedOfferSeed.offerId,
          buyerAccountId,
          sellerAccountId: identitySeedIds.demo.accountId,
          catalogItemId: acceptedOfferSeed.catalogItemId,
          productId: acceptedOfferInput?.product_id ?? "",
          itemTitle: acceptedOfferSeed.itemTitle,
          itemSubtitle: acceptedOfferSeed.itemSubtitle,
          selectedOptions: [...acceptedOfferSeed.selectedOptions],
          productSummary: acceptedOfferSeed.productSummary,
          priceAmount: acceptedOfferSeed.priceAmount,
          marketplaceSalesFeeUnitAmount:
            acceptedOfferInput?.marketplace_sales_fee_unit_amount ?? "0.00",
          sellerNetUnitAmount:
            acceptedOfferInput?.seller_net_unit_amount ?? "44.00",
          termsScheduleId: acceptedOfferInput?.terms_schedule_id ?? null,
          termsAgreementId: acceptedOfferInput?.terms_agreement_id ?? null,
          termsResolvedAt:
            acceptedOfferInput?.terms_resolved_at ?? new Date().toISOString(),
          shippingDestinationSnapshot: seedShippingAddress,
          quantityRequested: acceptedOfferSeed.quantityRequested,
          orderIdsOverride: [orderingReservedSeedIds.orders.acceptedOfferReady],
        },
        sellerContext,
      );
      await drainProjectors(ordering.projectors);
      console.log(
        `  Accepted-offer order seeded (${orderingReservedSeedIds.orders.acceptedOfferReady})`,
      );
    }
  }

  console.log("\nOrdering seed complete!");
}
