export { default as contextManifest } from "./context.json";

import {
  buildEventReactionsFromManifest,
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
} from "@chase-sets/bounded-context-module";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { PaymentsServices, PaymentsServiceOptions } from "./support/runtime-support/services";
import { buildPaymentsApi } from "./api";
import { buildPaymentsOrderInputProjectionHandlers } from "./features/payments/integrations/order-input/order-input-projection";
import { buildPaymentsFulfillmentDisputeEvidenceProjectionHandlers } from "./features/payments/integrations/dispute-evidence/fulfillment-dispute-evidence-projection";
import {
  buildPaymentsIdentityAccountRiskSourceProjectionHandlers,
  buildPaymentsPaymentsAccountRiskSourceProjectionHandlers,
} from "./features/payments/integrations/account-risk-source/account-risk-source-projection";
import { buildPaymentsOrderCancellationRefundEffectHandlers } from "./features/refunds/integrations/ordering/order-cancellation-refund-effect-projection";
import { buildPaymentsSupportRefundEffectHandlers } from "./features/refunds/integrations/support/support-refund-effect-projection";
import { createPaymentProcessorWebhookRoutes } from "./features/payments/api/route";
import { createPaymentsServices } from "./support/runtime-support/services";
import { paymentsSchemaMigrations, paymentsSchemaSql } from "./support/runtime-support/schema";
import { seedPaymentsDatabase } from "./support/runtime-support/seed";

type SubscriptionContextEvent = Readonly<{
  tenantId: EventStoreContext["tenantId"];
  audit: EventStoreContext["audit"];
  trace: EventStoreContext["trace"];
}>;

function subscriptionEventContext(event: SubscriptionContextEvent): EventStoreContext {
  return {
    tenantId: event.tenantId,
    audit: event.audit,
    trace: event.trace,
  };
}

export const module = defineBoundedContextModule<PaymentsServices, PgTransactionalPool, PaymentsServiceOptions>({
  manifest: contextManifest,
  schemaSql: paymentsSchemaSql,
  schemaMigrations: paymentsSchemaMigrations,
  createServices: (pool, options) => createPaymentsServices(pool, options),
  buildApis: (services) => [buildPaymentsApi(services), createPaymentProcessorWebhookRoutes(services.payments)],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => [
    ...buildEventSubscriptionsFromManifest({
      contextName: "payments",
      manifest: contextManifest,
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
      manifest: contextManifest,
      handlers: {
        "payments.payments-dispute-evidence-submission": () => ({
          "payments.payment-disputed": async (event) => {
            const data = event.data as Parameters<PaymentsServices["payments"]["submitDisputeEvidence"]>[0];
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
