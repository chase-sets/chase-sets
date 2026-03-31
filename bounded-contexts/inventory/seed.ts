import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  catalogSeedIds,
  demoIdentitySeedIds,
  inventorySeedIds,
} from "@chase-sets/dev-seeds";
import type {
  SeedCatalogItemId,
  SeedInventoryHoldId,
  SeedInventoryRecordId,
  SeedStorageLocationId,
} from "@chase-sets/dev-seeds";
import { createInventoryServices } from "./services";
import { drainProjectors, sendSeedCommand } from "./seed-support";

const DEMO_RELEASED_AT = "2026-03-31T00:00:00.000Z";

type StorageLocationSeed = Readonly<{
  storageLocationId: SeedStorageLocationId;
  name: string;
  description?: string;
  shipFromCode: string;
}>;

type InventoryRecordSeed = Readonly<{
  recordId: SeedInventoryRecordId;
  catalogItemId: SeedCatalogItemId;
  versionSelection: readonly { dimensionId: string; choiceId: string }[];
  condition: string;
  storageLocationId: SeedStorageLocationId;
  totalQuantity: number;
  acquisitionCostAmount: string;
}>;

type InventoryHoldSeed = Readonly<{
  holdId: SeedInventoryHoldId;
  recordId: SeedInventoryRecordId;
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
];

const inventoryRecords: readonly InventoryRecordSeed[] = [
  {
    recordId: inventorySeedIds.records.charizardBaseSetNearMint,
    catalogItemId: catalogSeedIds.items.charizardBaseSet,
    versionSelection: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        choiceId: catalogSeedIds.dimensions.form.choiceIds.raw,
      },
    ],
    condition: "NM",
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    totalQuantity: 3,
    acquisitionCostAmount: "275.00",
  },
  {
    recordId: inventorySeedIds.records.pikachuJungleLightlyPlayed,
    catalogItemId: catalogSeedIds.items.pikachuJungle,
    versionSelection: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        choiceId: catalogSeedIds.dimensions.form.choiceIds.raw,
      },
    ],
    condition: "LP",
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    totalQuantity: 8,
    acquisitionCostAmount: "12.50",
  },
  {
    recordId: inventorySeedIds.records.lugiaNeoGenesisNearMint,
    catalogItemId: catalogSeedIds.items.lugiaNeoGenesis,
    versionSelection: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        choiceId: catalogSeedIds.dimensions.form.choiceIds.raw,
      },
    ],
    condition: "NM",
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    totalQuantity: 2,
    acquisitionCostAmount: "180.00",
  },
  {
    recordId: inventorySeedIds.records.pikachuPrismaticEvolutionsNearMint,
    catalogItemId: catalogSeedIds.items.pikachuPrismaticEvolutions,
    versionSelection: [
      {
        dimensionId: catalogSeedIds.dimensions.form.dimensionId,
        choiceId: catalogSeedIds.dimensions.form.choiceIds.raw,
      },
    ],
    condition: "NM",
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    totalQuantity: 12,
    acquisitionCostAmount: "8.25",
  },
  {
    recordId: inventorySeedIds.records.prismaticEvolutionsBoosterPack,
    catalogItemId: catalogSeedIds.items.prismaticEvolutionsBoosterPack,
    versionSelection: [],
    condition: "Sealed",
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    totalQuantity: 24,
    acquisitionCostAmount: "4.10",
  },
  {
    recordId: inventorySeedIds.records.surgingSparksBoosterBox,
    catalogItemId: catalogSeedIds.items.surgingSparksBoosterBox,
    versionSelection: [],
    condition: "Sealed",
    storageLocationId: inventorySeedIds.storageLocations.vaultAnnex,
    totalQuantity: 6,
    acquisitionCostAmount: "119.00",
  },
  {
    recordId: inventorySeedIds.records.twilightMasqueradeEliteTrainerBox,
    catalogItemId: catalogSeedIds.items.twilightMasqueradeEliteTrainerBox,
    versionSelection: [],
    condition: "Sealed",
    storageLocationId: inventorySeedIds.storageLocations.northShelf,
    totalQuantity: 4,
    acquisitionCostAmount: "41.50",
  },
];

const inventoryHolds: readonly InventoryHoldSeed[] = [
  {
    holdId: inventorySeedIds.holds.charizardCheckout,
    recordId: inventorySeedIds.records.charizardBaseSetNearMint,
    quantity: 1,
    reason: "Checkout hold",
    notes: "Buyer cart awaiting payment",
  },
  {
    holdId: inventorySeedIds.holds.pikachuPackingReleased,
    recordId: inventorySeedIds.records.pikachuJungleLightlyPlayed,
    quantity: 2,
    reason: "Packing",
    notes: "Batch wave complete",
    releasedAt: DEMO_RELEASED_AT,
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
      accountId: demoIdentitySeedIds.accountId,
      name: location.name,
      description: location.description,
      shipFromCode: location.shipFromCode,
    });

    console.log(`  Storage location "${location.name}" created`);
  }

  for (const record of inventoryRecords) {
    const streamId = `inventory.record-${record.recordId}`;

    await sendSeedCommand(services.records.commandHandler, streamId, {
      type: "CreateInventoryRecord",
      recordId: record.recordId,
      accountId: demoIdentitySeedIds.accountId,
      catalogItemId: record.catalogItemId,
      versionSelection: record.versionSelection,
      condition: record.condition,
      storageLocationId: record.storageLocationId,
      totalQuantity: record.totalQuantity,
      acquisitionCostAmount: record.acquisitionCostAmount,
    });

    console.log(`  Inventory record "${record.recordId}" created`);
  }

  for (const hold of inventoryHolds) {
    const streamId = `inventory.hold-${hold.holdId}`;

    await sendSeedCommand(services.holds.commandHandler, streamId, {
      type: "PlaceInventoryHold",
      holdId: hold.holdId,
      accountId: demoIdentitySeedIds.accountId,
      recordId: hold.recordId,
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
