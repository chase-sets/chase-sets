import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { marketplaceListingSchemaSql } from "../../features/listings/read-model/schema";
import { marketplaceSupplyProjectionSchemaSql } from "../../features/listings/integrations/supply/supply-schema";
import { marketplaceOfferSchemaSql } from "../../features/offers/read-model/schema";
import { reputationSourceProjectionSchemaSql } from "../../features/reviews/integrations/source/source-schema";
import { reviewSchemaSql } from "../../features/reviews/read-model/schema";

export const marketplaceSchemaSql = [
  eventCorePostgresSchemaSql,
  marketplaceSupplyProjectionSchemaSql,
  marketplaceListingSchemaSql,
  marketplaceOfferSchemaSql,
  reputationSourceProjectionSchemaSql,
  reviewSchemaSql,
  realtimeOutboxSchemaSql,
].join("\n\n");
