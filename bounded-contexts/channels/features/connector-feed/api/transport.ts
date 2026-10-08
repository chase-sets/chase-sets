import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ChannelProviderRegistry } from "../../publication-port/domain/contracts";
import type { OutboundSyncServices } from "../../outbound-sync/domain/contracts";
import { ConnectorPairingError, type ConnectorIdentity } from "../domain/contracts";
import { decodeConnectorPolicy, type ConnectorPolicy } from "../domain/policy";
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
    resolvePolicy: () => Promise<ConnectorPolicy>;
    now?: () => Date;
  }>,
) {
  const now = deps.now ?? (() => new Date());
  async function policy(): Promise<ConnectorPolicy> {
    try {
      return decodeConnectorPolicy(await deps.resolvePolicy());
    } catch {
      throw new ConnectorTransportError("policy-unavailable");
    }
  }
  return {
    resolveTransportPolicy: policy,
    readAdmittedConnectorInboundEvents: createConnectorInboundReader(deps.db),
    async claim(input: RequestAuthority, value: unknown, identify: Identify) {
      assertConnectorClaim(value);
      const resolved = await policy();
      const admission = await deps.authority.withAuthority(
        { ...input, operation: "claim" },
        async (authority, db: PgQueryable) => {
          if (!authority.pairingId || !authority.grant) throw new ConnectorPairingError("invalid-credential");
          const at = now().toISOString();
          const observed = await db.query<{ revision: number }>(
            `SELECT revision FROM channel_connector_pairings
          WHERE pairing_id=$1 AND grant_id=$2 AND state='paired' FOR UPDATE`,
            [authority.pairingId, authority.grant.grantId],
          );
          const revision = observed.rows[0]?.revision;
          if (revision === undefined) throw new ConnectorPairingError("conflict");
          const updated = await db.query(
            `UPDATE channel_connector_pairings SET
          last_seen_at=GREATEST(COALESCE(last_seen_at,$1::timestamptz),$1::timestamptz),
          served_poll_window_seconds=CASE WHEN last_seen_at IS NULL OR last_seen_at <= $1::timestamptz
            THEN $2 ELSE served_poll_window_seconds END
          WHERE pairing_id=$3 AND revision=$4 AND state='paired' AND grant_id=$5
          RETURNING pairing_id`,
            [at, resolved.pollWindowSeconds, authority.pairingId, revision, authority.grant.grantId],
          );
          if (updated.rows.length !== 1) throw new ConnectorPairingError("conflict");
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
        async (authority, db: PgQueryable) => {
          if (!authority.pairingId) throw new ConnectorPairingError("invalid-credential");
          const context = value.runSettlement?.context;
          if (context) {
            const opening = await db.query<{ tenant_id: string }>(
              "SELECT tenant_id FROM event_store_events WHERE stream_id=$1 ORDER BY stream_version LIMIT 1",
              [`channels.connection-${input.connectionId}`],
            );
            if (
              context.audit.forAccountId !== authority.accountId ||
              context.audit.performedByUserId !== authority.grant?.userId ||
              context.tenantId !== opening.rows[0]?.tenant_id
            )
              throw new ConnectorPairingError("authorization-refused");
          }
          await deps.outboundSync.reportClaimedOperationOutcomes({
            ...value,
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
