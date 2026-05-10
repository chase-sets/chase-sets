export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { PaymentsServices, PaymentsServiceOptions } from "./support/runtime-support/services";
import { buildPaymentsApi } from "./api";
import { buildPaymentsOrderInputProjectionHandlers } from "./features/payments/integrations/order-input/order-input-projection";
import { buildPaymentsSupportRefundEffectHandlers } from "./features/refunds/integrations/support/support-refund-effect-projection";
import { createPaymentProcessorWebhookRoutes } from "./features/payments/api/route";
import { createPaymentsServices } from "./support/runtime-support/services";
import { paymentsSchemaSql } from "./support/runtime-support/schema";
import { seedPaymentsDatabase } from "./support/runtime-support/seed";

const eventSubscriptions =
  (contextManifest.eventSubscriptions ?? []) as readonly BcEventSubscriptionDeclaration[];
const projectionGroups =
  (contextManifest.projectionGroups ?? []) as readonly BcProjectionGroupDeclaration[];

function getEventSubscription(
  sourceContextName: string,
  projectionName: string,
): BcEventSubscriptionDeclaration {
  const declaration = eventSubscriptions.find(
    (entry) =>
      entry.sourceContextName === sourceContextName &&
      entry.projectionName === projectionName,
  );

  if (!declaration) {
    throw new Error(
      `Payments is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<PaymentsServices, PgTransactionalPool, PaymentsServiceOptions> = {
  contextName: "payments",
  routePrefix: "/api/marketplace",
  streamPrefix: "payments.",
  schemaSql: paymentsSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<PaymentsServices, PgTransactionalPool, PaymentsServiceOptions>["apiMounts"],
  projectionGroups,
  createServices: (pool, options) => createPaymentsServices(pool, options),
  buildApis: (services) => [
    buildPaymentsApi(services),
    createPaymentProcessorWebhookRoutes(services.payments),
  ],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const orderingSubscription = getEventSubscription(
      "ordering",
      "payments-order-input-projection",
    );
    const supportSubscription = getEventSubscription(
      "support",
      "payments-support-refund-effect",
    );

    return [
      {
        subscriptionName: "payments.order-input-projection",
        sourceContextName: "ordering",
        projectionName: orderingSubscription.projectionName,
        subscriptionVersion: orderingSubscription.subscriptionVersion,
        handlers: buildPaymentsOrderInputProjectionHandlers(services.db),
        eventTypes: orderingSubscription.eventTypes,
        streamPrefixes: orderingSubscription.streamPrefixes,
        order: orderingSubscription.order,
      },
      {
        subscriptionName: "payments.support-refund-effect",
        sourceContextName: "support",
        projectionName: supportSubscription.projectionName,
        subscriptionVersion: supportSubscription.subscriptionVersion,
        handlers: buildPaymentsSupportRefundEffectHandlers(
          services.db,
          services.refunds,
        ),
        eventTypes: supportSubscription.eventTypes,
        streamPrefixes: supportSubscription.streamPrefixes,
        order: supportSubscription.order,
      },
    ];
  },
  seed: seedPaymentsDatabase,
};
