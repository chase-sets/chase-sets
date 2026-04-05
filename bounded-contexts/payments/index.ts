export { default as contextManifest } from "./context.json";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { PaymentsServices, PaymentsServiceOptions } from "./services";
import { buildPaymentsApi } from "./api";
import { createStripeWebhookRoutes } from "./payments/route";
import { createPaymentsServices } from "./services";
import { paymentsSchemaSql } from "./schema";
import { seedPaymentsDatabase } from "./seed";

export const module: BcApiModule<PaymentsServices, PgTransactionalPool, PaymentsServiceOptions> = {
  contextName: "payments",
  routePrefix: "/api/marketplace",
  streamPrefix: "payments.",
  schemaSql: paymentsSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<PaymentsServices, PgTransactionalPool, PaymentsServiceOptions>["apiMounts"],
  createServices: (pool, options) => createPaymentsServices(pool, options),
  buildApis: (services) => [
    buildPaymentsApi(services.payments),
    createStripeWebhookRoutes(services.payments),
  ],
  projectors: (services) => services.projectors,
  seed: seedPaymentsDatabase,
};
