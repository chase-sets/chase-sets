import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelConnectionStatus } from "../../connections/domain/contracts";

export const channelHealthStates = ["unknown", "healthy", "degraded", "failing"] as const;
export const channelHealthReasons = [
  "credential",
  "seller-setup",
  "subscription",
  "polling",
  "drift",
  "provider-rate",
  "provider-availability",
  "sale-follow-up",
] as const;
export const channelHealthSources = [
  "credential",
  "seller-setup",
  "subscription",
  "polling",
  "channel-reconciliation",
  "provider-rate",
  "provider-availability",
  "sale-follow-up",
] as const;
export type ChannelHealthState = (typeof channelHealthStates)[number];
export type ChannelHealthReason = (typeof channelHealthReasons)[number];
export type ChannelHealthSource = (typeof channelHealthSources)[number];
export type ChannelHealthPolicy = Readonly<{
  windowSeconds: number;
  consecutiveFailureThreshold: number;
  failureBudgetCount: number;
}>;
export type ChannelHealthObservation = Readonly<{
  schemaVersion: "ChannelHealthObservation/v1";
  sourceKind: ChannelHealthSource;
  sourceWorkId: string;
  sourceAttempt: number;
  resultOrdinal: number;
  policyRevision: string;
  evaluationGeneration: number;
  connectionId: string;
  reasonCode: ChannelHealthReason;
  fingerprint: string;
  outcome: "success" | "failure";
  occurredAt: string;
}>;
export type ChannelHealthReasonGeneration = Readonly<{
  reasonCode: ChannelHealthReason;
  generation: number;
  fingerprint: string;
  state: "closed" | "degraded" | "failing";
  consecutiveFailures: number;
  trailingFailures: number;
  opening: Readonly<{ sourceWorkId: string; sourceAttempt: number; occurredAt: string }>;
  lastOccurredAt: string;
}>;
export type ChannelHealthSnapshot = Readonly<{
  policyRevision: string;
  evaluationGeneration: number;
  state: ChannelHealthState;
  reasons: readonly ChannelHealthReasonGeneration[];
  observedAt: string | null;
}>;
export type ChannelHealthRead = Readonly<{
  schemaVersion: "ChannelHealthRead/v1";
  connection: Readonly<{ connectionId: string; accountId: string; status: ChannelConnectionStatus | null }>;
  health: ChannelHealthSnapshot;
  policyAvailable: boolean;
  systemPaused: boolean;
  outboundPublicationAllowed: boolean;
  pollingAllowed: boolean;
  verifiedInboundSaleAllowed: boolean;
}>;
export type ChannelHealthChanged = Readonly<{
  schemaVersion: "ChannelHealthChanged/v1";
  connection: Readonly<{ connectionId: string; accountId: string }>;
  reasonCode: ChannelHealthReason;
  generation: number;
  diagnosticCode: "reason-opened" | "reason-failing" | "reason-closed";
  observedAt: string;
}>;
export type ChannelHealthQuery = Readonly<{ connectionId: string; accountId: string }>;
export type ChannelHealthSubmission = Readonly<{
  outcome: "accepted" | "replayed" | "stale" | "inert" | "conflicting-terminal" | "policy-unavailable";
  health: ChannelHealthRead;
}>;
export type ConnectionHealthServices = Readonly<{
  submitObservation: (input: ChannelHealthObservation, context: EventStoreContext) => Promise<ChannelHealthSubmission>;
  readConnectionHealth: (input: ChannelHealthQuery) => Promise<ChannelHealthRead>;
  listOpenReasonGenerations: (input: ChannelHealthQuery) => Promise<readonly ChannelHealthReasonGeneration[]>;
}>;

export class ChannelHealthError extends Error {
  constructor(readonly code: "invalid-health-contract" | "connection-not-found" | "health-write-conflict") {
    super(code);
    this.name = "ChannelHealthError";
  }
}
