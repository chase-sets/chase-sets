import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import { decodeChannelHealthPolicy } from "./codecs";
import type { ChannelHealthReason } from "./contracts";

// Controller-owned engineering law, not a provider limit.
export const channelHealthPolicy = definePolicy({
  policyKey: "channels.connection-health",
  contextName: "channels",
  schemaSummary:
    "channels.connection-health/v1: { windowSeconds, consecutiveFailureThreshold, failureBudgetCount }: integers 1..2592000",
  defaultValue: { windowSeconds: 900, consecutiveFailureThreshold: 3, failureBudgetCount: 5 },
  decodeValue: decodeChannelHealthPolicy,
});

// The downstream liveness slice owns its producer and reason admission.
export function consecutiveFailureThreshold(
  reason: ChannelHealthReason | "connector-liveness",
  configured: number,
): number {
  return reason === "connector-liveness" ? 1 : configured;
}
