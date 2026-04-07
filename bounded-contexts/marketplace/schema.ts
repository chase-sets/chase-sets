import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { marketplaceListingSchemaSql } from "./listings/schema";
import { marketplaceSupplyProjectionSchemaSql } from "./listings/supply-schema";
import { marketplaceOfferSchemaSql } from "./offers/schema";

export const marketplaceSchemaSql = [
  eventCorePostgresSchemaSql,
  marketplaceSupplyProjectionSchemaSql,
  marketplaceListingSchemaSql,
  marketplaceOfferSchemaSql,
].join("\n\n");
