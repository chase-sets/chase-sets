import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { orderingAccountSchemaSql } from "./accounts/schema";
import { orderingCartSchemaSql } from "./cart/schema";
import { orderingOrderSchemaSql } from "./orders/schema";

export const orderingSchemaSql = [
  eventCorePostgresSchemaSql,
  orderingAccountSchemaSql,
  orderingCartSchemaSql,
  orderingOrderSchemaSql,
].join("\n\n");
