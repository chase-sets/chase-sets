export { default as contextManifest } from "./context.json";

import type {
  BcApiModule,
  BcEventSubscriptionDeclaration,
  BcProjectionGroupDeclaration,
} from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import { buildAuthApi } from "./api";
import {
  buildAuthIdentityAccountProjectionHandlers,
  buildAuthIdentityInvitationProjectionHandlers,
  buildAuthIdentityMembershipProjectionHandlers,
  buildAuthIdentityUserProjectionHandlers,
} from "./support/auth-support/identity-projection";
import { authSchemaSql } from "./support/runtime-support/schema";
import { seedAuthDatabase } from "./support/runtime-support/seed";
import type { AuthHostPorts, AuthServices } from "./support/runtime-support/services";
import { createAuthServices } from "./support/runtime-support/services";

const eventSubscriptions = (contextManifest.eventSubscriptions ?? []) as readonly BcEventSubscriptionDeclaration[];
const projectionGroups = (contextManifest.projectionGroups ?? []) as readonly BcProjectionGroupDeclaration[];

function getEventSubscription(sourceContextName: string, projectionName: string): BcEventSubscriptionDeclaration {
  const declaration = eventSubscriptions.find(
    (entry) => entry.sourceContextName === sourceContextName && entry.projectionName === projectionName,
  );

  if (!declaration) {
    throw new Error(
      `Auth is missing an eventSubscriptions declaration for '${sourceContextName}' -> '${projectionName}'.`,
    );
  }

  return declaration;
}

export const module: BcApiModule<AuthServices, PgTransactionalPool, AuthHostPorts> = {
  contextName: "auth",
  routePrefix: "/api/auth",
  streamPrefix: "auth.",
  schemaSql: authSchemaSql,
  apiMounts: contextManifest.apiMounts as BcApiModule<AuthServices, PgTransactionalPool, AuthHostPorts>["apiMounts"],
  projectionGroups,
  createServices: (pool, ports) => createAuthServices(pool, ports),
  buildApis: (services) => [buildAuthApi(services)],
  projectors: (services) => services.projectors,
  buildSubscriptions: (services) => {
    const accountSubscription = getEventSubscription("identity", "auth-identity-account-projection");
    const userSubscription = getEventSubscription("identity", "auth-identity-user-projection");
    const membershipSubscription = getEventSubscription("identity", "auth-identity-membership-projection");
    const invitationSubscription = getEventSubscription("identity", "auth-identity-invitation-projection");

    return [
      {
        subscriptionName: "auth.identity-account-projection",
        sourceContextName: "identity",
        projectionName: accountSubscription.projectionName,
        subscriptionVersion: accountSubscription.subscriptionVersion,
        handlers: buildAuthIdentityAccountProjectionHandlers(services.db),
        eventTypes: accountSubscription.eventTypes,
        streamPrefixes: accountSubscription.streamPrefixes,
        order: accountSubscription.order,
      },
      {
        subscriptionName: "auth.identity-user-projection",
        sourceContextName: "identity",
        projectionName: userSubscription.projectionName,
        subscriptionVersion: userSubscription.subscriptionVersion,
        handlers: buildAuthIdentityUserProjectionHandlers(services.db),
        eventTypes: userSubscription.eventTypes,
        streamPrefixes: userSubscription.streamPrefixes,
        order: userSubscription.order,
      },
      {
        subscriptionName: "auth.identity-membership-projection",
        sourceContextName: "identity",
        projectionName: membershipSubscription.projectionName,
        subscriptionVersion: membershipSubscription.subscriptionVersion,
        handlers: buildAuthIdentityMembershipProjectionHandlers(services.db),
        eventTypes: membershipSubscription.eventTypes,
        streamPrefixes: membershipSubscription.streamPrefixes,
        order: membershipSubscription.order,
      },
      {
        subscriptionName: "auth.identity-invitation-projection",
        sourceContextName: "identity",
        projectionName: invitationSubscription.projectionName,
        subscriptionVersion: invitationSubscription.subscriptionVersion,
        handlers: buildAuthIdentityInvitationProjectionHandlers(services.db),
        eventTypes: invitationSubscription.eventTypes,
        streamPrefixes: invitationSubscription.streamPrefixes,
        order: invitationSubscription.order,
      },
    ];
  },
  seed: seedAuthDatabase,
};
