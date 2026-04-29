import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  catalogSeedIds,
  type SeedCatalogItemId,
} from "@chase-sets/catalog/seed-support/ids";
import {
  demoIdentitySeedIds,
  identitySeedIds,
} from "@chase-sets/identity/seed-support/ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  inventorySeedIds,
  type SeedInventoryHoldId,
  type SeedInventoryItemId,
  type SeedStorageLocationId,
} from "@chase-sets/inventory/seed-support/ids";
import { createInventoryProductDescriptor } from "../../features/inventory-items/integrations/catalog/versioning";
import { createInventoryServices } from "./services";
import { drainProjectors, sendSeedCommand } from "../seed-support/context";

const DEMO_RELEASED_AT = "2026-03-31T00:00:00.000Z";

type StorageLocationSeed = Readonly<{
  storageLocationId: SeedStorageLocationId;
  accountId?: AccountId;
  name: string;
  description?: string;
  shipFromCode: string;
}>;

type InventoryItemSeed = Readonly<{
  itemId: SeedInventoryItemId;
  accountId?: AccountId;
  catalogItemId: SeedCatalogItemId;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  storageLocationId: SeedStorageLocationId;
  totalQuantity: number;
  acquisitionCostAmount: string;
}>;

type InventoryHoldSeed = Readonly<{
  holdId: SeedInventoryHoldId;
  itemId: SeedInventoryItemId;
  quantity: number;
  reason: string;
  notes?: string;
  releasedAt?: string;
}>;

const storageLocations: readonly StorageLocationSeed[] = [
  {
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    name: "North shelf",
    description: "Singles and fast-moving modern inventory",
    shipFromCode: "CHI-WH-1",
  },
  {
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    name: "Vault annex",
    description: "Vintage singles and sealed reserve stock",
    shipFromCode: "CHI-ANNEX-2",
  },
  {
    storageLocationId: inventorySeedIds.storageLocations.archivedOverflow,
    name: "Archived overflow",
    description: "Retired overflow storage kept for audit history",
    shipFromCode: "CHI-OLD-9",
  },
  {
    storageLocationId: inventorySeedIds.storageLocations.cardVaultBackRoom,
    accountId: identitySeedIds.cardVaultSeller.accountId,
    name: "Card Vault back room",
    description: "Vintage singles and curated binder inventory",
    shipFromCode: "STL-VAULT-4",
  },
  {
    storageLocationId: inventorySeedIds.storageLocations.sealedCaseWall,
    accountId: identitySeedIds.sealedSeller.accountId,
    name: "Sealed case wall",
    description: "Fast-pick sealed product cases",
    shipFromCode: "IND-CASE-2",
  },
];

const inventoryItems: readonly InventoryItemSeed[] = [
  {
    itemId: inventorySeedIds.items.charizardBaseSetNearMint,
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
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
    totalQuantity: 3,
    acquisitionCostAmount: "275.00",
  },
  {
    itemId: inventorySeedIds.items.pikachuJungleLightlyPlayed,
    catalogItemId: catalogSeedIds.items.pikachuJungle,
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
    catalogItemId: catalogSeedIds.items.lugiaNeoGenesis,
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
    itemId: inventorySeedIds.items.mewtwoBlackStarPromoNearMint,
    catalogItemId: catalogSeedIds.items.mewtwoBlackStarPromo,
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
    catalogItemId: catalogSeedIds.items.pikachuPrismaticEvolutions,
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
    itemId: inventorySeedIds.items.prismaticEvolutionsBoosterPack,
    catalogItemId: catalogSeedIds.items.prismaticEvolutionsBoosterPack,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    totalQuantity: 24,
    acquisitionCostAmount: "4.10",
  },
  {
    itemId: inventorySeedIds.items.surgingSparksBoosterBox,
    catalogItemId: catalogSeedIds.items.surgingSparksBoosterBox,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    totalQuantity: 6,
    acquisitionCostAmount: "119.00",
  },
  {
    itemId: inventorySeedIds.items.twilightMasqueradeEliteTrainerBox,
    catalogItemId: catalogSeedIds.items.twilightMasqueradeEliteTrainerBox,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    totalQuantity: 4,
    acquisitionCostAmount: "41.50",
  },
  {
    itemId: inventorySeedIds.items.cardVaultCharizardNearMint,
    accountId: identitySeedIds.cardVaultSeller.accountId,
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
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
    itemId: inventorySeedIds.items.cardVaultPikachuExcellent,
    accountId: identitySeedIds.cardVaultSeller.accountId,
    catalogItemId: catalogSeedIds.items.pikachuJungle,
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
    accountId: identitySeedIds.cardVaultSeller.accountId,
    catalogItemId: catalogSeedIds.items.mewtwoBlackStarPromo,
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
    accountId: identitySeedIds.cardVaultSeller.accountId,
    catalogItemId: catalogSeedIds.items.twilightMasqueradeEliteTrainerBox,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.cardVaultBackRoom,
    totalQuantity: 6,
    acquisitionCostAmount: "40.50",
  },
  {
    itemId: inventorySeedIds.items.sealedSellerPrismaticEvolutionsBoosterPack,
    accountId: identitySeedIds.sealedSeller.accountId,
    catalogItemId: catalogSeedIds.items.prismaticEvolutionsBoosterPack,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.sealedCaseWall,
    totalQuantity: 96,
    acquisitionCostAmount: "4.00",
  },
  {
    itemId: inventorySeedIds.items.sealedSellerSurgingSparksBoosterBox,
    accountId: identitySeedIds.sealedSeller.accountId,
    catalogItemId: catalogSeedIds.items.surgingSparksBoosterBox,
    selectedOptions: [],
    storageLocationId: inventorySeedIds.storageLocations.sealedCaseWall,
    totalQuantity: 10,
    acquisitionCostAmount: "116.00",
  },
  {
    itemId: inventorySeedIds.items.sealedSellerTwilightMasqueradeEliteTrainerBox,
    accountId: identitySeedIds.sealedSeller.accountId,
    catalogItemId: catalogSeedIds.items.twilightMasqueradeEliteTrainerBox,
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
    notes: "Buyer cart awaiting payment",
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
    const existing = await services.db.query(
      "SELECT COUNT(*) FROM inventory_storage_locations",
    );
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Inventory already contains data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  console.log("Starting inventory development seed...\n");

  await drainProjectors("inventory-catalog", services.catalogItems.projectors);

  for (const location of storageLocations) {
    const streamId = `inventory.storage-location-${location.storageLocationId}`;

    await sendSeedCommand(services.storageLocations.commandHandler, streamId, {
      type: "CreateStorageLocation",
      storageLocationId: location.storageLocationId,
      accountId: location.accountId ?? demoIdentitySeedIds.accountId,
      name: location.name,
      description: location.description,
      shipFromCode: location.shipFromCode,
    });

    if (location.storageLocationId === inventorySeedIds.storageLocations.archivedOverflow) {
      await sendSeedCommand(services.storageLocations.commandHandler, streamId, {
        type: "UpdateStorageLocation",
        name: location.name,
        description: location.description,
        shipFromCode: location.shipFromCode,
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
      storageLocationId: item.storageLocationId,
      totalQuantity: item.totalQuantity,
      acquisitionCostAmount: item.acquisitionCostAmount,
    });

    if (item.itemId === inventorySeedIds.items.charizardBaseSetNearMint) {
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "AdjustInventoryItemQuantity",
        quantityDelta: 1,
        reason: "Cycle count increase",
      });
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "AdjustInventoryItemQuantity",
        quantityDelta: -1,
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
    });

    if (hold.releasedAt) {
      await sendSeedCommand(services.holds.commandHandler, streamId, {
        type: "ReleaseInventoryHold",
        releasedAt: hold.releasedAt,
      });
    }

    console.log(`  Inventory hold "${hold.holdId}" seeded`);
  }

  await drainProjectors("inventory", services.projectors);
  console.log("\nInventory seed complete!");
}
