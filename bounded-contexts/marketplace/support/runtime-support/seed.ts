import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { catalogScenarioItems, catalogSeedIds } from "@chase-sets/catalog-seed";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { inventorySeedIds } from "@chase-sets/inventory/seed-support/ids";
import { marketplaceReservedSeedIds, reputationReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type {
  AccountId,
  CatalogItemId,
  ListingId,
  OfferId,
  UserId,
  OrderId,
  TenantId,
} from "@chase-sets/primitives/typed-ids";
import {
  createMarketplaceProductDescriptor,
  type MarketplaceVersionSchema,
} from "../../features/offers/domain/versioning";
import { addReviewWindowDays, REVIEW_WINDOW_DAYS, type ReviewRole } from "../../features/reviews/domain/common";
import { requiresListingPhotoEvidence, type MarketplaceListingState } from "../../features/listings/domain/domain";
import type { MarketplaceListingPhotoUpload } from "../../features/listings/api/runtime";
import { quoteMarketplaceTerms } from "./fee-quotes";
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
  // Accepted offer behind the review-eligible delivered order. The order it
  // produces never receives a support request, so review eligibility survives
  // for the reviews seed.
  {
    offerId: marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerEncore,
    catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
    itemTitle: "Twilight Masquerade Elite Trainer Box",
    itemSubtitle: "Sealed elite trainer box",
    selectedOptions: [],
    productSummary: null,
    priceAmount: "44.50",
    quantityRequested: 1,
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
const HIGH_DOLLAR_SEED_LISTING_AMOUNT = 250;

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

function requiresSeedListingPhotoUpload(
  supply: Readonly<{
    selected_options: readonly { dimensionId: string; optionId: string }[];
    product_summary: string | null;
    graded_card: MarketplaceListingState["gradedCard"];
  }>,
  listing: ListingSeed,
) {
  return (
    requiresListingPhotoEvidence({
      selectedOptions: supply.selected_options,
      productSummary: supply.product_summary,
      gradedCard: supply.graded_card,
    }) || Number.parseFloat(listing.priceAmount) >= HIGH_DOLLAR_SEED_LISTING_AMOUNT
  );
}

async function getProductId(
  services: ReturnType<typeof createMarketplaceServices>,
  catalogItemId: string,
  selection: readonly { dimensionId: string; optionId: string }[],
): Promise<ProductKey> {
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

async function acceptReservedSeedOffer(
  services: ReturnType<typeof createMarketplaceServices>,
  offer: OfferSeed,
  sellerAccountId: AccountId,
  context: ReturnType<typeof createSeedContextFor>,
) {
  const quote = await quoteMarketplaceTerms(services.commercialTermsResolver, {
    accountId: sellerAccountId,
    priceAmount: offer.priceAmount,
  });

  await services.offers.commandHandler({
    streamId: `marketplace.offer-${offer.offerId}`,
    command: {
      type: "AcceptOffer",
      sellerAccountId,
      acceptedAt: new Date().toISOString(),
      marketplaceSalesFeePercentageBps: quote.marketplace_sales_fee_percentage_bps,
      marketplaceSalesFeeFixedAmount: quote.marketplace_sales_fee_fixed_amount,
      marketplaceSalesFeeCapAmount: quote.marketplace_sales_fee_cap_amount,
      marketplaceSalesFeeUnitAmount: quote.marketplace_sales_fee_unit_amount,
      sellerNetUnitAmount: quote.seller_net_unit_amount,
      shippingAllowancePercentageBps: quote.shipping_allowance_percentage_bps,
      termsScheduleId: quote.schedule_id,
      termsAgreementId: quote.agreement_id,
      termsResolvedAt: quote.resolved_at,
      feeQuoteFingerprint: quote.fee_quote_fingerprint,
      acceptanceBatchId: null,
      acceptanceBatchSize: null,
    },
    context,
  });
}

function createSeedContext() {
  return createSeedContextFor(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);
}

function createSeedContextFor(accountId: string, userId: string) {
  return {
    tenantId: "tnt_identity" as TenantId,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId as AccountId,
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
        listingPhotoUploads: requiresSeedListingPhotoUpload(supply, listing)
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
        catalogItemId: offer.catalogItemId as CatalogItemId,
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

  const acceptedSeedOffer = offers.find(
    (offer) => offer.offerId === marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
  );
  if (!acceptedSeedOffer) {
    throw new Error("Reserved accepted seed offer is missing from the marketplace seed list.");
  }

  await acceptReservedSeedOffer(services, acceptedSeedOffer, identitySeedIds.demo.accountId, context);

  const reviewEligibleSeedOffer = offers.find(
    (offer) => offer.offerId === marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerEncore,
  );
  if (!reviewEligibleSeedOffer) {
    throw new Error("Reserved review-eligible seed offer is missing from the marketplace seed list.");
  }

  await acceptReservedSeedOffer(services, reviewEligibleSeedOffer, identitySeedIds.demo.accountId, context);
}

function createReputationSeedContext(accountId: string, userId: string): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as TenantId,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId as AccountId,
    },
  };
}

export async function seedReputationData(
  pool: PgTransactionalPool,
  services: MarketplaceServices = createMarketplaceServices(pool),
) {
  try {
    const existing = await services.db.query("SELECT COUNT(*) AS count FROM marketplace_review_pages");
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Reputation already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  // Seed orders identify by ready_for_fulfillment_at (the payments seed fixes
  // it via payment-capture timestamps): reviews attach to the latest-ready
  // eligible order, which the support seed never targets, so seeded reviews
  // stay off the support-blocked delivered order in every seed harness.
  const buyerToSellerOpportunity = await services.reviews.getOrderReviewOpportunity(
    (
      await services.db.query<{ order_id: string }>(
        `SELECT eligibility.order_id
         FROM marketplace_review_eligibility_pages eligibility
         JOIN marketplace_review_order_sources order_source
           ON order_source.order_id = eligibility.order_id
         WHERE eligibility.author_account_id = $1
         ORDER BY order_source.ready_for_fulfillment_at DESC NULLS LAST,
           eligibility.eligible_at ASC,
           eligibility.order_id ASC
         LIMIT 1`,
        [identitySeedIds.collector.accountId],
      )
    ).rows[0]?.order_id ?? "",
    identitySeedIds.collector.accountId,
  );

  if (!buyerToSellerOpportunity) {
    console.log(
      "Reputation seed is waiting for buyer-to-seller review eligibility from a delivered shipment. Skipping reviews for this pass.",
    );
    return;
  }

  const sellerToBuyerOpportunity = await services.reviews.getOrderReviewOpportunity(
    buyerToSellerOpportunity.order_id,
    identitySeedIds.demo.accountId,
  );

  if (!sellerToBuyerOpportunity) {
    console.log(
      "Reputation seed is waiting for seller-to-buyer review eligibility from a delivered shipment. Skipping reviews for this pass.",
    );
    return;
  }

  await services.reviews.commandHandler({
    streamId: `marketplace.review-${reputationReservedSeedIds.reviews.buyerToSellerActive}`,
    command: {
      type: "SubmitReview",
      reviewId: reputationReservedSeedIds.reviews.buyerToSellerActive,
      orderId: buyerToSellerOpportunity.order_id as OrderId,
      authorAccountId: identitySeedIds.collector.accountId,
      subjectAccountId: buyerToSellerOpportunity.subject_account_id as AccountId,
      authorRole: buyerToSellerOpportunity.author_role as ReviewRole,
      rating: 4,
      feedback: "Packed well and shipped exactly as described.",
      submittedAt: "2026-03-23T09:00:00.000Z",
      reviewWindowExpiresAt: addReviewWindowDays(buyerToSellerOpportunity.eligible_at, REVIEW_WINDOW_DAYS),
    },
    context: createReputationSeedContext(identitySeedIds.collector.accountId, identitySeedIds.collector.userId),
  });
  await services.reviews.commandHandler({
    streamId: `marketplace.review-${reputationReservedSeedIds.reviews.buyerToSellerActive}`,
    command: {
      type: "UpdateReview",
      rating: 5,
      feedback: "Packed well, shipped quickly, and matched the listing.",
      updatedAt: "2026-03-23T10:00:00.000Z",
    },
    context: createReputationSeedContext(identitySeedIds.collector.accountId, identitySeedIds.collector.userId),
  });
  // No counterpart seller-to-buyer review is seeded for this direction, so
  // reveal it directly (m108 double-blind reveal): a staging seed review
  // should be visible, not stuck hidden until a 60-day sweep.
  await services.reviews.commandHandler({
    streamId: `marketplace.review-${reputationReservedSeedIds.reviews.buyerToSellerActive}`,
    command: {
      type: "RevealReview",
      revealedAt: "2026-03-23T10:05:00.000Z",
      reason: "window-expired",
    },
    context: createReputationSeedContext(identitySeedIds.collector.accountId, identitySeedIds.collector.userId),
  });

  await services.reviews.commandHandler({
    streamId: `marketplace.review-${reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn}`,
    command: {
      type: "SubmitReview",
      reviewId: reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn,
      orderId: sellerToBuyerOpportunity.order_id as OrderId,
      authorAccountId: identitySeedIds.demo.accountId,
      subjectAccountId: sellerToBuyerOpportunity.subject_account_id as AccountId,
      authorRole: sellerToBuyerOpportunity.author_role as ReviewRole,
      rating: 3,
      feedback: "Responsive but asked for extra packing photos.",
      submittedAt: "2026-03-23T09:15:00.000Z",
      reviewWindowExpiresAt: addReviewWindowDays(sellerToBuyerOpportunity.eligible_at, REVIEW_WINDOW_DAYS),
    },
    context: createReputationSeedContext(identitySeedIds.demo.accountId, identitySeedIds.demo.userId),
  });
  await services.reviews.commandHandler({
    streamId: `marketplace.review-${reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn}`,
    command: {
      type: "WithdrawReview",
      withdrawnAt: "2026-03-23T10:15:00.000Z",
    },
    context: createReputationSeedContext(identitySeedIds.demo.accountId, identitySeedIds.demo.userId),
  });
}

export async function seedMarketplaceContextDatabase(
  pool: PgTransactionalPool,
  services: MarketplaceServices = createMarketplaceServices(pool),
) {
  await seedMarketplaceDatabase(pool, services);
  await seedReputationData(pool, services);
}
