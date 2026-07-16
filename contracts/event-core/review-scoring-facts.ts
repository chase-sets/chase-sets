export const marketplaceReviewScoringFactType = "marketplace.review-scoring.disposition-projected.v1" as const;
export const marketplaceReviewScoringPolicyVersion = "resolution-aware-v1" as const;

export const marketplaceReviewScoringDispositions = ["included", "context-only"] as const;
export type MarketplaceReviewScoringDisposition = (typeof marketplaceReviewScoringDispositions)[number];

export const marketplaceReviewScoringReasonCodes = [
  "normal-completion",
  "subject-responsible",
  "reviewer-responsible",
  "external-responsibility",
  "non-directional-responsibility",
  "responsibility-undetermined",
  "responsibility-unrecognized",
  "multiple-responsibilities",
  "seller-responsible-cancellation",
  "support-request-open",
] as const;
export type MarketplaceReviewScoringReasonCode = (typeof marketplaceReviewScoringReasonCodes)[number];

export type MarketplaceReviewScoringDecision = Readonly<{
  scoringDisposition: MarketplaceReviewScoringDisposition;
  reasonCode: MarketplaceReviewScoringReasonCode;
}>;

export type MarketplaceReviewScoringSourceFactVersion = Readonly<{
  supportRequestId: string;
  sourceStreamVersion: number;
  status: "open" | "resolved" | "cancelled";
}>;

export type MarketplaceReviewScoringDispositionProjectedV1Payload = Readonly<{
  factSchemaVersion: 1;
  orderId: string;
  policyVersion: typeof marketplaceReviewScoringPolicyVersion;
  supportFacts: readonly Readonly<{
    supportRequestId: string;
    sourceStreamVersion: number;
    status: "open" | "resolved" | "cancelled";
    responsibility: string | null;
    resolutionType?: string | null;
    lifecycleAt: string;
  }>[];
  sourceFactVersions: readonly MarketplaceReviewScoringSourceFactVersion[];
  buyerToSeller: MarketplaceReviewScoringDecision;
  sellerToBuyer: MarketplaceReviewScoringDecision;
  operationalSignal: "responsibility-missing" | "responsibility-unrecognized" | null;
  projectedAt: string;
}>;

export type MarketplaceReviewScoringSnapshot = MarketplaceReviewScoringDecision &
  Readonly<{
    policyVersion: string;
    sourceFactVersions: readonly MarketplaceReviewScoringSourceFactVersion[];
    operationalSignal: "responsibility-missing" | "responsibility-unrecognized" | "policy-version-unrecognized" | null;
  }>;

const contextOnlyUnknownPolicy: MarketplaceReviewScoringSnapshot = {
  scoringDisposition: "context-only",
  reasonCode: "responsibility-unrecognized",
  policyVersion: "unrecognized",
  sourceFactVersions: [],
  operationalSignal: "policy-version-unrecognized",
};

function isDecision(value: unknown): value is MarketplaceReviewScoringDecision {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    marketplaceReviewScoringDispositions.includes(
      candidate.scoringDisposition as MarketplaceReviewScoringDisposition,
    ) && marketplaceReviewScoringReasonCodes.includes(candidate.reasonCode as MarketplaceReviewScoringReasonCode)
  );
}

function sourceFactVersions(value: unknown): readonly MarketplaceReviewScoringSourceFactVersion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const fact = entry as Record<string, unknown>;
    if (
      typeof fact.supportRequestId !== "string" ||
      !Number.isInteger(fact.sourceStreamVersion) ||
      (fact.status !== "open" && fact.status !== "resolved" && fact.status !== "cancelled")
    ) {
      return [];
    }
    return [
      {
        supportRequestId: fact.supportRequestId,
        sourceStreamVersion: fact.sourceStreamVersion as number,
        status: fact.status,
      },
    ];
  });
}

export function normalizeMarketplaceReviewSubmittedScoring(data: object): MarketplaceReviewScoringSnapshot {
  const record = data as Readonly<Record<string, unknown>>;
  const hasScoringFields =
    record.scoringDisposition !== undefined ||
    record.scoringReasonCode !== undefined ||
    record.scoringPolicyVersion !== undefined;
  const decision = { scoringDisposition: record.scoringDisposition, reasonCode: record.scoringReasonCode };
  if (hasScoringFields) {
    if (record.scoringPolicyVersion !== marketplaceReviewScoringPolicyVersion || !isDecision(decision)) {
      return contextOnlyUnknownPolicy;
    }
    return {
      ...decision,
      policyVersion: marketplaceReviewScoringPolicyVersion,
      sourceFactVersions: sourceFactVersions(record.scoringSourceFactVersions),
      operationalSignal:
        record.scoringOperationalSignal === "responsibility-missing" ||
        record.scoringOperationalSignal === "responsibility-unrecognized"
          ? record.scoringOperationalSignal
          : null,
    };
  }

  if (record.resolutionContext !== undefined && record.resolutionContext !== null) {
    return {
      scoringDisposition: "context-only",
      reasonCode: "responsibility-undetermined",
      policyVersion: "legacy-unattributed-resolution-v0",
      sourceFactVersions: [],
      operationalSignal: "responsibility-missing",
    };
  }

  return {
    scoringDisposition: "included",
    reasonCode: "normal-completion",
    policyVersion: marketplaceReviewScoringPolicyVersion,
    sourceFactVersions: [],
    operationalSignal: null,
  };
}

export function normalizeMarketplaceReviewScoringFact(data: unknown): Readonly<{
  orderId: string;
  buyerToSeller: MarketplaceReviewScoringSnapshot;
  sellerToBuyer: MarketplaceReviewScoringSnapshot;
  projectedAt: string;
}> {
  if (!data || typeof data !== "object") throw new Error("Review scoring fact payload is required.");
  const candidate = data as Record<string, unknown>;
  if (typeof candidate.orderId !== "string" || typeof candidate.projectedAt !== "string") {
    throw new Error("Review scoring fact requires an order and projection timestamp.");
  }
  const recognized =
    candidate.factSchemaVersion === 1 && candidate.policyVersion === marketplaceReviewScoringPolicyVersion;
  const versions = sourceFactVersions(candidate.sourceFactVersions);
  const normalizeDirection = (value: unknown): MarketplaceReviewScoringSnapshot => {
    if (!recognized || !isDecision(value)) return contextOnlyUnknownPolicy;
    return {
      ...value,
      policyVersion: marketplaceReviewScoringPolicyVersion,
      sourceFactVersions: versions,
      operationalSignal:
        candidate.operationalSignal === "responsibility-missing" ||
        candidate.operationalSignal === "responsibility-unrecognized"
          ? candidate.operationalSignal
          : null,
    };
  };
  return {
    orderId: candidate.orderId,
    buyerToSeller: normalizeDirection(candidate.buyerToSeller),
    sellerToBuyer: normalizeDirection(candidate.sellerToBuyer),
    projectedAt: candidate.projectedAt,
  };
}
