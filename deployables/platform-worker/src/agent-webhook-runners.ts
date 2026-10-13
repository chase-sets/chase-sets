import {
  createAgentWebhookDispatcher,
  createFetchAgentWebhookSender,
  createPostgresAgentWebhookOutbox,
  resolveAgentWebhookSigningSecret,
  resolveAgentWebhookTargets,
  resumeAgentGrantRevocation,
} from "@chase-sets/auth/server";
import { createActiveAgentGrantFence, type IdentityServices } from "@chase-sets/identity/server";
import type { PaymentsServices } from "@chase-sets/payments/server";
import {
  resolveOrderRecipient as resolveOrderingOrderRecipient,
  resolveShipmentOrderId as resolveOrderingShipmentOrderId,
} from "@chase-sets/ordering/server";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
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
    linkedAuthorizations: PgTransactionalPool;
    oauthClients: PgQueryable;
  }>,
) {
  return {
    withActiveGrants: createActiveAgentGrantFence(pools.linkedAuthorizations),
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

  const identityContext = runtime.mountedContexts.find((context) => context.contextName === "identity");
  const withActiveGrants = identityContext ? createActiveAgentGrantFence(identityContext.pool) : undefined;
  const outbox = createPostgresAgentWebhookOutbox({ db: authContext.pool, withActiveGrants });
  const dispatcher = createAgentWebhookDispatcher({
    outbox,
    withActiveGrants,
    resolveSigningSecret: (clientId) => resolveAgentWebhookSigningSecret(authContext.pool, clientId),
    send: createFetchAgentWebhookSender(),
    claimOwnerId: `${input.workerId}:auth-agent-webhooks`,
  });

  const runners: WorkerRunner[] = [
    {
      name: "auth.agent-webhook-dispatcher",
      kind: "job",
      runOnce: dispatcher.runOnce,
    },
  ];
  const identity = runtime.services.identity as IdentityServices | undefined;
  const payments = runtime.services.payments as PaymentsServices | undefined;
  if (identity?.agentGrantRevocations && payments?.payments)
    runners.push({
      name: "auth.agent-grant-revocation-recovery",
      kind: "job",
      runOnce: async () => {
        const pending = await identity.agentGrantRevocations.pending();
        for (const operation of pending)
          await resumeAgentGrantRevocation(
            {
              advance: identity.agentGrantRevocations.advance,
              cleanup: payments.payments.revokeSavedCheckoutInstrumentsForAgentGrant,
              exclude: outbox.excludeRevokedGrant,
            },
            operation.state,
            operation.context,
          );
        return { processed: pending.length, lastGlobalPosition: ZERO_GLOBAL_POSITION };
      },
    });
  return runners;
}
