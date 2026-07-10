export { default as contextManifest } from "./context.json";

import {
  buildEventReactionsFromManifest,
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
} from "@chase-sets/bounded-context-module";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import {
  paymentsRetentionExemptions,
  paymentsRetentionSchemaMigrations,
  paymentsRetentionSweeps,
} from "./support/runtime-support/retention-policy";
import type { PaymentsServices, PaymentsServiceOptions } from "./support/runtime-support/services";
import { buildPaymentsApi } from "./api";
import { createPaymentMcpHandlers } from "./features/payments/api/mcp";
import { buildPaymentsOrderInputProjectionHandlers } from "./features/payments/integrations/order-input/order-input-projection";
import { buildPaymentsFulfillmentDisputeEvidenceProjectionHandlers } from "./features/payments/integrations/dispute-evidence/fulfillment-dispute-evidence-projection";
import type { PaymentDisputedEvent } from "./features/payments/domain/domain";
import {
  buildPaymentsIdentityAccountRiskSourceProjectionHandlers,
  buildPaymentsPaymentsAccountRiskSourceProjectionHandlers,
} from "./features/payments/integrations/account-risk-source/account-risk-source-projection";
import { buildPaymentsOrderCancellationRefundEffectHandlers } from "./features/refunds/integrations/ordering/order-cancellation-refund-effect-projection";
import { buildPaymentsSupportRefundEffectHandlers } from "./features/refunds/integrations/support/support-refund-effect-projection";
import { createPaymentProcessorWebhookRoutes } from "./features/payments/api/route";
import { createPaymentsServices } from "./support/runtime-support/services";
import { paymentsSchemaMigrations, paymentsSchemaSql } from "./support/runtime-support/schema";
import { paymentsUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { seedPaymentsDatabase } from "./support/runtime-support/seed";

const paymentsContextManifest = contextManifest as BcContextManifest;

type SubscriptionContextEvent = Readonly<{
  tenantId: EventStoreContext["tenantId"];
  audit: EventStoreContext["audit"];
  trace: EventStoreContext["trace"];
}>;

type PaymentDisputedReactionEvent = SubscriptionContextEvent &
  Readonly<{
    data: PaymentDisputedEvent["data"];
  }>;

function subscriptionEventContext(event: SubscriptionContextEvent): EventStoreContext {
  return {
    tenantId: event.tenantId,
    audit: event.audit,
    trace: event.trace,
  };
}

export const module = defineBoundedContextModule<PaymentsServices, PgTransactionalPool, PaymentsServiceOptions>({
  manifest: paymentsContextManifest,
  schemaSql: paymentsSchemaSql,
  retentionSweeps: paymentsRetentionSweeps,
  retentionExemptions: paymentsRetentionExemptions,
  schemaMigrations: [
    ...paymentsUnloggedProjectionSchemaMigrations,
    ...paymentsSchemaMigrations,
    ...paymentsRetentionSchemaMigrations,
  ],
  createServices: (pool, options) => createPaymentsServices(pool, options),
  buildApis: (services) => [buildPaymentsApi(services), createPaymentProcessorWebhookRoutes(services.payments)],
  buildMcpHandlers: (services) => createPaymentMcpHandlers(services.payments),
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => [
    ...buildEventSubscriptionsFromManifest({
      contextName: "payments",
      manifest: paymentsContextManifest,
      handlers: {
        "ordering.payments-order-input-projection": () => buildPaymentsOrderInputProjectionHandlers(services.db),
        "fulfillment.payments-fulfillment-dispute-evidence-source-projection": () =>
          buildPaymentsFulfillmentDisputeEvidenceProjectionHandlers(services.db),
        "platform-operations.payments-support-refund-effect": () =>
          buildPaymentsSupportRefundEffectHandlers(services.db, services.refunds),
        "ordering.payments-order-cancellation-refund-effect": {
          buildHandlers: () => buildPaymentsOrderCancellationRefundEffectHandlers(services.db, services.refunds),
          filterToEventTypes: true,
        },
        "payments.payments-order-cancellation-refund-effect": {
          subscriptionName: "payments.payment-capture-cancellation-refund-effect",
          buildHandlers: () => buildPaymentsOrderCancellationRefundEffectHandlers(services.db, services.refunds),
          filterToEventTypes: true,
        },
        "identity.payments-account-risk-source-projection": () =>
          buildPaymentsIdentityAccountRiskSourceProjectionHandlers(services.db),
        "payments.payments-account-risk-source-projection": () =>
          buildPaymentsPaymentsAccountRiskSourceProjectionHandlers(services.db),
      },
    }),
    ...buildEventReactionsFromManifest({
      contextName: "payments",
      manifest: paymentsContextManifest,
      handlers: {
        "payments.payments-dispute-evidence-submission": () => ({
          "payments.payment-disputed": async (event: PaymentDisputedReactionEvent) => {
            const data = event.data;
            if (data.disputeLifecycleState !== "created" && data.disputeLifecycleState !== "updated") {
              return;
            }
            await services.payments.submitDisputeEvidence(data, subscriptionEventContext(event));
          },
        }),
      },
    }),
  ],
  seed: seedPaymentsDatabase,
});
