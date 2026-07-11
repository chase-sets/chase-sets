import type {
  SupportChecklistItem,
  SupportEvidenceType,
  SupportFlowType,
  SupportRequesterRole,
  SupportResolutionType,
  SupportResponseType,
} from "./common";
import { SupportDomainError } from "./common";

export type SupportFlowDefinition = Readonly<{
  flowType: SupportFlowType;
  title: string;
  openedBy: readonly SupportRequesterRole[];
  initialStatus: "open" | "waiting-on-buyer" | "waiting-on-seller" | "ready-for-support";
  priority: "normal" | "urgent";
  sellerResponseHours: number | null;
  supportReviewHours: number | null;
  checklist: readonly Omit<SupportChecklistItem, "satisfiedAt">[];
  allowedEvidenceTypes: readonly SupportEvidenceType[];
  allowedResponses: readonly SupportResponseType[];
  allowedResolutions: readonly SupportResolutionType[];
  defaultResolution: SupportResolutionType;
  /**
   * Whether seller silence past `sellerResponseDueAt` auto-resolves the case
   * to `defaultResolution` with a system actor. `false` for flows whose
   * default requires a human-computed value (for example `partial-refund`,
   * which needs an amount no sweep can safely infer) or that never enter
   * `waiting-on-seller` in the first place; those escalate to
   * `ready-for-support` on deadline expiry instead.
   */
  autoResolvesOnSellerSilence: boolean;
  automationSummary: string;
}>;

const buyerAttestation = {
  key: "buyer-attestation",
  label: "Buyer confirms the issue in a structured support form.",
  ownerRole: "buyer",
  evidenceTypes: ["buyer-attestation"],
  required: true,
} as const;

const sellerAttestation = {
  key: "seller-response",
  label: "Seller responds with the requested structured action.",
  ownerRole: "seller",
  evidenceTypes: ["seller-attestation"],
  required: false,
} as const;

export const supportFlowCatalog = [
  {
    flowType: "product-not-received",
    title: "Product not received",
    openedBy: ["buyer"],
    initialStatus: "waiting-on-seller",
    priority: "normal",
    sellerResponseHours: 48,
    supportReviewHours: 24,
    checklist: [
      buyerAttestation,
      {
        key: "delivery-evidence",
        label: "Tracking or delivery evidence is attached or confirmed by the platform.",
        ownerRole: "seller",
        evidenceTypes: ["tracking-number", "tracking-status", "delivery-confirmation"],
        required: true,
      },
    ],
    allowedEvidenceTypes: [
      "buyer-attestation",
      "tracking-number",
      "tracking-status",
      "delivery-confirmation",
      "carrier-claim",
      "support-note",
    ],
    allowedResponses: [
      "provide-tracking",
      "issue-refund",
      "offer-replacement",
      "challenge-with-evidence",
      "request-support-review",
    ],
    allowedResolutions: ["full-refund", "replacement", "no-action", "support-reviewed"],
    defaultResolution: "full-refund",
    autoResolvesOnSellerSilence: true,
    automationSummary:
      "If delivery cannot be proven by the response deadline, the buyer is eligible for a full refund without additional buyer-seller messages.",
  },
  {
    flowType: "product-not-as-described",
    title: "Product not as described",
    openedBy: ["buyer"],
    initialStatus: "waiting-on-seller",
    priority: "normal",
    sellerResponseHours: 48,
    supportReviewHours: 24,
    checklist: [
      buyerAttestation,
      {
        key: "condition-evidence",
        label: "Buyer provides photos and condition notes.",
        ownerRole: "buyer",
        evidenceTypes: ["photo", "condition-notes"],
        required: true,
      },
      sellerAttestation,
    ],
    allowedEvidenceTypes: [
      "buyer-attestation",
      "photo",
      "unboxing-photo",
      "condition-notes",
      "seller-attestation",
      "support-note",
    ],
    allowedResponses: [
      "accept-return",
      "offer-partial-refund",
      "offer-replacement",
      "challenge-with-evidence",
      "request-support-review",
    ],
    allowedResolutions: ["return-for-refund", "partial-refund", "replacement", "no-action", "support-reviewed"],
    defaultResolution: "return-for-refund",
    autoResolvesOnSellerSilence: true,
    automationSummary:
      "Photos and condition notes replace open-ended negotiation; seller chooses return, partial refund, replacement, or evidence challenge. If the seller does not respond by the deadline, the buyer is eligible for a return-for-refund without additional buyer-seller messages.",
  },
  {
    flowType: "product-damaged",
    title: "Product arrived damaged",
    openedBy: ["buyer"],
    initialStatus: "waiting-on-seller",
    priority: "normal",
    sellerResponseHours: 48,
    supportReviewHours: 24,
    checklist: [
      buyerAttestation,
      {
        key: "damage-evidence",
        label: "Buyer provides item and package photos.",
        ownerRole: "buyer",
        evidenceTypes: ["photo", "unboxing-photo", "condition-notes"],
        required: true,
      },
      sellerAttestation,
    ],
    allowedEvidenceTypes: [
      "buyer-attestation",
      "photo",
      "unboxing-photo",
      "condition-notes",
      "carrier-claim",
      "seller-attestation",
      "support-note",
    ],
    allowedResponses: [
      "accept-return",
      "offer-partial-refund",
      "offer-replacement",
      "issue-refund",
      "challenge-with-evidence",
      "request-support-review",
    ],
    allowedResolutions: ["full-refund", "partial-refund", "return-for-refund", "replacement", "support-reviewed"],
    defaultResolution: "return-for-refund",
    autoResolvesOnSellerSilence: true,
    automationSummary:
      "Damage evidence and carrier claim data allow support to resolve without parties negotiating packaging details. If the seller does not respond by the deadline, the buyer is eligible for a return-for-refund without additional buyer-seller messages.",
  },
  {
    flowType: "wrong-product-received",
    title: "Wrong product received",
    openedBy: ["buyer"],
    initialStatus: "waiting-on-seller",
    priority: "normal",
    sellerResponseHours: 48,
    supportReviewHours: 24,
    checklist: [
      buyerAttestation,
      {
        key: "wrong-product-evidence",
        label: "Buyer provides photos of the received product.",
        ownerRole: "buyer",
        evidenceTypes: ["photo", "unboxing-photo"],
        required: true,
      },
      sellerAttestation,
    ],
    allowedEvidenceTypes: ["buyer-attestation", "photo", "unboxing-photo", "seller-attestation", "support-note"],
    allowedResponses: [
      "accept-return",
      "offer-replacement",
      "issue-refund",
      "challenge-with-evidence",
      "request-support-review",
    ],
    allowedResolutions: ["full-refund", "return-for-refund", "replacement", "support-reviewed"],
    defaultResolution: "replacement",
    autoResolvesOnSellerSilence: true,
    automationSummary:
      "The seller chooses replacement, refund, or evidence challenge from structured options. If the seller does not respond by the deadline, a replacement is issued without additional buyer-seller messages.",
  },
  {
    flowType: "missing-products",
    title: "Missing products",
    openedBy: ["buyer"],
    initialStatus: "waiting-on-seller",
    priority: "normal",
    sellerResponseHours: 48,
    supportReviewHours: 24,
    checklist: [
      buyerAttestation,
      {
        key: "missing-quantity",
        label: "Buyer identifies the missing quantity or missing line.",
        ownerRole: "buyer",
        evidenceTypes: ["missing-quantity", "photo"],
        required: true,
      },
      sellerAttestation,
    ],
    allowedEvidenceTypes: ["buyer-attestation", "missing-quantity", "photo", "seller-attestation", "support-note"],
    allowedResponses: [
      "offer-replacement",
      "offer-partial-refund",
      "issue-refund",
      "challenge-with-evidence",
      "request-support-review",
    ],
    allowedResolutions: ["partial-refund", "replacement", "full-refund", "support-reviewed"],
    defaultResolution: "partial-refund",
    autoResolvesOnSellerSilence: false,
    automationSummary:
      "Missing quantity is captured as structured evidence so support can calculate the remedy. If the seller does not respond by the deadline, the case moves to support review rather than resolving automatically, because the remedy amount needs to be calculated.",
  },
  {
    flowType: "authenticity-concern",
    title: "Authenticity concern",
    openedBy: ["buyer"],
    initialStatus: "ready-for-support",
    priority: "urgent",
    sellerResponseHours: 24,
    supportReviewHours: 12,
    checklist: [
      buyerAttestation,
      {
        key: "authenticity-evidence",
        label: "Buyer provides photos and authenticity notes.",
        ownerRole: "buyer",
        evidenceTypes: ["photo", "authenticity-notes"],
        required: true,
      },
    ],
    allowedEvidenceTypes: ["buyer-attestation", "photo", "authenticity-notes", "seller-attestation", "support-note"],
    allowedResponses: ["challenge-with-evidence", "accept-return", "request-support-review"],
    allowedResolutions: ["return-for-refund", "full-refund", "no-action", "support-reviewed"],
    defaultResolution: "support-reviewed",
    autoResolvesOnSellerSilence: false,
    automationSummary:
      "Authenticity concerns go straight to support review with seller response captured through evidence, not direct debate.",
  },
  {
    flowType: "return-request",
    title: "Return request",
    openedBy: ["buyer"],
    initialStatus: "waiting-on-seller",
    priority: "normal",
    sellerResponseHours: 48,
    supportReviewHours: 24,
    checklist: [
      {
        key: "return-reason",
        label: "Buyer selects a return reason.",
        ownerRole: "buyer",
        evidenceTypes: ["return-reason"],
        required: true,
      },
      {
        key: "return-condition-evidence",
        label: "Buyer provides photos of the item as received and condition notes.",
        ownerRole: "buyer",
        evidenceTypes: ["photo", "condition-notes"],
        required: true,
      },
      sellerAttestation,
    ],
    allowedEvidenceTypes: [
      "return-reason",
      "photo",
      "condition-notes",
      "return-delivery-confirmation",
      "seller-attestation",
      "seller-condition-attestation",
      "return-discrepancy-photo",
      "support-note",
    ],
    allowedResponses: ["accept-return", "offer-partial-refund", "challenge-with-evidence", "request-support-review"],
    allowedResolutions: ["return-for-refund", "partial-refund", "no-action", "support-reviewed"],
    defaultResolution: "return-for-refund",
    autoResolvesOnSellerSilence: true,
    automationSummary:
      "Return reasons, photos, condition notes, and seller receipt attestation are captured before refund release. If the seller does not respond by the deadline and the buyer's return evidence checklist is complete, the return is resolved automatically; otherwise the case moves to support review.",
  },
  {
    flowType: "buyer-cancel-request",
    title: "Buyer cancellation request",
    openedBy: ["buyer", "support"],
    initialStatus: "waiting-on-seller",
    priority: "normal",
    sellerResponseHours: 24,
    supportReviewHours: 24,
    checklist: [buyerAttestation, sellerAttestation],
    allowedEvidenceTypes: ["buyer-attestation", "seller-attestation", "support-note"],
    allowedResponses: ["confirm-cancellation", "challenge-with-evidence", "request-support-review"],
    allowedResolutions: ["cancel-order", "no-action", "support-reviewed"],
    defaultResolution: "cancel-order",
    autoResolvesOnSellerSilence: true,
    automationSummary:
      "If the order has not shipped, cancellation can be confirmed through structured seller action. If the seller does not respond by the deadline, the cancellation is confirmed automatically.",
  },
  {
    flowType: "seller-cannot-fulfill",
    title: "Seller cannot fulfill",
    openedBy: ["seller", "support"],
    initialStatus: "ready-for-support",
    priority: "urgent",
    sellerResponseHours: null,
    supportReviewHours: 12,
    checklist: [
      {
        key: "seller-cannot-fulfill",
        label: "Seller confirms the order cannot be fulfilled.",
        ownerRole: "seller",
        evidenceTypes: ["seller-attestation"],
        required: true,
      },
    ],
    allowedEvidenceTypes: ["seller-attestation", "support-note"],
    allowedResponses: ["confirm-cannot-fulfill", "issue-refund", "request-support-review"],
    allowedResolutions: ["cancel-order", "full-refund", "support-reviewed"],
    defaultResolution: "full-refund",
    autoResolvesOnSellerSilence: false,
    automationSummary:
      "Seller fulfillment failures move directly to support so buyer refund and inventory cleanup are not delayed.",
  },
  {
    flowType: "refund-status",
    title: "Refund status",
    openedBy: ["buyer", "seller", "support"],
    initialStatus: "ready-for-support",
    priority: "normal",
    sellerResponseHours: null,
    supportReviewHours: 24,
    checklist: [
      {
        key: "refund-reference",
        label: "Refund reference or prior support request is attached when available.",
        ownerRole: "support",
        evidenceTypes: ["refund-reference"],
        required: false,
      },
    ],
    allowedEvidenceTypes: ["refund-reference", "payment-error", "support-note"],
    allowedResponses: ["request-support-review"],
    allowedResolutions: ["support-reviewed", "no-action"],
    defaultResolution: "support-reviewed",
    autoResolvesOnSellerSilence: false,
    automationSummary: "Refund status is owned by support and payment data, avoiding buyer-seller back and forth.",
  },
  {
    flowType: "shipping-label-or-tracking",
    title: "Shipping label or tracking problem",
    openedBy: ["seller", "support"],
    initialStatus: "ready-for-support",
    priority: "normal",
    sellerResponseHours: null,
    supportReviewHours: 24,
    checklist: [
      {
        key: "tracking-problem",
        label: "Seller provides the tracking or label problem details.",
        ownerRole: "seller",
        evidenceTypes: ["tracking-number", "tracking-status", "seller-attestation"],
        required: true,
      },
    ],
    allowedEvidenceTypes: ["tracking-number", "tracking-status", "seller-attestation", "support-note"],
    allowedResponses: ["provide-tracking", "request-support-review"],
    allowedResolutions: ["support-reviewed", "no-action"],
    defaultResolution: "support-reviewed",
    autoResolvesOnSellerSilence: false,
    automationSummary: "Seller logistics issues are routed to support or carrier operations without buyer involvement.",
  },
  {
    flowType: "payment-problem",
    title: "Payment problem",
    openedBy: ["buyer", "support"],
    initialStatus: "ready-for-support",
    priority: "urgent",
    sellerResponseHours: null,
    supportReviewHours: 12,
    checklist: [
      {
        key: "payment-error",
        label: "Payment error or charge reference is attached.",
        ownerRole: "buyer",
        evidenceTypes: ["payment-error", "refund-reference"],
        required: true,
      },
    ],
    allowedEvidenceTypes: ["payment-error", "refund-reference", "support-note"],
    allowedResponses: ["request-support-review"],
    allowedResolutions: ["support-reviewed", "no-action", "full-refund"],
    defaultResolution: "support-reviewed",
    autoResolvesOnSellerSilence: false,
    automationSummary: "Payment issues bypass seller response and route to support and payment operations.",
  },
] as const satisfies readonly SupportFlowDefinition[];

export function getSupportFlowDefinition(flowType: SupportFlowType): SupportFlowDefinition {
  const definition = supportFlowCatalog.find((entry) => entry.flowType === flowType);
  if (!definition) {
    throw new SupportDomainError("Support flow type is not configured.");
  }
  return definition;
}

export function createChecklist(flowType: SupportFlowType): readonly SupportChecklistItem[] {
  return getSupportFlowDefinition(flowType).checklist.map((item) => ({
    ...item,
    evidenceTypes: [...item.evidenceTypes],
    satisfiedAt: null,
  }));
}

export function includesEvidenceType(allowedTypes: readonly SupportEvidenceType[], evidenceType: SupportEvidenceType) {
  return allowedTypes.includes(evidenceType);
}
