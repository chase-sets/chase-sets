import {
  createAgentWebhookDispatcher,
  createFetchAgentWebhookSender,
  createPostgresAgentWebhookOutbox,
  resolveAgentWebhookSigningSecret,
  resolveAgentWebhookTargets,
} from "@chase-sets/auth/server";
import {
  resolveOrderRecipient as resolveOrderingOrderRecipient,
  resolveShipmentOrderId as resolveOrderingShipmentOrderId,
} from "@chase-sets/ordering/server";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { WorkerHostRuntime, WorkerRunner } from "@chase-sets/platform-runtime/worker";

/**
 * Cross-context resolvers the Auth agent-order-webhook projection needs but
 * cannot reach from its own pool: order/shipment recipients live in Ordering,
 * linked-platform authorizations in Identity, and webhook callbacks on the
 * Auth-owned OAuth client record.
 */
export function createOrderingAgentWebhookOrderResolvers(
  pools: Readonly<{
    ordering: PgQueryable;
    linkedAuthorizations: PgQueryable;
    oauthClients: PgQueryable;
  }>,
) {
  return {
    resolveOrderRecipient: (orderId: string) => resolveOrderingOrderRecipient(pools.ordering, orderId),
    resolveShipmentOrderId: (shipmentId: string) => resolveOrderingShipmentOrderId(pools.ordering, shipmentId),
    resolveWebhookTargets: (accountId: string) =>
      resolveAgentWebhookTargets(pools.linkedAuthorizations, pools.oauthClients, accountId),
  };
}

export function createAgentWebhookDispatchRunners(
  runtime: WorkerHostRuntime,
  input: Readonly<{ workerId: string }>,
): readonly WorkerRunner[] {
  const authContext = runtime.mountedContexts.find((context) => context.contextName === "auth");
  if (!authContext) {
    return [];
  }

  const outbox = createPostgresAgentWebhookOutbox({ db: authContext.pool });
  const dispatcher = createAgentWebhookDispatcher({
    outbox,
    resolveSigningSecret: (clientId) => resolveAgentWebhookSigningSecret(authContext.pool, clientId),
    send: createFetchAgentWebhookSender(),
    claimOwnerId: `${input.workerId}:auth-agent-webhooks`,
  });

  return [
    {
      name: "auth.agent-webhook-dispatcher",
      kind: "job",
      runOnce: dispatcher.runOnce,
    },
  ];
}
