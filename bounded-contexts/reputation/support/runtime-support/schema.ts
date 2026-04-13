import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { reputationReviewSchemaSql } from "../../features/reviews/read-model/schema";
import { reputationSourceProjectionSchemaSql } from "../../features/reviews/integrations/source/source-schema";

export const reputationSchemaSql = [
  eventCorePostgresSchemaSql,
  reputationSourceProjectionSchemaSql,
  reputationReviewSchemaSql,
].join("\n\n");
