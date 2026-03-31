import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { marketplaceListingSchemaSql } from "./listings/schema";

export const marketplaceSchemaSql = [
  eventCorePostgresSchemaSql,
  marketplaceListingSchemaSql,
].join("\n\n");
