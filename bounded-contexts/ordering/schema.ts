import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { orderingAccountSchemaSql } from "./accounts/schema";
import { orderingCatalogProjectionSchemaSql } from "./cart/catalog-schema";
import { orderingCartSchemaSql } from "./cart/schema";
import { orderingOrderSchemaSql } from "./orders/schema";
import { orderingSupplySourceSchemaSql } from "./orders/supply-source-schema";

export const orderingSchemaSql = [
  eventCorePostgresSchemaSql,
  orderingAccountSchemaSql,
  orderingCatalogProjectionSchemaSql,
  orderingCartSchemaSql,
  orderingSupplySourceSchemaSql,
  orderingOrderSchemaSql,
].join("\n\n");
