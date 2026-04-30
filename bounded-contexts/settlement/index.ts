export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { SettlementServices } from "./support/runtime-support/services";
import { buildSettlementApi } from "./api";
import { createSettlementServices } from "./support/runtime-support/services";
import { settlementSchemaSql } from "./support/runtime-support/schema";
import { seedSettlementDatabase } from "./support/runtime-support/seed";
import { buildSettlementPaymentInputProjectionHandlers } from "./features/wallets/integrations/payment-source/payment-source-projection";

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
      `Settlement is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<SettlementServices, PgTransactionalPool, void> = {
  contextName: "settlement",
  routePrefix: "/api/settlement",
  streamPrefix: "settlement.",
  schemaSql: settlementSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<SettlementServices, PgTransactionalPool, void>["apiMounts"],
  projectionGroups,
  createServices: (pool) => createSettlementServices(pool),
  buildApis: (services) => [buildSettlementApi(services)],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const paymentsSubscription = getEventSubscription(
      "payments",
      "settlement-payment-input-projection",
    );

    return [
      {
        subscriptionName: "settlement.payment-input-projection",
        sourceContextName: "payments",
        projectionName: paymentsSubscription.projectionName,
        subscriptionVersion: paymentsSubscription.subscriptionVersion,
        handlers: buildSettlementPaymentInputProjectionHandlers(
          services.db,
          services.wallets,
        ),
        eventTypes: paymentsSubscription.eventTypes,
        streamPrefixes: paymentsSubscription.streamPrefixes,
        order: paymentsSubscription.order,
      },
    ];
  },
  seed: seedSettlementDatabase,
};
