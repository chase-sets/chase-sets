import type { BcRetentionExemption, BcRetentionSweep } from "@chase-sets/bounded-context-module";
import { manualSyncIngestContract } from "../../manual-sync/domain/contracts";
import { connectorInboundKindRetention, resolveConnectorInboundRetentionClasses } from "../domain/retention";
import type { ConnectorInboundKind } from "../domain/transport";

const HOUR_MS = 60 * 60 * 1_000;
const RETENTION_BATCH_BYTES = 256 * 1_048_576;
const sweepNames: Record<ConnectorInboundKind, string> = {
  export: "connector-inbound-inventory-snapshot",
  order: "connector-inbound-order-observation",
  "channel-order-fulfillment-observation/v1": "connector-inbound-fulfillment-observation",
};

// Sized by the largest payload any policy revision could ever admit, so a batch
// stays bounded for historical rows after the live policy is lowered.
export const connectorInboundRetentionBatchLimit = Math.floor(
  RETENTION_BATCH_BYTES / manualSyncIngestContract.configuredBounds.bytes[1],
);

export function buildConnectorInboundRetentionSweeps(
  registrations: readonly unknown[] = connectorInboundKindRetention,
): readonly BcRetentionSweep[] {
  const kinds = resolveConnectorInboundRetentionClasses(registrations).flatMap(({ windowSeconds, inboundKinds }) =>
    inboundKinds.map((kind) => ({ kind, windowSeconds })),
  );
  return kinds.map(({ kind, windowSeconds }) => ({
    name: sweepNames[kind],
    tableName: "channel_connector_inbound_payloads",
    // Strictly after the deadline, measured on the DELETE transaction's clock.
    // One equality range per kind preserves index order without an unbounded bitmap/sort.
    predicateSql: `candidate.inbound_kind = '${kind}'
      AND candidate.received_at < CURRENT_TIMESTAMP - make_interval(secs => ${windowSeconds})`,
    orderBySql: "candidate.received_at ASC, candidate.provider_event_id ASC",
    intervalMs: HOUR_MS,
    batchLimit: connectorInboundRetentionBatchLimit,
  }));
}

export const connectorInboundRetentionSweeps = buildConnectorInboundRetentionSweeps();

export const connectorInboundRetentionExemptions: readonly BcRetentionExemption[] = [
  {
    tableName: "channel_connector_inbound_events",
    owner: "channels",
    reason:
      "Non-PII admitted identity is the dedupe key that keeps a re-post inert after payload expiry, and #7795 consumes its order, cursor and horizon; payload bytes live only in the swept payload table.",
  },
];
