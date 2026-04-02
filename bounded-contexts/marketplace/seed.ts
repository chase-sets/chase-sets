import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  catalogSeedIds,
  demoIdentitySeedIds,
  inventorySeedIds,
  marketplaceReservedSeedIds,
} from "@chase-sets/dev-seeds";
import type { ListingId, OfferId } from "@chase-sets/primitives/typed-ids";
import {
  resolveSellableUnitDescriptor,
  type CatalogVersionSchema,
} from "@chase-sets/sellable-units";
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
    versionSelection: rawNearMintVersionSelection,
    versionSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "350.00",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.charizardBaseSetPlayset,
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    versionSelection: rawNearMintVersionSelection,
    versionSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "325.00",
    quantityRequested: 2,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuJungleCollectorLot,
    catalogItemId: catalogSeedIds.items.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    versionSelection: rawExcellentVersionSelection,
    versionSummary: "Form: Raw | Condition: Excellent",
    priceAmount: "18.25",
    quantityRequested: 4,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.lugiaNeoGenesisCollector,
    catalogItemId: catalogSeedIds.items.lugiaNeoGenesis,
    itemTitle: "Lugia",
    itemSubtitle: "Neo Genesis 9/111 Holo Rare",
    versionSelection: rawNearMintVersionSelection,
    versionSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "215.00",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuPrismaticEvolutionsModern,
    catalogItemId: catalogSeedIds.items.pikachuPrismaticEvolutions,
    itemTitle: "Pikachu",
    itemSubtitle: "Prismatic Evolutions 025 Illustration Rare",
    versionSelection: rawNearMintVersionSelection,
    versionSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "14.50",
    quantityRequested: 3,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.prismaticEvolutionsBoosterPackLot,
    catalogItemId: catalogSeedIds.items.prismaticEvolutionsBoosterPack,
    itemTitle: "Prismatic Evolutions Booster Pack",
    itemSubtitle: "Sealed booster pack",
    versionSelection: [],
    versionSummary: null,
    priceAmount: "5.25",
    quantityRequested: 10,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.surgingSparksBoosterBoxRestock,
    catalogItemId: catalogSeedIds.items.surgingSparksBoosterBox,
    itemTitle: "Surging Sparks Booster Box",
    itemSubtitle: "Sealed booster box",
    versionSelection: [],
    versionSummary: null,
    priceAmount: "128.00",
    quantityRequested: 2,
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

async function getCatalogVersionKey(
  services: ReturnType<typeof createMarketplaceServices>,
  catalogItemId: string,
  selection: readonly { dimensionId: string; choiceId: string }[],
) {
  const result = await services.db.query<{ version_schema: unknown }>(
    `SELECT version_schema
     FROM inventory_catalog_items
     WHERE item_id = $1`,
    [catalogItemId],
  );
  const versionSchema = result.rows[0]?.version_schema;

  return resolveSellableUnitDescriptor({
    catalogItemId,
    versionSchema:
      typeof versionSchema === "object" && versionSchema !== null
        ? (versionSchema as CatalogVersionSchema)
        : null,
    selection,
  }).catalogVersionKey;
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
        catalogVersionKey: supply.catalog_version_key as never,
        itemTitle: supply.item_title,
        itemSubtitle: supply.item_subtitle,
        versionSelection: supply.version_selection,
        versionSummary: supply.version_summary,
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
        catalogVersionKey: await getCatalogVersionKey(
          services,
          offer.catalogItemId,
          offer.versionSelection,
        ),
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
