import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { fulfillmentSourceProjectionSchemaSql } from "../../features/shipments/integrations/source/source-schema";
import { fulfillmentSupportReturnSourceSchemaSql } from "../../features/return-shipments/integrations/support/support-source-schema";
import {
  fulfillmentShipmentSchemaMigrations,
  fulfillmentShipmentSchemaSql,
} from "../../features/shipments/read-model/schema";
import {
  fulfillmentReturnShipmentSchemaMigrations,
  fulfillmentReturnShipmentSchemaSql,
} from "../../features/return-shipments/read-model/schema";

export const fulfillmentSchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  fulfillmentSourceProjectionSchemaSql,
  fulfillmentSupportReturnSourceSchemaSql,
  fulfillmentShipmentSchemaSql,
  fulfillmentReturnShipmentSchemaSql,
].join("\n\n");

export const fulfillmentSchemaMigrations = [
  ...fulfillmentShipmentSchemaMigrations,
  ...fulfillmentReturnShipmentSchemaMigrations,
] as const;
