import type { AccountId, OrderId, ReviewId } from "@chase-sets/primitives/typed-ids";

export type ReviewStatus = "active" | "withdrawn";
export type ReviewRole = "buyer" | "seller";

export type ReputationSummary = Readonly<{
  accountId: AccountId;
  averageRating: string | null;
  reviewCount: number;
  rating1Count: number;
  rating2Count: number;
  rating3Count: number;
  rating4Count: number;
  rating5Count: number;
  updatedAt: string | null;
}>;

export type ReviewSnapshot = Readonly<{
  reviewId: ReviewId;
  orderId: OrderId;
  authorAccountId: AccountId;
  subjectAccountId: AccountId;
  authorRole: ReviewRole;
  rating: number;
  feedback: string | null;
  status: ReviewStatus;
  submittedAt: string;
  updatedAt: string;
  withdrawnAt: string | null;
}>;

export class ReputationDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReputationDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ReputationDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new ReputationDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

export function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function ensureIsoTimestamp(value: string, message: string): string {
  assert(!Number.isNaN(Date.parse(value)), message);
  return value;
}

export function normalizeReviewStatus(value: string): ReviewStatus {
  switch (value.trim()) {
    case "active":
      return "active";
    case "withdrawn":
      return "withdrawn";
    default:
      throw new ReputationDomainError("Review status is not supported.");
  }
}

export function normalizeReviewRole(value: string): ReviewRole {
  switch (value.trim()) {
    case "buyer":
      return "buyer";
    case "seller":
      return "seller";
    default:
      throw new ReputationDomainError("Review role is not supported.");
  }
}

export function normalizeRating(value: number): number {
  assert(Number.isInteger(value), "Rating must be a whole number.");
  assert(value >= 1 && value <= 5, "Rating must be between 1 and 5.");
  return value;
}

export function normalizeFeedback(value?: string | null): string | null {
  const normalized = normalizeOptionalText(value);
  if (normalized === null) {
    return null;
  }

  assert(
    normalized.length <= 1000,
    "Feedback must be 1000 characters or fewer.",
  );

  return normalized;
}
