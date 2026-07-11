import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { marketplaceListingSchemaSql } from "../../features/listings/read-model/schema";
import { marketplaceSupplyProjectionSchemaSql } from "../../features/listings/integrations/supply/supply-schema";
import { marketplaceOfferSchemaSql } from "../../features/offers/read-model/schema";
import { marketplaceReviewSourceProjectionSchemaSql } from "../../features/reviews/integrations/source/source-schema";
import { reviewSchemaSql } from "../../features/reviews/read-model/schema";

export const marketplaceSchemaSql = [
  eventCorePostgresSchemaSql,
  marketplaceSupplyProjectionSchemaSql,
  marketplaceListingSchemaSql,
  marketplaceOfferSchemaSql,
  marketplaceReviewSourceProjectionSchemaSql,
  reviewSchemaSql,
  realtimeOutboxSchemaSql,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for the listing-gate policy -- see ../../features/listings/domain/listing-gate-policy.
  platformPolicySchemaSql,
].join("\n\n");
