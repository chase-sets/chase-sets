import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { inventoryCatalogItemSchemaMigrations, inventoryCatalogItemSchemaSql } from "../catalog-item-support/schema";
import { inventoryHoldSchemaMigrations, inventoryHoldSchemaSql } from "../../features/holds/read-model/schema";
import { inventoryHoldCollisionSchemaSql } from "../../features/hold-collisions/read-model/schema";
import { inventoryImportBatchSchemaSql } from "../../features/import-batches/read-model/schema";
import {
  inventoryItemSchemaMigrations,
  inventoryItemSchemaSql,
} from "../../features/inventory-items/read-model/schema";
import { inventoryReservationSchemaSql } from "../../features/reservations/read-model/schema";
import { inventoryRestockDecisionSchemaSql } from "../../features/restock-decisions/read-model/schema";
import { inventoryRecoveredItemSchemaSql } from "../../features/recovered-items/read-model/schema";
import { inventoryStorageLocationSchemaSql } from "../../features/storage-locations/read-model/schema";

export const inventorySchemaSql = [
  eventCorePostgresSchemaSql,
  inventoryCatalogItemSchemaSql,
  inventoryStorageLocationSchemaSql,
  inventoryItemSchemaSql,
  inventoryRestockDecisionSchemaSql,
  inventoryRecoveredItemSchemaSql,
  inventoryImportBatchSchemaSql,
  inventoryHoldSchemaSql,
  inventoryHoldCollisionSchemaSql,
  inventoryReservationSchemaSql,
].join("\n\n");

export const inventorySchemaMigrations = [
  ...inventoryItemSchemaMigrations,
  ...inventoryHoldSchemaMigrations,
  ...inventoryCatalogItemSchemaMigrations,
] as const;
