import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool, PostgresEventStore } from "@chase-sets/event-core-postgres";
import type { RecordExternalChannelSale } from "@chase-sets/inventory/server";
import type { ChannelProviderRegistry } from "../../publication-port/domain/contracts";
import type { OutboundSyncServices } from "../../outbound-sync/domain/contracts";

export const channelDriftClassifications = [
  "in-sync",
  "repairable",
  "foreign-edit",
  "structural",
  "source-unavailable",
] as const;
export type ChannelDriftClassification = (typeof channelDriftClassifications)[number];

export type ChannelObservedListing =
  | Readonly<{
      present: true;
      revision: string;
      price: Readonly<{ amountMinor: number; currency: string }>;
      quantity: number;
      fingerprint: string;
    }>
  | Readonly<{ present: false }>;

export type ChannelSourceAuthority =
  | Readonly<{ kind: "complete"; collectedCount: number; authorityTotal: number }>
  | Readonly<{ kind: "declared-incomplete"; reason: string }>
  | Readonly<{
      kind: "absent-by-design";
      reason: "claimed-snapshot-not-installed" | "reconciliation-capability-unregistered";
    }>;

export type AcceptedChannelDrift = Readonly<{
  observedFingerprint: string;
  expectedMaterialFingerprint: string;
  acceptedAtRunGeneration: number;
}>;

export type ChannelDriftObservationV1 = Readonly<{
  connectionId: string;
  channelListingId: string;
  expectedRevision: number;
  expectedPrice: Readonly<{ amountMinor: number; currency: string }>;
  expectedQuantity: number;
  expectedMaterialFingerprint: string;
  lastAppliedRevision: number | null;
  acceptedForeignEdit: AcceptedChannelDrift | null;
  observed: ChannelObservedListing;
  sourceAuthority: ChannelSourceAuthority;
}>;

export type ChannelHealthObservationV1 = Readonly<{
  sourceKind: "channel-reconciliation";
  sourceWorkId: string;
  sourceAttempt: number;
  resultOrdinal: number;
  policyRevision: number;
  evaluationGeneration: number;
  connectionId: string;
  reasonCode: "drift";
  fingerprint: string;
  outcome: "success" | "failure";
  occurredAt: string;
}>;

export type ChannelHealthObservationIdentity = Pick<
  ChannelHealthObservationV1,
  "sourceWorkId" | "sourceAttempt" | "resultOrdinal"
>;

export type ChannelDriftDecision = Readonly<{
  connectionId: string;
  channelListingId: string;
  revision: number;
  accepted: AcceptedChannelDrift | null;
  repushRequested: boolean;
  operationId: string | null;
}>;

export type AcceptChannelDrift = Readonly<{
  connectionId: string;
  channelListingId: string;
  observedFingerprint: string;
  expectedMaterialFingerprint: string;
  expectedDecisionRevision: number;
  operationId: string;
}>;

export type RepushChannelListing = Readonly<{
  connectionId: string;
  channelListingId: string;
  expectedDecisionRevision: number;
  operationId: string;
}>;

export type ChannelOutboundHoldSource = "seller-pause" | "health" | "operator-kill";
export type ChannelOutboundHold = Readonly<{
  held: boolean;
  sources: readonly ChannelOutboundHoldSource[];
}>;

export type ChannelDriftAttentionContribution = Readonly<{
  connectionId: string;
  generation: number;
  affectedListingCount: number;
  hasMore: 0 | 1;
  fingerprint: string;
  resolution: "handled-on-channel" | "recovered-automatically" | null;
}>;

export type ChannelReconciliationCounts = Readonly<{
  listingsReconciled: number;
  inSync: number;
  repairable: number;
  foreignEdit: number;
  structural: number;
  sourceUnavailable: number;
  repairsEnqueued: number;
  repairsSucceeded: number;
  missedSaleGaps: number;
}>;

export type ChannelReconciliationMetrics = Readonly<{
  connectionId: string;
  window: Readonly<{ from: string; to: string }>;
  runsCompleted: number;
  counts: ChannelReconciliationCounts;
  lastCleanRunAt: string | null;
}>;

export type ChannelReconciliationRunResult = Readonly<{
  connectionId: string;
  generation: number;
  state: "completed" | "bounded-unknown" | "held";
  counts: ChannelReconciliationCounts;
  clean: boolean;
}>;

export interface ChannelReconciliationServices {
  reconcileConnection(
    input: Readonly<{
      connectionId: string;
      registry: ChannelProviderRegistry;
      sourceAttempt: number;
      healthAuthority: Readonly<{ policyRevision: number; evaluationGeneration: number }> | null;
    }>,
    context: EventStoreContext,
  ): Promise<ChannelReconciliationRunResult>;
  reconcileDueConnections(
    input: Readonly<{
      registry: ChannelProviderRegistry;
      sourceAttempt: number;
      healthAuthority: Readonly<{ policyRevision: number; evaluationGeneration: number }> | null;
      limit?: number;
    }>,
    contextForAccount: (accountId: string) => EventStoreContext,
  ): Promise<readonly ChannelReconciliationRunResult[]>;
  acceptChannelDrift(input: AcceptChannelDrift, context: EventStoreContext): Promise<ChannelDriftDecision>;
  repushChannelListing(input: RepushChannelListing, context: EventStoreContext): Promise<ChannelDriftDecision>;
  readChannelDriftDecision(
    input: Readonly<{ connectionId: string; channelListingId: string }>,
  ): Promise<ChannelDriftDecision>;
  readChannelDriftAttentionContribution(
    input: Readonly<{ connectionId: string }>,
  ): Promise<ChannelDriftAttentionContribution | null>;
  readChannelReconciliationMetrics(
    input: Readonly<{ accountId: string; connectionId: string; window: Readonly<{ from: string; to: string }> }>,
  ): Promise<ChannelReconciliationMetrics>;
  readPendingHealthObservations(input: Readonly<{ limit?: number }>): Promise<readonly ChannelHealthObservationV1[]>;
  /** Called by the owning health consumer only after its intake transaction commits. */
  acknowledgeHealthObservations(
    input: Readonly<{ observations: readonly ChannelHealthObservationIdentity[] }>,
  ): Promise<Readonly<{ consumed: number }>>;
}

export type ChannelReconciliationRuntimeDependencies = Readonly<{
  db: PgTransactionalPool;
  eventStore: Pick<PostgresEventStore, "appendToStreamInTransaction" | "readStream">;
  outboundSync: Pick<
    OutboundSyncServices,
    "enqueueReconciliationRepair" | "enqueueRepush" | "readOutboundOperationsByIds"
  >;
  channelSaleRecorder: RecordExternalChannelSale;
  resolvePolicy: () => Promise<
    Readonly<{
      value: import("./policy").ChannelReconciliationPolicyValue;
      revision: number;
    }>
  >;
  resolveKillSwitch: () => Promise<import("./policy").ChannelOutboundKillSwitchPolicyValue | null>;
  readHealthHold?: (connectionId: string) => Promise<boolean>;
  clock?: Readonly<{ now(): Date }>;
}>;
