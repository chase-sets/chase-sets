import type { BcSeedAggregateStateReport } from "@chase-sets/bounded-context-module";
import { loadSeedAggregateState, type SeedAggregateState } from "@chase-sets/bounded-context-runtime";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
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
import {
  evolveStorageLocation,
  initialStorageLocationState,
  type StorageLocationEvent,
  type StorageLocationState,
} from "../../features/storage-locations/domain/domain";
import {
  evolveInventoryItem,
  initialInventoryItemState,
  type InventoryItemEvent,
  type InventoryItemState,
} from "../../features/inventory-items/domain/domain";
import {
  evolveInventoryHold,
  initialInventoryHoldState,
  type InventoryHoldEvent,
  type InventoryHoldState,
} from "../../features/holds/domain/domain";
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

const INVENTORY_BOOTSTRAP_LABEL = "Inventory seed bootstrap";

const storageLocationStreamId = (storageLocationId: string) => `inventory.storage-location-${storageLocationId}`;
const inventoryItemStreamId = (itemId: string) => `inventory.item-${itemId}`;
const inventoryHoldStreamId = (holdId: string) => `inventory.hold-${holdId}`;

type SeedItemAdjustment = Readonly<{
  quantityDelta: number;
  heldQuantity: number;
  reason: string;
  reasonCode: "correction";
}>;

const itemAdjustments = (item: InventoryItemSeed): readonly SeedItemAdjustment[] =>
  item.itemId === inventorySeedIds.items.charizardBaseSetNearMint
    ? [
        { quantityDelta: 1, heldQuantity: 0, reason: "Cycle count increase", reasonCode: "correction" },
        { quantityDelta: -1, heldQuantity: 0, reason: "Reserve correction", reasonCode: "correction" },
      ]
    : [];

const expectsArchived = (location: StorageLocationSeed) =>
  location.storageLocationId === inventorySeedIds.storageLocations.archivedOverflow;

/**
 * Storage-location re-author decision, folded from `inventory.*` event streams.
 *
 * `inventory_storage_locations` is UNLOGGED, so PostgreSQL truncates it on
 * crash recovery while the logged streams survive; the projection-sourced guard
 * this replaced then read zero rows and replayed `CreateStorageLocation` into an
 * existing aggregate, which the domain correctly rejects with
 * `Storage location has already been created`.
 */
function loadStorageLocationSeedState(
  db: PgQueryable,
  location: StorageLocationSeed,
): Promise<SeedAggregateState<StorageLocationState, StorageLocationEvent>> {
  const archived = expectsArchived(location);
  return loadSeedAggregateState<StorageLocationState, StorageLocationEvent>({
    db,
    bootstrapLabel: INVENTORY_BOOTSTRAP_LABEL,
    aggregateName: "Storage Location",
    streamId: storageLocationStreamId(location.storageLocationId),
    createdEventType: "inventory.storage-location.created",
    createdIdField: "storageLocationId",
    createdKeyField: "shipFromCode",
    expectedId: location.storageLocationId,
    expectedKey: location.shipFromCode,
    initialState: initialStorageLocationState,
    evolve: evolveStorageLocation,
    identity: (state) => ({ id: state.id, key: state.shipFromCode }),
    status: (state, events) => {
      if (state.isArchived) {
        return "archived";
      }
      return archived && events.some((event) => event.type === "inventory.storage-location.updated")
        ? "updated"
        : "active";
    },
    completedStatuses: archived ? ["archived"] : ["active"],
    terminalStatuses: archived ? [] : ["archived"],
    resumableStatuses: archived ? ["active", "updated"] : [],
  });
}

function loadInventoryItemSeedState(
  db: PgQueryable,
  item: InventoryItemSeed,
): Promise<SeedAggregateState<InventoryItemState, InventoryItemEvent>> {
  const expectedAdjustments = itemAdjustments(item).length;
  return loadSeedAggregateState<InventoryItemState, InventoryItemEvent>({
    db,
    bootstrapLabel: INVENTORY_BOOTSTRAP_LABEL,
    aggregateName: "Inventory Item",
    streamId: inventoryItemStreamId(item.itemId),
    createdEventType: "inventory.item.created",
    createdIdField: "itemId",
    createdKeyField: null,
    expectedId: item.itemId,
    expectedKey: item.itemId,
    initialState: initialInventoryItemState,
    evolve: evolveInventoryItem,
    identity: (state) => ({ id: state.id, key: state.id }),
    // Item quantity nets back to its seeded total after both adjustments, so
    // completion is not visible in the aggregate's own state. Count the
    // committed adjustment events instead of trusting stream presence.
    status: (_state, events) =>
      countAppliedAdjustments(events) >= expectedAdjustments ? "created" : "partially-adjusted",
    completedStatuses: ["created"],
    resumableStatuses: ["partially-adjusted"],
    validateIdentity: (state) => {
      const expectedAccountId = String(item.accountId ?? demoIdentitySeedIds.accountId);
      if (String(state.accountId) !== expectedAccountId || String(state.catalogItemId) !== String(item.catalogItemId)) {
        throw new Error(
          `${INVENTORY_BOOTSTRAP_LABEL} Inventory Item '${item.itemId}' expected account ` +
            `'${expectedAccountId}' and catalog item '${item.catalogItemId}', but found account ` +
            `'${state.accountId ?? "null"}' and catalog item '${state.catalogItemId ?? "null"}'. ` +
            `Stream '${inventoryItemStreamId(item.itemId)}'.`,
        );
      }
    },
  });
}

function countAppliedAdjustments(events: readonly InventoryItemEvent[]): number {
  return events.filter((event) => event.type === "inventory.item.adjusted").length;
}

function loadInventoryHoldSeedState(
  db: PgQueryable,
  hold: InventoryHoldSeed,
): Promise<SeedAggregateState<InventoryHoldState, InventoryHoldEvent>> {
  const expectsReleased = hold.releasedAt !== undefined;
  return loadSeedAggregateState<InventoryHoldState, InventoryHoldEvent>({
    db,
    bootstrapLabel: INVENTORY_BOOTSTRAP_LABEL,
    aggregateName: "Inventory Hold",
    streamId: inventoryHoldStreamId(hold.holdId),
    createdEventType: "inventory.hold.placed",
    createdIdField: "holdId",
    createdKeyField: null,
    expectedId: hold.holdId,
    expectedKey: hold.holdId,
    initialState: initialInventoryHoldState,
    evolve: evolveInventoryHold,
    identity: (state) => ({ id: state.id, key: state.id }),
    status: (state) => String(state.status),
    completedStatuses: expectsReleased ? ["released"] : ["active"],
    terminalStatuses: expectsReleased ? ["consumed", "expired"] : ["released", "consumed", "expired"],
    resumableStatuses: expectsReleased ? ["active"] : [],
    validateIdentity: (state) => {
      if (String(state.itemId) !== String(hold.itemId)) {
        throw new Error(
          `${INVENTORY_BOOTSTRAP_LABEL} Inventory Hold '${hold.holdId}' expected item '${hold.itemId}', ` +
            `but found '${state.itemId ?? "null"}'. Stream '${inventoryHoldStreamId(hold.holdId)}'.`,
        );
      }
    },
  });
}

/**
 * Reports every base aggregate the Inventory seed authors, folded from the
 * authoritative `inventory.*` streams. Throws for the same retained-state
 * conflicts the seed itself refuses to paper over.
 */
export async function inspectInventorySeedState(db: PgQueryable): Promise<readonly BcSeedAggregateStateReport[]> {
  const reports: BcSeedAggregateStateReport[] = [];

  for (const location of storageLocations) {
    const state = await loadStorageLocationSeedState(db, location);
    reports.push({
      contextName: "inventory",
      aggregateName: "Storage Location",
      id: location.storageLocationId,
      key: location.shipFromCode,
      streamId: storageLocationStreamId(location.storageLocationId),
      kind: state.kind,
      status: state.status,
      eventCount: state.events.length,
    });
  }
  for (const item of inventoryItems) {
    const state = await loadInventoryItemSeedState(db, item);
    reports.push({
      contextName: "inventory",
      aggregateName: "Inventory Item",
      id: item.itemId,
      key: item.itemId,
      streamId: inventoryItemStreamId(item.itemId),
      kind: state.kind,
      status: state.status,
      eventCount: state.events.length,
    });
  }
  for (const hold of inventoryHolds) {
    const state = await loadInventoryHoldSeedState(db, hold);
    reports.push({
      contextName: "inventory",
      aggregateName: "Inventory Hold",
      id: hold.holdId,
      key: hold.holdId,
      streamId: inventoryHoldStreamId(hold.holdId),
      kind: state.kind,
      status: state.status,
      eventCount: state.events.length,
    });
  }

  return reports;
}

export async function seedInventoryDatabase(pool: PgTransactionalPool) {
  const services = createInventoryServices(pool);

  console.log("Starting inventory development seed...\n");

  for (const location of storageLocations) {
    const streamId = storageLocationStreamId(location.storageLocationId);
    const persisted = await loadStorageLocationSeedState(services.db, location);
    if (persisted.kind === "active") {
      continue;
    }

    if (persisted.kind === "absent") {
      await sendSeedCommand(services.storageLocations.commandHandler, streamId, {
        type: "CreateStorageLocation",
        storageLocationId: location.storageLocationId,
        accountId: location.accountId ?? demoIdentitySeedIds.accountId,
        name: location.name,
        description: location.description,
        shipFromCode: location.shipFromCode,
        shipFromAddress: location.shipFromAddress,
      });
    }

    if (expectsArchived(location)) {
      if (!persisted.events.some((event) => event.type === "inventory.storage-location.updated")) {
        await sendSeedCommand(services.storageLocations.commandHandler, streamId, {
          type: "UpdateStorageLocation",
          name: location.name,
          description: location.description,
          shipFromCode: location.shipFromCode,
          shipFromAddress: location.shipFromAddress,
        });
      }
      await sendSeedCommand(services.storageLocations.commandHandler, streamId, {
        type: "ArchiveStorageLocation",
      });
    }

    console.log(`  Storage location "${location.name}" created`);
  }

  for (const item of inventoryItems) {
    const streamId = inventoryItemStreamId(item.itemId);
    const persisted = await loadInventoryItemSeedState(services.db, item);
    if (persisted.kind === "active") {
      continue;
    }

    if (persisted.kind === "absent") {
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
    }

    for (const adjustment of itemAdjustments(item).slice(countAppliedAdjustments(persisted.events))) {
      await sendSeedCommand(services.items.commandHandler, streamId, {
        type: "AdjustInventoryItemQuantity",
        quantityDelta: adjustment.quantityDelta,
        heldQuantity: adjustment.heldQuantity,
        reason: adjustment.reason,
        reasonCode: adjustment.reasonCode,
      });
    }

    console.log(`  Inventory item "${item.itemId}" created`);
  }

  for (const hold of inventoryHolds) {
    const streamId = inventoryHoldStreamId(hold.holdId);
    const persisted = await loadInventoryHoldSeedState(services.db, hold);
    if (persisted.kind === "active") {
      continue;
    }

    if (persisted.kind === "absent") {
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
    }

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
