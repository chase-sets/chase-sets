import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext, GlobalPosition } from "@chase-sets/event-core/storage";
import type {
  ChannelProviderIdentity,
  ChannelProviderRegistry,
  ChannelPublicationDraft,
  ChannelPublicationRejectionCode,
  ChannelPublicationSuccess,
} from "../../publication-port/domain/contracts";

export const outboundOperationKinds = ["publish", "update", "delist"] as const;
export type OutboundOperationKind = (typeof outboundOperationKinds)[number];

export const outboundOperationStatuses = ["pending", "in-flight", "succeeded", "failed"] as const;
export type OutboundOperationStatus = (typeof outboundOperationStatuses)[number];

export const outboundClaimantKinds = ["inline", "connector", "manual"] as const;
export type OutboundClaimantKind = (typeof outboundClaimantKinds)[number];

export type OutboundOperationPayload =
  | Readonly<{ kind: "draft"; draft: ChannelPublicationDraft }>
  | Readonly<{ kind: "delist"; delist: unknown }>;

export type OutboundDesiredStateEnvelope = Readonly<{
  sourceEventId: string;
  sourceStreamId: string;
  sourceStreamVersion: number;
  sourceGlobalPosition: GlobalPosition;
  sourceOccurredAt: string;
}>;

export type EnqueueOutboundOperation = Readonly<{
  connectionId: string;
  channelListingId: string;
  listingId: string;
  operationKind: OutboundOperationKind;
  listingRevision: number;
  desiredStateSequence: number;
  desiredStateHash: string;
  payload: OutboundOperationPayload;
  envelope: OutboundDesiredStateEnvelope;
}>;

export type OutboundOperationRecord = Readonly<{
  operationId: string;
  connectionId: string;
  channelListingId: string;
  listingId: string;
  operationKind: OutboundOperationKind;
  listingRevision: number;
  sourceDesiredStateSequence: number;
  payload: OutboundOperationPayload;
  payloadDigest: string;
  status: OutboundOperationStatus;
  revision: number;
  attemptId: string | null;
  claimGeneration: number;
  claimantKind: OutboundClaimantKind | null;
  claimOwnerId: string | null;
  reservationId: string | null;
  claimedUntil: string | null;
  attemptCount: number;
  nextAttemptAt: string;
  lastRejectionCode: string | null;
  terminalReason: string | null;
  linkWriteState: "pending" | "applied" | "link-write-refused";
  sourceEventId: string;
  sourceStreamId: string;
  sourceStreamVersion: number;
  sourceGlobalPosition: GlobalPosition;
  sourceDesiredStateHash: string;
  sourceOccurredAt: string;
  enqueuedAt: string;
  firstClaimedAt: string | null;
  terminalAt: string | null;
}>;

export type OutboundOperationLane = Readonly<{
  connectionId: string;
  channelListingId: string;
  generation: number;
  blockedOperationId: string | null;
  blockedReason: string | null;
  blockedAt: string | null;
  clearedAt: string | null;
  revision: number;
}>;

export type ClaimedOutboundOperation = Readonly<{
  operationId: string;
  attemptId: string;
  claimGeneration: number;
  connectionId: string;
  providerIdentity: ChannelProviderIdentity;
  channelListingId: string;
  listingId: string;
  operationKind: OutboundOperationKind;
  listingRevision: number;
  desiredStateSequence: number;
  payload: OutboundOperationPayload;
  payloadDigest: string;
  sourceOccurredAt: string;
  enqueuedAt: string;
}>;

export type ClaimedOperationClaimant = Readonly<{
  claimantKind: "connector" | "manual";
  claimantId: string;
}>;

export type ClaimedOperationReservation = Readonly<{
  reservationId: string;
  connectionId: string;
  providerIdentity: ChannelProviderIdentity;
  claimant: ClaimedOperationClaimant;
  reservedAt: string;
  leaseExpiresAt: string;
  operations: readonly ClaimedOutboundOperation[];
}>;

export type ClaimedOperationOutcome = Readonly<{
  operationId: string;
  attemptId: string;
  claimGeneration: number;
  desiredStateSequence: number;
  outcome:
    | Readonly<{ kind: "applied"; result: ChannelPublicationSuccess }>
    | Readonly<{ kind: "rejected"; code: ChannelPublicationRejectionCode }>
    | Readonly<{ kind: "outcome-unknown" }>
    | Readonly<{ kind: "abandoned"; reason: "released" | "superseded-basis" | "claimant-cancelled" }>;
}>;

/**
 * The reservation-side view of a downstream run while its operation members
 * are locked. The downstream owner derives the total outcome vector from its
 * immutable member partition; outbound sync only validates and settles it.
 */
export type BoundClaimedReservationRun = Readonly<{
  runId: string;
  revision: number;
  reservationId: string;
  state: "composed" | "claimed" | "awaiting-verification" | "terminal";
  submitMayHaveOccurred: boolean;
  uploadAttemptedAt: string | null;
  claimant: ClaimedOperationClaimant;
  outcomes: readonly ClaimedOperationOutcome[];
}>;

export type ClaimedReservationRunSettlement = Readonly<{
  runId: string;
  expectedRunRevision: number;
  fromState: "composed" | "claimed" | "awaiting-verification";
  toState: "applied" | "validation-rejected" | "application-unknown" | "superseded" | "stale-basis" | "abandoned";
  verificationSnapshotId: string | null;
  verificationSnapshotGeneration: number | null;
  uploadAttemptedAt: string | null;
  uploadFileName: string | null;
  importSummary: Readonly<{
    fileName: string;
    dateImportedText: string;
    numberOfProducts: number;
    recordedAt: string;
  }> | null;
  context: EventStoreContext | null;
}>;

export interface ClaimedReservationRunSettlementPort {
  lockBoundRun(
    db: PgQueryable,
    input: Readonly<{
      reservationId: string;
      runId?: string;
      expectedRunRevision?: number;
    }>,
  ): Promise<BoundClaimedReservationRun | null>;
  settleBoundRun(
    db: PgQueryable,
    input: ClaimedReservationRunSettlement &
      Readonly<{ reservationId: string; outcomes: readonly ClaimedOperationOutcome[] }>,
  ): Promise<void>;
}

export type ConnectionExecutionAdmission =
  | Readonly<{ kind: "blocked"; reason: "provider-descriptor-unregistered" | "provider-publication-unregistered" }>
  | Readonly<{ kind: "claimed"; providerIdentity: ChannelProviderIdentity }>
  | Readonly<{
      kind: "inline";
      providerIdentity: ChannelProviderIdentity;
      publication: Extract<
        NonNullable<ReturnType<ChannelProviderRegistry["get"]>>["publication"],
        { execution: "inline" }
      >;
    }>
  | Readonly<{ kind: "indeterminate" }>;

export type OutboundConnection = Readonly<{
  connectionId: string;
  providerKey: string;
  environment: "sandbox" | "production";
  status: "pending-setup" | "active" | "paused" | "disconnected";
}>;

export type OutboundOperationLogItem = Readonly<{
  operationId: string;
  channelListingId: string;
  listingId: string;
  operationKind: OutboundOperationKind;
  status: OutboundOperationStatus;
  terminalReason: string | null;
  rejectionCode: string | null;
  attemptCount: number;
  linkWriteState: "pending" | "applied" | "link-write-refused";
  sourceOccurredAt: string;
  enqueuedAt: string;
  terminalAt: string | null;
  eventToEnqueueMs: number;
  enqueueToTerminalMs: number | null;
  eventToProviderAckMs: number | null;
}>;

export type OutboundOperationLogPage = Readonly<{
  items: readonly OutboundOperationLogItem[];
  nextCursor?: string;
  completeness:
    | Readonly<{ kind: "complete"; total: number }>
    | Readonly<{ kind: "bounded-incomplete"; reason: string }>;
}>;

export type OutboundOperationSummary = Readonly<{
  completeness:
    | Readonly<{ kind: "complete"; total: number }>
    | Readonly<{ kind: "bounded-incomplete"; reason: string }>;
  succeeded: number;
  failed: number;
  pending: number;
  inFlight: number;
  blocked: number;
  inlineEventToProviderAckMs: Readonly<{ p50: number | null; p95: number | null; p99: number | null }>;
  claimedEventToProviderAckMs: Readonly<{ p50: number | null; p95: number | null; p99: number | null }>;
}>;

export interface OutboundSyncServices {
  enqueueDesiredState(input: EnqueueOutboundOperation): Promise<OutboundOperationRecord | null>;
  reserveClaimedOutboundOperations(
    input: Readonly<{
      registry: ChannelProviderRegistry;
      connectionId: string;
      claimant: ClaimedOperationClaimant;
      maxOperations: number;
      leaseMs: number;
    }>,
  ): Promise<ClaimedOperationReservation | null>;
  reportClaimedOperationOutcomes(
    input: Readonly<{
      reservationId: string;
      claimant: ClaimedOperationClaimant;
      outcomes: readonly ClaimedOperationOutcome[];
      runSettlement?: ClaimedReservationRunSettlement;
    }>,
  ): Promise<void>;
  clearOutboundOperationLane(
    input: Readonly<{
      connectionId: string;
      channelListingId: string;
      expectedRevision: number;
    }>,
  ): Promise<OutboundOperationLane>;
  readOutboundOperationLog(
    input: Readonly<{
      accountId: string;
      connectionId: string;
      cursor?: string;
      limit?: number;
    }>,
  ): Promise<OutboundOperationLogPage>;
  readOutboundOperationSummary(
    input: Readonly<{
      accountId: string;
      connectionId: string;
      window: Readonly<{ from: string; to: string }>;
    }>,
  ): Promise<OutboundOperationSummary>;
  processNextInlineOperation(
    input: Readonly<{ registry: ChannelProviderRegistry; claimOwnerId: string }>,
  ): Promise<number>;
  recoverExpiredClaimedOperations(): Promise<number>;
}

export type OutboundSyncRuntimeDependencies = Readonly<{
  db: PgTransactionalPool;
  clock?: Readonly<{ now(): Date }>;
  resolveBudgetPolicy?: () => Promise<import("./policy").OutboundOperationBudgetPolicyValue>;
  compiledProviderBudgets?: Readonly<Record<string, import("./policy").OutboundOperationBudget>>;
  recordOutcome?: (
    db: PgQueryable,
    operation: OutboundOperationRecord,
    outcome:
      | ChannelPublicationSuccess
      | Readonly<{ kind: "rejected"; code: ChannelPublicationRejectionCode }>
      | Readonly<{ kind: "outcome-unknown" }>,
  ) => Promise<"applied" | "link-write-refused">;
  claimedReservationRunSettlement?: ClaimedReservationRunSettlementPort;
}>;

export class OutboundSyncError extends Error {
  public constructor(
    public readonly code:
      | "invalid-input"
      | "connection-not-found"
      | "connection-not-active"
      | "execution-mode-mismatch"
      | "stale-fence"
      | "reservation-expired"
      | "reservation-membership-mismatch"
      | "run-settlement-unavailable",
    message: string = code,
  ) {
    super(message);
    this.name = "OutboundSyncError";
  }
}
