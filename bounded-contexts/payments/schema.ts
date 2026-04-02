import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { paymentsPaymentSchemaSql } from "./payments/schema";
import { paymentsRefundSchemaSql } from "./refunds/schema";

export const paymentsSchemaSql = [
  eventCorePostgresSchemaSql,
  paymentsPaymentSchemaSql,
  paymentsRefundSchemaSql,
].join("\n\n");
