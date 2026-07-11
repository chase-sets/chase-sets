import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { marketplaceListingSchemaSql } from "../../features/listings/read-model/schema";
import { marketplaceSupplyProjectionSchemaSql } from "../../features/listings/integrations/supply/supply-schema";
import { marketplaceOfferSchemaSql } from "../../features/offers/read-model/schema";
import { marketplaceReviewSourceProjectionSchemaSql } from "../../features/reviews/integrations/source/source-schema";
import { reviewSchemaSql } from "../../features/reviews/read-model/schema";
import { marketplaceSellerMetricsSourceSchemaSql } from "../../features/seller-metrics/integrations/source/source-schema";
import { marketplaceSellerMetricsSummarySchemaSql } from "../../features/seller-metrics/read-model/schema";

export const marketplaceSchemaSql = [
  eventCorePostgresSchemaSql,
  // Post-delivery review nudges (m108) ride the shared notification
  // outbox, owned locally by this context like discovery's product-alert
  // notifications -- see infrastructure/notification-outbox.
  notificationOutboxSchemaSql,
  marketplaceSupplyProjectionSchemaSql,
  marketplaceListingSchemaSql,
  marketplaceOfferSchemaSql,
  marketplaceReviewSourceProjectionSchemaSql,
  reviewSchemaSql,
  marketplaceSellerMetricsSourceSchemaSql,
  marketplaceSellerMetricsSummarySchemaSql,
  realtimeOutboxSchemaSql,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for the listing-gate policy -- see ../../features/listings/domain/listing-gate-policy.
  platformPolicySchemaSql,
].join("\n\n");
