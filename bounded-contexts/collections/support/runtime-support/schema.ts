import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { savedListValuationSchemaSql } from "../../features/saved-list-valuation/read-model/schema";

export const collectionsSchemaSql = [eventCorePostgresSchemaSql, savedListValuationSchemaSql].join("\n\n");
