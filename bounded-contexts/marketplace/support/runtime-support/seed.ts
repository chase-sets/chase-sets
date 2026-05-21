import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { catalogSeedIds } from "@chase-sets/catalog/seed-support/ids";
import { catalogScenarioItems } from "@chase-sets/catalog/seed-support/scenario";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { inventorySeedIds } from "@chase-sets/inventory/seed-support/ids";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { AccountId, ListingId, OfferId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  createMarketplaceProductDescriptor,
  type MarketplaceVersionSchema,
} from "../../features/offers/domain/versioning";
import { requiresListingPhotoEvidence } from "../../features/listings/domain/domain";
import type { MarketplaceListingPhotoUpload } from "../../features/listings/api/runtime";
import { createMarketplaceServices, type MarketplaceServices } from "./services";
import sharp from "sharp";

type ListingSeed = Readonly<{
  listingId: ListingId;
  accountId?: AccountId;
  userId?: UserId;
  inventoryItemId: string;
  catalogItemId: string;
  priceAmount: string;
  quantityCap: number;
  finalStatus: "draft" | "active" | "paused" | "withdrawn";
}>;

type OfferSeed = Readonly<{
  offerId: OfferId;
  buyerAccountId?: AccountId;
  buyerUserId?: UserId;
  catalogItemId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  shippingDestinationSnapshot?: AddressSnapshot;
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
  // Both listings and offers, sparse listings.
  {
    listingId: marketplaceReservedSeedIds.listings.charizardBaseSetNearMint,
    inventoryItemId: inventorySeedIds.items.charizardBaseSetNearMint,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    priceAmount: "399.99",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.charizardBaseSetPsa8,
    inventoryItemId: inventorySeedIds.items.charizardBaseSetPsa8,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    priceAmount: "749.00",
    quantityCap: 1,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.cardVaultCharizardNearMint,
    accountId: identitySeedIds.cardVault.accountId,
    userId: identitySeedIds.cardVault.userId,
    inventoryItemId: inventorySeedIds.items.cardVaultCharizardNearMint,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    priceAmount: "389.00",
    quantityCap: 1,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.cardVaultCharizardPsa8,
    accountId: identitySeedIds.cardVault.accountId,
    userId: identitySeedIds.cardVault.userId,
    inventoryItemId: inventorySeedIds.items.cardVaultCharizardPsa8,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    priceAmount: "735.00",
    quantityCap: 1,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.cardVaultCharizardMarketMaker,
    accountId: identitySeedIds.cardVault.accountId,
    userId: identitySeedIds.cardVault.userId,
    inventoryItemId: inventorySeedIds.items.cardVaultCharizardNearMint,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    priceAmount: "412.00",
    quantityCap: 1,
    finalStatus: "active",
  },
  // Both listings and offers, many listings.
  {
    listingId: marketplaceReservedSeedIds.listings.pikachuJungleLightlyPlayed,
    inventoryItemId: inventorySeedIds.items.pikachuJungleLightlyPlayed,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    priceAmount: "21.50",
    quantityCap: 3,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.pikachuJungleValueCopy,
    inventoryItemId: inventorySeedIds.items.pikachuJungleLightlyPlayed,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    priceAmount: "19.99",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.pikachuJunglePremiumCopy,
    inventoryItemId: inventorySeedIds.items.pikachuJungleLightlyPlayed,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    priceAmount: "24.00",
    quantityCap: 1,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.cardVaultPikachuStack,
    accountId: identitySeedIds.cardVault.accountId,
    userId: identitySeedIds.cardVault.userId,
    inventoryItemId: inventorySeedIds.items.cardVaultPikachuExcellent,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    priceAmount: "18.75",
    quantityCap: 6,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.cardVaultPikachuLowMargin,
    accountId: identitySeedIds.cardVault.accountId,
    userId: identitySeedIds.cardVault.userId,
    inventoryItemId: inventorySeedIds.items.cardVaultPikachuExcellent,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    priceAmount: "17.95",
    quantityCap: 4,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.lugiaNeoGenesisDraft,
    inventoryItemId: inventorySeedIds.items.lugiaNeoGenesisNearMint,
    catalogItemId: catalogScenarioItems.lugiaNeoGenesis,
    priceAmount: "229.00",
    quantityCap: 1,
    finalStatus: "draft",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.lugiaNeoGenesisBgs95,
    inventoryItemId: inventorySeedIds.items.lugiaNeoGenesisBgs95,
    catalogItemId: catalogScenarioItems.lugiaNeoGenesis,
    priceAmount: "620.00",
    quantityCap: 1,
    finalStatus: "active",
  },
  // Listings with no offers.
  {
    listingId: marketplaceReservedSeedIds.listings.mewtwoBlackStarPromoActive,
    inventoryItemId: inventorySeedIds.items.mewtwoBlackStarPromoNearMint,
    catalogItemId: catalogScenarioItems.mewtwoBlackStarPromo,
    priceAmount: "48.00",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.mewtwoBlackStarPromoPremium,
    inventoryItemId: inventorySeedIds.items.mewtwoBlackStarPromoNearMint,
    catalogItemId: catalogScenarioItems.mewtwoBlackStarPromo,
    priceAmount: "52.50",
    quantityCap: 1,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.cardVaultMewtwoBudget,
    accountId: identitySeedIds.cardVault.accountId,
    userId: identitySeedIds.cardVault.userId,
    inventoryItemId: inventorySeedIds.items.cardVaultMewtwoNearMint,
    catalogItemId: catalogScenarioItems.mewtwoBlackStarPromo,
    priceAmount: "45.50",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.prismaticEvolutionsPaused,
    inventoryItemId: inventorySeedIds.items.pikachuPrismaticEvolutionsNearMint,
    catalogItemId: catalogScenarioItems.pikachuPrismaticEvolutions,
    priceAmount: "16.25",
    quantityCap: 4,
    finalStatus: "paused",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.pikachuPrismaticEvolutionsPsa10,
    inventoryItemId: inventorySeedIds.items.pikachuPrismaticEvolutionsPsa10,
    catalogItemId: catalogScenarioItems.pikachuPrismaticEvolutions,
    priceAmount: "89.00",
    quantityCap: 1,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.surgingSparksWithdrawn,
    inventoryItemId: inventorySeedIds.items.surgingSparksBoosterBox,
    catalogItemId: catalogScenarioItems.surgingSparksBoosterBox,
    priceAmount: "132.00",
    quantityCap: 1,
    finalStatus: "withdrawn",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.sealedStockroomSurgingSparksActive,
    accountId: identitySeedIds.sealedStockroom.accountId,
    userId: identitySeedIds.sealedStockroom.userId,
    inventoryItemId: inventorySeedIds.items.sealedStockroomSurgingSparksBoosterBox,
    catalogItemId: catalogScenarioItems.surgingSparksBoosterBox,
    priceAmount: "126.00",
    quantityCap: 4,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.sealedStockroomSurgingSparksPremium,
    accountId: identitySeedIds.sealedStockroom.accountId,
    userId: identitySeedIds.sealedStockroom.userId,
    inventoryItemId: inventorySeedIds.items.sealedStockroomSurgingSparksBoosterBox,
    catalogItemId: catalogScenarioItems.surgingSparksBoosterBox,
    priceAmount: "131.50",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.twilightMasqueradeEliteTrainerActive,
    inventoryItemId: inventorySeedIds.items.twilightMasqueradeEliteTrainerBox,
    catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
    priceAmount: "46.00",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.cardVaultTwilightMasqueradeEliteTrainer,
    accountId: identitySeedIds.cardVault.accountId,
    userId: identitySeedIds.cardVault.userId,
    inventoryItemId: inventorySeedIds.items.cardVaultTwilightMasqueradeEliteTrainerBox,
    catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
    priceAmount: "44.75",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.sealedStockroomTwilightMasqueradeEliteTrainer,
    accountId: identitySeedIds.sealedStockroom.accountId,
    userId: identitySeedIds.sealedStockroom.userId,
    inventoryItemId: inventorySeedIds.items.sealedStockroomTwilightMasqueradeEliteTrainerBox,
    catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
    priceAmount: "43.25",
    quantityCap: 4,
    finalStatus: "active",
  },
];

const offers: readonly OfferSeed[] = [
  // Both listings and offers, sparse offers.
  {
    offerId: marketplaceReservedSeedIds.offers.charizardBaseSetNearMint,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "350.00",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.charizardBaseSetPlayset,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "325.00",
    quantityRequested: 2,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.charizardBaseSetHighRoller,
    buyerAccountId: identitySeedIds.highRollerTrader.accountId,
    buyerUserId: identitySeedIds.highRollerTrader.userId,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "380.00",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.charizardBaseSetValueTrader,
    buyerAccountId: identitySeedIds.valueTrader.accountId,
    buyerUserId: identitySeedIds.valueTrader.userId,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    itemTitle: "Charizard",
    itemSubtitle: "Base Set 4/102 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "310.00",
    quantityRequested: 1,
  },
  // Both listings and offers, many offers.
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuJungleCollectorLot,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    priceAmount: "18.25",
    quantityRequested: 4,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuJungleQuickSale,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    priceAmount: "17.75",
    quantityRequested: 2,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuJungleBinderFill,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    priceAmount: "16.50",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuJungleBulkRestock,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    priceAmount: "15.25",
    quantityRequested: 6,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuJungleHighVelocityLot,
    buyerAccountId: identitySeedIds.highRollerTrader.accountId,
    buyerUserId: identitySeedIds.highRollerTrader.userId,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    priceAmount: "18.00",
    quantityRequested: 8,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuJungleFloorBid,
    buyerAccountId: identitySeedIds.valueTrader.accountId,
    buyerUserId: identitySeedIds.valueTrader.userId,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    itemTitle: "Pikachu",
    itemSubtitle: "Jungle 60/64 Common",
    selectedOptions: rawExcellentVersionSelection,
    productSummary: "Form: Raw | Condition: Excellent",
    priceAmount: "13.50",
    quantityRequested: 12,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.lugiaNeoGenesisCollector,
    catalogItemId: catalogScenarioItems.lugiaNeoGenesis,
    itemTitle: "Lugia",
    itemSubtitle: "Neo Genesis 9/111 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "215.00",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.lugiaNeoGenesisHighRoller,
    buyerAccountId: identitySeedIds.highRollerTrader.accountId,
    buyerUserId: identitySeedIds.highRollerTrader.userId,
    catalogItemId: catalogScenarioItems.lugiaNeoGenesis,
    itemTitle: "Lugia",
    itemSubtitle: "Neo Genesis 9/111 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "225.00",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.lugiaNeoGenesisValueTrader,
    buyerAccountId: identitySeedIds.valueTrader.accountId,
    buyerUserId: identitySeedIds.valueTrader.userId,
    catalogItemId: catalogScenarioItems.lugiaNeoGenesis,
    itemTitle: "Lugia",
    itemSubtitle: "Neo Genesis 9/111 Holo Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "190.00",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuPrismaticEvolutionsModern,
    catalogItemId: catalogScenarioItems.pikachuPrismaticEvolutions,
    itemTitle: "Pikachu",
    itemSubtitle: "Prismatic Evolutions 025 Illustration Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "14.50",
    quantityRequested: 3,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.pikachuPrismaticEvolutionsBinder,
    buyerAccountId: identitySeedIds.valueTrader.accountId,
    buyerUserId: identitySeedIds.valueTrader.userId,
    catalogItemId: catalogScenarioItems.pikachuPrismaticEvolutions,
    itemTitle: "Pikachu",
    itemSubtitle: "Prismatic Evolutions 025 Illustration Rare",
    selectedOptions: rawNearMintVersionSelection,
    productSummary: "Form: Raw | Condition: Near Mint",
    priceAmount: "12.75",
    quantityRequested: 5,
  },
  // Offers with no listings.
  {
    offerId: marketplaceReservedSeedIds.offers.prismaticEvolutionsBoosterPackLot,
    catalogItemId: catalogScenarioItems.prismaticEvolutionsBoosterPack,
    itemTitle: "Prismatic Evolutions Booster Pack",
    itemSubtitle: "Sealed booster pack",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "5.25",
    quantityRequested: 10,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.prismaticEvolutionsBoosterPackCaseBreak,
    catalogItemId: catalogScenarioItems.prismaticEvolutionsBoosterPack,
    itemTitle: "Prismatic Evolutions Booster Pack",
    itemSubtitle: "Sealed booster pack",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "4.85",
    quantityRequested: 24,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.prismaticEvolutionsBoosterPackMicroLot,
    buyerAccountId: identitySeedIds.valueTrader.accountId,
    buyerUserId: identitySeedIds.valueTrader.userId,
    catalogItemId: catalogScenarioItems.prismaticEvolutionsBoosterPack,
    itemTitle: "Prismatic Evolutions Booster Pack",
    itemSubtitle: "Sealed booster pack",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "5.00",
    quantityRequested: 4,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.prismaticEvolutionsBoosterPackFloor,
    buyerAccountId: identitySeedIds.highRollerTrader.accountId,
    buyerUserId: identitySeedIds.highRollerTrader.userId,
    catalogItemId: catalogScenarioItems.prismaticEvolutionsBoosterPack,
    itemTitle: "Prismatic Evolutions Booster Pack",
    itemSubtitle: "Sealed booster pack",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "4.50",
    quantityRequested: 48,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.surgingSparksBoosterBoxRestock,
    catalogItemId: catalogScenarioItems.surgingSparksBoosterBox,
    itemTitle: "Surging Sparks Booster Box",
    itemSubtitle: "Sealed booster box",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "128.00",
    quantityRequested: 2,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.surgingSparksBoosterBoxCaseBid,
    buyerAccountId: identitySeedIds.highRollerTrader.accountId,
    buyerUserId: identitySeedIds.highRollerTrader.userId,
    catalogItemId: catalogScenarioItems.surgingSparksBoosterBox,
    itemTitle: "Surging Sparks Booster Box",
    itemSubtitle: "Sealed booster box",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "124.00",
    quantityRequested: 4,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.surgingSparksBoosterBoxValueBid,
    buyerAccountId: identitySeedIds.valueTrader.accountId,
    buyerUserId: identitySeedIds.valueTrader.userId,
    catalogItemId: catalogScenarioItems.surgingSparksBoosterBox,
    itemTitle: "Surging Sparks Booster Box",
    itemSubtitle: "Sealed booster box",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "118.00",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
    catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
    itemTitle: "Twilight Masquerade Elite Trainer Box",
    itemSubtitle: "Sealed elite trainer box",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "44.00",
    quantityRequested: 1,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerBundle,
    buyerAccountId: identitySeedIds.highRollerTrader.accountId,
    buyerUserId: identitySeedIds.highRollerTrader.userId,
    catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
    itemTitle: "Twilight Masquerade Elite Trainer Box",
    itemSubtitle: "Sealed elite trainer box",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "42.25",
    quantityRequested: 4,
  },
  {
    offerId: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerFloor,
    buyerAccountId: identitySeedIds.valueTrader.accountId,
    buyerUserId: identitySeedIds.valueTrader.userId,
    catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
    itemTitle: "Twilight Masquerade Elite Trainer Box",
    itemSubtitle: "Sealed elite trainer box",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "39.00",
    quantityRequested: 6,
  },
];

const defaultOfferDestination: AddressSnapshot = {
  name: "Chase Sets Offer Buyer",
  line1: "100 Market Street",
  line2: null,
  city: "Chicago",
  state: "IL",
  postalCode: "60601",
  country: "US",
  phone: "3125550199",
  email: "buyer@chasesets.test",
};

let seedListingPhotoBodyPromise: Promise<Buffer> | null = null;

async function getSeedListingPhotoBody() {
  seedListingPhotoBodyPromise ??= sharp({
    create: {
      width: 720,
      height: 1008,
      channels: 3,
      background: { r: 245, g: 247, b: 250 },
    },
  })
    .png()
    .toBuffer();

  return seedListingPhotoBodyPromise;
}

async function buildSeedListingPhotoUpload(listing: ListingSeed): Promise<readonly MarketplaceListingPhotoUpload[]> {
  return [
    {
      body: await getSeedListingPhotoBody(),
      contentType: "image/png",
      originalFilename: `${listing.listingId}-condition-evidence.png`,
      altText: "Seed listing condition evidence photo",
    },
  ];
}

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
      typeof productSchema === "object" && productSchema !== null ? (productSchema as MarketplaceVersionSchema) : null,
    selection,
  }).productId;
}

function createSeedContext() {
  return createSeedContextFor(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);
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

export async function seedMarketplaceDatabase(
  pool: PgTransactionalPool,
  services: MarketplaceServices = createMarketplaceServices(pool),
) {
  try {
    const existing = await services.db.query(`
      SELECT
        (
          (SELECT COUNT(*) FROM marketplace_listing_pages) +
          (SELECT COUNT(*) FROM marketplace_offer_pages)
        ) AS count
    `);

    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Marketplace already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const context = createSeedContext();

  for (const listing of listings) {
    const accountId = listing.accountId ?? identitySeedIds.demo.accountId;
    const listingContext = createSeedContextFor(accountId, listing.userId ?? identitySeedIds.demo.userId);
    const supply = await services.listings.getInventoryItemSupply(listing.inventoryItemId, accountId);

    if (!supply) {
      continue;
    }

    const seededListingId = listing.listingId;
    const createdListing = await services.listings.createListing(
      {
        accountId,
        inventoryItemId: supply.item_id,
        priceAmount: listing.priceAmount,
        quantityCap: listing.quantityCap,
        listingIdOverride: seededListingId,
        listingPhotoUploads: requiresListingPhotoEvidence({
          selectedOptions: supply.selected_options,
          productSummary: supply.product_summary,
        })
          ? await buildSeedListingPhotoUpload(listing)
          : [],
      },
      listingContext,
    );

    if (listing.finalStatus !== "draft") {
      await services.listings.publishListing(
        {
          accountId,
          listingId: seededListingId,
          feeQuoteFingerprint: createdListing.feeQuoteFingerprint,
        },
        listingContext,
      );
    }

    if (listing.finalStatus === "paused") {
      await services.listings.pauseListing(
        {
          accountId,
          listingId: seededListingId,
        },
        listingContext,
      );
    }

    if (listing.finalStatus === "withdrawn") {
      await services.listings.withdrawListing(
        {
          accountId,
          listingId: seededListingId,
        },
        listingContext,
      );
    }
  }

  for (const offer of offers) {
    const buyerAccountId = offer.buyerAccountId ?? identitySeedIds.collector.accountId;
    await services.offers.commandHandler({
      streamId: `marketplace.offer-${offer.offerId}`,
      command: {
        type: "SubmitOffer",
        offerId: offer.offerId,
        buyerAccountId,
        catalogItemId: offer.catalogItemId,
        productId: await getProductId(services, offer.catalogItemId, offer.selectedOptions),
        itemTitle: offer.itemTitle,
        itemSubtitle: offer.itemSubtitle,
        selectedOptions: offer.selectedOptions,
        productSummary: offer.productSummary,
        shippingDestinationSnapshot: offer.shippingDestinationSnapshot ?? defaultOfferDestination,
        priceAmount: offer.priceAmount,
        quantityRequested: offer.quantityRequested,
      },
      context: createSeedContextFor(buyerAccountId, offer.buyerUserId ?? identitySeedIds.collector.userId),
    });
  }

  await drainProjectors(services.projectors);

  const acceptedOfferQuote = await services.offers.previewOfferAcceptanceTerms({
    offerId: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
    sellerAccountId: identitySeedIds.demo.accountId,
  });

  await services.offers.acceptOffer(
    {
      offerId: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
      sellerAccountId: identitySeedIds.demo.accountId,
      feeQuoteFingerprint: acceptedOfferQuote.fee_quote_fingerprint,
    },
    context,
  );
  await drainProjectors(services.projectors);
}
