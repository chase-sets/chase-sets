import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { reputationReviewSchemaSql } from "./reviews/schema";

export const reputationSchemaSql = [
  eventCorePostgresSchemaSql,
  reputationReviewSchemaSql,
].join("\n\n");
