import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { pricingPriceSignalSchemaSql } from "../../features/price-signals/read-model/schema";
import { pricingRecommendationSchemaSql } from "../../features/recommendations/read-model/schema";
import { pricingRecommendationSourceSchemaSql } from "../../features/recommendations/integrations/source/source-schema";
import {
  pricingMarketTradesSchemaMigrations,
  pricingMarketTradesSchemaSql,
} from "../../features/market-trades/read-model/schema";
import {
  pricingMarketRollupsSchemaMigrations,
  pricingMarketRollupsSchemaSql,
} from "../../features/market-rollups/read-model/schema";
import { pricingMarketEstimatesSchemaSql } from "../../features/market-estimates/read-model/schema";
import { pricingRepricingPolicySchemaSql } from "../../features/repricing-policies/read-model/schema";
import { pricingRepricingEngineSchemaSql } from "../../features/repricing-engine/read-model/schema";
import {
  pricingBulkRepriceIngestionSchemaMigrations,
  pricingBulkRepriceIngestionSchemaSql,
} from "../../features/bulk-reprice-ingestion/read-model/schema";

export const pricingFeatureSchemaMigrations = [
  ...pricingMarketTradesSchemaMigrations,
  ...pricingMarketRollupsSchemaMigrations,
  ...pricingBulkRepriceIngestionSchemaMigrations,
];

export const pricingSchemaSql = [
  eventCorePostgresSchemaSql,
  realtimeOutboxSchemaSql,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for bulk reprice ingestion's dials -- see ../../features/bulk-reprice-ingestion/domain/policy.
  platformPolicySchemaSql,
  pricingRecommendationSourceSchemaSql,
  pricingPriceSignalSchemaSql,
  pricingRecommendationSchemaSql,
  pricingMarketTradesSchemaSql,
  pricingMarketRollupsSchemaSql,
  pricingMarketEstimatesSchemaSql,
  // Must run after pricingRecommendationSourceSchemaSql: the assignment view joins
  // pricing_market_listing_inputs and pricing_catalog_item_inputs.
  pricingRepricingPolicySchemaSql,
  pricingRepricingEngineSchemaSql,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for the market-stat-hygiene and market-analytics-display policies -- see
  // ../../features/market-trades/domain/stat-hygiene-policy and
  // ../../features/market-rollups/domain/display-policy.
  platformPolicySchemaSql,
  // Bulk reprice ingestion reads pricing_market_listing_inputs but owns no
  // dependent views, so ordering after the source projection is a courtesy, not a hard need.
  pricingBulkRepriceIngestionSchemaSql,
].join("\n\n");
