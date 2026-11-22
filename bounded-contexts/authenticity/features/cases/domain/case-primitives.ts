import type { AccountId, OrderId, TypedUlid } from "@chase-sets/primitives/typed-ids";

export type AuthenticityCaseId = TypedUlid<"case">;

export const authenticityCaseStatuses = [
  "awaiting-inbound",
  "received",
  "inspecting",
  "passed",
  "failed",
  "inconclusive",
  "forwarded",
  "returned",
] as const;

export type AuthenticityCaseStatus = (typeof authenticityCaseStatuses)[number];

export const authenticityVerdicts = ["passed", "failed", "inconclusive"] as const;

export type AuthenticityVerdict = (typeof authenticityVerdicts)[number];

export const authenticityVerdictReasonCodes = [
  "identity-mismatch",
  "condition-mismatch",
  "cert-mismatch",
  "counterfeit",
  "damage-in-transit",
  "inconclusive",
] as const;

export type AuthenticityVerdictReasonCode = (typeof authenticityVerdictReasonCodes)[number];

export type AuthenticityChecklistResult = Readonly<{
  checkName: string;
  result: "pass" | "fail" | "not-applicable";
  notes: string | null;
}>;

export type AuthenticityOrderLineNote = Readonly<{
  orderLineId: string;
  note: string;
}>;

/**
 * Opaque order/listing snapshot reference captured when the case is opened.
 * The authenticity context judges against this snapshot; it does not own or
 * mutate catalog, listing, or order state.
 */
export type AuthenticityOrderSnapshotRef = Readonly<{
  orderId: OrderId;
  listingId: string;
  catalogItemId: string;
  expectedConditionLabel: string;
}>;

/**
 * Opaque reference to the fee/opt-in decision recorded at checkout. The
 * authenticity context does not own fee policy; it only carries the
 * reference so a case can be traced back to the commercial decision that
 * created it.
 */
export type AuthenticityPlanRef = Readonly<{
  planId: string;
  feeAmount: string;
  feeCurrency: string;
}>;

export class AuthenticityDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AuthenticityDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new AuthenticityDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new AuthenticityDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function normalizeLabel(value: string): string {
  return value.trim();
}

export function normalizeOptionalText(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export type AuthenticityCaseActorRef = Readonly<{
  sellerAccountId: AccountId;
  buyerAccountId: AccountId;
}>;
