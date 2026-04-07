import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { reputationReviewSchemaSql } from "./reviews/schema";
import { reputationSourceProjectionSchemaSql } from "./reviews/source-schema";

export const reputationSchemaSql = [
  eventCorePostgresSchemaSql,
  reputationSourceProjectionSchemaSql,
  reputationReviewSchemaSql,
].join("\n\n");
