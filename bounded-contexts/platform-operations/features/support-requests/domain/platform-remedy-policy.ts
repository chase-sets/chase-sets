import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { compareMoneyAmounts } from "@chase-sets/primitives/money";
import type { RefundTrigger } from "@chase-sets/primitives/platform-coverage";
import { SupportDomainError } from "./common";

export const platformRemedyCapabilities = {
  propose: "support.remedies.propose",
  approve: "support.remedies.approve",
  approveElevated: "support.remedies.approve-elevated",
  overrideReturn: "support.remedies.override-return",
  retry: "support.remedies.retry",
  waive: "support.remedies.waive",
  correct: "support.remedies.correct",
} as const;

export type PlatformRemedyCapability = (typeof platformRemedyCapabilities)[keyof typeof platformRemedyCapabilities];

export type PlatformRemedyPolicyValue = Readonly<{
  eligibleReasonCodes: readonly string[];
  maximumAmountByCapability: Readonly<Record<"propose" | "approve" | "approveElevated", string>>;
  maximumPercentageByCapability: Readonly<Record<"propose" | "approve" | "approveElevated", number>>;
  splitFundingAllowed: boolean;
  returnRequiredAtOrAboveAmount: string;
  allowableRefundTriggers: readonly RefundTrigger[];
  dualControlAtOrAboveAmount: string;
  splitFundingRequiresDualControl: boolean;
  reservationExpiryHours: number;
  returnExceptionReasonCodes: readonly string[];
  escalationReasonCodes: readonly string[];
}>;

export const PLATFORM_REMEDY_LAUNCH_POLICY_VALUE: PlatformRemedyPolicyValue = {
  eligibleReasonCodes: [
    "insufficient-evidence",
    "platform-service-failure",
    "carrier-exception",
    "customer-protection",
  ],
  maximumAmountByCapability: {
    propose: "1000.00",
    approve: "250.00",
    approveElevated: "5000.00",
  },
  maximumPercentageByCapability: {
    propose: 100,
    approve: 100,
    approveElevated: 100,
  },
  splitFundingAllowed: true,
  returnRequiredAtOrAboveAmount: "500.00",
  allowableRefundTriggers: ["immediate", "carrier-accepted", "delivered", "facility-intake", "operator-release"],
  dualControlAtOrAboveAmount: "500.00",
  splitFundingRequiresDualControl: true,
  reservationExpiryHours: 24,
  returnExceptionReasonCodes: ["unsafe-return", "lost-return", "cost-disproportionate", "documented-exception"],
  escalationReasonCodes: [
    "coverage-rejected",
    "reservation-expired",
    "carrier-exception",
    "refund-failure",
    "reconciliation-stuck",
    "policy-exception",
  ],
};

const REFUND_TRIGGERS = new Set<RefundTrigger>(PLATFORM_REMEDY_LAUNCH_POLICY_VALUE.allowableRefundTriggers);

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SupportDomainError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function textArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SupportDomainError(`${field} must contain at least one value.`);
  }
  const normalized = value.map((entry) => String(entry).trim());
  if (normalized.some((entry) => !entry)) {
    throw new SupportDomainError(`${field} cannot contain empty values.`);
  }
  return [...new Set(normalized)];
}

function money(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new SupportDomainError(`${field} must be a non-negative decimal amount with at most two decimals.`);
  }
  return Number(normalized).toFixed(2);
}

function percentage(value: unknown, field: string): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new SupportDomainError(`${field} must be between 0 and 100.`);
  }
  return normalized;
}

function positiveHours(value: unknown): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 168) {
    throw new SupportDomainError("Reservation expiry must be a whole number of hours between 1 and 168.");
  }
  return normalized;
}

export function decodePlatformRemedyPolicyValue(raw: JsonValue): PlatformRemedyPolicyValue {
  const record = requiredRecord(raw, "Platform remedy policy");
  const amountLimits = requiredRecord(record.maximumAmountByCapability, "Maximum amount by capability");
  const percentageLimits = requiredRecord(record.maximumPercentageByCapability, "Maximum percentage by capability");
  const triggers = textArray(record.allowableRefundTriggers, "Allowable refund triggers");
  if (triggers.some((trigger) => !REFUND_TRIGGERS.has(trigger as RefundTrigger))) {
    throw new SupportDomainError("Allowable refund triggers contain an unknown trigger.");
  }
  return {
    eligibleReasonCodes: textArray(record.eligibleReasonCodes, "Eligible reason codes"),
    maximumAmountByCapability: {
      propose: money(amountLimits.propose, "Proposer maximum amount"),
      approve: money(amountLimits.approve, "Approver maximum amount"),
      approveElevated: money(amountLimits.approveElevated, "Elevated approver maximum amount"),
    },
    maximumPercentageByCapability: {
      propose: percentage(percentageLimits.propose, "Proposer maximum percentage"),
      approve: percentage(percentageLimits.approve, "Approver maximum percentage"),
      approveElevated: percentage(percentageLimits.approveElevated, "Elevated approver maximum percentage"),
    },
    splitFundingAllowed: record.splitFundingAllowed === true,
    returnRequiredAtOrAboveAmount: money(record.returnRequiredAtOrAboveAmount, "Return-required threshold"),
    allowableRefundTriggers: triggers as readonly RefundTrigger[],
    dualControlAtOrAboveAmount: money(record.dualControlAtOrAboveAmount, "Dual-control threshold"),
    splitFundingRequiresDualControl: record.splitFundingRequiresDualControl === true,
    reservationExpiryHours: positiveHours(record.reservationExpiryHours),
    returnExceptionReasonCodes: textArray(record.returnExceptionReasonCodes, "Return exception reason codes"),
    escalationReasonCodes: textArray(record.escalationReasonCodes, "Escalation reason codes"),
  };
}

export const platformRemedyPolicy: PolicyDefinition<PlatformRemedyPolicyValue> = definePolicy({
  policyKey: "platform-operations.platform-remedies",
  contextName: "platform-operations",
  schemaSummary:
    "{ eligibleReasonCodes, maximumAmountByCapability, maximumPercentageByCapability, splitFundingAllowed, returnRequiredAtOrAboveAmount, allowableRefundTriggers, dualControlAtOrAboveAmount, splitFundingRequiresDualControl, reservationExpiryHours, returnExceptionReasonCodes, escalationReasonCodes }",
  defaultValue: PLATFORM_REMEDY_LAUNCH_POLICY_VALUE,
  decodeValue: decodePlatformRemedyPolicyValue,
});

export type RemedyPolicyAuthority = "propose" | "approve" | "approveElevated";

export function strongestRemedyPolicyAuthority(permissions: readonly string[]): RemedyPolicyAuthority | null {
  if (permissions.includes(platformRemedyCapabilities.approveElevated)) return "approveElevated";
  if (permissions.includes(platformRemedyCapabilities.approve)) return "approve";
  if (permissions.includes(platformRemedyCapabilities.propose)) return "propose";
  return null;
}

export function assertRemedyPolicyLimit(
  params: Readonly<{
    authority: RemedyPolicyAuthority;
    amount: string;
    eligibleAmount: string;
    policy: PlatformRemedyPolicyValue;
  }>,
) {
  const maximumAmount = params.policy.maximumAmountByCapability[params.authority];
  if (compareMoneyAmounts(params.amount, maximumAmount) > 0) {
    throw new SupportDomainError(`Remedy amount exceeds the ${params.authority} amount limit.`);
  }
  const eligible = Number(params.eligibleAmount);
  const percentage = eligible <= 0 ? 100 : (Number(params.amount) / eligible) * 100;
  if (percentage > params.policy.maximumPercentageByCapability[params.authority]) {
    throw new SupportDomainError(`Remedy amount exceeds the ${params.authority} percentage limit.`);
  }
}

export function platformRemedyPolicyVersion(
  resolved: Readonly<{
    documentId: string | null;
    effectiveFrom: string | null;
  }>,
): string {
  return resolved.documentId
    ? `${platformRemedyPolicy.policyKey}:${resolved.documentId}:${resolved.effectiveFrom ?? "active"}`
    : `${platformRemedyPolicy.policyKey}:compiled-v1`;
}
