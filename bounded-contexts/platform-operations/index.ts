export { default as contextManifest } from "./context.json" with { type: "json" };

import {
  buildEventReactionsFromManifest,
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildPlatformOperationsApi } from "./api";
import contextManifest from "./context.json" with { type: "json" };
import { createInsightsDashboardMcpHandlers } from "./features/insights-dashboards/api/mcp";
import { createOfferEconomicsMcpHandlers } from "./features/offer-economics/api/mcp";
import { buildExperienceApi } from "./features/platform-feedback/api/http";
import {
  buildCommercialTermsPublicDocReviewProjectionHandlers,
  buildPlatformOperationsPublicDocReviewProjectionHandlers,
} from "./features/public-doc-reviews/read-model/projection";
import { buildCommercialTermsEffectiveDateAttentionProjectionHandlers } from "./features/commercial-terms-attention/read-model/projection";
import {
  buildMarketplaceReportedContentProjectionHandlers,
  buildPlatformOperationsReportedContentProjectionHandlers,
} from "./features/reported-content/read-model/projection";
import {
  buildOrderingSellerComplianceSalesProjectionHandlers,
  buildPaymentsSellerComplianceSalesProjectionHandlers,
} from "./features/seller-compliance-sales/read-model/projection";
import {
  buildIdentityRiskAlertProjectionHandlers,
  buildMarketplaceRiskAlertProjectionHandlers,
  buildPaymentsRiskAlertProjectionHandlers,
  buildPlatformOperationsRiskAlertProjectionHandlers,
} from "./features/risk-alerts/read-model/projection";
import { buildSupportApi } from "./features/support-requests/api/http";
import { createSupportRequestMcpHandlers } from "./features/support-requests/api/mcp";
import { buildSupportAffectedLineAmountProjectionHandlers } from "./features/support-requests/integrations/source/affected-line-amount-projection";
import {
  buildSupportOrderSourceProjectionHandlers,
  buildSupportShipmentSourceProjectionHandlers,
} from "./features/support-requests/integrations/source/source-projection";
import { buildSupportReturnLabelSourceProjectionHandlers } from "./features/support-requests/integrations/source/return-label-source-projection";
import { buildInventoryCollisionSupportReactionHandlers } from "./features/support-requests/integrations/inventory-collision/inventory-collision-reaction";
import { platformOperationsSchemaSql } from "./support/runtime-support/schema";
import { supportRequestSchemaMigrations } from "./features/support-requests/read-model/schema";
import { sellerComplianceSalesSchemaMigrations } from "./features/seller-compliance-sales/read-model/schema";
import { platformOperationsUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { inspectPlatformOperationsSeedState, seedPlatformOperationsDatabase } from "./support/runtime-support/seed";
import {
  createPlatformOperationsServices,
  type PlatformOperationsHostPorts,
  type PlatformOperationsServices,
} from "./support/runtime-support/services";

const platformOperationsContextManifest = contextManifest as BcContextManifest;

export const module = defineBoundedContextModule<
  PlatformOperationsServices,
  PgTransactionalPool,
  PlatformOperationsHostPorts
>({
  manifest: platformOperationsContextManifest,
  schemaSql: platformOperationsSchemaSql,
  schemaMigrations: [
    ...platformOperationsUnloggedProjectionSchemaMigrations,
    ...supportRequestSchemaMigrations,
    ...sellerComplianceSalesSchemaMigrations,
  ],
  createServices: (pool, ports) => createPlatformOperationsServices(pool, ports),
  buildApis: (services) => [
    { mountPath: "/api/platform", contextMountOrdinal: 1, router: buildPlatformOperationsApi(services) },
    {
      mountPath: "/api/experience",
      contextMountOrdinal: 2,
      router: buildExperienceApi(services.platformFeedback, services.reportedContent, services.riskAlerts),
    },
    {
      mountPath: "/api/marketplace",
      contextMountOrdinal: 3,
      router: buildSupportApi(services.supportRequests),
    },
  ],
  buildMcpHandlers: (services) => {
    const insightsHandlers = createInsightsDashboardMcpHandlers(services.insightsDashboards);
    const offerEconomicsHandlers = createOfferEconomicsMcpHandlers(services.offerEconomics);
    const supportHandlers = createSupportRequestMcpHandlers(services.supportRequests);

    return {
      toolHandlers: {
        ...insightsHandlers.toolHandlers,
        ...offerEconomicsHandlers.toolHandlers,
        ...supportHandlers.toolHandlers,
      },
      resourceHandlers: {
        ...insightsHandlers.resourceHandlers,
        ...offerEconomicsHandlers.resourceHandlers,
        ...supportHandlers.resourceHandlers,
      },
    };
  },
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => [
    ...buildEventSubscriptionsFromManifest({
      contextName: "platform-operations",
      manifest: platformOperationsContextManifest,
      handlers: {
        "ordering.support-affected-line-amount-projection": () =>
          buildSupportAffectedLineAmountProjectionHandlers(services.db, "ordering"),
        "payments.support-affected-line-amount-projection": () =>
          buildSupportAffectedLineAmountProjectionHandlers(services.db, "payments"),
        "ordering.support-order-source-projection": () => buildSupportOrderSourceProjectionHandlers(services.db),
        "fulfillment.support-shipment-source-projection": () =>
          buildSupportShipmentSourceProjectionHandlers(services.db, services.supportRequests),
        "fulfillment.support-return-label-source-projection": () =>
          buildSupportReturnLabelSourceProjectionHandlers(services.db),
        "marketplace.reported-content-queue-projection": () =>
          buildMarketplaceReportedContentProjectionHandlers(services.db),
        "platform-operations.reported-content-queue-projection": () =>
          buildPlatformOperationsReportedContentProjectionHandlers(services.db),
        "commercial-terms.public-doc-review-queue-projection": () =>
          buildCommercialTermsPublicDocReviewProjectionHandlers(services.db),
        "commercial-terms.commercial-terms-effective-date-attention-projection": () =>
          buildCommercialTermsEffectiveDateAttentionProjectionHandlers(services.db),
        "platform-operations.public-doc-review-queue-projection": () =>
          buildPlatformOperationsPublicDocReviewProjectionHandlers(services.db),
        "identity.risk-alert-queue-projection": () =>
          buildIdentityRiskAlertProjectionHandlers(services.db, { policies: services.policies }),
        "marketplace.risk-alert-queue-projection": () =>
          buildMarketplaceRiskAlertProjectionHandlers(services.db, { policies: services.policies }),
        "payments.risk-alert-queue-projection": () =>
          buildPaymentsRiskAlertProjectionHandlers(services.db, { policies: services.policies }),
        "platform-operations.risk-alert-queue-projection": () =>
          buildPlatformOperationsRiskAlertProjectionHandlers(services.db),
        // Two declarations, one projection: `buildEventSubscriptionsFromManifest` keys
        // registration on `(sourceContextName, projectionName)`, so Ordering created/cancelled
        // and Payments captured/refunded reach the same handler set exactly once each.
        "ordering.seller-compliance-sales-projection": () =>
          buildOrderingSellerComplianceSalesProjectionHandlers(services.db),
        "payments.seller-compliance-sales-projection": () =>
          buildPaymentsSellerComplianceSalesProjectionHandlers(services.db),
      },
    }),
    ...buildEventReactionsFromManifest({
      contextName: "platform-operations",
      manifest: platformOperationsContextManifest,
      handlers: {
        "inventory.support-inventory-hold-collision": () =>
          buildInventoryCollisionSupportReactionHandlers(services.supportRequests),
      },
    }),
  ],
  seed: seedPlatformOperationsDatabase,
  inspectSeedState: (pool) => inspectPlatformOperationsSeedState(pool),
});
