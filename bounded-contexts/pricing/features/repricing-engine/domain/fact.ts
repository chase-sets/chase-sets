import type { DomainEvent } from "@chase-sets/event-core";
import type { RepricingAnchorTrace, RepricingClampTrace } from "./evaluate";

export const repricingPolicyEvaluatedEventType = "pricing.repricing-policy.evaluated" as const;

export type RepricingEvaluationSkipReason =
  | "within-tolerance"
  | "anchor-chain-exhausted"
  | "terminal-hold"
  | "terminal-pause"
  | "terminal-notify-only"
  | "budget-exhausted"
  | "manual-edit-conflict"
  | "domain-no-op"
  | "policy-precondition-failed"
  | "resume-hysteresis"
  | "repause-cooldown"
  | "command-error";

export type RepricingPolicyListingTrace = Readonly<{
  listingId: string;
  currentPriceAmount: string;
  targetPriceAmount: string | null;
  ruleIndex: number;
  anchor: RepricingAnchorTrace | null;
  exhaustedAnchors: readonly Readonly<{ source: string; state: "present" | "stale" | "absent" }>[];
  clamps: RepricingClampTrace;
  flags: readonly string[];
  outcome: "changed" | "skipped" | "pause-requested" | "notify-only";
  skipReason: RepricingEvaluationSkipReason | null;
}>;

export type RepricingPolicyEvaluatedEvent = DomainEvent<
  typeof repricingPolicyEvaluatedEventType,
  Readonly<{
    schemaVersion: 1;
    evaluationId: string;
    policyId: string;
    policyRevision: string;
    sellerAccountId: string;
    catalogItemId: string;
    productId: string;
    trigger: Readonly<{
      kind: "market-price-estimated" | "competing-ask-changed" | "daily-drift-sweep";
      eventId: string;
      signalVersion: string;
      occurredAt: string;
    }>;
    listingsEvaluated: number;
    listingsChanged: number;
    listingsSkipped: number;
    listings: readonly RepricingPolicyListingTrace[];
    signalToEvaluationLatencyMs: number;
    evaluatedAt: string;
  }>
>;
