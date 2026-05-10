import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { webNotificationsSchemaSql } from "@chase-sets/web-notifications";
import { orderingAccountSchemaSql } from "../account-support/schema";
import { orderingOrderSchemaSql } from "../../features/orders/read-model/schema";
import { orderingSupplySourceSchemaSql } from "../../features/orders/integrations/supply/supply-source-schema";

export const orderingSchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  webNotificationsSchemaSql,
  orderingAccountSchemaSql,
  orderingSupplySourceSchemaSql,
  orderingOrderSchemaSql,
].join("\n\n");
