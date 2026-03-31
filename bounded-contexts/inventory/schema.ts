import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { inventoryHoldSchemaSql } from "./holds/schema";
import { inventoryRecordSchemaSql } from "./records/schema";
import { inventoryStorageLocationSchemaSql } from "./storage-locations/schema";

export const inventorySchemaSql = [
  eventCorePostgresSchemaSql,
  inventoryStorageLocationSchemaSql,
  inventoryRecordSchemaSql,
  inventoryHoldSchemaSql,
].join("\n\n");
