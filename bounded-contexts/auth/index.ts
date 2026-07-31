export { default as contextManifest } from "./context.json";

import { buildEventSubscriptionsFromManifest, defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import {
  authRetentionExemptions,
  authRetentionSchemaMigrations,
  authRetentionSweeps,
} from "./support/runtime-support/retention-policy";
import { buildAuthApi } from "./api";
import {
  buildAuthIdentityAccountProjectionHandlers,
  buildAuthIdentityInvitationProjectionHandlers,
  buildAuthIdentityMembershipProjectionHandlers,
  buildAuthIdentityUserProjectionHandlers,
} from "./support/auth-support/identity-projection";
import { authSchemaSql } from "./support/runtime-support/schema";
import { authUnloggedProjectionSchemaMigrations } from "./support/runtime-support/unlogged-projection-migrations";
import { inspectAuthSeedState, seedAuthDatabase } from "./support/runtime-support/seed";
import type { AuthHostPorts, AuthServices } from "./support/runtime-support/services";
import { createAuthServices } from "./support/runtime-support/services";
import {
  AGENT_ORDER_WEBHOOK_PROJECTION,
  buildAgentOrderWebhookProjectionHandlers,
} from "./support/ucp-support/agent-webhooks";

export const module = defineBoundedContextModule<AuthServices, PgTransactionalPool, AuthHostPorts>({
  manifest: contextManifest,
  schemaSql: authSchemaSql,
  retentionSweeps: authRetentionSweeps,
  retentionExemptions: authRetentionExemptions,
  schemaMigrations: [...authUnloggedProjectionSchemaMigrations, ...authRetentionSchemaMigrations],
  createServices: (pool, ports) => createAuthServices(pool, ports),
  buildApis: (services) => [{ mountPath: "/api/auth", contextMountOrdinal: 1, router: buildAuthApi(services) }],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) =>
    buildEventSubscriptionsFromManifest({
      contextName: "auth",
      manifest: contextManifest,
      handlers: {
        [`ordering.${AGENT_ORDER_WEBHOOK_PROJECTION}`]: () => buildAgentWebhookHandlers(services),
        [`fulfillment.${AGENT_ORDER_WEBHOOK_PROJECTION}`]: () => buildAgentWebhookHandlers(services),
        [`payments.${AGENT_ORDER_WEBHOOK_PROJECTION}`]: () => buildAgentWebhookHandlers(services),
        "identity.auth-identity-account-projection": () => buildAuthIdentityAccountProjectionHandlers(services.db),
        "identity.auth-identity-user-projection": () => buildAuthIdentityUserProjectionHandlers(services.db),
        "identity.auth-identity-membership-projection": () =>
          buildAuthIdentityMembershipProjectionHandlers(services.db),
        "identity.auth-identity-invitation-projection": () =>
          buildAuthIdentityInvitationProjectionHandlers(services.db),
      },
    }),
  seed: seedAuthDatabase,
  inspectSeedState: (pool) => inspectAuthSeedState(pool),
});

function buildAgentWebhookHandlers(services: AuthServices) {
  return buildAgentOrderWebhookProjectionHandlers({
    outbox: services.agentWebhookOutbox,
    resolveWebhookTargets: services.agentWebhookOrderResolvers.resolveWebhookTargets,
    resolveOrderRecipient: services.agentWebhookOrderResolvers.resolveOrderRecipient,
    resolveShipmentOrderId: services.agentWebhookOrderResolvers.resolveShipmentOrderId,
  });
}
