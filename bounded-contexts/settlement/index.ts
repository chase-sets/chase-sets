export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { SettlementHostPorts, SettlementServices } from "./support/runtime-support/services";
import { buildSettlementApi, buildSettlementMoneyMovementWebhookApi } from "./api";
import { createSettlementServices } from "./support/runtime-support/services";
import { settlementSchemaSql } from "./support/runtime-support/schema";
import { seedSettlementDatabase } from "./support/runtime-support/seed";
import { buildSettlementPaymentInputProjectionHandlers } from "./features/wallets/integrations/payment-source/payment-source-projection";
import { buildSettlementSupportHoldProjectionHandlers } from "./features/wallets/integrations/support-source/support-source-projection";
import { buildSettlementFulfillmentSourceProjectionHandlers } from "./features/wallets/integrations/fulfillment-source/fulfillment-source-projection";
import {
  buildSettlementIdentityAccountRiskSourceProjectionHandlers,
  buildSettlementReputationAccountRiskSourceProjectionHandlers,
} from "./features/wallets/integrations/account-risk-source/account-risk-source-projection";

const eventSubscriptions = (contextManifest.eventSubscriptions ?? []) as readonly BcEventSubscriptionDeclaration[];
const projectionGroups = (contextManifest.projectionGroups ?? []) as readonly BcProjectionGroupDeclaration[];

function getEventSubscription(sourceContextName: string, projectionName: string): BcEventSubscriptionDeclaration {
  const declaration = eventSubscriptions.find(
    (entry) => entry.sourceContextName === sourceContextName && entry.projectionName === projectionName,
  );

  if (!declaration) {
    throw new Error(
      `Settlement is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<SettlementServices, PgTransactionalPool, SettlementHostPorts> = {
  contextName: "settlement",
  routePrefix: "/api/settlement",
  streamPrefix: "settlement.",
  schemaSql: settlementSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    SettlementServices,
    PgTransactionalPool,
    SettlementHostPorts
  >["apiMounts"],
  projectionGroups,
  createServices: (pool, ports) => createSettlementServices(pool, ports),
  buildApis: (services) => [buildSettlementApi(services), buildSettlementMoneyMovementWebhookApi(services)],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const paymentsSubscription = getEventSubscription("payments", "settlement-payment-input-projection");
    const supportSubscription = getEventSubscription("support", "settlement-support-hold-projection");
    const fulfillmentSubscription = getEventSubscription("fulfillment", "settlement-fulfillment-source-projection");
    const identityRiskSubscription = getEventSubscription("identity", "settlement-account-risk-source-projection");
    const reputationRiskSubscription = getEventSubscription("reputation", "settlement-account-risk-source-projection");

    return [
      {
        subscriptionName: "settlement.payment-input-projection",
        sourceContextName: "payments",
        projectionName: paymentsSubscription.projectionName,
        subscriptionVersion: paymentsSubscription.subscriptionVersion,
        handlers: buildSettlementPaymentInputProjectionHandlers(services.db, services.wallets),
        eventTypes: paymentsSubscription.eventTypes,
        streamPrefixes: paymentsSubscription.streamPrefixes,
        order: paymentsSubscription.order,
      },
      {
        subscriptionName: "settlement.support-hold-projection",
        sourceContextName: "support",
        projectionName: supportSubscription.projectionName,
        subscriptionVersion: supportSubscription.subscriptionVersion,
        handlers: buildSettlementSupportHoldProjectionHandlers(services.db),
        eventTypes: supportSubscription.eventTypes,
        streamPrefixes: supportSubscription.streamPrefixes,
        order: supportSubscription.order,
      },
      {
        subscriptionName: "settlement.fulfillment-source-projection",
        sourceContextName: "fulfillment",
        projectionName: fulfillmentSubscription.projectionName,
        subscriptionVersion: fulfillmentSubscription.subscriptionVersion,
        handlers: buildSettlementFulfillmentSourceProjectionHandlers(services.db),
        eventTypes: fulfillmentSubscription.eventTypes,
        streamPrefixes: fulfillmentSubscription.streamPrefixes,
        order: fulfillmentSubscription.order,
      },
      {
        subscriptionName: "settlement.identity-account-risk-source-projection",
        sourceContextName: "identity",
        projectionName: identityRiskSubscription.projectionName,
        subscriptionVersion: identityRiskSubscription.subscriptionVersion,
        handlers: buildSettlementIdentityAccountRiskSourceProjectionHandlers(services.db),
        eventTypes: identityRiskSubscription.eventTypes,
        streamPrefixes: identityRiskSubscription.streamPrefixes,
        order: identityRiskSubscription.order,
      },
      {
        subscriptionName: "settlement.reputation-account-risk-source-projection",
        sourceContextName: "reputation",
        projectionName: reputationRiskSubscription.projectionName,
        subscriptionVersion: reputationRiskSubscription.subscriptionVersion,
        handlers: buildSettlementReputationAccountRiskSourceProjectionHandlers(services.db),
        eventTypes: reputationRiskSubscription.eventTypes,
        streamPrefixes: reputationRiskSubscription.streamPrefixes,
        order: reputationRiskSubscription.order,
      },
    ];
  },
  seed: seedSettlementDatabase,
};
