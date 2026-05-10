import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { webNotificationsSchemaSql } from "@chase-sets/web-notifications";
import { fulfillmentSourceProjectionSchemaSql } from "../../features/shipments/integrations/source/source-schema";
import { fulfillmentShipmentSchemaSql } from "../../features/shipments/read-model/schema";

export const fulfillmentSchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  webNotificationsSchemaSql,
  fulfillmentSourceProjectionSchemaSql,
  fulfillmentShipmentSchemaSql,
].join("\n\n");
