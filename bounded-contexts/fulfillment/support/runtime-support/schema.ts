import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { fulfillmentSourceProjectionSchemaSql } from "../../features/shipments/integrations/source/source-schema";
import {
  fulfillmentShipmentSchemaMigrations,
  fulfillmentShipmentSchemaSql,
} from "../../features/shipments/read-model/schema";

export const fulfillmentSchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  fulfillmentSourceProjectionSchemaSql,
  fulfillmentShipmentSchemaSql,
].join("\n\n");

export const fulfillmentSchemaMigrations = [...fulfillmentShipmentSchemaMigrations] as const;
