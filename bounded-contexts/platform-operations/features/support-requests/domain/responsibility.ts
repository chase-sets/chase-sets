import type {
  SupportEvidenceBasis,
  SupportEvidenceBasisType,
  SupportFlowType,
  SupportResolution,
  SupportResponsibility,
  SupportResponsibilityFact,
  SupportResponsibilityReasonCode,
} from "./common";
import { assert, normalizeRequiredText } from "./common";

export type SupportResponsibilityReasonDefinition = Readonly<{
  code: SupportResponsibilityReasonCode;
  responsibility: SupportResponsibility;
  operatorLabel: string;
  operatorSelectable: boolean;
}>;

const operatorReasons = {
  "product-not-received": [
    ["seller-did-not-ship", "seller", "Seller did not ship the order"],
    ["carrier-loss", "carrier", "Carrier lost the shipment"],
    ["platform-tracking-error", "platform", "Platform tracking data was incorrect"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
  "product-not-as-described": [
    ["seller-misdescription", "seller", "Seller materially misdescribed the product"],
    ["buyer-misread-listing", "buyer", "Buyer misread an accurate listing"],
    ["shared-description-ambiguity", "shared", "Both parties contributed to listing ambiguity"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
  "product-damaged": [
    ["seller-inadequate-packaging", "seller", "Seller packaging was inadequate"],
    ["buyer-post-delivery-damage", "buyer", "Damage occurred after buyer delivery"],
    ["carrier-damage", "carrier", "Carrier handling damaged the shipment"],
    ["shared-packaging-and-handling", "shared", "Seller packaging and carrier handling both contributed"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
  "wrong-product-received": [
    ["seller-sent-wrong-product", "seller", "Seller sent the wrong product"],
    ["buyer-selected-wrong-product", "buyer", "Buyer selected the wrong product"],
    ["platform-order-routing-error", "platform", "Platform order routing was incorrect"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
  "missing-products": [
    ["seller-omitted-products", "seller", "Seller omitted products from the package"],
    ["buyer-quantity-misunderstanding", "buyer", "Buyer misunderstood the listed quantity"],
    ["carrier-package-loss", "carrier", "Carrier loss affected part of the shipment"],
    ["platform-order-record-error", "platform", "Platform order quantity was incorrect"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
  "authenticity-concern": [
    ["seller-authenticity-misrepresentation", "seller", "Seller misrepresented authenticity"],
    ["platform-verification-error", "platform", "Platform verification was incorrect"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
  "return-request": [
    ["buyer-remorse", "buyer", "Buyer changed their mind"],
    ["seller-misdescription", "seller", "Seller materially misdescribed the product"],
    ["shared-agreed-return", "shared", "Both parties materially contributed and agreed to return"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
  "buyer-cancel-request": [
    ["buyer-requested-cancellation", "buyer", "Buyer requested cancellation after fulfillment started"],
    ["shared-cancellation-cause", "shared", "Both parties materially contributed to cancellation"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
  "seller-cannot-fulfill": [
    ["seller-unable-to-fulfill", "seller", "Seller could not fulfill the order"],
    ["platform-fulfillment-block", "platform", "A platform failure prevented fulfillment"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
  "refund-status": [
    ["seller-refund-not-initiated", "seller", "Seller did not initiate the agreed refund"],
    ["platform-refund-processing-delay", "platform", "Platform refund processing was delayed"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
  "shipping-label-or-tracking": [
    ["seller-shipping-error", "seller", "Seller shipping information was incorrect"],
    ["carrier-tracking-error", "carrier", "Carrier tracking information was incorrect"],
    ["platform-label-error", "platform", "Platform label generation was incorrect"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
  "payment-problem": [
    ["buyer-payment-method-failure", "buyer", "Buyer payment method failed"],
    ["platform-payment-processing-error", "platform", "Platform payment processing failed"],
    ["conflicting-evidence", "undetermined", "Evidence conflicts or is insufficient"],
  ],
} as const satisfies Record<SupportFlowType, readonly (readonly [string, SupportResponsibility, string])[]>;

function code(flowType: SupportFlowType, suffix: string): SupportResponsibilityReasonCode {
  return `${flowType}.${suffix}`;
}

export function getSupportResponsibilityReasonDefinitions(
  flowType: SupportFlowType,
): readonly SupportResponsibilityReasonDefinition[] {
  const selectable = operatorReasons[flowType].map(([suffix, responsibility, operatorLabel]) => ({
    code: code(flowType, suffix),
    responsibility,
    operatorLabel,
    operatorSelectable: true,
  }));
  return [
    ...selectable,
    {
      code: code(flowType, "accepted-resolution-without-cause-finding"),
      responsibility: "undetermined",
      operatorLabel: "Accepted resolution did not establish cause",
      operatorSelectable: false,
    },
    {
      code: code(flowType, "seller-response-deadline-expired"),
      responsibility: "undetermined",
      operatorLabel: "Seller response deadline expired without a cause finding",
      operatorSelectable: false,
    },
    {
      code: code(flowType, "legacy-resolution-without-responsibility"),
      responsibility: "undetermined",
      operatorLabel: "Legacy resolution did not record responsibility",
      operatorSelectable: false,
    },
  ];
}

function normalizeResponsibility(value: string): SupportResponsibility {
  const normalized = value.trim();
  assert(
    ["seller", "buyer", "carrier", "platform", "shared", "undetermined"].includes(normalized),
    "Support responsibility is not supported.",
  );
  return normalized as SupportResponsibility;
}

function normalizeEvidenceBasis(value: Readonly<{ type: string; reference: string }>): SupportEvidenceBasis {
  const type = value.type.trim();
  assert(
    [
      "party-accepted-resolution",
      "deterministic-policy",
      "operator-finding",
      "insufficient-evidence",
      "legacy",
    ].includes(type),
    "Support evidence basis is not supported.",
  );
  return {
    type: type as SupportEvidenceBasisType,
    reference: normalizeRequiredText(value.reference, "Support evidence basis must include a stable reference."),
  };
}

export function createSupportResponsibilityFact(
  input: Readonly<{
    flowType: SupportFlowType;
    responsibility: SupportResponsibility | string;
    evidenceBasis: Readonly<{ type: SupportEvidenceBasisType | string; reference: string }>;
    responsibilityReasonCode: SupportResponsibilityReasonCode | string;
  }>,
): SupportResponsibilityFact {
  const responsibility = normalizeResponsibility(input.responsibility);
  const evidenceBasis = normalizeEvidenceBasis(input.evidenceBasis);
  const reasonCode = normalizeRequiredText(
    input.responsibilityReasonCode,
    "Support responsibility reason code is required.",
  ) as SupportResponsibilityReasonCode;
  const reason = getSupportResponsibilityReasonDefinitions(input.flowType).find(({ code }) => code === reasonCode);
  assert(reason !== undefined, "Support responsibility reason is not supported for this flow.");
  assert(reason.responsibility === responsibility, "Support responsibility does not match its reason code.");
  assert(
    evidenceBasis.type !== "insufficient-evidence" || responsibility === "undetermined",
    "Insufficient evidence can only produce undetermined responsibility.",
  );
  assert(
    evidenceBasis.type !== "legacy" || responsibility === "undetermined",
    "Legacy evidence can only produce undetermined responsibility.",
  );
  assert(
    responsibility !== "carrier" || reason.code.includes("carrier-"),
    "Carrier responsibility requires a carrier-related reason.",
  );
  return { responsibility, evidenceBasis, responsibilityReasonCode: reason.code };
}

export function acceptedOfferResponsibilityFact(flowType: SupportFlowType, offerId: string): SupportResponsibilityFact {
  return createSupportResponsibilityFact({
    flowType,
    responsibility: "undetermined",
    evidenceBasis: { type: "party-accepted-resolution", reference: `support-offer.${offerId}` },
    responsibilityReasonCode: code(flowType, "accepted-resolution-without-cause-finding"),
  });
}

export function sellerSilenceResponsibilityFact(flowType: SupportFlowType): SupportResponsibilityFact {
  return createSupportResponsibilityFact({
    flowType,
    responsibility: "undetermined",
    evidenceBasis: { type: "deterministic-policy", reference: "support-policy.seller-response-deadline.v1" },
    responsibilityReasonCode: code(flowType, "seller-response-deadline-expired"),
  });
}

export function normalizeSupportResolutionForReplay(
  resolution: Partial<SupportResolution> &
    Pick<
      SupportResolution,
      "resolutionType" | "summary" | "refundAmount" | "resolvedByAccountId" | "resolvedByRole" | "resolvedAt"
    >,
  flowType: SupportFlowType,
): SupportResolution {
  if (!resolution.responsibility || !resolution.evidenceBasis || !resolution.responsibilityReasonCode) {
    return {
      ...resolution,
      responsibility: "undetermined",
      evidenceBasis: { type: "legacy", reference: "support-event.pre-responsibility-resolution.v1" },
      responsibilityReasonCode: code(flowType, "legacy-resolution-without-responsibility"),
    };
  }
  return {
    ...resolution,
    ...createSupportResponsibilityFact({
      flowType,
      responsibility: resolution.responsibility,
      evidenceBasis: resolution.evidenceBasis,
      responsibilityReasonCode: resolution.responsibilityReasonCode,
    }),
  } as SupportResolution;
}
