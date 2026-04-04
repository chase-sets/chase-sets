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

import type { BcModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { PaymentsServices, PaymentsServiceOptions } from "./services";
import { buildPaymentsApi } from "./api";
import { createPaymentsServices } from "./services";
import { paymentsSchemaSql } from "./schema";
import { seedPaymentsDatabase } from "./seed";

export function createPaymentsModule(
  options: PaymentsServiceOptions = {},
): BcModule<PaymentsServices, PgTransactionalPool> {
  return {
    routePrefix: "/api/marketplace",
    schemaSql: paymentsSchemaSql,
    createServices: (pool) => createPaymentsServices(pool, options),
    buildApi: (services) => buildPaymentsApi(services.payments),
    projectors: (services) => services.projectors,
    seed: seedPaymentsDatabase,
  };
}
