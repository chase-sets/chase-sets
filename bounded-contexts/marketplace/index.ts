export { default as contextManifest } from "./context.json";

import {
  buildEventReactionsFromManifest,
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { marketplaceRetentionExemptions, marketplaceRetentionSweeps } from "./support/runtime-support/retention-policy";
import {
  buildMarketplaceAccountProjectionHandlers,
  buildMarketplaceCatalogProjectionHandlers,
  buildMarketplaceInventoryProjectionHandlers,
} from "./features/listings/integrations/supply/supply-projection";
import { buildMarketplaceSettlementNegativeBalanceProjectionHandlers } from "./features/listings/integrations/settlement/negative-balance-projection";
import { buildMarketplaceListingProjectionHandlers } from "./features/listings/read-model/projection";
import { createMarketplaceListingMcpHandlers } from "./features/listings/api/mcp";
import { createMarketplaceOfferMcpHandlers } from "./features/offers/api/mcp";
import { createMarketplaceReviewMcpHandlers } from "./features/reviews/api/mcp";
import { createSellerDeskMcpHandlers } from "./features/seller-desk/api/mcp";
import {
  buildReviewAccountProjectionHandlers,
  buildReviewOrderSourceProjectionHandlers,
  buildReviewShipmentSourceProjectionHandlers,
  buildReviewSupportSourceProjectionHandlers,
} from "./features/reviews/integrations/source/source-projection";
import { buildReviewModerationReactionHandlers } from "./features/reviews/integrations/moderation/moderation-reaction";
import { buildReviewHoldReactionHandlers } from "./features/reviews/integrations/support/review-hold-reaction";
import { buildReviewScoringReactionHandlers } from "./features/reviews/integrations/support/review-scoring-reaction";
import {
  buildSellerMetricsOrderSourceProjectionHandlers,
  buildSellerMetricsShipmentSourceProjectionHandlers,
  buildSellerMetricsSupportSourceProjectionHandlers,
} from "./features/seller-metrics/integrations/source/source-projection";
import { marketplaceSellerMetricsSourceSchemaMigrations } from "./features/seller-metrics/integrations/source/source-schema";
import { marketplaceSellerMetricsSummarySchemaMigrations } from "./features/seller-metrics/read-model/schema";
import type { MarketplaceServiceOptions, MarketplaceServices } from "./support/runtime-support/services";
import { buildMarketplaceApi } from "./api";
import { buildReviewApi } from "./features/reviews/api/http";
import { buildSellerMetricsApi } from "./features/seller-metrics/api/http";
import { createMarketplaceServices } from "./support/runtime-support/services";
import { marketplaceSchemaSql } from "./support/runtime-support/schema";
import { marketplaceUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { marketplaceSupplyProjectionSchemaMigrations } from "./features/listings/integrations/supply/supply-schema";
import { marketplaceListingSchemaMigrations } from "./features/listings/read-model/schema";
import { marketplaceListingReadModelSchemaMigrations } from "./features/listings/read-model/schema";
import { reviewSchemaMigrations } from "./features/reviews/read-model/schema";
import { inspectMarketplaceSeedState, seedMarketplaceContextDatabase } from "./support/runtime-support/seed";

const marketplaceContextManifest = contextManifest as BcContextManifest;

export const module = defineBoundedContextModule<MarketplaceServices, PgTransactionalPool, MarketplaceServiceOptions>({
  manifest: marketplaceContextManifest,
  schemaSql: marketplaceSchemaSql,
  schemaMigrations: [
    ...marketplaceUnloggedProjectionSchemaMigrations,
    ...marketplaceSupplyProjectionSchemaMigrations,
    ...marketplaceListingSchemaMigrations,
    ...marketplaceListingReadModelSchemaMigrations,
    ...reviewSchemaMigrations,
    ...marketplaceSellerMetricsSourceSchemaMigrations,
    ...marketplaceSellerMetricsSummarySchemaMigrations,
  ],
  retentionSweeps: marketplaceRetentionSweeps,
  retentionExemptions: marketplaceRetentionExemptions,
  createServices: (pool, options) => createMarketplaceServices(pool, options),
  buildApis: (services) => [
    buildMarketplaceApi(services),
    buildReviewApi(services.reviews),
    buildSellerMetricsApi(services.sellerMetrics),
  ],
  buildMcpHandlers: (services) => {
    const listings = createMarketplaceListingMcpHandlers(services.listings);
    const offers = createMarketplaceOfferMcpHandlers(services.offers);
    const reviews = createMarketplaceReviewMcpHandlers(services.reviews);
    const sellerDesk = createSellerDeskMcpHandlers(services.sellerAttentionQueue);

    return {
      toolHandlers: {
        ...listings.toolHandlers,
        ...offers.toolHandlers,
        ...reviews.toolHandlers,
        ...sellerDesk.toolHandlers,
      },
      resourceHandlers: {
        ...listings.resourceHandlers,
        ...offers.resourceHandlers,
        ...reviews.resourceHandlers,
      },
    };
  },
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const accountProjectionHandlers = buildMarketplaceAccountProjectionHandlers(services.db);

    return [
      ...buildEventSubscriptionsFromManifest({
        contextName: "marketplace",
        manifest: marketplaceContextManifest,
        handlers: {
          "catalog.marketplace-catalog-item-projection": () => buildMarketplaceCatalogProjectionHandlers(services.db),
          "catalog.marketplace-listing-projection": () => buildMarketplaceListingProjectionHandlers(services.db),
          "identity.marketplace-identity-account-projection": () => accountProjectionHandlers,
          "inventory.marketplace-inventory-supply-projection": () =>
            buildMarketplaceInventoryProjectionHandlers(services.db, {
              onInventoryItemChanged: services.listings.reconcileInventoryCapacity,
            }),
          "marketplace.marketplace-identity-account-projection": () => accountProjectionHandlers,
          "marketplace.marketplace-listing-projection": () => buildMarketplaceListingProjectionHandlers(services.db),
          "identity.marketplace-review-account-source-projection": () =>
            buildReviewAccountProjectionHandlers(services.db),
          "ordering.marketplace-review-order-source-projection": () =>
            buildReviewOrderSourceProjectionHandlers(services.db, { outbox: services.notificationOutbox }),
          "fulfillment.marketplace-review-shipment-source-projection": () =>
            buildReviewShipmentSourceProjectionHandlers(services.db, {
              onDeliveredShipment: services.reviews.recordDeliveredShipmentReviewEligibility,
            }),
          "platform-operations.marketplace-review-support-source-projection": () =>
            buildReviewSupportSourceProjectionHandlers(services.db, { outbox: services.notificationOutbox }),
          "ordering.marketplace-seller-metrics-order-source-projection": () =>
            buildSellerMetricsOrderSourceProjectionHandlers(services.db, {
              resolvePolicy: services.policies.resolvePolicy,
            }),
          "fulfillment.marketplace-seller-metrics-shipment-source-projection": () =>
            buildSellerMetricsShipmentSourceProjectionHandlers(services.db, {
              resolvePolicy: services.policies.resolvePolicy,
            }),
          "platform-operations.marketplace-seller-metrics-support-source-projection": () =>
            buildSellerMetricsSupportSourceProjectionHandlers(services.db, {
              resolvePolicy: services.policies.resolvePolicy,
            }),
          "settlement.marketplace-settlement-negative-balance-projection": () =>
            buildMarketplaceSettlementNegativeBalanceProjectionHandlers(services.listings),
        },
      }),
      ...buildEventReactionsFromManifest({
        contextName: "marketplace",
        manifest: marketplaceContextManifest,
        handlers: {
          "platform-operations.marketplace-review-hold-reaction": () =>
            buildReviewHoldReactionHandlers({
              recordSupportRequestOpened: services.reviews.recordSupportRequestOpened,
              recordSupportRequestTerminal: services.reviews.recordSupportRequestTerminal,
            }),
          "platform-operations.marketplace-review-scoring-reaction": () =>
            buildReviewScoringReactionHandlers({
              recordSupportFact: services.reviews.recordReviewScoringSupportFact,
            }),
          "platform-operations.marketplace-review-moderation-reaction": () =>
            buildReviewModerationReactionHandlers({
              operatorWithdrawReview: services.reviews.operatorWithdrawReview,
              operatorRedactReviewFeedback: services.reviews.operatorRedactReviewFeedback,
              operatorWithdrawReviewReply: services.reviews.operatorWithdrawReviewReply,
            }),
        },
      }),
    ];
  },
  seed: seedMarketplaceContextDatabase,
  inspectSeedState: (pool) => inspectMarketplaceSeedState(pool),
});
