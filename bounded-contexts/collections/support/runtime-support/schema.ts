import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { savedListValuationSchemaSql } from "../../features/saved-list-valuation/read-model/schema";
import { savedListDiscoverySchemaSql } from "../../features/saved-lists/read-model/migrations/discovery-schema";
import { savedListReadModelSchemaSql } from "../../features/saved-lists/read-model/schema";
import { savedListSharedPageSchemaSql } from "../../features/saved-lists/read-model/shared-page-schema";
import { savedListRecoverySchemaSql } from "../../features/saved-lists/read-model/migrations/recovery";

export const collectionsSchemaSql = [
  eventCorePostgresSchemaSql,
  savedListValuationSchemaSql,
  savedListReadModelSchemaSql,
  savedListSharedPageSchemaSql,
  savedListDiscoverySchemaSql,
  savedListRecoverySchemaSql,
].join("\n\n");
