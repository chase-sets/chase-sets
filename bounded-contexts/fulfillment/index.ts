export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { FulfillmentHostPorts, FulfillmentServices } from "./support/runtime-support/services";
import { buildFulfillmentApi, buildFulfillmentProviderWebhookApi } from "./api";
import { createFulfillmentServices } from "./support/runtime-support/services";
import { fulfillmentSchemaMigrations, fulfillmentSchemaSql } from "./support/runtime-support/schema";
import { seedFulfillmentDatabase } from "./support/runtime-support/seed";
import {
  buildFulfillmentAccountProjectionHandlers,
  buildFulfillmentOrderProjectionHandlers,
} from "./features/shipments/integrations/source/source-projection";

export const module = defineBoundedContextModule<FulfillmentServices, PgTransactionalPool, FulfillmentHostPorts>({
  manifest: contextManifest,
  schemaSql: fulfillmentSchemaSql,
  schemaMigrations: fulfillmentSchemaMigrations,
  createServices: (pool, ports) => createFulfillmentServices(pool, ports),
  buildApis: (services) => [buildFulfillmentApi(services), buildFulfillmentProviderWebhookApi(services)],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "fulfillment",
      manifest: contextManifest,
      handlers: {
        "identity.fulfillment-account-projection": () => buildFulfillmentAccountProjectionHandlers(services.db),
        "ordering.fulfillment-order-source-projection": () =>
          buildFulfillmentOrderProjectionHandlers(services.db, {
            onReadyForFulfillment: async (params) => {
              await services.shipments.createShipmentForReadyOrder(params);
            },
            onOrderCancelled: async (params) => {
              await services.shipments.cancelShipmentForCancelledOrder(params);
            },
          }),
      },
    }),
  seed: seedFulfillmentDatabase,
});
