import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { pricingRecommendationSchemaSql } from "./recommendations/schema";
import { pricingRecommendationSourceSchemaSql } from "./recommendations/source-schema";

export const pricingSchemaSql = [
  eventCorePostgresSchemaSql,
  pricingRecommendationSourceSchemaSql,
  pricingRecommendationSchemaSql,
].join("\n\n");
