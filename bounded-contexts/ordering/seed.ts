import type { Projector } from "@chase-sets/event-core/projector";
import type {
  PgQueryable,
  PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import {
  catalogSeedIds,
  demoIdentitySeedIds,
} from "@chase-sets/dev-seeds";
import { createInventoryServices } from "@chase-sets/inventory";
import { createMarketplaceServices } from "@chase-sets/marketplace-context";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  resolveSellableUnitDescriptor,
  type CatalogVersionSchema,
} from "@chase-sets/sellable-units";
import { createOrderingServices } from "./services";

const rawNearMintVersionSelection = [
  {
    dimensionId: catalogSeedIds.dimensions.form.dimensionId,
    choiceId: catalogSeedIds.dimensions.form.choiceIds.raw,
  },
  {
    dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
    choiceId: catalogSeedIds.dimensions.condition.choiceIds.nearMint,
  },
] as const;

const rawExcellentVersionSelection = [
  {
    dimensionId: catalogSeedIds.dimensions.form.dimensionId,
    choiceId: catalogSeedIds.dimensions.form.choiceIds.raw,
  },
  {
    dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
    choiceId: catalogSeedIds.dimensions.condition.choiceIds.excellent,
  },
] as const;

const checkoutCartLines = [
  {
    catalogItemId: catalogSeedIds.items.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    versionSelection: rawExcellentVersionSelection,
    versionSummary: "Form: Raw | Condition: Excellent",
    quantity: 2,
  },
] as const;

const cancelledCartLines = [
  {
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    versionSelection: rawNearMintVersionSelection,
    versionSummary: "Form: Raw | Condition: Near Mint",
    quantity: 1,
  },
] as const;

const activeCartLines = [
  {
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    versionSelection: rawNearMintVersionSelection,
    versionSummary: "Form: Raw | Condition: Near Mint",
    quantity: 1,
  },
  {
    catalogItemId: catalogSeedIds.items.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    versionSelection: rawExcellentVersionSelection,
    versionSummary: "Form: Raw | Condition: Excellent",
    quantity: 1,
  },
] as const;

const acceptedOfferSeed = {
  catalogItemId: catalogSeedIds.items.pikachuJungle,
  itemTitle: "Pikachu",
  itemSubtitle: "Jungle 60/64 Common",
  versionSelection: rawExcellentVersionSelection,
  versionSummary: "Form: Raw | Condition: Excellent",
  priceAmount: "19.25",
  quantityRequested: 2,
} as const;

function createSeedContext() {
  return {
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: demoIdentitySeedIds.userId,
      forAccountId: demoIdentitySeedIds.accountId,
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

async function countOrderingEvents(db: PgQueryable) {
  const result = await db.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE 'ordering.%'",
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function countMarketplaceDependencies(db: PgQueryable) {
  const result = await db.query<{
    listing_count: string;
    offer_count: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM marketplace_listing_pages) AS listing_count,
       (SELECT COUNT(*) FROM marketplace_offer_pages) AS offer_count`,
  );

  return {
    listingCount: Number(result.rows[0]?.listing_count ?? 0),
    offerCount: Number(result.rows[0]?.offer_count ?? 0),
  };
}

async function addCartLines(
  services: ReturnType<typeof createOrderingServices>,
  inventory: ReturnType<typeof createInventoryServices>,
  buyerAccountId: AccountId,
  lines: typeof checkoutCartLines | typeof cancelledCartLines | typeof activeCartLines,
  context: ReturnType<typeof createSeedContext>,
) {
  for (const line of lines) {
    const catalogItem = await inventory.catalogItems.getCatalogItem(line.catalogItemId);
    if (!catalogItem) {
      throw new Error(`Catalog item ${line.catalogItemId} not found for ordering seed.`);
    }

    const sellableUnit = resolveSellableUnitDescriptor({
      catalogItemId: line.catalogItemId,
      versionSchema:
        typeof catalogItem.version_schema === "object" && catalogItem.version_schema !== null
          ? (catalogItem.version_schema as CatalogVersionSchema)
          : null,
      selection: line.versionSelection,
    });

    await services.cart.addLine(
      {
        buyerAccountId,
        catalogItemId: line.catalogItemId,
        catalogVersionKey: sellableUnit.catalogVersionKey,
        itemTitle: line.itemTitle,
        itemSubtitle: line.itemSubtitle,
        versionSelection: line.versionSelection,
        versionSummary: line.versionSummary,
        quantity: line.quantity,
      },
      context,
    );
  }
}

async function getOfferAcceptanceOrderId(db: PgQueryable, offerId: string) {
  const result = await db.query<{ order_id: string }>(
    `SELECT order_id
     FROM ordering_order_pages
     WHERE source_type = 'offer-acceptance'
       AND source_reference_id = $1
     ORDER BY created_at DESC, order_id DESC
     LIMIT 1`,
    [offerId],
  );

  return result.rows[0]?.order_id ?? null;
}

export async function seedOrderingDatabase(pool: PgTransactionalPool) {
  const inventory = createInventoryServices(pool);
  const marketplace = createMarketplaceServices(pool);
  const ordering = createOrderingServices(pool, {
    inventoryReservations: {
      createReservation: async ({
        sellerAccountId,
        inventoryRecordId,
        quantity,
        reason,
        notes,
        context,
      }) => {
        const result = await inventory.holds.createHold(
          {
            accountId: sellerAccountId,
            recordId: inventoryRecordId,
            quantity,
            reason,
            notes,
          },
          context as never,
        );

        return {
          holdId: result.holdId,
          inventoryRecordId,
          sellerAccountId,
          quantity,
        };
      },
      releaseReservation: async ({ sellerAccountId, holdId, context }) => {
        await inventory.holds.releaseHold(
          {
            accountId: sellerAccountId,
            holdId,
          },
          context as never,
        );
      },
    },
  });

  try {
    if ((await countOrderingEvents(ordering.db)) > 0) {
      console.log("Ordering already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Event store tables may not exist yet. Proceed with seeding.
  }

  await drainProjectors([
    ...inventory.projectors,
    ...marketplace.projectors,
    ...ordering.projectors,
  ]);

  const dependencies = await countMarketplaceDependencies(ordering.db);
  if (dependencies.listingCount === 0 || dependencies.offerCount === 0) {
    throw new Error(
      "Ordering demo seed requires marketplace listings and offers. Seed marketplace first.",
    );
  }

  console.log("Starting ordering development seed...\n");

  const context = createSeedContext();
  const buyerAccountId = demoIdentitySeedIds.accountId;

  await addCartLines(ordering, inventory, buyerAccountId, checkoutCartLines, context);
  await drainProjectors([
    ...inventory.projectors,
    ...marketplace.projectors,
    ...ordering.projectors,
  ]);
  const checkoutResult = await ordering.orders.checkoutCart(
    {
      buyerAccountId,
      shippingOption: "standard",
    },
    context,
  );
  await drainProjectors([
    ...inventory.projectors,
    ...marketplace.projectors,
    ...ordering.projectors,
  ]);
  console.log(`  Pending checkout order seeded (${checkoutResult.orderIds.join(", ")})`);

  await addCartLines(ordering, inventory, buyerAccountId, cancelledCartLines, context);
  await drainProjectors([
    ...inventory.projectors,
    ...marketplace.projectors,
    ...ordering.projectors,
  ]);
  const cancelledOrderResult = await ordering.orders.checkoutCart(
    {
      buyerAccountId,
      shippingOption: "expedited",
    },
    context,
  );
  await drainProjectors([
    ...inventory.projectors,
    ...marketplace.projectors,
    ...ordering.projectors,
  ]);

  const cancelledOrderId = cancelledOrderResult.orderIds[0];
  if (!cancelledOrderId) {
    throw new Error("Ordering demo seed could not create the cancellable order.");
  }

  await ordering.orders.cancelBuyerOrder(
    {
      orderId: cancelledOrderId,
      buyerAccountId,
    },
    context,
  );
  await drainProjectors([
    ...inventory.projectors,
    ...marketplace.projectors,
    ...ordering.projectors,
  ]);
  console.log(`  Cancelled order seeded (${cancelledOrderId})`);

  const acceptedOffer = await marketplace.offers.submitOffer(
    {
      buyerAccountId,
      catalogItemId: acceptedOfferSeed.catalogItemId,
      catalogVersionKey: resolveSellableUnitDescriptor({
        catalogItemId: acceptedOfferSeed.catalogItemId,
        versionSchema: (
          (
            await inventory.catalogItems.getCatalogItem(acceptedOfferSeed.catalogItemId)
          )?.version_schema ?? null
        ) as CatalogVersionSchema | null,
        selection: acceptedOfferSeed.versionSelection,
      }).catalogVersionKey,
      itemTitle: acceptedOfferSeed.itemTitle,
      itemSubtitle: acceptedOfferSeed.itemSubtitle,
      versionSelection: acceptedOfferSeed.versionSelection,
      versionSummary: acceptedOfferSeed.versionSummary,
      priceAmount: acceptedOfferSeed.priceAmount,
      quantityRequested: acceptedOfferSeed.quantityRequested,
    },
    context,
  );
  await drainProjectors([
    ...inventory.projectors,
    ...marketplace.projectors,
    ...ordering.projectors,
  ]);

  await marketplace.offers.acceptOffer(
    {
      offerId: acceptedOffer.offerId,
      sellerAccountId: demoIdentitySeedIds.accountId,
    },
    context,
  );
  await drainProjectors([
    ...inventory.projectors,
    ...marketplace.projectors,
    ...ordering.projectors,
  ]);

  const acceptedOfferOrderId = await getOfferAcceptanceOrderId(
    ordering.db,
    acceptedOffer.offerId,
  );
  if (!acceptedOfferOrderId) {
    throw new Error("Ordering demo seed could not create the accepted-offer order.");
  }
  console.log(`  Accepted-offer order seeded (${acceptedOfferOrderId})`);

  await addCartLines(ordering, inventory, buyerAccountId, activeCartLines, context);
  await drainProjectors([
    ...inventory.projectors,
    ...marketplace.projectors,
    ...ordering.projectors,
  ]);
  console.log(`  Active cart seeded for ${buyerAccountId}`);

  console.log("\nOrdering seed complete!");
}
