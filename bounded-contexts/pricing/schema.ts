import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { pricingRecommendationSchemaSql } from "./recommendations/schema";

export const pricingSchemaSql = [
  eventCorePostgresSchemaSql,
  pricingRecommendationSchemaSql,
].join("\n\n");
