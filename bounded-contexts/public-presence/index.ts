export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildPublicPresenceAdminApi, buildPublicPresencePublicApi } from "./api";
import { buildWaitlistProjectionHandlers } from "./features/waitlist/read-model/projection";
import type { PublicPresenceServices } from "./support/runtime-support/services";
import { createPublicPresenceServices } from "./support/runtime-support/services";
import { publicPresenceSchemaSql } from "./support/runtime-support/schema";

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
      `Public Presence is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<PublicPresenceServices, PgTransactionalPool, void> = {
  contextName: "public-presence",
  routePrefix: "/api/public-presence",
  streamPrefix: "public-presence.",
  schemaSql: publicPresenceSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<
    PublicPresenceServices,
    PgTransactionalPool,
    void
  >["apiMounts"],
  projectionGroups,
  createServices: (pool) => createPublicPresenceServices(pool),
  buildApis: (services) => [
    buildPublicPresencePublicApi(services),
    buildPublicPresenceAdminApi(services),
  ],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const waitlistSubscription = getEventSubscription(
      "public-presence",
      "public-presence-waitlist-projection",
    );

    return [
      {
        subscriptionName: "public-presence.waitlist-projection",
        sourceContextName: "public-presence",
        projectionName: waitlistSubscription.projectionName,
        subscriptionVersion: waitlistSubscription.subscriptionVersion,
        handlers: buildWaitlistProjectionHandlers(services.db),
        eventTypes: waitlistSubscription.eventTypes,
        streamPrefixes: waitlistSubscription.streamPrefixes,
        order: waitlistSubscription.order,
      },
    ];
  },
};
