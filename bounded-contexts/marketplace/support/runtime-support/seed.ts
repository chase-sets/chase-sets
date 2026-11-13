import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { catalogScenarioItems, catalogSeedIds } from "@chase-sets/catalog-seed";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { inventorySeedIds } from "@chase-sets/inventory/seed-support/ids";
import { marketplaceReservedSeedIds, reputationReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import { tryMoneyToCents } from "@chase-sets/primitives/money";
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
import { buildListingEvidenceSnapshot } from "../../features/listings/domain/evidence-snapshot";
import { normalizeMarketplaceListingFeeLock, totalFeeLockedUnits } from "../../features/listings/domain/fee-lock";
import type { MarketplaceListingPhotoUpload } from "../../features/listings/api/runtime";
import {
  openMarketplaceListingTermsSession,
  quoteMarketplaceTerms,
  requoteMarketplaceListingFeeLock,
} from "./fee-quotes";
import { createMarketplaceServices, type MarketplaceServices } from "./services";
import type { BcSeedAggregateStateReport } from "@chase-sets/bounded-context-module";
import { loadSeedStreamEvents } from "@chase-sets/bounded-context-runtime";
import {
  activeListingPhotos,
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingEvent,
} from "../../features/listings/domain/domain";
import {
  evolveMarketplaceOffer,
  initialMarketplaceOfferState,
  type MarketplaceOfferEvent,
} from "../../features/offers/domain/domain";
import {
  evolveReview,
  initialReviewState,
  type ReviewEvent,
  type ReviewState,
} from "../../features/reviews/domain/domain";
import sharp from "sharp";
import { seedListingEvidencePolicy } from "../../features/listing-evidence-policy/integrations/seed";

type ListingSeed = Readonly<{
  listingId: ListingId;
  accountId?: AccountId;
  userId?: UserId;
  inventoryItemId: string;
  catalogItemId: string;
  priceAmount: string;
  priceCurrencyCode: string;
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
    priceCurrencyCode: "USD",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.charizardBaseSetPsa8,
    inventoryItemId: inventorySeedIds.items.charizardBaseSetPsa8,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    priceAmount: "749.00",
    priceCurrencyCode: "USD",
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
    priceCurrencyCode: "USD",
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
    priceCurrencyCode: "USD",
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
    priceCurrencyCode: "USD",
    quantityCap: 1,
    finalStatus: "active",
  },
  // Both listings and offers, many listings.
  {
    listingId: marketplaceReservedSeedIds.listings.pikachuJungleLightlyPlayed,
    inventoryItemId: inventorySeedIds.items.pikachuJungleLightlyPlayed,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    priceAmount: "21.50",
    priceCurrencyCode: "USD",
    quantityCap: 3,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.pikachuJungleValueCopy,
    inventoryItemId: inventorySeedIds.items.pikachuJungleLightlyPlayed,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    priceAmount: "19.99",
    priceCurrencyCode: "USD",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.pikachuJunglePremiumCopy,
    inventoryItemId: inventorySeedIds.items.pikachuJungleLightlyPlayed,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    priceAmount: "24.00",
    priceCurrencyCode: "USD",
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
    priceCurrencyCode: "USD",
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
    priceCurrencyCode: "USD",
    quantityCap: 4,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.lugiaNeoGenesisDraft,
    inventoryItemId: inventorySeedIds.items.lugiaNeoGenesisNearMint,
    catalogItemId: catalogScenarioItems.lugiaNeoGenesis,
    priceAmount: "229.00",
    priceCurrencyCode: "USD",
    quantityCap: 1,
    finalStatus: "draft",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.lugiaNeoGenesisBgs95,
    inventoryItemId: inventorySeedIds.items.lugiaNeoGenesisBgs95,
    catalogItemId: catalogScenarioItems.lugiaNeoGenesis,
    priceAmount: "620.00",
    priceCurrencyCode: "USD",
    quantityCap: 1,
    finalStatus: "active",
  },
  // Listings with no offers.
  {
    listingId: marketplaceReservedSeedIds.listings.mewtwoBlackStarPromoActive,
    inventoryItemId: inventorySeedIds.items.mewtwoBlackStarPromoNearMint,
    catalogItemId: catalogScenarioItems.mewtwoBlackStarPromo,
    priceAmount: "48.00",
    priceCurrencyCode: "USD",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.mewtwoBlackStarPromoPremium,
    inventoryItemId: inventorySeedIds.items.mewtwoBlackStarPromoNearMint,
    catalogItemId: catalogScenarioItems.mewtwoBlackStarPromo,
    priceAmount: "52.50",
    priceCurrencyCode: "USD",
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
    priceCurrencyCode: "USD",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.prismaticEvolutionsPaused,
    inventoryItemId: inventorySeedIds.items.pikachuPrismaticEvolutionsNearMint,
    catalogItemId: catalogScenarioItems.pikachuPrismaticEvolutions,
    priceAmount: "16.25",
    priceCurrencyCode: "USD",
    quantityCap: 4,
    finalStatus: "paused",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.pikachuPrismaticEvolutionsPsa10,
    inventoryItemId: inventorySeedIds.items.pikachuPrismaticEvolutionsPsa10,
    catalogItemId: catalogScenarioItems.pikachuPrismaticEvolutions,
    priceAmount: "89.00",
    priceCurrencyCode: "USD",
    quantityCap: 1,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.surgingSparksWithdrawn,
    inventoryItemId: inventorySeedIds.items.surgingSparksBoosterBox,
    catalogItemId: catalogScenarioItems.surgingSparksBoosterBox,
    priceAmount: "132.00",
    priceCurrencyCode: "USD",
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
    priceCurrencyCode: "USD",
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
    priceCurrencyCode: "USD",
    quantityCap: 2,
    finalStatus: "active",
  },
  {
    listingId: marketplaceReservedSeedIds.listings.twilightMasqueradeEliteTrainerActive,
    inventoryItemId: inventorySeedIds.items.twilightMasqueradeEliteTrainerBox,
    catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
    priceAmount: "46.00",
    priceCurrencyCode: "USD",
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
    priceCurrencyCode: "USD",
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
    priceCurrencyCode: "USD",
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

async function getSeedListingPhotoBody(index: number) {
  return sharp({
    create: {
      width: 720,
      height: 1008,
      channels: 3,
      background: { r: 220 + (index % 20), g: 230 + (index % 15), b: 240 + (index % 10) },
    },
  })
    .png()
    .toBuffer();
}

async function buildSeedListingEvidenceUploads(
  listing: ListingSeed,
  requirements: NonNullable<
    Awaited<ReturnType<MarketplaceServices["listings"]["loadListingState"]>>["evidenceRequirements"]
  >,
): Promise<readonly MarketplaceListingPhotoUpload[]> {
  const count = Math.max(requirements.requirements.minimumPhotoCount, requirements.requirements.requiredSlots.length);
  return Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const slot = requirements.requirements.requiredSlots[index] ?? null;
      return {
        body: await getSeedListingPhotoBody(index),
        contentType: "image/png",
        originalFilename: `${listing.listingId}-evidence-${index + 1}.png`,
        altText: `Seed listing evidence image ${index + 1}`,
        slotId: slot?.slotId ?? null,
        viewKind: slot?.viewKind ?? null,
      } satisfies MarketplaceListingPhotoUpload;
    }),
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
  listing: ListingSeed,
  context: ReturnType<typeof createSeedContextFor>,
) {
  const quote = await quoteMarketplaceTerms(services.commercialTermsResolver, {
    accountId: sellerAccountId,
    priceAmount: offer.priceAmount,
  });

  if ((await loadSeedOfferState(services.db, offer.offerId)).state.status === "accepted") {
    return;
  }

  const acceptedAt = new Date().toISOString();
  const listingEvidencePolicyHash = "seed:listing-evidence-policy";
  await services.offers.commandHandler({
    streamId: `marketplace.offer-${offer.offerId}`,
    command: {
      type: "AcceptOffer",
      sellerAccountId,
      listingId: listing.listingId,
      inventoryItemId: listing.inventoryItemId,
      listingVersion: 2,
      listingEvidencePolicyId: null,
      listingEvidencePolicyVersion: null,
      listingEvidencePolicyHash,
      listingEvidenceSnapshot: buildListingEvidenceSnapshot({
        evidence: [],
        policyHash: listingEvidencePolicyHash,
        createdAt: acceptedAt,
      }),
      acceptedAt,
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

const MARKETPLACE_BOOTSTRAP_LABEL = "Marketplace seed bootstrap";

const acceptedSeedOfferIds = [
  marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted,
  marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerEncore,
] as const;

const marketplaceListingStreamId = (listingId: string) => `marketplace.listing-${listingId}`;
const marketplaceOfferStreamId = (offerId: string) => `marketplace.offer-${offerId}`;
const marketplaceReviewStreamId = (reviewId: string) => `marketplace.review-${reviewId}`;

/**
 * Folds one seeded Marketplace aggregate from its own `marketplace.*` stream.
 *
 * `marketplace_listing_pages`, `marketplace_offer_pages`, and
 * `marketplace_review_pages` are UNLOGGED, so PostgreSQL truncates them on
 * crash recovery while the logged streams survive. The projection-sourced
 * guards this replaced answered one all-or-nothing question across every
 * listing and offer (and another across both reviews); a partially seeded set
 * was therefore re-authored into existing aggregates. Each listing, offer, and
 * review is now decided on its own committed events.
 */
async function loadSeedListingState(db: PgQueryable, listingId: string) {
  const committed = await loadSeedStreamEvents<MarketplaceListingEvent>(db, marketplaceListingStreamId(listingId));
  return { committed, state: committed.reduce(evolveMarketplaceListing, initialMarketplaceListingState) };
}

async function loadSeedOfferState(db: PgQueryable, offerId: string) {
  const committed = await loadSeedStreamEvents<MarketplaceOfferEvent>(db, marketplaceOfferStreamId(offerId));
  return { committed, state: committed.reduce(evolveMarketplaceOffer, initialMarketplaceOfferState) };
}

async function loadSeedReviewState(db: PgQueryable, reviewId: string) {
  const committed = await loadSeedStreamEvents<ReviewEvent>(db, marketplaceReviewStreamId(reviewId));
  return { committed, state: committed.reduce(evolveReview, initialReviewState) };
}

type SeedListingClassification = Readonly<{
  listing: ListingSeed;
  accountId: AccountId;
  context: ReturnType<typeof createSeedContextFor>;
  committed: readonly MarketplaceListingEvent[];
  state: ReturnType<typeof evolveMarketplaceListing>;
  kind: "absent" | "exact" | "author" | "reconcile" | "refused";
  mismatches: readonly string[];
}>;

function seedListingStatusIsOnPath(finalStatus: ListingSeed["finalStatus"], status: string): boolean {
  switch (finalStatus) {
    case "draft":
      return status === "draft";
    case "active":
      return status === "draft" || status === "active";
    case "paused":
      return status === "draft" || status === "active" || status === "paused";
    case "withdrawn":
      return status === "draft" || status === "active" || status === "withdrawn";
  }
}

function seedMoneyMatches(actual: string | null, expected: string): boolean {
  const actualCents = actual === null ? null : tryMoneyToCents(actual);
  const expectedCents = tryMoneyToCents(expected);
  return actualCents !== null && expectedCents !== null && actualCents === expectedCents;
}

function classifySeedListing(
  listing: ListingSeed,
  committed: readonly MarketplaceListingEvent[],
  state: ReturnType<typeof evolveMarketplaceListing>,
  accountId: AccountId,
  context: ReturnType<typeof createSeedContextFor>,
): SeedListingClassification {
  if (state.listingId === null) {
    return { listing, accountId, context, committed, state, kind: "absent", mismatches: [] };
  }

  const mismatches: string[] = [];
  if (String(state.accountId) !== String(accountId)) mismatches.push("owner account");
  if (String(state.inventoryItemId) !== String(listing.inventoryItemId)) mismatches.push("inventory item");
  if (String(state.catalogItemId) !== String(listing.catalogItemId)) mismatches.push("catalog item");
  if (state.quantityCap !== listing.quantityCap) mismatches.push("quantity cap");
  if (!seedMoneyMatches(state.priceAmount, listing.priceAmount)) mismatches.push("price amount");

  const currencyRequired = listing.finalStatus !== "withdrawn";
  const currencyMatches = state.priceCurrencyCode === listing.priceCurrencyCode;
  const currencyReconcile = currencyRequired && state.priceCurrencyCode === null;
  if (currencyRequired && !currencyMatches && !currencyReconcile) mismatches.push("price currency");

  if (!seedListingStatusIsOnPath(listing.finalStatus, state.status)) mismatches.push("status");
  if (mismatches.length > 0) {
    return { listing, accountId, context, committed, state, kind: "refused", mismatches };
  }

  if (state.status === listing.finalStatus && !currencyReconcile) {
    return { listing, accountId, context, committed, state, kind: "exact", mismatches: [] };
  }
  return {
    listing,
    accountId,
    context,
    committed,
    state,
    kind: currencyReconcile ? "reconcile" : "author",
    mismatches: [],
  };
}

function assertSeedListingClassification(classification: SeedListingClassification): void {
  if (classification.mismatches.length === 0) return;
  const { listing, state, committed } = classification;
  throw new Error(
    `${MARKETPLACE_BOOTSTRAP_LABEL} Listing '${listing.listingId}' rejected; ` +
      `stream '${marketplaceListingStreamId(listing.listingId)}', version ${committed.length}; ` +
      `mismatched fields: ${classification.mismatches.join(", ")}; ` +
      `found status '${state.status}'.`,
  );
}

async function classifyAllSeedListings(services: MarketplaceServices): Promise<readonly SeedListingClassification[]> {
  const classifications: SeedListingClassification[] = [];
  for (const listing of listings) {
    const accountId = listing.accountId ?? identitySeedIds.demo.accountId;
    const context = createSeedContextFor(accountId, listing.userId ?? identitySeedIds.demo.userId);
    const { committed, state } = await loadSeedListingState(services.db, listing.listingId);
    const classification = classifySeedListing(listing, committed, state, accountId, context);
    assertSeedListingClassification(classification);
    classifications.push(classification);
  }
  for (const classification of classifications) {
    if (classification.kind !== "absent") continue;
    const supply = await services.listings.getInventoryItemSupply(
      classification.listing.inventoryItemId,
      classification.accountId,
    );
    if (!supply) {
      throw new Error(
        `${MARKETPLACE_BOOTSTRAP_LABEL} Listing '${classification.listing.listingId}' rejected; ` +
          `stream '${marketplaceListingStreamId(classification.listing.listingId)}', version 0; ` +
          `mismatched fields: missing inventory supply.`,
      );
    }
  }
  return classifications;
}

async function reconcileSeedListings(
  services: MarketplaceServices,
  classifications: readonly SeedListingClassification[],
): Promise<void> {
  const updatesByAccount = new Map<AccountId, SeedListingClassification[]>();
  for (const classification of classifications) {
    if (classification.kind !== "reconcile") continue;
    const entries = updatesByAccount.get(classification.accountId) ?? [];
    entries.push(classification);
    updatesByAccount.set(classification.accountId, entries);
  }

  const accountOrder = [
    identitySeedIds.demo.accountId,
    identitySeedIds.cardVault.accountId,
    identitySeedIds.sealedStockroom.accountId,
  ] as const;

  const entriesByAccount = accountOrder.map((accountId) => ({
    accountId,
    entries: updatesByAccount.get(accountId) ?? [],
  }));

  // Open every terms session and validate every candidate before the first
  // owner call. The owner opens its own session again inside the call; that
  // residual race is intentional and the CAS remains authoritative.
  const termsSessions = new Map<AccountId, Awaited<ReturnType<typeof openMarketplaceListingTermsSession>>>();
  for (const { accountId, entries } of entriesByAccount) {
    if (entries.length === 0) continue;
    termsSessions.set(
      accountId,
      await openMarketplaceListingTermsSession(services.commercialTermsResolver, { accountId }),
    );
  }

  for (const { accountId, entries } of entriesByAccount) {
    const termsSession = termsSessions.get(accountId);
    if (!termsSession) continue;
    for (const entry of entries) {
      try {
        if (totalFeeLockedUnits(entry.state.feeLocks) !== entry.state.quantityCap) {
          throw new Error("fee-lock units do not cover the listing quantity cap");
        }
        entry.state.feeLocks.forEach(normalizeMarketplaceListingFeeLock);
        const feeLocks = entry.state.feeLocks.map((lock) =>
          requoteMarketplaceListingFeeLock(lock, entry.listing.priceAmount),
        );
        termsSession.quote(entry.listing.priceAmount);
        const decided = decideMarketplaceListing(entry.state, {
          type: "UpdateListingPrice",
          priceAmount: entry.listing.priceAmount,
          priceCurrencyCode: entry.listing.priceCurrencyCode,
          feeLocks,
        });
        if (decided.length !== 1 || decided[0]?.type !== "marketplace.listing.price-updated") {
          throw new Error("price update precheck did not produce exactly one price-updated event");
        }
      } catch (error) {
        throw new Error(
          `${MARKETPLACE_BOOTSTRAP_LABEL} Listing '${entry.listing.listingId}' rejected; ` +
            `stream '${marketplaceListingStreamId(entry.listing.listingId)}', version ${entry.committed.length}; ` +
            `mismatched fields: fee locks (${error instanceof Error ? error.message : "invalid fee lock"}).`,
        );
      }
    }
  }

  const reconciliationStates = async (
    entries: readonly SeedListingClassification[],
    notAttempted: readonly SeedListingClassification[] = [],
  ): Promise<string> => {
    const attempted = await Promise.all(
      entries.map(async (entry) => {
        const refolded = await loadSeedListingState(services.db, entry.listing.listingId);
        const appended = refolded.committed
          .slice(entry.committed.length)
          .some((event) => event.type === "marketplace.listing.price-updated");
        return `${entry.listing.listingId} version ${refolded.committed.length} ${appended ? "applied" : "not-applied"}`;
      }),
    );
    const pending = notAttempted.map(
      (entry) => `${entry.listing.listingId} version ${entry.committed.length} not-attempted`,
    );
    return [...attempted, ...pending].join(", ");
  };

  for (const accountId of accountOrder) {
    const entries = updatesByAccount.get(accountId);
    if (!entries || entries.length === 0) continue;
    let outcomes: Awaited<ReturnType<MarketplaceServices["listings"]["applyBulkListingPriceUpdates"]>>;
    try {
      outcomes = await services.listings.applyBulkListingPriceUpdates(
        {
          accountId,
          updates: entries.map(({ listing, committed }) => ({
            listingId: listing.listingId,
            priceAmount: listing.priceAmount,
            priceCurrencyCode: listing.priceCurrencyCode,
            expectedVersion: committed.length,
            idempotencyKey: `seed:listing-denomination:${listing.listingId}`,
          })),
        },
        entries[0]!.context,
      );
    } catch (error) {
      const first = entries[0]!;
      const laterEntries = accountOrder
        .slice(accountOrder.indexOf(accountId) + 1)
        .flatMap((laterAccountId) => updatesByAccount.get(laterAccountId) ?? []);
      const states = await reconciliationStates(entries, laterEntries);
      throw new Error(
        `${MARKETPLACE_BOOTSTRAP_LABEL} Listing '${first.listing.listingId}' reconciliation failed; ` +
          `stream '${marketplaceListingStreamId(first.listing.listingId)}', version ${first.committed.length}; ` +
          `owner call did not apply: ${error instanceof Error ? error.message : "unknown error"}; ` +
          `listing states: ${states}.`,
      );
    }

    for (const entry of entries) {
      const outcome = outcomes.find((candidate) => candidate.listingId === entry.listing.listingId);
      if (!outcome || outcome.outcome !== "applied") {
        const laterEntries = accountOrder
          .slice(accountOrder.indexOf(accountId) + 1)
          .flatMap((laterAccountId) => updatesByAccount.get(laterAccountId) ?? []);
        const states = await reconciliationStates(entries, laterEntries);
        throw new Error(
          `${MARKETPLACE_BOOTSTRAP_LABEL} Listing '${entry.listing.listingId}' reconciliation failed; ` +
            `stream '${marketplaceListingStreamId(entry.listing.listingId)}', version ${entry.committed.length}; ` +
            `owner outcome '${outcome?.outcome ?? "missing"}'; listing states: ${states}.`,
        );
      }
      const refolded = await loadSeedListingState(services.db, entry.listing.listingId);
      const checked = classifySeedListing(
        entry.listing,
        refolded.committed,
        refolded.state,
        entry.accountId,
        entry.context,
      );
      if (
        checked.mismatches.length > 0 ||
        (checked.kind !== "exact" && checked.kind !== "author") ||
        refolded.state.priceCurrencyCode !== entry.listing.priceCurrencyCode
      ) {
        const laterEntries = accountOrder
          .slice(accountOrder.indexOf(accountId) + 1)
          .flatMap((laterAccountId) => updatesByAccount.get(laterAccountId) ?? []);
        const states = await reconciliationStates(entries, laterEntries);
        throw new Error(
          `${MARKETPLACE_BOOTSTRAP_LABEL} Listing '${entry.listing.listingId}' reconciliation failed; ` +
            `stream '${marketplaceListingStreamId(entry.listing.listingId)}', version ${refolded.committed.length}; ` +
            `exact re-fold did not converge; listing states: ${states}.`,
        );
      }
      const event = await services.db.query<{ event_id: string; stream_version: string; event_type: string }>(
        `SELECT event_id, stream_version, event_type
         FROM event_store_events
         WHERE stream_id = $1 AND stream_version = $2`,
        [marketplaceListingStreamId(entry.listing.listingId), refolded.committed.length],
      );
      const appendedEvent = event.rows[0];
      if (!appendedEvent || appendedEvent.event_type !== "marketplace.listing.price-updated") {
        throw new Error(
          `${MARKETPLACE_BOOTSTRAP_LABEL} Listing '${entry.listing.listingId}' reconciliation failed; ` +
            `stream '${marketplaceListingStreamId(entry.listing.listingId)}', version ${refolded.committed.length}; ` +
            `reconciled event evidence is missing.`,
        );
      }
      console.log(
        `[marketplace-seed] Listing '${entry.listing.listingId}' reconciled; ` +
          `stream '${marketplaceListingStreamId(entry.listing.listingId)}', version ${entry.committed.length} -> ${refolded.committed.length}; ` +
          `event '${appendedEvent.event_id}'`,
      );
    }
  }
}

const seededReviewInventory = [
  {
    reviewId: reputationReservedSeedIds.reviews.buyerToSellerActive,
    key: "buyer-to-seller-active",
    isComplete: (state: ReviewState) => state.revealedAt !== null,
    describe: (state: ReviewState) => (state.revealedAt === null ? String(state.status) : "revealed"),
  },
  {
    reviewId: reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn,
    key: "seller-to-buyer-withdrawn",
    isComplete: (state: ReviewState) => state.status === "withdrawn",
    describe: (state: ReviewState) => String(state.status),
  },
] as const;

/**
 * Reports the Marketplace seed's base aggregate state from the authoritative
 * `marketplace.*` streams: every seeded listing, offer, and review.
 */
export async function inspectMarketplaceSeedState(
  pool: PgTransactionalPool,
): Promise<readonly BcSeedAggregateStateReport[]> {
  const reports: BcSeedAggregateStateReport[] = [];

  for (const listing of listings) {
    const { committed, state } = await loadSeedListingState(pool, listing.listingId);
    const accountId = listing.accountId ?? identitySeedIds.demo.accountId;
    const context = createSeedContextFor(accountId, listing.userId ?? identitySeedIds.demo.userId);
    const classification = classifySeedListing(listing, committed, state, accountId, context);
    reports.push({
      contextName: "marketplace",
      aggregateName: "Listing",
      id: listing.listingId,
      key: listing.inventoryItemId,
      streamId: marketplaceListingStreamId(listing.listingId),
      kind: classification.kind === "exact" ? "active" : classification.kind === "absent" ? "absent" : "draft",
      status: state.listingId === null ? null : String(state.status),
      eventCount: committed.length,
    });
  }

  for (const offer of offers) {
    const { committed, state } = await loadSeedOfferState(pool, offer.offerId);
    const expectedAccepted = acceptedSeedOfferIds.some((offerId) => String(offerId) === String(offer.offerId));
    const complete = state.offerId !== null && (!expectedAccepted || state.status === "accepted");
    reports.push({
      contextName: "marketplace",
      aggregateName: "Offer",
      id: offer.offerId,
      key: offer.catalogItemId,
      streamId: marketplaceOfferStreamId(offer.offerId),
      kind: state.offerId === null ? "absent" : complete ? "active" : "draft",
      status: state.offerId === null ? null : String(state.status),
      eventCount: committed.length,
    });
  }

  for (const review of seededReviewInventory) {
    const { committed, state } = await loadSeedReviewState(pool, review.reviewId);
    const complete = review.isComplete(state);
    reports.push({
      contextName: "marketplace",
      aggregateName: "Review",
      id: review.reviewId,
      key: review.key,
      streamId: marketplaceReviewStreamId(review.reviewId),
      kind: state.reviewId === null ? "absent" : complete ? "active" : "draft",
      status: state.reviewId === null ? null : review.describe(state),
      eventCount: committed.length,
    });
  }

  return reports;
}

export async function seedMarketplaceDatabase(
  pool: PgTransactionalPool,
  services: MarketplaceServices = createMarketplaceServices(pool),
) {
  const classifications = await classifyAllSeedListings(services);
  await reconcileSeedListings(services, classifications);
  const classificationByListingId = new Map(
    classifications.map((classification) => [classification.listing.listingId, classification]),
  );
  const authoredOrReconciled = classifications.filter((classification) => classification.kind !== "exact");
  const context = createSeedContext();

  for (const listing of listings) {
    const accountId = listing.accountId ?? identitySeedIds.demo.accountId;
    const listingContext = createSeedContextFor(accountId, listing.userId ?? identitySeedIds.demo.userId);
    const seededListingId = listing.listingId;
    const classification = classificationByListingId.get(seededListingId);
    if (!classification) {
      throw new Error(`${MARKETPLACE_BOOTSTRAP_LABEL} Listing '${seededListingId}' was not classified.`);
    }
    if (classification.kind === "exact") {
      continue;
    }
    const persisted = await loadSeedListingState(services.db, seededListingId);

    let feeQuoteFingerprint: string | null = null;
    if (persisted.state.listingId === null) {
      const supply = await services.listings.getInventoryItemSupply(listing.inventoryItemId, accountId);
      if (!supply) {
        throw new Error(
          `${MARKETPLACE_BOOTSTRAP_LABEL} Listing '${listing.listingId}' rejected; ` +
            `stream '${marketplaceListingStreamId(listing.listingId)}', version 0; ` +
            `mismatched fields: missing inventory supply.`,
        );
      }

      const createdListing = await services.listings.createListing(
        {
          accountId,
          inventoryItemId: supply.item_id,
          priceAmount: listing.priceAmount,
          priceCurrencyCode: listing.priceCurrencyCode,
          quantityCap: listing.quantityCap,
          listingIdOverride: seededListingId,
          listingPhotoUploads: [],
        },
        listingContext,
      );
      feeQuoteFingerprint = createdListing.feeQuoteFingerprint;
    }

    if (listing.finalStatus !== "draft") {
      const beforePublish = await services.listings.loadListingState(seededListingId);
      if (beforePublish.status === "draft") {
        if (
          beforePublish.evidenceRequirements &&
          beforePublish.evidenceRequirements.requirements.minimumPhotoCount > 0 &&
          activeListingPhotos(beforePublish.evidence).length <
            beforePublish.evidenceRequirements.requirements.minimumPhotoCount
        ) {
          await services.listings.addListingPhotos(
            {
              accountId,
              listingId: seededListingId,
              listingPhotoUploads: await buildSeedListingEvidenceUploads(listing, beforePublish.evidenceRequirements),
            },
            listingContext,
          );
        }
        await services.listings.publishListing(
          {
            accountId,
            listingId: seededListingId,
            feeQuoteFingerprint:
              feeQuoteFingerprint ?? (await services.listings.loadListingState(seededListingId)).feeQuoteFingerprint,
          },
          listingContext,
        );
      }
    }

    if (
      listing.finalStatus === "paused" &&
      (await loadSeedListingState(services.db, seededListingId)).state.status !== "paused"
    ) {
      await services.listings.pauseListing(
        {
          accountId,
          listingId: seededListingId,
        },
        listingContext,
      );
    }

    if (
      listing.finalStatus === "withdrawn" &&
      (await loadSeedListingState(services.db, seededListingId)).state.status !== "withdrawn"
    ) {
      await services.listings.withdrawListing(
        {
          accountId,
          listingId: seededListingId,
        },
        listingContext,
      );
    }
  }

  for (const classification of authoredOrReconciled) {
    const refolded = await loadSeedListingState(services.db, classification.listing.listingId);
    const checked = classifySeedListing(
      classification.listing,
      refolded.committed,
      refolded.state,
      classification.accountId,
      classification.context,
    );
    if (checked.kind !== "exact" || checked.mismatches.length > 0) {
      throw new Error(
        `${MARKETPLACE_BOOTSTRAP_LABEL} Listing '${classification.listing.listingId}' authoring failed; ` +
          `stream '${marketplaceListingStreamId(classification.listing.listingId)}', version ${refolded.committed.length}; ` +
          `exact re-fold did not converge.`,
      );
    }
  }

  for (const offer of offers) {
    if ((await loadSeedOfferState(services.db, offer.offerId)).state.offerId !== null) {
      continue;
    }
    const buyerAccountId = offer.buyerAccountId ?? identitySeedIds.collector.accountId;
    await services.offers.commandHandler({
      streamId: marketplaceOfferStreamId(offer.offerId),
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
        priceCurrencyCode: "USD",
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

  const acceptedSeedListing = listings.find(
    (listing) => listing.listingId === marketplaceReservedSeedIds.listings.twilightMasqueradeEliteTrainerActive,
  );
  if (!acceptedSeedListing) {
    throw new Error("Reserved accepted seed Listing is missing from the marketplace seed list.");
  }
  await acceptReservedSeedOffer(
    services,
    acceptedSeedOffer,
    identitySeedIds.demo.accountId,
    acceptedSeedListing,
    context,
  );

  const reviewEligibleSeedOffer = offers.find(
    (offer) => offer.offerId === marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerEncore,
  );
  if (!reviewEligibleSeedOffer) {
    throw new Error("Reserved review-eligible seed offer is missing from the marketplace seed list.");
  }

  await acceptReservedSeedOffer(
    services,
    reviewEligibleSeedOffer,
    identitySeedIds.demo.accountId,
    acceptedSeedListing,
    context,
  );

  await withdrawStrayRepresentativeListings(services, context);
}

// Pinned identity anchors the browser E2E seed contract depends on for an exact
// deterministic listing shape (deployables/marketplace/e2e/support/seed-contract.ts):
// a zero-listing item drives the "no product selected" dock, and a single raw
// near-mint listing drives implicit price-based product resolution. The
// out-of-band Representative Commerce State refresh
// (.github/workflows/platform-staging-representative-commerce-state.yml) is not
// scenario-seed aware and adds one low-priced "lst_repr_*" listing to every
// active Catalog Item it walks, silently violating both invariants and
// out-competing the real listings on price. Reconciling them away here, on
// every scenario-seed run, makes the deterministic contract self-healing
// regardless of what the representative refresh has already done.
const identityAnchorCatalogItemIds = [
  catalogScenarioItems.bulbasaurBaseSet,
  catalogScenarioItems.charizardBaseSet,
] as const;

async function withdrawStrayRepresentativeListings(
  services: MarketplaceServices,
  context: EventStoreContext,
): Promise<void> {
  const result = await services.db.query<{ listing_id: string; account_id: string }>(
    `SELECT listing_id, account_id
     FROM marketplace_listing_pages
     WHERE catalog_catalog_item_id = ANY($1::text[])
       AND listing_id LIKE 'lst$_repr$_%' ESCAPE '$'
       AND status <> 'withdrawn'`,
    [identityAnchorCatalogItemIds],
  );

  for (const row of result.rows) {
    await services.listings.withdrawListing({ accountId: row.account_id, listingId: row.listing_id }, context);
  }
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
  const buyerToSellerReview = await loadSeedReviewState(
    services.db,
    reputationReservedSeedIds.reviews.buyerToSellerActive,
  );
  const sellerToBuyerReview = await loadSeedReviewState(
    services.db,
    reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn,
  );
  if (buyerToSellerReview.state.revealedAt !== null && sellerToBuyerReview.state.status === "withdrawn") {
    return;
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

  // Each review resumes from its own committed stream, so a review submitted
  // but not yet revealed (or withdrawn) is repaired rather than re-submitted.
  const buyerReviewContext = createReputationSeedContext(
    identitySeedIds.collector.accountId,
    identitySeedIds.collector.userId,
  );
  const buyerReviewStreamId = marketplaceReviewStreamId(reputationReservedSeedIds.reviews.buyerToSellerActive);
  if (buyerToSellerReview.state.reviewId === null) {
    await services.reviews.commandHandler({
      streamId: buyerReviewStreamId,
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
      context: buyerReviewContext,
    });
  }
  if (
    !buyerToSellerReview.committed.some((event) => event.type === "marketplace.review.updated") &&
    buyerToSellerReview.state.revealedAt === null
  ) {
    await services.reviews.commandHandler({
      streamId: buyerReviewStreamId,
      command: {
        type: "UpdateReview",
        rating: 5,
        feedback: "Packed well, shipped quickly, and matched the listing.",
        updatedAt: "2026-03-23T10:00:00.000Z",
      },
      context: buyerReviewContext,
    });
  }
  // No counterpart seller-to-buyer review is seeded for this direction, so
  // reveal it directly (m108 double-blind reveal): a staging seed review
  // should be visible, not stuck hidden until a 60-day sweep.
  if (buyerToSellerReview.state.revealedAt === null) {
    await services.reviews.commandHandler({
      streamId: buyerReviewStreamId,
      command: {
        type: "RevealReview",
        revealedAt: "2026-03-23T10:05:00.000Z",
        reason: "window-expired",
      },
      context: buyerReviewContext,
    });
  }

  const sellerReviewContext = createReputationSeedContext(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);
  const sellerReviewStreamId = marketplaceReviewStreamId(reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn);
  if (sellerToBuyerReview.state.reviewId === null) {
    await services.reviews.commandHandler({
      streamId: sellerReviewStreamId,
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
      context: sellerReviewContext,
    });
  }
  if (sellerToBuyerReview.state.status !== "withdrawn") {
    await services.reviews.commandHandler({
      streamId: sellerReviewStreamId,
      command: {
        type: "WithdrawReview",
        withdrawnAt: "2026-03-23T10:15:00.000Z",
      },
      context: sellerReviewContext,
    });
  }
}

export async function seedMarketplaceContextDatabase(
  pool: PgTransactionalPool,
  services: MarketplaceServices = createMarketplaceServices(pool),
) {
  await seedListingEvidencePolicy(services);
  await seedMarketplaceDatabase(pool, services);
  await seedReputationData(pool, services);
}
