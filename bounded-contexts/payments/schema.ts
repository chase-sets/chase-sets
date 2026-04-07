import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { paymentsOrderInputSchemaSql } from "./payments/order-input-schema";
import { paymentsPaymentSchemaSql } from "./payments/schema";
import { paymentsRefundSchemaSql } from "./refunds/schema";

export const paymentsSchemaSql = [
  eventCorePostgresSchemaSql,
  paymentsOrderInputSchemaSql,
  paymentsPaymentSchemaSql,
  paymentsRefundSchemaSql,
].join("\n\n");
