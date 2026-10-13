import type { DomainEvent } from "@chase-sets/event-core";
import type { RepricingAnchorTrace, RepricingClampTrace, RepricingExhaustedAnchor } from "./evaluate";

export const repricingPolicyEvaluatedEventType = "pricing.repricing-policy.evaluated" as const;

export type RepricingRoundDirection = "up" | "down";

export type RepricingEvaluationSkipReason =
  | "within-tolerance"
  | "anchor-chain-exhausted"
  | "terminal-hold"
  | "terminal-pause"
  | "terminal-notify-only"
  | "currency-input-incomplete-or-mismatched"
  | "budget-exhausted"
  | "manual-edit-conflict"
  | "domain-no-op"
  | "policy-precondition-failed"
  | "spiral-breaker-frozen"
  | "resume-hysteresis"
  | "repause-cooldown"
  | "command-error"
  | "hopeless-forecast-hold";

export type RepricingGoalInputs = Readonly<{
  curveVersion: number | null;
  economicsResolved: number;
  economicsUnavailable: number;
}>;

export type RepricingPolicyListingTrace = Readonly<{
  listingId: string;
  currentPriceAmount: string;
  targetPriceAmount: string | null;
  ruleIndex: number;
  anchor: RepricingAnchorTrace | null;
  exhaustedAnchors: readonly RepricingExhaustedAnchor[];
  clamps: RepricingClampTrace;
  flags: readonly string[];
  frozenUntil?: string;
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
    /** Recorded when the policy reads the Demand Curve: its version, and this policy's Economics resolutions. */
    goalInputs?: RepricingGoalInputs;
    spiralBreaker?: Readonly<{ tripped: boolean; frozenUntil: string }>;
    signalToEvaluationLatencyMs: number;
    evaluatedAt: string;
  }>
>;
