import type { ChannelConnectionStatus } from "../../connections/domain/contracts";
import {
  channelHealthReasons,
  type ChannelHealthState,
  type ChannelHealthReasonGeneration,
  type ChannelHealthPolicy,
  type ChannelHealthObservation,
} from "./contracts";
import { consecutiveFailureThreshold } from "./policy";

export function healthTransitionAllowed(status: ChannelConnectionStatus | null, health: ChannelHealthState): boolean {
  switch (status) {
    case "active":
    case "pending-setup":
      switch (health) {
        case "unknown":
        case "healthy":
        case "degraded":
        case "failing":
          return true;
        default:
          return false;
      }
    case "paused":
    case "disconnected":
    default:
      return false;
  }
}

export function healthAvailability(
  status: ChannelConnectionStatus | null,
  health: ChannelHealthState,
  policyAvailable: boolean,
) {
  const allowed = status === "active" && policyAvailable && (health === "healthy" || health === "degraded");
  return {
    systemPaused: health === "failing",
    outboundPublicationAllowed: allowed,
    pollingAllowed: allowed,
    // This describes an independently verified inbound observation, never verifies one itself.
    verifiedInboundSaleAllowed:
      status === "active" || status === "pending-setup" || status === "paused" || status === "disconnected",
  };
}

export function rollupHealth(reasons: readonly ChannelHealthReasonGeneration[]): ChannelHealthState {
  if (reasons.some((reason) => reason.state === "failing")) return "failing";
  if (reasons.some((reason) => reason.state === "degraded")) return "degraded";
  return channelHealthReasons.every((code) =>
    reasons.some((reason) => reason.reasonCode === code && reason.state === "closed"),
  )
    ? "healthy"
    : "unknown";
}

export function evaluateReason(
  reason: ChannelHealthReasonGeneration,
  policy: ChannelHealthPolicy,
): ChannelHealthReasonGeneration {
  if (reason.state === "closed" || reason.state === "failing") return reason;
  const failing =
    reason.consecutiveFailures >= consecutiveFailureThreshold(reason.reasonCode, policy.consecutiveFailureThreshold) ||
    reason.trailingFailures >= policy.failureBudgetCount;
  return { ...reason, state: failing ? "failing" : "degraded" };
}

export function observeReason(
  previous: ChannelHealthReasonGeneration | undefined,
  observation: ChannelHealthObservation,
  trailingFailures: number,
  policy: ChannelHealthPolicy,
): ChannelHealthReasonGeneration {
  const changed = previous?.fingerprint !== observation.fingerprint;
  const reason: ChannelHealthReasonGeneration = {
    reasonCode: observation.reasonCode,
    generation: changed ? (previous?.generation ?? 0) + 1 : previous.generation,
    fingerprint: observation.fingerprint,
    state:
      observation.outcome === "success" ? "closed" : !changed && previous.state === "failing" ? "failing" : "degraded",
    consecutiveFailures: observation.outcome === "success" ? 0 : (changed ? 0 : previous.consecutiveFailures) + 1,
    trailingFailures,
    opening:
      changed || (previous.state === "closed" && observation.outcome === "failure")
        ? {
            sourceWorkId: observation.sourceWorkId,
            sourceAttempt: observation.sourceAttempt,
            occurredAt: observation.occurredAt,
          }
        : previous.opening,
    lastOccurredAt: observation.occurredAt,
  };
  // A changed fingerprint cannot release an existing pause without a matching success.
  if (changed && previous?.state === "failing" && observation.outcome === "failure")
    return { ...reason, state: "failing" };
  return evaluateReason(reason, policy);
}
