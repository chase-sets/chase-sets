import { centsToMoneyAmount, tryMoneyToCents } from "@chase-sets/primitives/money";
import type { AffectedLineItemAmountInput } from "@chase-sets/primitives/affected-line-item-amount";
import type { AccountId, OrderId, SupportRequestId } from "@chase-sets/primitives/typed-ids";

export type SupportRequestStatus =
  | "open"
  | "waiting-on-buyer"
  | "waiting-on-seller"
  | "ready-for-support"
  | "resolved"
  | "closed"
  | "cancelled";

export type SupportRequesterRole = "buyer" | "seller" | "support";

export type SupportPriority = "normal" | "urgent";

export type SupportFlowType =
  | "product-not-received"
  | "product-not-as-described"
  | "product-damaged"
  | "wrong-product-received"
  | "missing-products"
  | "authenticity-concern"
  | "return-request"
  | "buyer-cancel-request"
  | "seller-cannot-fulfill"
  | "refund-status"
  | "shipping-label-or-tracking"
  | "payment-problem";

export type SupportEvidenceType =
  | "buyer-attestation"
  | "seller-attestation"
  | "seller-condition-attestation"
  | "tracking-status"
  | "tracking-number"
  | "delivery-confirmation"
  | "return-delivery-confirmation"
  | "photo"
  | "unboxing-photo"
  | "return-discrepancy-photo"
  | "condition-notes"
  | "missing-quantity"
  | "authenticity-notes"
  | "return-reason"
  | "carrier-claim"
  | "refund-reference"
  | "payment-error"
  | "support-note";

export type SupportResponseType =
  | "provide-tracking"
  | "accept-return"
  | "offer-partial-refund"
  | "offer-replacement"
  | "issue-refund"
  | "challenge-with-evidence"
  | "confirm-cancellation"
  | "confirm-cannot-fulfill"
  | "request-support-review";

export type SupportResolutionType =
  | "full-refund"
  | "partial-refund"
  | "return-for-refund"
  | "replacement"
  | "cancel-order"
  | "no-action"
  | "support-reviewed";

export type SupportResponsibility = "seller" | "buyer" | "carrier" | "platform" | "shared" | "undetermined";

export type SupportEvidenceBasisType =
  | "party-accepted-resolution"
  | "deterministic-policy"
  | "operator-finding"
  | "insufficient-evidence"
  | "legacy";

export type SupportEvidenceBasis = Readonly<{
  type: SupportEvidenceBasisType;
  /** Stable offer, policy/rule, operator workflow, or compatibility reference. */
  reference: string;
}>;

/** Flow-prefixed, stable machine-readable cause selected from Support's catalog. */
export type SupportResponsibilityReasonCode = `${SupportFlowType}.${string}`;

export type SupportResponsibilityFact = Readonly<{
  responsibility: SupportResponsibility;
  evidenceBasis: SupportEvidenceBasis;
  responsibilityReasonCode: SupportResponsibilityReasonCode;
}>;

export type SupportOfferStatus = "pending" | "accepted" | "declined";

export type SupportAffectedLineItemAmount = AffectedLineItemAmountInput;

/**
 * Lifecycle of the money gate on a `return-for-refund` resolution: the
 * resolution decides the buyer gets a refund, but the refund itself waits
 * for the returned item to come back. `null` for every resolution type
 * other than `return-for-refund`.
 */
export type SupportReturnRefundGateStatus =
  | "awaiting-return-delivery"
  | "awaiting-return-inspection"
  | "return-condition-disputed"
  | "return-refund-released";

export type SupportChecklistItem = Readonly<{
  key: string;
  label: string;
  ownerRole: SupportRequesterRole;
  evidenceTypes: readonly SupportEvidenceType[];
  required: boolean;
  satisfiedAt: string | null;
}>;

export type SupportEvidence = Readonly<{
  evidenceId: string;
  submittedByAccountId: AccountId | null;
  submittedByRole: SupportRequesterRole;
  evidenceType: SupportEvidenceType;
  summary: string;
  occurredAt: string | null;
  submittedAt: string;
  attachments: readonly string[];
}>;

export type SupportResponse = Readonly<{
  responseId: string;
  responseType: SupportResponseType;
  submittedByAccountId: AccountId | null;
  submittedByRole: SupportRequesterRole;
  summary: string;
  submittedAt: string;
  offerId: string | null;
}>;

export type SupportOffer = Readonly<{
  offerId: string;
  responseId: string;
  offeredByAccountId: AccountId | null;
  offeredByRole: SupportRequesterRole;
  pendingWithRole: SupportRequesterRole;
  responseType: SupportResponseType;
  resolutionType: SupportResolutionType;
  refundAmount: string | null;
  summary: string;
  offeredAt: string;
  status: SupportOfferStatus;
  decidedByAccountId: AccountId | null;
  decidedByRole: SupportRequesterRole | null;
  decidedAt: string | null;
  decisionSummary: string | null;
}>;

export type SupportResolution = Readonly<{
  resolutionType: SupportResolutionType;
  summary: string;
  refundAmount: string | null;
  resolvedByAccountId: AccountId | null;
  resolvedByRole: SupportRequesterRole | null;
  resolvedAt: string;
}> &
  SupportResponsibilityFact;

export type SupportOrderReturnContextLine = Readonly<{
  lineId: string;
  listingId: string;
  itemTitle: string;
  productSummary: string | null;
  quantity: number;
  gradedCard: Readonly<{
    gradingCompany: string;
    grade: string;
    certificationNumber: string | null;
  }> | null;
}>;

export type SupportReturnInvestigation = Readonly<{
  reason: "seller-condition-discrepancy";
  convertedAt: string;
}>;

export type SupportRequestSnapshot = Readonly<{
  supportRequestId: SupportRequestId;
  orderId: OrderId;
  orderTotalAmount: string;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  flowType: SupportFlowType;
  status: SupportRequestStatus;
  priority: SupportPriority;
  openedByAccountId: AccountId;
  openedByRole: SupportRequesterRole;
  openedAt: string;
  updatedAt: string;
  sellerResponseDueAt: string | null;
  supportReviewDueAt: string | null;
  sellerConditionAttestationDueAt: string | null;
  orderReturnContext: readonly SupportOrderReturnContextLine[];
  affectedLineItems: readonly SupportAffectedLineItemAmount[];
  returnInvestigation: SupportReturnInvestigation | null;
  checklist: readonly SupportChecklistItem[];
  evidence: readonly SupportEvidence[];
  responses: readonly SupportResponse[];
  offers: readonly SupportOffer[];
  pendingOffer: SupportOffer | null;
  resolution: SupportResolution | null;
  closedAt: string | null;
}>;

export class SupportDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SupportDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new SupportDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new SupportDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
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

export function normalizeIsoTimestamp(value: string, message: string): string {
  assert(!Number.isNaN(Date.parse(value)), message);
  return value;
}

export function normalizeMoneyAmount(value: string | null | undefined, fieldName = "Amount"): string | null {
  if (value === null || value === undefined || value.trim().length === 0) {
    return null;
  }

  const cents = tryMoneyToCents(value);
  assert(cents !== null, `${fieldName} must be a valid money amount.`);
  assert(cents >= 0n, `${fieldName} cannot be negative.`);
  return centsToMoneyAmount(cents);
}

export function normalizeCurrencyCode(value: string, fieldName = "Currency"): string {
  const normalized = value.trim().toLowerCase();
  assert(/^[a-z]{3}$/.test(normalized), `${fieldName} must be a three-letter currency code.`);
  return normalized;
}

export function normalizeRequesterRole(value: string): SupportRequesterRole {
  switch (value.trim()) {
    case "buyer":
      return "buyer";
    case "seller":
      return "seller";
    case "support":
      return "support";
    default:
      throw new SupportDomainError("Support requester role is not supported.");
  }
}

export function normalizePriority(value: string): SupportPriority {
  switch (value.trim()) {
    case "normal":
      return "normal";
    case "urgent":
      return "urgent";
    default:
      throw new SupportDomainError("Support priority is not supported.");
  }
}

export function normalizeFlowType(value: string): SupportFlowType {
  switch (value.trim()) {
    case "product-not-received":
    case "product-not-as-described":
    case "product-damaged":
    case "wrong-product-received":
    case "missing-products":
    case "authenticity-concern":
    case "return-request":
    case "buyer-cancel-request":
    case "seller-cannot-fulfill":
    case "refund-status":
    case "shipping-label-or-tracking":
    case "payment-problem":
      return value.trim() as SupportFlowType;
    default:
      throw new SupportDomainError("Support flow type is not supported.");
  }
}

export function normalizeEvidenceType(value: string): SupportEvidenceType {
  switch (value.trim()) {
    case "buyer-attestation":
    case "seller-attestation":
    case "seller-condition-attestation":
    case "tracking-status":
    case "tracking-number":
    case "delivery-confirmation":
    case "return-delivery-confirmation":
    case "photo":
    case "unboxing-photo":
    case "return-discrepancy-photo":
    case "condition-notes":
    case "missing-quantity":
    case "authenticity-notes":
    case "return-reason":
    case "carrier-claim":
    case "refund-reference":
    case "payment-error":
    case "support-note":
      return value.trim() as SupportEvidenceType;
    default:
      throw new SupportDomainError("Support evidence type is not supported.");
  }
}

export function normalizeResponseType(value: string): SupportResponseType {
  switch (value.trim()) {
    case "provide-tracking":
    case "accept-return":
    case "offer-partial-refund":
    case "offer-replacement":
    case "issue-refund":
    case "challenge-with-evidence":
    case "confirm-cancellation":
    case "confirm-cannot-fulfill":
    case "request-support-review":
      return value.trim() as SupportResponseType;
    default:
      throw new SupportDomainError("Support response type is not supported.");
  }
}

export function normalizeResolutionType(value: string): SupportResolutionType {
  switch (value.trim()) {
    case "full-refund":
    case "partial-refund":
    case "return-for-refund":
    case "replacement":
    case "cancel-order":
    case "no-action":
    case "support-reviewed":
      return value.trim() as SupportResolutionType;
    default:
      throw new SupportDomainError("Support resolution type is not supported.");
  }
}

export function normalizeAttachments(value: readonly string[] | undefined): readonly string[] {
  return [...new Set((value ?? []).map((entry) => entry.trim()).filter(Boolean))];
}
