import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { settlementWalletSchemaSql } from "./wallets/schema";
import { settlementPaymentSourceSchemaSql } from "./wallets/payment-source-schema";
import { settlementPayoutSchemaSql } from "./payouts/schema";

export const settlementSchemaSql = [
  eventCorePostgresSchemaSql,
  settlementPaymentSourceSchemaSql,
  settlementWalletSchemaSql,
  settlementPayoutSchemaSql,
].join("\n\n");
