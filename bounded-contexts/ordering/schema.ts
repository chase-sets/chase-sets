import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { orderingCartSchemaSql } from "./cart/schema";
import { orderingOrderSchemaSql } from "./orders/schema";

export const orderingSchemaSql = [
  eventCorePostgresSchemaSql,
  orderingCartSchemaSql,
  orderingOrderSchemaSql,
].join("\n\n");
