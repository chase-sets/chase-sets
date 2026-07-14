import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { savedListValuationSchemaSql } from "../../features/saved-list-valuation/read-model/schema";
import { savedListReadModelSchemaSql } from "../../features/saved-lists/read-model/schema";
import { savedListSharedPageSchemaSql } from "../../features/saved-lists/read-model/shared-page-schema";

export const collectionsSchemaSql = [
  eventCorePostgresSchemaSql,
  savedListValuationSchemaSql,
  savedListReadModelSchemaSql,
  savedListSharedPageSchemaSql,
].join("\n\n");
