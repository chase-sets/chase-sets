import type { BuyerRemedyKind } from "@chase-sets/primitives/platform-coverage";
import type { CoverageId, RemedyId } from "@chase-sets/primitives/typed-ids";
import { addReviewWindowDays, ensureIsoTimestamp, REVIEW_WINDOW_DAYS, type ReviewRole } from "./common";

export type ResolvedResponsibility = "seller" | "buyer" | "carrier" | "platform" | "shared" | "undetermined";

export type ReviewRemedyReference = Readonly<{
  remedyId: RemedyId;
  coverageId: CoverageId | null;
  kind: BuyerRemedyKind;
}>;

export type ReviewSupportRequestFact = Readonly<{
  status: string;
  responsibility?: unknown;
  resolvedAt: string | null;
  resolutionType?: string | null;
  /** ADR 0022 correlation only. Remedy and coverage never determine scoring. */
  remedy?: ReviewRemedyReference | null;
}>;

export type ReviewScoringDisposition = "included" | "context-only";
export type ReviewSubmissionState = "allowed" | "held" | "expired" | "ineligible";
export type ReviewVisibilityState = "double-blind-pending" | "held" | "revealed" | "suppressed";

export type ReviewDispositionReasonCode =
  | "normal-completion"
  | "subject-responsible"
  | "reviewer-responsible"
  | "external-responsibility"
  | "non-directional-responsibility"
  | "responsibility-undetermined"
  | "responsibility-unrecognized"
  | "multiple-responsibilities"
  | "seller-responsible-cancellation"
  | "cancellation-not-reviewable"
  | "support-request-open"
  | "submission-window-expired"
  | "transaction-not-completed";

export type ReviewScoringReasonCode = Exclude<
  ReviewDispositionReasonCode,
  "cancellation-not-reviewable" | "submission-window-expired" | "transaction-not-completed"
>;

type PublishableReviewVisibilityState = Exclude<ReviewVisibilityState, "held">;

type EligibleReviewDispositionBase = Readonly<{
  transactionEligibility: "eligible";
  eligibleAt: string;
  effectiveDeadline: string;
  scoringDisposition: ReviewScoringDisposition;
  reasonCode: ReviewDispositionReasonCode;
}>;

export type AllowedReviewDisposition = EligibleReviewDispositionBase &
  Readonly<{
    submissionState: "allowed";
    visibilityState: PublishableReviewVisibilityState;
  }>;

export type HeldReviewDisposition = EligibleReviewDispositionBase &
  Readonly<{
    submissionState: "held";
    visibilityState: "held" | "suppressed";
    scoringDisposition: "context-only";
    reasonCode: "support-request-open" | "responsibility-unrecognized";
  }>;

export type ExpiredReviewDisposition = EligibleReviewDispositionBase &
  Readonly<{
    submissionState: "expired";
    visibilityState: PublishableReviewVisibilityState;
    reasonCode: "submission-window-expired";
  }>;

export type IneligibleReviewDisposition = Readonly<{
  transactionEligibility: "ineligible";
  submissionState: "ineligible";
  visibilityState: "suppressed";
  scoringDisposition: "context-only";
  reasonCode: "transaction-not-completed" | "cancellation-not-reviewable" | "responsibility-unrecognized";
  eligibleAt: null;
  effectiveDeadline: null;
}>;

export type DirectionalReviewDisposition =
  | AllowedReviewDisposition
  | HeldReviewDisposition
  | ExpiredReviewDisposition
  | IneligibleReviewDisposition;

export type DirectionalReviewPolicyDecision = Readonly<{
  buyerToSeller: DirectionalReviewDisposition;
  sellerToBuyer: DirectionalReviewDisposition;
}>;

export type DirectionalReviewPolicyInput = Readonly<{
  deliveredAt: string | null;
  cancelledAt: string | null;
  evaluatedAt: string;
  supportRequests: readonly ReviewSupportRequestFact[];
  visibilityStates?: Readonly<{
    buyerToSeller?: PublishableReviewVisibilityState;
    sellerToBuyer?: PublishableReviewVisibilityState;
  }>;
}>;

export type ResolvedResponsibilityFact = Readonly<{
  responsibility: ResolvedResponsibility | null;
  responsibilityRecognized: boolean;
  resolvedAt: string | null;
  resolutionType: string | null;
}>;

const resolvedResponsibilities: readonly ResolvedResponsibility[] = [
  "seller",
  "buyer",
  "carrier",
  "platform",
  "shared",
  "undetermined",
];

function normalizeResolvedResponsibility(value: unknown): ResolvedResponsibility | null {
  return typeof value === "string" && resolvedResponsibilities.includes(value as ResolvedResponsibility)
    ? (value as ResolvedResponsibility)
    : null;
}

function normalizeResolvedFacts(
  supportRequests: readonly ReviewSupportRequestFact[],
): readonly ResolvedResponsibilityFact[] {
  return supportRequests
    .filter((request) => request.status === "resolved")
    .map((request) => {
      const normalizedResponsibility = normalizeResolvedResponsibility(request.responsibility);
      const responsibilityMissing = request.responsibility === null || request.responsibility === undefined;
      return {
        responsibility: responsibilityMissing ? "undetermined" : normalizedResponsibility,
        responsibilityRecognized: responsibilityMissing || normalizedResponsibility !== null,
        resolvedAt:
          request.resolvedAt !== null && !Number.isNaN(Date.parse(request.resolvedAt)) ? request.resolvedAt : null,
        resolutionType: request.resolutionType ?? null,
      };
    });
}

function laterTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function decideReviewScoringForDirection(
  reviewerRole: ReviewRole,
  resolvedFacts: readonly ResolvedResponsibilityFact[],
): Readonly<{ scoringDisposition: ReviewScoringDisposition; reasonCode: ReviewScoringReasonCode }> {
  if (resolvedFacts.length === 0) {
    return { scoringDisposition: "included", reasonCode: "normal-completion" };
  }

  if (resolvedFacts.some((fact) => !fact.responsibilityRecognized || fact.responsibility === null)) {
    return { scoringDisposition: "context-only", reasonCode: "responsibility-unrecognized" };
  }

  const responsibilities = resolvedFacts.map((fact) => fact.responsibility as ResolvedResponsibility);
  const uniqueResponsibilities = new Set(responsibilities);
  if (uniqueResponsibilities.size > 1) {
    return { scoringDisposition: "context-only", reasonCode: "multiple-responsibilities" };
  }

  const responsibility = responsibilities[0]!;
  const subjectRole: ReviewRole = reviewerRole === "buyer" ? "seller" : "buyer";
  if (responsibility === subjectRole) {
    return { scoringDisposition: "included", reasonCode: "subject-responsible" };
  }
  if (responsibility === reviewerRole) {
    return { scoringDisposition: "context-only", reasonCode: "reviewer-responsible" };
  }
  if (responsibility === "carrier" || responsibility === "platform") {
    return { scoringDisposition: "context-only", reasonCode: "external-responsibility" };
  }
  if (responsibility === "shared") {
    return { scoringDisposition: "context-only", reasonCode: "non-directional-responsibility" };
  }
  return { scoringDisposition: "context-only", reasonCode: "responsibility-undetermined" };
}

function ineligibleDisposition(reasonCode: IneligibleReviewDisposition["reasonCode"]): IneligibleReviewDisposition {
  return {
    transactionEligibility: "ineligible",
    submissionState: "ineligible",
    visibilityState: "suppressed",
    scoringDisposition: "context-only",
    reasonCode,
    eligibleAt: null,
    effectiveDeadline: null,
  };
}

function decideDirection(
  params: Readonly<{
    reviewerRole: ReviewRole;
    eligibleAt: string | null;
    evaluatedAt: string;
    isHeld: boolean;
    hasUnrecognizedFact: boolean;
    resolvedFacts: readonly ResolvedResponsibilityFact[];
    visibilityState: PublishableReviewVisibilityState;
    sellerResponsibleCancellation: boolean;
    ineligibleReason: IneligibleReviewDisposition["reasonCode"];
  }>,
): DirectionalReviewDisposition {
  if (params.eligibleAt === null) {
    return ineligibleDisposition(params.hasUnrecognizedFact ? "responsibility-unrecognized" : params.ineligibleReason);
  }

  const scoring = decideReviewScoringForDirection(params.reviewerRole, params.resolvedFacts);
  const effectiveDeadline = addReviewWindowDays(params.eligibleAt, REVIEW_WINDOW_DAYS);
  if (params.isHeld || params.hasUnrecognizedFact) {
    return {
      transactionEligibility: "eligible",
      submissionState: "held",
      visibilityState: params.visibilityState === "suppressed" ? "suppressed" : "held",
      scoringDisposition: "context-only",
      reasonCode: params.hasUnrecognizedFact ? "responsibility-unrecognized" : "support-request-open",
      eligibleAt: params.eligibleAt,
      effectiveDeadline,
    };
  }

  if (Date.parse(params.evaluatedAt) >= Date.parse(effectiveDeadline)) {
    return {
      transactionEligibility: "eligible",
      submissionState: "expired",
      visibilityState: params.visibilityState,
      scoringDisposition: scoring.scoringDisposition,
      reasonCode: "submission-window-expired",
      eligibleAt: params.eligibleAt,
      effectiveDeadline,
    };
  }

  return {
    transactionEligibility: "eligible",
    submissionState: "allowed",
    visibilityState: params.visibilityState,
    scoringDisposition: scoring.scoringDisposition,
    reasonCode: params.sellerResponsibleCancellation ? "seller-responsible-cancellation" : scoring.reasonCode,
    eligibleAt: params.eligibleAt,
    effectiveDeadline,
  };
}

/**
 * Marketplace's canonical rating policy. Support contributes factual
 * responsibility only; remedies and evidence never enter this decision.
 *
 * Scoring-disposition persistence and hold-state transitions remain owned by
 * their dedicated review slices. The explicit states here let those slices
 * compose without reconstructing responsibility or permitting invalid state
 * combinations.
 */
export function decideDirectionalReviewDisposition(
  input: DirectionalReviewPolicyInput,
): DirectionalReviewPolicyDecision {
  const evaluatedAt = ensureIsoTimestamp(input.evaluatedAt, "Review disposition must record an evaluation timestamp.");
  const deliveredAt =
    input.deliveredAt === null
      ? null
      : ensureIsoTimestamp(input.deliveredAt, "Review disposition delivery must record a timestamp.");
  const cancelledAt =
    input.cancelledAt === null
      ? null
      : ensureIsoTimestamp(input.cancelledAt, "Review disposition cancellation must record a timestamp.");
  const resolvedFacts = normalizeResolvedFacts(input.supportRequests);
  const isHeld = input.supportRequests.some((request) => request.status === "open");
  const hasUnrecognizedFact =
    input.supportRequests.some(
      (request) => request.status !== "open" && request.status !== "resolved" && request.status !== "cancelled",
    ) || resolvedFacts.some((fact) => !fact.responsibilityRecognized || fact.resolvedAt === null);
  const isCancellation = cancelledAt !== null || resolvedFacts.some((fact) => fact.resolutionType === "cancel-order");
  const sellerResponsibilityEstablishedAt = resolvedFacts
    .filter(
      (fact) => fact.responsibility === "seller" && fact.resolutionType === "cancel-order" && fact.resolvedAt !== null,
    )
    .map((fact) => fact.resolvedAt as string)
    .sort()[0];
  const sellerResponsibleCancellation =
    cancelledAt !== null &&
    sellerResponsibilityEstablishedAt !== undefined &&
    resolvedFacts.every((fact) => fact.responsibility === "seller");
  const buyerEligibleAt = isCancellation
    ? sellerResponsibleCancellation
      ? laterTimestamp(cancelledAt, sellerResponsibilityEstablishedAt)
      : null
    : deliveredAt;
  const ineligibleReason = isCancellation ? "cancellation-not-reviewable" : "transaction-not-completed";

  return {
    buyerToSeller: decideDirection({
      reviewerRole: "buyer",
      eligibleAt: buyerEligibleAt,
      evaluatedAt,
      isHeld,
      hasUnrecognizedFact,
      resolvedFacts,
      visibilityState: input.visibilityStates?.buyerToSeller ?? "double-blind-pending",
      sellerResponsibleCancellation,
      ineligibleReason,
    }),
    sellerToBuyer: decideDirection({
      reviewerRole: "seller",
      eligibleAt: isCancellation ? null : deliveredAt,
      evaluatedAt,
      isHeld,
      hasUnrecognizedFact,
      resolvedFacts,
      visibilityState: input.visibilityStates?.sellerToBuyer ?? "double-blind-pending",
      sellerResponsibleCancellation: false,
      ineligibleReason,
    }),
  };
}
