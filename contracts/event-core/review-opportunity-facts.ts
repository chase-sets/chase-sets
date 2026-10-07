export const reviewOpportunityFactType = "marketplace.review-opportunity.changed.v1" as const;

export type ReviewOpportunitySlot = Readonly<{
  authorRole: "buyer" | "seller";
  eligibleAt: string;
  effectiveDeadlineAt: string;
  submissionState: "allowed" | "held" | "expired";
  held: boolean;
  activeReviewId: string | null;
  activeReviewRevealedAt: string | null;
}>;

export type ReviewOpportunityProvenance = Readonly<{
  ordering: string;
  fulfillment: string;
  support: string;
  marketplace: string;
}>;

export type ReviewOpportunityChangedV1 = Readonly<{
  factSchemaVersion: 1;
  orderId: string;
  buyerAccountId: string;
  sellerAccountId: string;
  generation: string;
  sourceGeneration: string;
  provenance: ReviewOpportunityProvenance;
  generatedAt: string;
  buyerToSeller: ReviewOpportunitySlot | null;
  sellerToBuyer: ReviewOpportunitySlot | null;
}>;

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function isReviewOpportunityPosition(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function slot(value: unknown, role: "buyer" | "seller"): value is ReviewOpportunitySlot | null {
  if (value === null) return true;
  return (
    closed(value, [
      "authorRole",
      "eligibleAt",
      "effectiveDeadlineAt",
      "submissionState",
      "held",
      "activeReviewId",
      "activeReviewRevealedAt",
    ]) &&
    value.authorRole === role &&
    instant(value.eligibleAt) &&
    instant(value.effectiveDeadlineAt) &&
    typeof value.submissionState === "string" &&
    ["allowed", "held", "expired"].includes(value.submissionState) &&
    typeof value.held === "boolean" &&
    (value.activeReviewId === null || text(value.activeReviewId)) &&
    (value.activeReviewRevealedAt === null || (value.activeReviewId !== null && instant(value.activeReviewRevealedAt)))
  );
}

export function isReviewOpportunityChangedV1(value: unknown): value is ReviewOpportunityChangedV1 {
  return (
    closed(value, [
      "factSchemaVersion",
      "orderId",
      "buyerAccountId",
      "sellerAccountId",
      "generation",
      "sourceGeneration",
      "provenance",
      "generatedAt",
      "buyerToSeller",
      "sellerToBuyer",
    ]) &&
    value.factSchemaVersion === 1 &&
    text(value.orderId) &&
    text(value.buyerAccountId) &&
    text(value.sellerAccountId) &&
    isReviewOpportunityPosition(value.generation) &&
    value.generation !== "0" &&
    text(value.sourceGeneration) &&
    closed(value.provenance, ["ordering", "fulfillment", "support", "marketplace"]) &&
    Object.values(value.provenance).every(isReviewOpportunityPosition) &&
    instant(value.generatedAt) &&
    slot(value.buyerToSeller, "buyer") &&
    slot(value.sellerToBuyer, "seller")
  );
}
