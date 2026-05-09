import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { transactionalEmailOutboxSchemaSql } from "@chase-sets/transactional-email-outbox";
import { orderingAccountSchemaSql } from "../account-support/schema";
import { orderingOrderSchemaSql } from "../../features/orders/read-model/schema";
import { orderingSupplySourceSchemaSql } from "../../features/orders/integrations/supply/supply-source-schema";

export const orderingSchemaSql = [
  eventCorePostgresSchemaSql,
  transactionalEmailOutboxSchemaSql,
  orderingAccountSchemaSql,
  orderingSupplySourceSchemaSql,
  orderingOrderSchemaSql,
].join("\n\n");
