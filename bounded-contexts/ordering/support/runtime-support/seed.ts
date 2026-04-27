import type { Projector } from "@chase-sets/event-core/projector";
import type {
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import { catalogSeedIds } from "@chase-sets/catalog/seed-support/ids";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  createOrderingProductDescriptor,
  type OrderingVersionSchema,
} from "./common";
import { orderingReservedSeedIds } from "../seed-support/ids";
import { createOrderingServices } from "./services";

const rawNearMintVersionSelection = [
  {
    dimensionId: catalogSeedIds.dimensions.form.dimensionId,
    optionId: catalogSeedIds.dimensions.form.optionIds.raw,
  },
  {
    dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
    optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
  },
] as const;

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

const activeCartLines = [
  {
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    quantity: 1,
  },
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

async function hasActiveCartLines(db: PgQueryable, buyerAccountId: AccountId) {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM ordering_cart_line_pages
     WHERE buyer_account_id = $1`,
    [buyerAccountId],
  );
  return Number(result.rows[0]?.count ?? 0) > 0;
}

async function addCartLines(
  services: ReturnType<typeof createOrderingServices>,
  buyerAccountId: AccountId,
  lines: typeof checkoutCartLines | typeof cancelledCartLines | typeof activeCartLines,
  context: ReturnType<typeof createSeedContextFor>,
) {
  for (const line of lines) {
    const catalogItem = await services.db.query<{
      product_schema: unknown;
    }>(
      `SELECT product_schema
       FROM ordering_catalog_items
       WHERE catalog_item_id = $1`,
      [line.catalogItemId],
    );
    const productSchema = catalogItem.rows[0]?.product_schema ?? null;

    if (productSchema === null) {
      throw new Error(`Catalog item ${line.catalogItemId} not found for ordering seed.`);
    }

    const catalogVersion = createOrderingProductDescriptor({
      catalogItemId: line.catalogItemId,
      productSchema:
        typeof productSchema === "object" && productSchema !== null
          ? (productSchema as OrderingVersionSchema)
          : null,
      selection: line.selectedOptions,
    });

    await services.cart.addLine(
      {
        buyerAccountId,
        catalogItemId: line.catalogItemId,
        productId: catalogVersion.productId,
        itemTitle: line.itemTitle,
        itemSubtitle: line.itemSubtitle,
        selectedOptions: catalogVersion.selection,
        productSummary: line.productSummary,
        quantity: line.quantity,
      },
      context,
    );
  }
}

async function getProductId(
  services: ReturnType<typeof createOrderingServices>,
  catalogItemId: string,
  selection: readonly { dimensionId: string; optionId: string }[],
) {
  const result = await services.db.query<{ product_schema: unknown }>(
    `SELECT product_schema
     FROM ordering_catalog_items
     WHERE catalog_item_id = $1`,
    [catalogItemId],
  );
  const productSchema = result.rows[0]?.product_schema;

  return createOrderingProductDescriptor({
    catalogItemId,
    productSchema:
      typeof productSchema === "object" && productSchema !== null
        ? (productSchema as OrderingVersionSchema)
        : null,
    selection,
  }).productId;
}

export async function seedOrderingDatabase(pool: PgTransactionalPool) {
  const ordering = createOrderingServices(pool);
  const buyerAccountId = identitySeedIds.buyer.accountId;

  try {
    const [hasCheckoutPending, hasCancelledOrder, hasAcceptedOfferOrder, hasBuyerCart] =
      await Promise.all([
        hasOrderPage(ordering.db, orderingReservedSeedIds.orders.checkoutPending),
        hasOrderPage(ordering.db, orderingReservedSeedIds.orders.cancelled),
        hasOrderPage(ordering.db, orderingReservedSeedIds.orders.acceptedOfferReady),
        hasActiveCartLines(ordering.db, buyerAccountId),
      ]);

    if (
      hasCheckoutPending &&
      hasCancelledOrder &&
      hasAcceptedOfferOrder &&
      hasBuyerCart
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
    identitySeedIds.buyer.accountId,
    identitySeedIds.buyer.userId,
  );
  const sellerContext = createSeedContextFor(
    identitySeedIds.seller.accountId,
    identitySeedIds.seller.userId,
  );

  if (!(await hasOrderPage(ordering.db, orderingReservedSeedIds.orders.checkoutPending))) {
    await addCartLines(ordering, buyerAccountId, checkoutCartLines, buyerContext);
    await drainProjectors(ordering.projectors);
    const checkoutResult = await ordering.orders.checkoutCart(
      {
        buyerAccountId,
        shippingOption: "standard",
        orderIdsOverride: [orderingReservedSeedIds.orders.checkoutPending],
      },
      buyerContext,
    );
    await drainProjectors(ordering.projectors);
    console.log(`  Pending checkout order seeded (${checkoutResult.orderIds.join(", ")})`);
  }

  if (!(await hasOrderPage(ordering.db, orderingReservedSeedIds.orders.cancelled))) {
    await addCartLines(ordering, buyerAccountId, cancelledCartLines, buyerContext);
    await drainProjectors(ordering.projectors);
    const cancelledOrderResult = await ordering.orders.checkoutCart(
      {
        buyerAccountId,
        shippingOption: "expedited",
        orderIdsOverride: [orderingReservedSeedIds.orders.cancelled],
      },
      buyerContext,
    );
    await drainProjectors(ordering.projectors);

    const cancelledOrderId = cancelledOrderResult.orderIds[0];
    if (!cancelledOrderId) {
      throw new Error("Ordering demo seed could not create the cancellable order.");
    }

    await ordering.orders.cancelBuyerOrder(
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
        sellerAccountId: identitySeedIds.seller.accountId,
        catalogItemId: acceptedOfferSeed.catalogItemId,
        productId: await getProductId(
          ordering,
          acceptedOfferSeed.catalogItemId,
          acceptedOfferSeed.selectedOptions,
        ),
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

  if (!(await hasActiveCartLines(ordering.db, buyerAccountId))) {
    await addCartLines(ordering, buyerAccountId, activeCartLines, buyerContext);
    await drainProjectors(ordering.projectors);
    console.log(`  Active cart seeded for ${buyerAccountId}`);
  }

  console.log("\nOrdering seed complete!");
}

