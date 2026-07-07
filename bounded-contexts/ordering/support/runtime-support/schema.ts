import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { orderingAccountSchemaSql } from "../account-support/schema";
import { orderingOrderSchemaMigrations, orderingOrderSchemaSql } from "../../features/orders/read-model/schema";
import { orderingFulfillmentSourceSchemaSql } from "../../features/orders/integrations/fulfillment/fulfillment-source-schema";
import { orderingReputationSourceSchemaSql } from "../../features/orders/integrations/reputation/reputation-source-schema";
import {
  orderingSupplySourceSchemaMigrations,
  orderingSupplySourceSchemaSql,
} from "../../features/orders/integrations/supply/supply-source-schema";
import { postagePolicySchemaSql } from "../../features/postage-policies/read-model/schema";

export const orderingSchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  orderingAccountSchemaSql,
  orderingSupplySourceSchemaSql,
  orderingFulfillmentSourceSchemaSql,
  orderingReputationSourceSchemaSql,
  postagePolicySchemaSql,
  orderingOrderSchemaSql,
].join("\n\n");

export const orderingSchemaMigrations = [
  ...orderingSupplySourceSchemaMigrations,
  ...orderingOrderSchemaMigrations,
] as const;
