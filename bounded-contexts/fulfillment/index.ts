export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { fulfillmentRetentionExemptions, fulfillmentRetentionSweeps } from "./support/runtime-support/retention-policy";
import type { FulfillmentHostPorts, FulfillmentServices } from "./support/runtime-support/services";
import { buildFulfillmentApi, buildFulfillmentProviderWebhookApi } from "./api";
import { createFulfillmentServices } from "./support/runtime-support/services";
import { fulfillmentSchemaMigrations, fulfillmentSchemaSql } from "./support/runtime-support/schema";
import { fulfillmentUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { inspectFulfillmentSeedState, seedFulfillmentDatabase } from "./support/runtime-support/seed";
import {
  buildFulfillmentAccountProjectionHandlers,
  buildFulfillmentOrderProjectionHandlers,
} from "./features/shipments/integrations/source/source-projection";
import { createFulfillmentShipmentMcpHandlers } from "./features/shipments/api/mcp";
import { buildFulfillmentSupportReturnSourceProjectionHandlers } from "./features/return-shipments/integrations/support/support-source-projection";

export const module = defineBoundedContextModule<FulfillmentServices, PgTransactionalPool, FulfillmentHostPorts>({
  manifest: contextManifest,
  schemaSql: fulfillmentSchemaSql,
  retentionSweeps: fulfillmentRetentionSweeps,
  retentionExemptions: fulfillmentRetentionExemptions,
  schemaMigrations: [...fulfillmentUnloggedProjectionSchemaMigrations, ...fulfillmentSchemaMigrations],
  createServices: (pool, ports) => createFulfillmentServices(pool, ports),
  buildApis: (services) => [buildFulfillmentApi(services), buildFulfillmentProviderWebhookApi(services)],
  buildMcpHandlers: (services) => createFulfillmentShipmentMcpHandlers(services.shipments),
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "fulfillment",
      manifest: contextManifest,
      handlers: {
        "identity.fulfillment-account-projection": () => buildFulfillmentAccountProjectionHandlers(services.db),
        "ordering.fulfillment-order-source-projection": {
          buildHandlers: () =>
            buildFulfillmentOrderProjectionHandlers(services.db, {
              onReadyForFulfillment: async (params) => {
                await services.shipments.createShipmentForReadyOrder(params);
              },
              onOrderCancelled: async (params) => {
                await services.shipments.cancelShipmentForCancelledOrder(params);
              },
            }),
          filterToEventTypes: true,
        },
        "payments.fulfillment-payment-fraud-source-projection": {
          buildHandlers: () =>
            buildFulfillmentOrderProjectionHandlers(services.db, {
              onFraudWarningReceived: async (params) => {
                await services.shipments.cancelShipmentForCancelledOrder({
                  orderId: params.orderId,
                  cancelledAt: params.receivedAt,
                  context: params.context,
                });
              },
            }),
          filterToEventTypes: true,
        },
        "platform-operations.fulfillment-support-return-source-projection": {
          buildHandlers: () =>
            buildFulfillmentSupportReturnSourceProjectionHandlers(services.db, {
              onResolved: (input, context) =>
                services.returnShipments.supportReturnLabels.issueForResolution(input, context),
              onCancelled: (input, context) =>
                services.returnShipments.supportReturnLabels.voidForCancellation(input, context),
            }),
          filterToEventTypes: true,
        },
      },
    }),
  seed: seedFulfillmentDatabase,
  inspectSeedState: (pool) => inspectFulfillmentSeedState(pool),
});
