export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { buildPlatformOperationsApi } from "./api";
import contextManifest from "./context.json";
import { buildExperienceApi } from "./features/platform-feedback/api/http";
import {
  buildMarketplaceReportedContentProjectionHandlers,
  buildPlatformOperationsReportedContentProjectionHandlers,
} from "./features/reported-content/read-model/projection";
import { buildSupportApi } from "./features/support-requests/api/http";
import {
  buildSupportOrderSourceProjectionHandlers,
  buildSupportShipmentSourceProjectionHandlers,
} from "./features/support-requests/integrations/source/source-projection";
import { platformOperationsSchemaSql } from "./support/runtime-support/schema";
import { seedPlatformOperationsDatabase } from "./support/runtime-support/seed";
import {
  createPlatformOperationsServices,
  type PlatformOperationsHostPorts,
  type PlatformOperationsServices,
} from "./support/runtime-support/services";

export const module = defineBoundedContextModule<
  PlatformOperationsServices,
  PgTransactionalPool,
  PlatformOperationsHostPorts
>({
  manifest: contextManifest,
  schemaSql: platformOperationsSchemaSql,
  createServices: (pool, ports) => createPlatformOperationsServices(pool, ports),
  buildApis: (services) => [
    buildPlatformOperationsApi(services),
    buildExperienceApi(services.platformFeedback, services.reportedContent),
    buildSupportApi(services.supportRequests),
  ],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "platform-operations",
      manifest: contextManifest,
      handlers: {
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
      },
    }),
  seed: seedPlatformOperationsDatabase,
});
