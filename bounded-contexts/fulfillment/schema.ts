import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { fulfillmentSourceProjectionSchemaSql } from "./shipments/source-schema";
import { fulfillmentShipmentSchemaSql } from "./shipments/schema";

export const fulfillmentSchemaSql = [
  eventCorePostgresSchemaSql,
  fulfillmentSourceProjectionSchemaSql,
  fulfillmentShipmentSchemaSql,
].join("\n\n");
