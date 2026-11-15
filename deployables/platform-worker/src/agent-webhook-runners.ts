import { resolveAgentWebhookTargets } from "@chase-sets/auth/server";
import type { RevokeAgentGrantPaymentInstruments } from "@chase-sets/auth/server";
import type { PaymentsServices } from "@chase-sets/payments/server";
import type { WorkerHostRuntime } from "@chase-sets/platform-runtime/worker";
import { createActiveAgentGrantFence } from "@chase-sets/identity/server";

import {
  resolveOrderRecipient as resolveOrderingOrderRecipient,
  resolveShipmentOrderId as resolveOrderingShipmentOrderId,
} from "@chase-sets/ordering/server";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";

export function createAgentGrantRevocationWorkerPorts(runtime: WorkerHostRuntime) {
  const payments = runtime.services.payments as PaymentsServices | undefined;
  return {
    revokeAgentGrantPaymentInstruments: payments?.payments?.revokeSavedCheckoutInstrumentsForAgentGrant satisfies
      | RevokeAgentGrantPaymentInstruments
      | undefined,
  };
}

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
