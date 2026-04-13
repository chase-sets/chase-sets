import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { paymentsOrderInputSchemaSql } from "../../features/payments/integrations/order-input/order-input-schema";
import { paymentsPaymentSchemaSql } from "../../features/payments/read-model/schema";
import { paymentsRefundSchemaSql } from "../../features/refunds/read-model/schema";

export const paymentsSchemaSql = [
  eventCorePostgresSchemaSql,
  paymentsOrderInputSchemaSql,
  paymentsPaymentSchemaSql,
  paymentsRefundSchemaSql,
].join("\n\n");
