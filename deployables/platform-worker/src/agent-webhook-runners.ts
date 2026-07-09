import {
  createAgentWebhookDispatcher,
  createFetchAgentWebhookSender,
  createPostgresAgentWebhookOutbox,
  resolveAgentWebhookSigningSecret,
} from "@chase-sets/auth/server";
import {
  resolveOrderRecipient as resolveOrderingOrderRecipient,
  resolveShipmentOrderId as resolveOrderingShipmentOrderId,
} from "@chase-sets/ordering/server";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { WorkerHostRuntime, WorkerRunner } from "@chase-sets/platform-runtime/worker";

export function createOrderingAgentWebhookOrderResolvers(db: PgQueryable) {
  return {
    resolveOrderRecipient: (orderId: string) => resolveOrderingOrderRecipient(db, orderId),
    resolveShipmentOrderId: (shipmentId: string) => resolveOrderingShipmentOrderId(db, shipmentId),
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
