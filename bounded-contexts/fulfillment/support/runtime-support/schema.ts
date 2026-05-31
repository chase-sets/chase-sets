import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { transactionalEmailOutboxSchemaSql } from "@chase-sets/transactional-email-outbox";
import { fulfillmentSourceProjectionSchemaSql } from "../../features/shipments/integrations/source/source-schema";
import { fulfillmentShipmentSchemaSql } from "../../features/shipments/read-model/schema";

export const fulfillmentSchemaSql = [
  eventCorePostgresSchemaSql,
  transactionalEmailOutboxSchemaSql,
  fulfillmentSourceProjectionSchemaSql,
  fulfillmentShipmentSchemaSql,
].join("\n\n");
