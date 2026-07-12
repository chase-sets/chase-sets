export { default as contextManifest } from "./context.json";

import {
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildPlatformOperationsApi } from "./api";
import contextManifest from "./context.json";
import { createInsightsDashboardMcpHandlers } from "./features/insights-dashboards/api/mcp";
import { createOfferEconomicsMcpHandlers } from "./features/offer-economics/api/mcp";
import { buildExperienceApi } from "./features/platform-feedback/api/http";
import {
  buildCommercialTermsPublicDocReviewProjectionHandlers,
  buildPlatformOperationsPublicDocReviewProjectionHandlers,
} from "./features/public-doc-reviews/read-model/projection";
import {
  buildMarketplaceReportedContentProjectionHandlers,
  buildPlatformOperationsReportedContentProjectionHandlers,
} from "./features/reported-content/read-model/projection";
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
import { platformOperationsSchemaSql } from "./support/runtime-support/schema";
import { supportRequestSchemaMigrations } from "./features/support-requests/read-model/schema";
import { platformOperationsUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { seedPlatformOperationsDatabase } from "./support/runtime-support/seed";
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
  schemaMigrations: [...platformOperationsUnloggedProjectionSchemaMigrations, ...supportRequestSchemaMigrations],
  createServices: (pool, ports) => createPlatformOperationsServices(pool, ports),
  buildApis: (services) => [
    buildPlatformOperationsApi(services),
    buildExperienceApi(services.platformFeedback, services.reportedContent, services.riskAlerts),
    buildSupportApi(services.supportRequests),
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
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "platform-operations",
      manifest: platformOperationsContextManifest,
      handlers: {
        "ordering.support-affected-line-amount-projection": {
          subscriptionName: "support.affected-line-amount-projection",
          buildHandlers: () => buildSupportAffectedLineAmountProjectionHandlers(services.db, "ordering"),
        },
        "payments.support-affected-line-amount-projection": {
          subscriptionName: "support.affected-line-amount-projection",
          buildHandlers: () => buildSupportAffectedLineAmountProjectionHandlers(services.db, "payments"),
        },
        "ordering.support-order-source-projection": {
          subscriptionName: "support.order-source-projection",
          buildHandlers: () => buildSupportOrderSourceProjectionHandlers(services.db),
        },
        "fulfillment.support-shipment-source-projection": {
          subscriptionName: "support.shipment-source-projection",
          buildHandlers: () => buildSupportShipmentSourceProjectionHandlers(services.db),
        },
        "marketplace.reported-content-queue-projection": {
          subscriptionName: "platform-operations.reported-content-queue-projection",
          buildHandlers: () => buildMarketplaceReportedContentProjectionHandlers(services.db),
        },
        "platform-operations.reported-content-queue-projection": {
          subscriptionName: "platform-operations.reported-content-queue-projection",
          buildHandlers: () => buildPlatformOperationsReportedContentProjectionHandlers(services.db),
        },
        "commercial-terms.public-doc-review-queue-projection": {
          subscriptionName: "platform-operations.public-doc-review-queue-projection",
          buildHandlers: () => buildCommercialTermsPublicDocReviewProjectionHandlers(services.db),
        },
        "platform-operations.public-doc-review-queue-projection": {
          subscriptionName: "platform-operations.public-doc-review-queue-projection",
          buildHandlers: () => buildPlatformOperationsPublicDocReviewProjectionHandlers(services.db),
        },
        "identity.risk-alert-queue-projection": {
          subscriptionName: "platform-operations.risk-alert-queue-projection",
          buildHandlers: () => buildIdentityRiskAlertProjectionHandlers(services.db),
        },
        "marketplace.risk-alert-queue-projection": {
          subscriptionName: "platform-operations.risk-alert-queue-projection",
          buildHandlers: () => buildMarketplaceRiskAlertProjectionHandlers(services.db),
        },
        "payments.risk-alert-queue-projection": {
          subscriptionName: "platform-operations.risk-alert-queue-projection",
          buildHandlers: () => buildPaymentsRiskAlertProjectionHandlers(services.db),
        },
        "platform-operations.risk-alert-queue-projection": {
          subscriptionName: "platform-operations.risk-alert-queue-projection",
          buildHandlers: () => buildPlatformOperationsRiskAlertProjectionHandlers(services.db),
        },
      },
    }),
  seed: seedPlatformOperationsDatabase,
});
