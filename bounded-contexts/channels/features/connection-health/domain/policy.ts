import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import { decodeChannelHealthPolicy } from "./codecs";
import type { ChannelHealthReason } from "./contracts";

// #7350/5483791378: controller-owned engineering law, not a provider limit.
export const channelHealthPolicy = definePolicy({
  policyKey: "channels.connection-health",
  contextName: "channels",
  schemaSummary:
    "channels.connection-health/v1: { windowSeconds, consecutiveFailureThreshold, failureBudgetCount }: integers 1..2592000",
  defaultValue: { windowSeconds: 900, consecutiveFailureThreshold: 3, failureBudgetCount: 5 },
  decodeValue: decodeChannelHealthPolicy,
});

// #7328 A.7 / #7330/5610796742. The downstream liveness slice owns its producer and reason admission.
export function consecutiveFailureThreshold(
  reason: ChannelHealthReason | "connector-liveness",
  configured: number,
): number {
  return reason === "connector-liveness" ? 1 : configured;
}
