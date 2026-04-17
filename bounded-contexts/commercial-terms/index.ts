export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildCommercialTermsApi } from "./api";
import { buildCommercialTermsAccountProjectionHandlers } from "./features/resolutions/integrations/account-source/account-projection";
import { commercialTermsSchemaSql } from "./support/runtime-support/schema";
import { seedCommercialTermsDatabase } from "./support/runtime-support/seed";
import type { CommercialTermsServices } from "./support/runtime-support/services";
import { createCommercialTermsServices } from "./support/runtime-support/services";

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
      `Commercial Terms is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<CommercialTermsServices, PgTransactionalPool, void> = {
  contextName: "commercial-terms",
  routePrefix: "/api/commercial-terms",
  streamPrefix: "commercial-terms.",
  schemaSql: commercialTermsSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    CommercialTermsServices,
    PgTransactionalPool,
    void
  >["apiMounts"],
  projectionGroups,
  createServices: (pool) => createCommercialTermsServices(pool),
  buildApis: (services) => [buildCommercialTermsApi(services)],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const identitySubscription = getEventSubscription(
      "identity",
      "commercial-terms-account-projection",
    );

    return [
      {
        subscriptionName: "commercial-terms.account-projection",
        sourceContextName: "identity",
        projectionName: identitySubscription.projectionName,
        subscriptionVersion: identitySubscription.subscriptionVersion,
        handlers: buildCommercialTermsAccountProjectionHandlers(services.db),
        eventTypes: identitySubscription.eventTypes,
        streamPrefixes: identitySubscription.streamPrefixes,
        order: identitySubscription.order,
      },
    ];
  },
  seed: seedCommercialTermsDatabase,
};
