import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { orderingAccountSchemaSql } from "../account-support/schema";
import { orderingCatalogProjectionSchemaSql } from "../../features/cart/integrations/catalog/catalog-schema";
import { orderingCartSchemaSql } from "../../features/cart/read-model/schema";
import { orderingOrderSchemaSql } from "../../features/orders/read-model/schema";
import { orderingSupplySourceSchemaSql } from "../../features/orders/integrations/supply/supply-source-schema";

export const orderingSchemaSql = [
  eventCorePostgresSchemaSql,
  orderingAccountSchemaSql,
  orderingCatalogProjectionSchemaSql,
  orderingCartSchemaSql,
  orderingSupplySourceSchemaSql,
  orderingOrderSchemaSql,
].join("\n\n");
