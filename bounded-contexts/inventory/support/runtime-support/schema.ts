import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { inventoryCatalogItemSchemaSql } from "../catalog-item-support/schema";
import { inventoryHoldSchemaSql } from "../../features/holds/read-model/schema";
import { inventoryRecordSchemaSql } from "../../features/records/read-model/schema";
import { inventoryReservationSchemaSql } from "../../features/reservations/read-model/schema";
import { inventoryStorageLocationSchemaSql } from "../../features/storage-locations/read-model/schema";

export const inventorySchemaSql = [
  eventCorePostgresSchemaSql,
  inventoryCatalogItemSchemaSql,
  inventoryStorageLocationSchemaSql,
  inventoryRecordSchemaSql,
  inventoryHoldSchemaSql,
  inventoryReservationSchemaSql,
].join("\n\n");
