import type { Projector } from "@chase-sets/event-core/projector";
import type {
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { catalogSeedIds } from "@chase-sets/catalog/seed-support/ids";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { orderingReservedSeedIds } from "../seed-support/ids";
import {
  createOrderingServices,
  type OrderingServices,
} from "./services";

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
    catalogItemId: catalogSeedIds.items.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    quantity: 2,
  },
] as const;

const cancelledCartLines = [
  {
    catalogItemId: catalogSeedIds.items.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    quantity: 1,
  },
] as const;

const acceptedOfferSeed = {
  offerId: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
  catalogItemId: catalogSeedIds.items.twilightMasqueradeEliteTrainerBox,
  itemTitle: "Twilight Masquerade Elite Trainer Box",
  itemSubtitle: "Sealed elite trainer box",
  selectedOptions: [] as const,
  productSummary: null,
  priceAmount: "44.00",
  quantityRequested: 1,
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

async function buildCheckoutLine(
  services: ReturnType<typeof createOrderingServices>,
  line: (typeof checkoutCartLines)[number] | (typeof cancelledCartLines)[number],
) {
  const result = await services.db.query<{
    product_id: string;
    selected_options: unknown;
  }>(
    `SELECT product_id, selected_options
     FROM ordering_market_listing_inputs
     WHERE catalog_catalog_item_id = $1
       AND product_summary = $2
       AND status = 'active'
     ORDER BY price_amount ASC, listing_id ASC
     LIMIT 1`,
    [line.catalogItemId, line.productSummary],
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
      ? (snapshot.selected_options as { dimensionId: string; optionId: string }[])
      : [...line.selectedOptions],
    productSummary: line.productSummary,
    quantity: line.quantity,
  };
}

async function getOfferProductId(
  services: ReturnType<typeof createOrderingServices>,
  offerId: string,
) {
  const result = await services.db.query<{ product_id: string }>(
    `SELECT product_id
     FROM ordering_offer_acceptance_inputs
     WHERE offer_id = $1`,
    [offerId],
  );

  return result.rows[0]?.product_id;
}

export async function seedOrderingDatabase(
  pool: PgTransactionalPool,
  ordering: OrderingServices = createOrderingServices(pool),
) {
  const buyerAccountId = identitySeedIds.collector.accountId;

  try {
    const [hasCheckoutPending, hasCancelledOrder, hasAcceptedOfferOrder] =
      await Promise.all([
        hasOrderPage(ordering.db, orderingReservedSeedIds.orders.checkoutPending),
        hasOrderPage(ordering.db, orderingReservedSeedIds.orders.cancelled),
        hasOrderPage(ordering.db, orderingReservedSeedIds.orders.acceptedOfferReady),
      ]);

    if (
      hasCheckoutPending &&
      hasCancelledOrder &&
      hasAcceptedOfferOrder
    ) {
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

  if (!(await hasOrderPage(ordering.db, orderingReservedSeedIds.orders.checkoutPending))) {
    const checkoutResult = await ordering.orders.createOrdersFromCheckout(
      {
        buyerAccountId,
        checkoutSessionId: "chk_seed_checkout_pending",
        sourceType: "cart-checkout",
        shippingOption: "standard",
        lines: [await buildCheckoutLine(ordering, checkoutCartLines[0]!)],
        orderIdsOverride: [orderingReservedSeedIds.orders.checkoutPending],
      },
      buyerContext,
    );
    await drainProjectors(ordering.projectors);
    console.log(`  Pending checkout order seeded (${checkoutResult.orderIds.join(", ")})`);
  }

  if (!(await hasOrderPage(ordering.db, orderingReservedSeedIds.orders.cancelled))) {
    const cancelledOrderResult = await ordering.orders.createOrdersFromCheckout(
      {
        buyerAccountId,
        checkoutSessionId: "chk_seed_cancelled",
        sourceType: "cart-checkout",
        shippingOption: "expedited",
        lines: [await buildCheckoutLine(ordering, cancelledCartLines[0]!)],
        orderIdsOverride: [orderingReservedSeedIds.orders.cancelled],
      },
      buyerContext,
    );
    await drainProjectors(ordering.projectors);

    const cancelledOrderId = cancelledOrderResult.orderIds[0];
    if (!cancelledOrderId) {
      throw new Error("Ordering demo seed could not create the cancellable order.");
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

  if (!(await hasOrderPage(ordering.db, orderingReservedSeedIds.orders.acceptedOfferReady))) {
    await ordering.orders.createOrdersFromAcceptedOffer(
      {
        offerId: acceptedOfferSeed.offerId,
        buyerAccountId,
        sellerAccountId: identitySeedIds.demo.accountId,
        catalogItemId: acceptedOfferSeed.catalogItemId,
        productId: (await getOfferProductId(ordering, acceptedOfferSeed.offerId)) ?? "",
        itemTitle: acceptedOfferSeed.itemTitle,
        itemSubtitle: acceptedOfferSeed.itemSubtitle,
        selectedOptions: [...acceptedOfferSeed.selectedOptions],
        productSummary: acceptedOfferSeed.productSummary,
        priceAmount: acceptedOfferSeed.priceAmount,
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

  console.log("\nOrdering seed complete!");
}
