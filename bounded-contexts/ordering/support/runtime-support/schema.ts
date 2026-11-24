import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { orderingAccountSchemaSql } from "../account-support/schema";
import { orderingOrderSchemaMigrations, orderingOrderSchemaSql } from "../../features/orders/read-model/schema";
import { orderingFulfillmentSourceSchemaSql } from "../../features/orders/integrations/fulfillment/fulfillment-source-schema";
import { orderingReputationSourceSchemaSql } from "../../features/orders/integrations/reputation/reputation-source-schema";
import {
  orderingOpportunitySchemaSql,
  orderingOpportunitySchemaMigrations,
} from "../../features/orders/integrations/reputation/opportunity-schema";
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
  orderingOpportunitySchemaSql,
  postagePolicySchemaSql,
  orderingOrderSchemaSql,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for the Shipping Rates Policy -- see ../../features/orders/domain/shipping-rates.
  platformPolicySchemaSql,
].join("\n\n");

export const orderingSchemaMigrations = [
  ...orderingOpportunitySchemaMigrations,
  ...orderingSupplySourceSchemaMigrations,
  ...orderingOrderSchemaMigrations,
] as const;
