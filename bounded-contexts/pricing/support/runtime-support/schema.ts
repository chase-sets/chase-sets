import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { pricingRecommendationSchemaSql } from "../../features/recommendations/read-model/schema";
import { pricingRecommendationSourceSchemaSql } from "../../features/recommendations/integrations/source/source-schema";

export const pricingSchemaSql = [
  eventCorePostgresSchemaSql,
  pricingRecommendationSourceSchemaSql,
  pricingRecommendationSchemaSql,
].join("\n\n");
