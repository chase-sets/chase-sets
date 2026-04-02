import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { fulfillmentShipmentSchemaSql } from "./shipments/schema";

export const fulfillmentSchemaSql = [
  eventCorePostgresSchemaSql,
  fulfillmentShipmentSchemaSql,
].join("\n\n");
