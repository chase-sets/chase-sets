import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { settlementWalletSchemaSql } from "./wallets/schema";
import { settlementPayoutSchemaSql } from "./payouts/schema";

export const settlementSchemaSql = [
  eventCorePostgresSchemaSql,
  settlementWalletSchemaSql,
  settlementPayoutSchemaSql,
].join("\n\n");
