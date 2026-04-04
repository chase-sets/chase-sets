export { default as contextManifest } from "./context.json";
export { buildPaymentsApi } from "./api";
export {
  createStripeWebhookRoutes,
} from "./payments/route";
export type { PaymentsApiEnv } from "./payments/route";
export { paymentsSchemaSql } from "./schema";
export { createPaymentsServices } from "./services";
export type { PaymentsServices, PaymentsServiceOptions } from "./services";
export { seedPaymentsDatabase } from "./seed";
export type {
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
  PaymentProcessorWebhookEvent,
} from "./processor-gateway";
export { createFakePaymentProcessorGateway } from "./fake-gateway";
export { createStripePaymentProcessorGateway } from "./stripe-gateway";

import type { BcApiModule } from "@chase-sets/bounded-context-module";
import { resolveContextApiMounts } from "@chase-sets/bounded-context-runtime";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { PaymentsServices, PaymentsServiceOptions } from "./services";
import { buildPaymentsApi } from "./api";
import { createStripeWebhookRoutes } from "./payments/route";
import { createPaymentsServices } from "./services";
import { paymentsSchemaSql } from "./schema";
import { seedPaymentsDatabase } from "./seed";

export function createPaymentsModule(
  options: PaymentsServiceOptions = {},
): BcApiModule<PaymentsServices, PgTransactionalPool, void> {
  return {
    contextName: "payments",
    routePrefix: "/api/marketplace",
    streamPrefix: "payments.",
    schemaSql: paymentsSchemaSql,
    createServices: (pool) => createPaymentsServices(pool, options),
    buildApi: (services) => buildPaymentsApi(services.payments),
    projectors: (services) => services.projectors,
    seed: seedPaymentsDatabase,
  };
}

export function resolveApiMounts(services: PaymentsServices) {
  return resolveContextApiMounts(contextManifest.contextName, contextManifest.apiMounts, [
    buildPaymentsApi(services.payments),
    createStripeWebhookRoutes(services.payments),
  ]);
}
