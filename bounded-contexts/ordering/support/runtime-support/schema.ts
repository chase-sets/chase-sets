import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { orderingAccountSchemaSql } from "../account-support/schema";
import { orderingOrderSchemaSql } from "../../features/orders/read-model/schema";
import { orderingFulfillmentSourceSchemaSql } from "../../features/orders/integrations/fulfillment/fulfillment-source-schema";
import { orderingSupplySourceSchemaSql } from "../../features/orders/integrations/supply/supply-source-schema";

export const orderingSchemaSql = [
  eventCorePostgresSchemaSql,
  orderingAccountSchemaSql,
  orderingSupplySourceSchemaSql,
  orderingFulfillmentSourceSchemaSql,
  orderingOrderSchemaSql,
].join("\n\n");
