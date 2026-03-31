import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  catalogSeedIds,
  demoIdentitySeedIds,
  inventorySeedIds,
  marketplaceReservedSeedIds,
} from "@chase-sets/dev-seeds";
import type { ListingId, OfferId } from "@chase-sets/primitives/typed-ids";
import { createMarketplaceServices } from "./services";

type ListingSeed = Readonly<{
  listingId: ListingId;
  inventoryRecordId: string;
  catalogItemId: string;
  priceAmount: string;
  quantityCap: number;
}>;

type OfferSeed = Readonly<{
  offerId: OfferId;
  catalogItemId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  versionSelection: readonly { dimensionId: string; choiceId: string }[];
  versionSummary: string | null;
  priceAmount: string;
  quantityRequested: number;
}>;

const listings: readonly ListingSeed[] = [
  {
    listingId: marketplaceReservedSeedIds.listings.charizardBaseSetNearMint,
    inventoryRecordId: inventorySeedIds.records.charizardBaseSetNearMint,
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
    priceAmount: "399.99",
    quantityCap: 2,
  },
  {
    listingId: marketplaceReservedSeedIds.listings.pikachuJungleLightlyPlayed,
    inventoryRecordId: inventorySeedIds.records.pikachuJungleLightlyPlayed,
    catalogItemId: catalogSeedIds.items.pikachuJungle,
    priceAmount: "21.50",
    quantityCap: 3,
  },
];

const offers: readonly OfferSeed[] = [
  {
    offerId: marketplaceReservedSeedIds.offers.charizardBaseSetNearMint,
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    versionSelection: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        choiceId: catalogSeedIds.dimensions.form.choiceIds.raw,
      },
    ],
    versionSummary: "Form: Raw",
    priceAmount: "350.00",
    quantityRequested: 1,
  },
];

async function drainProjectors(projectors: ReturnType<typeof createMarketplaceServices>["projectors"]) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

function createSeedContext() {
  return {
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: demoIdentitySeedIds.userId,
      forAccountId: demoIdentitySeedIds.accountId,
    },
  };
}

export async function seedMarketplaceDatabase(pool: PgTransactionalPool) {
  const services = createMarketplaceServices(pool);

  try {
    const existing = await services.db.query(
      "SELECT COUNT(*) AS count FROM marketplace_listing_pages",
    );

    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Marketplace already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const context = createSeedContext();

  for (const listing of listings) {
    const supply = await services.listings.getInventoryRecordSupply(
      listing.inventoryRecordId,
      demoIdentitySeedIds.accountId,
    );

    if (!supply) {
      continue;
    }

    await services.listings.commandHandler({
      streamId: `marketplace.listing-${listing.listingId}`,
      command: {
        type: "CreateListing",
        listingId: listing.listingId,
        accountId: demoIdentitySeedIds.accountId,
        inventoryRecordId: supply.record_id,
        catalogItemId: supply.catalog_item_id,
        itemTitle: supply.item_title,
        itemSubtitle: supply.item_subtitle,
        versionSelection: supply.version_selection,
        versionSummary: supply.version_summary,
        condition: supply.condition,
        storageLocationName: supply.storage_location_name,
        shipFromCode: supply.ship_from_code,
        priceAmount: listing.priceAmount,
        quantityCap: listing.quantityCap,
      },
      context,
    });

    await services.listings.commandHandler({
      streamId: `marketplace.listing-${listing.listingId}`,
      command: { type: "PublishListing" },
      context,
    });
  }

  for (const offer of offers) {
    await services.offers.commandHandler({
      streamId: `marketplace.offer-${offer.offerId}`,
      command: {
        type: "SubmitOffer",
        offerId: offer.offerId,
        buyerAccountId: demoIdentitySeedIds.accountId,
        catalogItemId: offer.catalogItemId,
        itemTitle: offer.itemTitle,
        itemSubtitle: offer.itemSubtitle,
        versionSelection: offer.versionSelection,
        versionSummary: offer.versionSummary,
        priceAmount: offer.priceAmount,
        quantityRequested: offer.quantityRequested,
      },
      context,
    });
  }

  await drainProjectors(services.projectors);
}
