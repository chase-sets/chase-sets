import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import { marketplaceReviewScoringPolicyVersion } from "@chase-sets/event-core/review-scoring-facts";
import { assert, ensureIsoTimestamp, type ReviewRole } from "./common";
import {
  decideReviewScoringForDirection,
  type ResolvedResponsibility,
  type ReviewScoringReasonCode,
  type ReviewScoringDisposition,
  type ReviewSupportRequestFact,
} from "./directional-review-disposition";

export const REVIEW_SCORING_POLICY_VERSION = marketplaceReviewScoringPolicyVersion;

export type ReviewScoringDecision = Readonly<{
  scoringDisposition: ReviewScoringDisposition;
  reasonCode: ReviewScoringReasonCode;
}>;

export type ReviewScoringOperationalSignal = "responsibility-missing" | "responsibility-unrecognized" | null;

type ReviewScoringSupportFact = Readonly<{
  supportRequestId: string;
  sourceStreamVersion: number;
  status: "open" | "resolved" | "cancelled";
  responsibility: string | null;
  resolutionType?: string | null;
  lifecycleAt: string;
}>;

export type ReviewScoringState = Readonly<{
  orderId: OrderId | null;
  supportFacts: Readonly<Record<string, ReviewScoringSupportFact>>;
  buyerToSeller: ReviewScoringDecision;
  sellerToBuyer: ReviewScoringDecision;
  operationalSignal: ReviewScoringOperationalSignal;
}>;

const normalCompletion: ReviewScoringDecision = {
  scoringDisposition: "included",
  reasonCode: "normal-completion",
};

export const initialReviewScoringState: ReviewScoringState = {
  orderId: null,
  supportFacts: {},
  buyerToSeller: normalCompletion,
  sellerToBuyer: normalCompletion,
  operationalSignal: null,
};

export type RecordReviewScoringSupportFactCommand = Readonly<{
  type: "RecordReviewScoringSupportFact";
  orderId: OrderId;
  supportRequestId: string;
  sourceStreamVersion: number;
  status: "open" | "resolved" | "cancelled";
  responsibility?: unknown;
  resolutionType?: string | null;
  lifecycleAt: string;
}>;

export type ReviewScoringCommand = RecordReviewScoringSupportFactCommand;

type ReviewScoringProjectedData = Readonly<{
  factSchemaVersion: 1;
  orderId: OrderId;
  policyVersion: typeof REVIEW_SCORING_POLICY_VERSION;
  supportFacts: readonly ReviewScoringSupportFact[];
  sourceFactVersions: readonly Readonly<{
    supportRequestId: string;
    sourceStreamVersion: number;
    status: ReviewScoringSupportFact["status"];
  }>[];
  buyerToSeller: ReviewScoringDecision;
  sellerToBuyer: ReviewScoringDecision;
  operationalSignal: ReviewScoringOperationalSignal;
  projectedAt: string;
}>;

export type ReviewScoringDispositionProjectedEvent = DomainEvent<
  "marketplace.review-scoring.disposition-projected.v1",
  ReviewScoringProjectedData
>;

export type ReviewScoringEvent = ReviewScoringDispositionProjectedEvent;

const recognizedResponsibilities = new Set(["seller", "buyer", "carrier", "platform", "shared", "undetermined"]);

function orderedSupportFacts(facts: ReviewScoringState["supportFacts"]): readonly ReviewScoringSupportFact[] {
  return Object.values(facts).sort((left, right) => left.supportRequestId.localeCompare(right.supportRequestId));
}

function toPolicyFacts(facts: readonly ReviewScoringSupportFact[]): readonly ReviewSupportRequestFact[] {
  return facts.map((fact) => ({
    status: fact.status,
    ...(fact.responsibility !== undefined ? { responsibility: fact.responsibility } : {}),
    resolvedAt: fact.status === "resolved" ? fact.lifecycleAt : null,
    resolutionType: fact.resolutionType ?? null,
  }));
}

function operationalSignal(facts: readonly ReviewScoringSupportFact[]): ReviewScoringOperationalSignal {
  const resolved = facts.filter((fact) => fact.status === "resolved");
  if (
    resolved.some(
      (fact) => typeof fact.responsibility === "string" && !recognizedResponsibilities.has(fact.responsibility),
    )
  ) {
    return "responsibility-unrecognized";
  }
  return resolved.some((fact) => fact.responsibility === null || fact.responsibility === undefined)
    ? "responsibility-missing"
    : null;
}

function scoringDecision(reviewerRole: ReviewRole, facts: readonly ReviewScoringSupportFact[]): ReviewScoringDecision {
  if (facts.some((fact) => fact.status === "open")) {
    return { scoringDisposition: "context-only", reasonCode: "support-request-open" };
  }

  const resolvedFacts = toPolicyFacts(facts).filter((fact) => fact.status === "resolved");
  const normalized = resolvedFacts.map((fact) => {
    const responsibilityMissing = fact.responsibility === null || fact.responsibility === undefined;
    const recognized =
      responsibilityMissing ||
      (typeof fact.responsibility === "string" && recognizedResponsibilities.has(fact.responsibility));
    return {
      responsibility: responsibilityMissing
        ? "undetermined"
        : recognized
          ? (fact.responsibility as ResolvedResponsibility)
          : null,
      responsibilityRecognized: recognized,
      resolvedAt: fact.resolvedAt,
      resolutionType: fact.resolutionType ?? null,
    };
  });
  return decideReviewScoringForDirection(reviewerRole, normalized);
}

export const decideReviewScoring: AggregateDecider<ReviewScoringState, ReviewScoringCommand, ReviewScoringEvent> = (
  state,
  command,
) => {
  const existing = state.supportFacts[command.supportRequestId];
  assert(
    Number.isInteger(command.sourceStreamVersion) && command.sourceStreamVersion > 0,
    "Review scoring source stream version must be a positive integer.",
  );
  if (existing && existing.sourceStreamVersion >= command.sourceStreamVersion) {
    return [];
  }

  const lifecycleAt = ensureIsoTimestamp(command.lifecycleAt, "Review scoring facts must record a timestamp.");
  const nextFact: ReviewScoringSupportFact = {
    supportRequestId: command.supportRequestId,
    sourceStreamVersion: command.sourceStreamVersion,
    status: command.status,
    responsibility:
      typeof command.responsibility === "string"
        ? command.responsibility
        : command.responsibility === null || command.responsibility === undefined
          ? null
          : "unrecognized-non-text-responsibility",
    resolutionType: command.resolutionType ?? null,
    lifecycleAt,
  };
  const supportFacts = orderedSupportFacts({ ...state.supportFacts, [command.supportRequestId]: nextFact });

  return [
    {
      type: "marketplace.review-scoring.disposition-projected.v1",
      data: {
        factSchemaVersion: 1,
        orderId: command.orderId,
        policyVersion: REVIEW_SCORING_POLICY_VERSION,
        supportFacts,
        sourceFactVersions: supportFacts.map((fact) => ({
          supportRequestId: fact.supportRequestId,
          sourceStreamVersion: fact.sourceStreamVersion,
          status: fact.status,
        })),
        buyerToSeller: scoringDecision("buyer", supportFacts),
        sellerToBuyer: scoringDecision("seller", supportFacts),
        operationalSignal: operationalSignal(supportFacts),
        projectedAt: lifecycleAt,
      },
    },
  ];
};

export const evolveReviewScoring: AggregateEvolver<ReviewScoringState, ReviewScoringEvent> = (_state, event) => ({
  orderId: event.data.orderId,
  supportFacts: Object.fromEntries(event.data.supportFacts.map((fact) => [fact.supportRequestId, fact])),
  buyerToSeller: event.data.buyerToSeller,
  sellerToBuyer: event.data.sellerToBuyer,
  operationalSignal: event.data.operationalSignal,
});

export function reviewScoringForAuthorRole(state: ReviewScoringState, authorRole: ReviewRole): ReviewScoringDecision {
  return authorRole === "buyer" ? state.buyerToSeller : state.sellerToBuyer;
}
