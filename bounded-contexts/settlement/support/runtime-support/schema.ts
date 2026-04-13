import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { settlementWalletSchemaSql } from "../../features/wallets/read-model/schema";
import { settlementPaymentSourceSchemaSql } from "../../features/wallets/integrations/payment-source/payment-source-schema";
import { settlementPayoutSchemaSql } from "../../features/payouts/read-model/schema";

export const settlementSchemaSql = [
  eventCorePostgresSchemaSql,
  settlementPaymentSourceSchemaSql,
  settlementWalletSchemaSql,
  settlementPayoutSchemaSql,
].join("\n\n");
