import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { marketplaceListingSchemaSql } from "../../features/listings/read-model/schema";
import { marketplaceSupplyProjectionSchemaSql } from "../../features/listings/integrations/supply/supply-schema";
import { marketplaceOfferSchemaSql } from "../../features/offers/read-model/schema";

export const marketplaceSchemaSql = [
  eventCorePostgresSchemaSql,
  marketplaceSupplyProjectionSchemaSql,
  marketplaceListingSchemaSql,
  marketplaceOfferSchemaSql,
].join("\n\n");
