import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ResolvedPolicy } from "@chase-sets/platform-policy/resolver";
import type { ChannelProviderRegistry } from "../../publication-port/domain/contracts";
import type { OutboundSyncServices } from "../../outbound-sync/domain/contracts";
import { ConnectorPairingError, type ConnectorIdentity } from "../domain/contracts";
import type { ConnectorPolicy } from "../domain/policy";
import { decodeServedConnectorPolicy, deriveServedPolicyIdentity } from "../domain/served-policy-identity";
import { recordConnectorHeartbeat } from "../read-model/liveness";
import {
  assertConnectorClaim,
  assertConnectorInbound,
  assertConnectorReport,
  ConnectorTransportError,
} from "../domain/transport";
import { admitConnectorInbound, createConnectorInboundReader } from "../read-model/inbound";
import type { ConnectorFeedServices } from "./runtime";

type RequestAuthority = Readonly<{ token: string; connectionId: string }>;
type Identify = (identity: ConnectorIdentity) => void;
export function createConnectorTransport(
  deps: Readonly<{
    db: PgTransactionalPool;
    authority: ConnectorFeedServices;
    outboundSync: OutboundSyncServices;
    registry: ChannelProviderRegistry;
    resolvePolicy: () => Promise<ResolvedPolicy<ConnectorPolicy>>;
    now?: () => Date;
  }>,
) {
  const now = deps.now ?? (() => new Date());
  async function snapshot(): Promise<ResolvedPolicy<ConnectorPolicy>> {
    try {
      return decodeServedConnectorPolicy(await deps.resolvePolicy());
    } catch {
      throw new ConnectorTransportError("policy-unavailable");
    }
  }
  async function policy(): Promise<ConnectorPolicy> {
    return (await snapshot()).value;
  }
  return {
    resolveTransportPolicy: policy,
    readAdmittedConnectorInboundEvents: createConnectorInboundReader(deps.db),
    async claim(input: RequestAuthority, value: unknown, identify: Identify) {
      assertConnectorClaim(value);
      const admittedPolicy = await snapshot();
      const resolved = admittedPolicy.value;
      const policyIdentity = deriveServedPolicyIdentity(admittedPolicy);
      const admission = await deps.authority.withAuthority(
        { ...input, operation: "claim" },
        async (authority, db: PgQueryable) => {
          if (!authority.pairingId || !authority.grant) throw new ConnectorPairingError("invalid-credential");
          const at = now().toISOString();
          await recordConnectorHeartbeat(db, {
            connectionId: input.connectionId,
            pairingId: authority.pairingId,
            at,
            pollWindowSeconds: resolved.pollWindowSeconds,
            policyIdentity,
          });
          return { paused: authority.connectionState === "paused", pairingId: authority.pairingId };
        },
        identify,
      );
      // The committed authority transaction must release the connection stream before the canonical health hold reads it.
      const reservation = admission.paused
        ? null
        : await deps.outboundSync.reserveConnectorClaimedOperations({
            connectionId: input.connectionId,
            claimant: { claimantKind: "connector", claimantId: admission.pairingId },
            registry: deps.registry,
            maxOperations: resolved.maxOperationsPerClaim,
            leaseMs: resolved.leaseMs,
            capabilities: value.capabilities ?? [],
          });
      return { reservation, pollWindowSeconds: resolved.pollWindowSeconds };
    },
    async report(input: RequestAuthority, value: unknown, identify: Identify) {
      await policy();
      assertConnectorReport(value);
      await deps.authority.withAuthority(
        { ...input, operation: "report" },
        async (authority) => {
          if (!authority.pairingId) throw new ConnectorPairingError("invalid-credential");
          await deps.outboundSync.reportClaimedOperationOutcomes({
            reservationId: value.reservationId,
            outcomes: value.outcomes,
            ...(value.runSettlement ? { runSettlement: { ...value.runSettlement, context: null } } : {}),
            claimant: { claimantKind: "connector", claimantId: authority.pairingId },
          });
        },
        identify,
      );
    },
    async ingest(input: RequestAuthority, value: unknown, identify: Identify) {
      const resolved = await policy();
      assertConnectorInbound(value, resolved);
      await deps.authority.withAuthority(
        { ...input, operation: "ingest" },
        async (_authority, db) => {
          await admitConnectorInbound(db, input.connectionId, value, now().toISOString());
        },
        identify,
      );
    },
  };
}
export type ConnectorTransportServices = ReturnType<typeof createConnectorTransport>;
