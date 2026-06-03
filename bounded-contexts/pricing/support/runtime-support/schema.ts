import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { pricingPriceSignalSchemaSql } from "../../features/price-signals/read-model/schema";
import { pricingRecommendationSchemaSql } from "../../features/recommendations/read-model/schema";
import { pricingRecommendationSourceSchemaSql } from "../../features/recommendations/integrations/source/source-schema";

export const pricingSchemaSql = [
  eventCorePostgresSchemaSql,
  pricingRecommendationSourceSchemaSql,
  pricingPriceSignalSchemaSql,
  pricingRecommendationSchemaSql,
].join("\n\n");
