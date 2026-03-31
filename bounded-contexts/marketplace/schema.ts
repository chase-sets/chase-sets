import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { marketplaceListingSchemaSql } from "./listings/schema";
import { marketplaceOfferSchemaSql } from "./offers/schema";

export const marketplaceSchemaSql = [
  eventCorePostgresSchemaSql,
  marketplaceListingSchemaSql,
  marketplaceOfferSchemaSql,
].join("\n\n");
