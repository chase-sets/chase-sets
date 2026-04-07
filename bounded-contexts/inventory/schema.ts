import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { inventoryCatalogItemSchemaSql } from "./catalog-items/schema";
import { inventoryHoldSchemaSql } from "./holds/schema";
import { inventoryRecordSchemaSql } from "./records/schema";
import { inventoryReservationSchemaSql } from "./reservations/schema";
import { inventoryStorageLocationSchemaSql } from "./storage-locations/schema";

export const inventorySchemaSql = [
  eventCorePostgresSchemaSql,
  inventoryCatalogItemSchemaSql,
  inventoryStorageLocationSchemaSql,
  inventoryRecordSchemaSql,
  inventoryHoldSchemaSql,
  inventoryReservationSchemaSql,
].join("\n\n");
