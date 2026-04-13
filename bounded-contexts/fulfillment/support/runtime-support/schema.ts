import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { fulfillmentSourceProjectionSchemaSql } from "../../features/shipments/integrations/source/source-schema";
import { fulfillmentShipmentSchemaSql } from "../../features/shipments/read-model/schema";

export const fulfillmentSchemaSql = [
  eventCorePostgresSchemaSql,
  fulfillmentSourceProjectionSchemaSql,
  fulfillmentShipmentSchemaSql,
].join("\n\n");
