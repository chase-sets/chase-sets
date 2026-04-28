import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { catalogSeedIds } from "@chase-sets/catalog/seed-support/ids";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { inventorySeedIds } from "@chase-sets/inventory/seed-support/ids";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import type { ListingId, OfferId } from "@chase-sets/primitives/typed-ids";
import {
  createMarketplaceProductDescriptor,
  type MarketplaceVersionSchema,
} from "../../features/offers/domain/versioning";
import { createMarketplaceServices } from "./services";

type ListingSeed = Readonly<{
  listingId: ListingId;
  inventoryRecordId: string;
  catalogItemId: string;
  priceAmount: string;
  quantityCap: number;
  finalStatus: "draft" | "active" | "paused" | "withdrawn";
}>;

type OfferSeed = Readonly<{
  offerId: OfferId;
  catalogItemId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  priceAmount: string;
  quantityRequested: number;
}>;

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

const listings: readonly ListingSeed[] = [
  {
    listingId: marketplaceReservedSeedIds.listings.charizardBaseSetNearMint,
    inventoryRecordId: inventorySeedIds.records.charizardBaseSetNearMint,
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
    priceAmount: "399.99",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.pikachuJungleLightlyPlayed,
    inventoryRecordId: inventorySeedIds.records.pikachuJungleLightlyPlayed,
    catalogItemId: catalogSeedIds.items.pikachuJungle,
    priceAmount: "21.50",
    quantityCap: 3,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.lugiaNeoGenesisDraft,
    inventoryRecordId: inventorySeedIds.records.lugiaNeoGenesisNearMint,
    catalogItemId: catalogSeedIds.items.lugiaNeoGenesis,
    priceAmount: "229.00",
    quantityCap: 1,
    finalStatus: "draft",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.prismaticEvolutionsPaused,
    inventoryRecordId: inventorySeedIds.records.pikachuPrismaticEvolutionsNearMint,
    catalogItemId: catalogSeedIds.items.pikachuPrismaticEvolutions,
    priceAmount: "16.25",
    quantityCap: 4,
    finalStatus: "paused",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.surgingSparksWithdrawn,
    inventoryRecordId: inventorySeedIds.records.surgingSparksBoosterBox,
    catalogItemId: catalogSeedIds.items.surgingSparksBoosterBox,
    priceAmount: "132.00",
    quantityCap: 1,
    finalStatus: "withdrawn",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.twilightMasqueradeEliteTrainerActive,
    inventoryRecordId: inventorySeedIds.records.twilightMasqueradeEliteTrainerBox,
    catalogItemId: catalogSeedIds.items.twilightMasqueradeEliteTrainerBox,
    priceAmount: "46.00",
    quantityCap: 2,
    finalStatus: "active",
  },
];

const offers: readonly OfferSeed[] = [
  {
    offerId: marketplaceReservedSeedIds.offers.charizardBaseSetNearMint,
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "350.00",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.charizardBaseSetPlayset,
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "325.00",
    quantityRequested: 2,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuJungleCollectorLot,
    catalogItemId: catalogSeedIds.items.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    priceAmount: "18.25",
    quantityRequested: 4,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuJungleQuickSale,
    catalogItemId: catalogSeedIds.items.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    priceAmount: "17.75",
    quantityRequested: 2,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.lugiaNeoGenesisCollector,
    catalogItemId: catalogSeedIds.items.lugiaNeoGenesis,
    itemTitle: "Lugia",
    itemSubtitle: "Neo Genesis 9/111 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "215.00",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuPrismaticEvolutionsModern,
    catalogItemId: catalogSeedIds.items.pikachuPrismaticEvolutions,
    itemTitle: "Pikachu",
    itemSubtitle: "Prismatic Evolutions 025 Illustration Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "14.50",
    quantityRequested: 3,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.prismaticEvolutionsBoosterPackLot,
    catalogItemId: catalogSeedIds.items.prismaticEvolutionsBoosterPack,
    itemTitle: "Prismatic Evolutions Booster Pack",
    itemSubtitle: "Sealed booster pack",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "5.25",
    quantityRequested: 10,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.surgingSparksBoosterBoxRestock,
    catalogItemId: catalogSeedIds.items.surgingSparksBoosterBox,
    itemTitle: "Surging Sparks Booster Box",
    itemSubtitle: "Sealed booster box",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "128.00",
    quantityRequested: 2,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
    catalogItemId: catalogSeedIds.items.twilightMasqueradeEliteTrainerBox,
    itemTitle: "Twilight Masquerade Elite Trainer Box",
    itemSubtitle: "Sealed elite trainer box",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "44.00",
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

async function getProductId(
  services: ReturnType<typeof createMarketplaceServices>,
  catalogItemId: string,
  selection: readonly { dimensionId: string; optionId: string }[],
) {
  const result = await services.db.query<{ product_schema: unknown }>(
    `SELECT product_schema
     FROM marketplace_catalog_items
     WHERE catalog_item_id = $1`,
    [catalogItemId],
  );
  const productSchema = result.rows[0]?.product_schema;

  return createMarketplaceProductDescriptor({
    catalogItemId,
    productSchema:
      typeof productSchema === "object" && productSchema !== null
        ? (productSchema as MarketplaceVersionSchema)
        : null,
    selection,
  }).productId;
}

function createSeedContext() {
  return createSeedContextFor(identitySeedIds.seller.accountId, identitySeedIds.seller.userId);
}

function createSeedContextFor(accountId: string, userId: string) {
  return {
    tenantId: "tnt_identity" as never,
    audit: {
      performedByUserId: userId as never,
      forAccountId: accountId as never,
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
  const buyerContext = createSeedContextFor(
    identitySeedIds.buyer.accountId,
    identitySeedIds.buyer.userId,
  );

  for (const listing of listings) {
    const supply = await services.listings.getInventoryRecordSupply(
      listing.inventoryRecordId,
      identitySeedIds.seller.accountId,
    );

    if (!supply) {
      continue;
    }

    const seededListingId = listing.listingId;
    await services.listings.createListing(
      {
        accountId: identitySeedIds.seller.accountId,
        inventoryRecordId: supply.record_id,
        priceAmount: listing.priceAmount,
        quantityCap: listing.quantityCap,
        listingIdOverride: seededListingId,
      },
      context,
    );

    if (listing.finalStatus !== "draft") {
      await services.listings.publishListing(
        {
          accountId: identitySeedIds.seller.accountId,
          listingId: seededListingId,
        },
        context,
      );
    }

    if (listing.finalStatus === "paused") {
      await services.listings.pauseListing(
        {
          accountId: identitySeedIds.seller.accountId,
          listingId: seededListingId,
        },
        context,
      );
    }

    if (listing.finalStatus === "withdrawn") {
      await services.listings.withdrawListing(
        {
          accountId: identitySeedIds.seller.accountId,
          listingId: seededListingId,
        },
        context,
      );
    }
  }

  for (const offer of offers) {
    await services.offers.commandHandler({
      streamId: `marketplace.offer-${offer.offerId}`,
      command: {
        type: "SubmitOffer",
        offerId: offer.offerId,
        buyerAccountId: identitySeedIds.buyer.accountId,
        catalogItemId: offer.catalogItemId,
        productId: await getProductId(
          services,
          offer.catalogItemId,
          offer.selectedOptions,
        ),
        itemTitle: offer.itemTitle,
        itemSubtitle: offer.itemSubtitle,
        selectedOptions: offer.selectedOptions,
        productSummary: offer.productSummary,
        priceAmount: offer.priceAmount,
        quantityRequested: offer.quantityRequested,
      },
      context: buyerContext,
    });
  }

  await drainProjectors(services.projectors);

  await services.offers.acceptOffer(
    {
      offerId: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
      sellerAccountId: identitySeedIds.seller.accountId,
    },
    context,
  );
  await drainProjectors(services.projectors);
}
