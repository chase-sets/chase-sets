import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import { catalogScenarioItems, catalogSeedIds, type SeedCatalogItemId } from "@chase-sets/catalog-seed";
import { demoIdentitySeedIds, identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  inventorySeedIds,
  type SeedInventoryHoldId,
  type SeedInventoryItemId,
  type SeedStorageLocationId,
} from "@chase-sets/inventory/seed-support/ids";
import { createInventoryProductDescriptor } from "../../features/inventory-items/integrations/catalog/versioning";
import { createInventoryServices } from "./services";
import { sendSeedCommand } from "../seed-support/context";

const DEMO_RELEASED_AT = "2026-03-31T00:00:00.000Z";

type StorageLocationSeed = Readonly<{
  storageLocationId: SeedStorageLocationId;
  accountId?: AccountId;
  name: string;
  description?: string;
  shipFromCode: string;
  shipFromAddress: AddressSnapshot;
}>;

type InventoryItemSeed = Readonly<{
  itemId: SeedInventoryItemId;
  accountId?: AccountId;
  catalogItemId: SeedCatalogItemId;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  gradedCard?: GradedCardSeedDetails;
  storageLocationId: SeedStorageLocationId;
  totalQuantity: number;
  acquisitionCostAmount: string;
}>;

type GradedCardSeedDetails = Readonly<{
  gradingCompany: string;
  grade: string;
  certificationNumber: string | null;
  population: Readonly<{
    populationAtGrade: number | null;
    populationHigher: number | null;
    source: string | null;
    asOf: string | null;
  }> | null;
  conditionDescriptors: string[];
}>;

type InventoryHoldSeed = Readonly<{
  holdId: SeedInventoryHoldId;
  itemId: SeedInventoryItemId;
  quantity: number;
  reason: string;
  notes?: string;
  releasedAt?: string;
}>;

const rawCardSelection = (conditionOptionId: string) =>
  [
    {
      dimensionId: catalogSeedIds.dimensions.form.dimensionId,
      optionId: catalogSeedIds.dimensions.form.optionIds.raw,
    },
    {
      dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
      optionId: conditionOptionId,
    },
  ] as const;

const gradedCardSelection = (gradingCompanyOptionId: string, gradeOptionId: string) =>
  [
    {
      dimensionId: catalogSeedIds.dimensions.form.dimensionId,
      optionId: catalogSeedIds.dimensions.form.optionIds.graded,
    },
    {
      dimensionId: catalogSeedIds.dimensions.gradingCompany.dimensionId,
      optionId: gradingCompanyOptionId,
    },
    {
      dimensionId: catalogSeedIds.dimensions.grade.dimensionId,
      optionId: gradeOptionId,
    },
  ] as const;

const storageLocations: readonly StorageLocationSeed[] = [
  {
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    name: "North shelf",
    description: "Singles and fast-moving modern inventory",
    shipFromCode: "CHI-WH-1",
    shipFromAddress: {
      name: "Chase Sets Shipping",
      company: "Chase Sets Demo",
      line1: "221 N LaSalle St",
      line2: "Suite 1200",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: "3125550101",
      email: "shipping@chasesets.test",
    },
  },
  {
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    name: "Vault annex",
    description: "Vintage singles and sealed reserve stock",
    shipFromCode: "CHI-ANNEX-2",
    shipFromAddress: {
      name: "Chase Sets Vault",
      company: "Chase Sets Demo",
      line1: "600 W Chicago Ave",
      city: "Chicago",
      state: "IL",
      postalCode: "60654",
      country: "US",
      phone: "3125550102",
      email: "vault@chasesets.test",
    },
  },
  {
    storageLocationId: inventorySeedIds.storageLocations.archivedOverflow,
    name: "Archived overflow",
    description: "Retired overflow storage kept for audit history",
    shipFromCode: "CHI-OLD-9",
    shipFromAddress: {
      name: "Chase Sets Overflow",
      company: "Chase Sets Demo",
      line1: "1900 S Clark St",
      city: "Chicago",
      state: "IL",
      postalCode: "60616",
      country: "US",
      phone: "3125550103",
      email: "overflow@chasesets.test",
    },
  },
  {
    storageLocationId: inventorySeedIds.storageLocations.cardVaultBackRoom,
    accountId: identitySeedIds.cardVault.accountId,
    name: "Card Vault back room",
    description: "Vintage singles and curated binder inventory",
    shipFromCode: "STL-VAULT-4",
    shipFromAddress: {
      name: "Card Vault Fulfillment",
      company: "Card Vault",
      line1: "720 Olive St",
      city: "Saint Louis",
      state: "MO",
      postalCode: "63101",
      country: "US",
      phone: "3145550104",
      email: "ship@cardvault.test",
    },
  },
  {
    storageLocationId: inventorySeedIds.storageLocations.sealedCaseWall,
    accountId: identitySeedIds.sealedStockroom.accountId,
    name: "Sealed case wall",
    description: "Fast-pick sealed product cases",
    shipFromCode: "IND-CASE-2",
    shipFromAddress: {
      name: "Sealed Stockroom Fulfillment",
      company: "Sealed Stockroom",
      line1: "200 S Meridian St",
      city: "Indianapolis",
      state: "IN",
      postalCode: "46225",
      country: "US",
      phone: "3175550105",
      email: "ship@sealedstockroom.test",
    },
  },
];

const inventoryItems: readonly InventoryItemSeed[] = [
  {
    itemId: inventorySeedIds.items.charizardBaseSetNearMint,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    selectedOptions: rawCardSelection(catalogSeedIds.dimensions.condition.optionIds.nearMint),
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    totalQuantity: 3,
    acquisitionCostAmount: "275.00",
  },
  {
    itemId: inventorySeedIds.items.charizardBaseSetPsa8,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    selectedOptions: gradedCardSelection(
      catalogSeedIds.dimensions.gradingCompany.optionIds.psa,
      catalogSeedIds.dimensions.grade.optionIds.nmMt8,
    ),
    gradedCard: {
      gradingCompany: "PSA",
      grade: "NM-MT 8",
      certificationNumber: "81234567",
      population: {
        populationAtGrade: 1842,
        populationHigher: 721,
        source: "PSA population report",
        asOf: "2026-04-01",
      },
      conditionDescriptors: ["Encapsulated", "Authentic label", "Minor holo scratching visible under angled light"],
    },
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    totalQuantity: 1,
    acquisitionCostAmount: "520.00",
  },
  {
    itemId: inventorySeedIds.items.pikachuJungleLightlyPlayed,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    selectedOptions: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        optionId: catalogSeedIds.dimensions.form.optionIds.raw,
      },
      {
        dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
        optionId: catalogSeedIds.dimensions.condition.optionIds.excellent,
      },
    ],
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    totalQuantity: 8,
    acquisitionCostAmount: "12.50",
  },
  {
    itemId: inventorySeedIds.items.lugiaNeoGenesisNearMint,
    catalogItemId: catalogScenarioItems.lugiaNeoGenesis,
    selectedOptions: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        optionId: catalogSeedIds.dimensions.form.optionIds.raw,
      },
      {
        dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
        optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
      },
    ],
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    totalQuantity: 2,
    acquisitionCostAmount: "180.00",
  },
  {
    itemId: inventorySeedIds.items.lugiaNeoGenesisBgs95,
    catalogItemId: catalogScenarioItems.lugiaNeoGenesis,
    selectedOptions: gradedCardSelection(
      catalogSeedIds.dimensions.gradingCompany.optionIds.bgs,
      catalogSeedIds.dimensions.grade.optionIds.mint95,
    ),
    gradedCard: {
      gradingCompany: "BGS",
      grade: "Mint 9.5",
      certificationNumber: "0012345678",
      population: null,
      conditionDescriptors: ["Encapsulated", "Strong centering", "Subgrades available on label"],
    },
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    totalQuantity: 1,
    acquisitionCostAmount: "475.00",
  },
  {
    itemId: inventorySeedIds.items.mewtwoBlackStarPromoNearMint,
    catalogItemId: catalogScenarioItems.mewtwoBlackStarPromo,
    selectedOptions: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        optionId: catalogSeedIds.dimensions.form.optionIds.raw,
      },
      {
        dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
        optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
      },
    ],
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    totalQuantity: 5,
    acquisitionCostAmount: "34.00",
  },
  {
    itemId: inventorySeedIds.items.pikachuPrismaticEvolutionsNearMint,
    catalogItemId: catalogScenarioItems.pikachuPrismaticEvolutions,
    selectedOptions: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        optionId: catalogSeedIds.dimensions.form.optionIds.raw,
      },
      {
        dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
        optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
      },
    ],
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    totalQuantity: 12,
    acquisitionCostAmount: "8.25",
  },
  {
    itemId: inventorySeedIds.items.pikachuPrismaticEvolutionsPsa10,
    catalogItemId: catalogScenarioItems.pikachuPrismaticEvolutions,
    selectedOptions: gradedCardSelection(
      catalogSeedIds.dimensions.gradingCompany.optionIds.psa,
      catalogSeedIds.dimensions.grade.optionIds.gemMint10,
    ),
    gradedCard: {
      gradingCompany: "PSA",
      grade: "Gem Mint 10",
      certificationNumber: "91234567",
      population: {
        populationAtGrade: 336,
        populationHigher: 0,
        source: "PSA population report",
        asOf: "2026-04-01",
      },
      conditionDescriptors: ["Encapsulated", "No visible whitening", "Clean modern slab presentation"],
    },
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    totalQuantity: 2,
    acquisitionCostAmount: "44.00",
  },
  {
    itemId: inventorySeedIds.items.prismaticEvolutionsBoosterPack,
    catalogItemId: catalogScenarioItems.prismaticEvolutionsBoosterPack,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    totalQuantity: 24,
    acquisitionCostAmount: "4.10",
  },
  {
    itemId: inventorySeedIds.items.surgingSparksBoosterBox,
    catalogItemId: catalogScenarioItems.surgingSparksBoosterBox,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    totalQuantity: 6,
    acquisitionCostAmount: "119.00",
  },
  {
    itemId: inventorySeedIds.items.twilightMasqueradeEliteTrainerBox,
    catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    totalQuantity: 4,
    acquisitionCostAmount: "41.50",
  },
  {
    itemId: inventorySeedIds.items.cardVaultCharizardNearMint,
    accountId: identitySeedIds.cardVault.accountId,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    selectedOptions: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        optionId: catalogSeedIds.dimensions.form.optionIds.raw,
      },
      {
        dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
        optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
      },
    ],
    storageLocationId: inventorySeedIds.storageLocations.cardVaultBackRoom,
    totalQuantity: 4,
    acquisitionCostAmount: "292.00",
  },
  {
    itemId: inventorySeedIds.items.cardVaultCharizardPsa8,
    accountId: identitySeedIds.cardVault.accountId,
    catalogItemId: catalogScenarioItems.charizardBaseSet,
    selectedOptions: gradedCardSelection(
      catalogSeedIds.dimensions.gradingCompany.optionIds.psa,
      catalogSeedIds.dimensions.grade.optionIds.nmMt8,
    ),
    gradedCard: {
      gradingCompany: "PSA",
      grade: "NM-MT 8",
      certificationNumber: "84561230",
      population: {
        populationAtGrade: 1842,
        populationHigher: 721,
        source: "PSA population report",
        asOf: "2026-04-01",
      },
      conditionDescriptors: ["Encapsulated", "Eye appeal copy", "Light edge whitening visible through slab"],
    },
    storageLocationId: inventorySeedIds.storageLocations.cardVaultBackRoom,
    totalQuantity: 1,
    acquisitionCostAmount: "535.00",
  },
  {
    itemId: inventorySeedIds.items.cardVaultPikachuExcellent,
    accountId: identitySeedIds.cardVault.accountId,
    catalogItemId: catalogScenarioItems.pikachuJungle,
    selectedOptions: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        optionId: catalogSeedIds.dimensions.form.optionIds.raw,
      },
      {
        dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
        optionId: catalogSeedIds.dimensions.condition.optionIds.excellent,
      },
    ],
    storageLocationId: inventorySeedIds.storageLocations.cardVaultBackRoom,
    totalQuantity: 14,
    acquisitionCostAmount: "11.75",
  },
  {
    itemId: inventorySeedIds.items.cardVaultMewtwoNearMint,
    accountId: identitySeedIds.cardVault.accountId,
    catalogItemId: catalogScenarioItems.mewtwoBlackStarPromo,
    selectedOptions: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        optionId: catalogSeedIds.dimensions.form.optionIds.raw,
      },
      {
        dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
        optionId: catalogSeedIds.dimensions.condition.optionIds.nearMint,
      },
    ],
    storageLocationId: inventorySeedIds.storageLocations.cardVaultBackRoom,
    totalQuantity: 5,
    acquisitionCostAmount: "32.00",
  },
  {
    itemId: inventorySeedIds.items.cardVaultTwilightMasqueradeEliteTrainerBox,
    accountId: identitySeedIds.cardVault.accountId,
    catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.cardVaultBackRoom,
    totalQuantity: 6,
    acquisitionCostAmount: "40.50",
  },
  {
    itemId: inventorySeedIds.items.sealedStockroomPrismaticEvolutionsBoosterPack,
    accountId: identitySeedIds.sealedStockroom.accountId,
    catalogItemId: catalogScenarioItems.prismaticEvolutionsBoosterPack,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.sealedCaseWall,
    totalQuantity: 96,
    acquisitionCostAmount: "4.00",
  },
  {
    itemId: inventorySeedIds.items.sealedStockroomSurgingSparksBoosterBox,
    accountId: identitySeedIds.sealedStockroom.accountId,
    catalogItemId: catalogScenarioItems.surgingSparksBoosterBox,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.sealedCaseWall,
    totalQuantity: 10,
    acquisitionCostAmount: "116.00",
  },
  {
    itemId: inventorySeedIds.items.sealedStockroomTwilightMasqueradeEliteTrainerBox,
    accountId: identitySeedIds.sealedStockroom.accountId,
    catalogItemId: catalogScenarioItems.twilightMasqueradeEliteTrainerBox,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.sealedCaseWall,
    totalQuantity: 8,
    acquisitionCostAmount: "39.50",
  },
];

const inventoryHolds: readonly InventoryHoldSeed[] = [
  {
    holdId: inventorySeedIds.holds.charizardCheckout,
    itemId: inventorySeedIds.items.charizardBaseSetNearMint,
    quantity: 1,
    reason: "Checkout hold",
    notes: "Cart awaiting payment",
  },
  {
    holdId: inventorySeedIds.holds.pikachuPackingReleased,
    itemId: inventorySeedIds.items.pikachuJungleLightlyPlayed,
    quantity: 2,
    reason: "Packing",
    notes: "Batch wave complete",
    releasedAt: DEMO_RELEASED_AT,
  },
  {
    holdId: inventorySeedIds.holds.lugiaQualityControl,
    itemId: inventorySeedIds.items.lugiaNeoGenesisNearMint,
    quantity: 1,
    reason: "Quality control",
    notes: "Centering review in progress",
  },
];

export async function seedInventoryDatabase(pool: PgTransactionalPool) {
  const services = createInventoryServices(pool);

  try {
    const existing = await services.db.query("SELECT COUNT(*) FROM inventory_storage_locations");
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Inventory already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  console.log("Starting inventory development seed...\n");

  for (const location of storageLocations) {
    const streamId = `inventory.storage-location-${location.storageLocationId}`;

    await sendSeedCommand(services.storageLocations.commandHandler, streamId, {
      type: "CreateStorageLocation",
      storageLocationId: location.storageLocationId,
      accountId: location.accountId ?? demoIdentitySeedIds.accountId,
      name: location.name,
      description: location.description,
      shipFromCode: location.shipFromCode,
      shipFromAddress: location.shipFromAddress,
    });

    if (location.storageLocationId === inventorySeedIds.storageLocations.archivedOverflow) {
      await sendSeedCommand(services.storageLocations.commandHandler, streamId, {
        type: "UpdateStorageLocation",
        name: location.name,
        description: location.description,
        shipFromCode: location.shipFromCode,
        shipFromAddress: location.shipFromAddress,
      });
      await sendSeedCommand(services.storageLocations.commandHandler, streamId, {
        type: "ArchiveStorageLocation",
      });
    }

    console.log(`  Storage location "${location.name}" created`);
  }

  for (const item of inventoryItems) {
    const streamId = `inventory.item-${item.itemId}`;
    const catalogItem = await services.catalogItems.getCatalogItem(item.catalogItemId);

    if (!catalogItem) {
      throw new Error(`Inventory seed could not load catalog item ${item.catalogItemId}.`);
    }

    const catalogVersion = createInventoryProductDescriptor({
      catalogItemId: item.catalogItemId,
      productSchema: catalogItem.product_schema,
      selection: item.selectedOptions,
    });

    await sendSeedCommand(services.items.commandHandler, streamId, {
      type: "CreateInventoryItem",
      itemId: item.itemId,
      accountId: item.accountId ?? demoIdentitySeedIds.accountId,
      catalogItemId: item.catalogItemId,
      productId: catalogVersion.productId,
      selectedOptions: catalogVersion.selection,
      gradedCard: item.gradedCard ?? null,
      storageLocationId: item.storageLocationId,
      totalQuantity: item.totalQuantity,
      acquisitionCostAmount: item.acquisitionCostAmount,
    });

    if (item.itemId === inventorySeedIds.items.charizardBaseSetNearMint) {
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "AdjustInventoryItemQuantity",
        quantityDelta: 1,
        heldQuantity: 0,
        reason: "Cycle count increase",
      });
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "AdjustInventoryItemQuantity",
        quantityDelta: -1,
        heldQuantity: 0,
        reason: "Reserve correction",
      });
    }

    console.log(`  Inventory item "${item.itemId}" created`);
  }

  for (const hold of inventoryHolds) {
    const streamId = `inventory.hold-${hold.holdId}`;

    await sendSeedCommand(services.holds.commandHandler, streamId, {
      type: "PlaceInventoryHold",
      holdId: hold.holdId,
      accountId: demoIdentitySeedIds.accountId,
      itemId: hold.itemId,
      quantity: hold.quantity,
      reason: hold.reason,
      notes: hold.notes,
      purpose: "manual",
      sourceRef: null,
      expiresAt: null,
    });

    if (hold.releasedAt) {
      await sendSeedCommand(services.holds.commandHandler, streamId, {
        type: "ReleaseInventoryHold",
        releasedAt: hold.releasedAt,
        releaseReason: "manual",
      });
    }

    console.log(`  Inventory hold "${hold.holdId}" seeded`);
  }

  console.log("\nInventory seed complete!");
}
