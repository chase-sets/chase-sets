import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

export const customerFeedbackPrivacyPolicyVersion = "customer-feedback-privacy.v1" as const;

export type CustomerFeedbackRetentionPolicyValue = Readonly<{
  responseContentDays: number;
  directIdentifiersDays: number;
  invitationDiagnosticsDays: number;
  operatorNotesDays: number;
  deliveryArtifactDays: number;
  exportArtifactHours: number;
  structuralAuditDays: number;
}>;

const retentionDefaultValue: CustomerFeedbackRetentionPolicyValue = {
  responseContentDays: 365,
  directIdentifiersDays: 365,
  invitationDiagnosticsDays: 90,
  operatorNotesDays: 365,
  deliveryArtifactDays: 30,
  exportArtifactHours: 24,
  structuralAuditDays: 2_555,
};

export const customerFeedbackRetentionPolicy = definePolicy<CustomerFeedbackRetentionPolicyValue>({
  policyKey: "customer-feedback.retention-schedule",
  contextName: "customer-feedback",
  schemaSummary:
    "{ responseContentDays, directIdentifiersDays, invitationDiagnosticsDays, operatorNotesDays, deliveryArtifactDays, exportArtifactHours, structuralAuditDays: positive integers }",
  defaultValue: retentionDefaultValue,
  decodeValue: decodeRetentionPolicy,
});

export const customerFeedbackDataClasses = [
  "response-content",
  "direct-identifiers",
  "invitation-diagnostics",
  "operator-notes",
  "delivery-artifacts",
  "export-artifacts",
  "structural-audit",
] as const;
export type CustomerFeedbackDataClass = (typeof customerFeedbackDataClasses)[number];

export type CustomerFeedbackRetentionRule = Readonly<{
  dataClass: CustomerFeedbackDataClass;
  duration: string;
  action: "redact" | "delete" | "retain";
  startsAt: "submitted-at" | "closed-at" | "created-at";
  rationale: string;
}>;

/** Versioned schedule interpreted only by the Customer Feedback retention worker. */
export const customerFeedbackRetentionSchedule: readonly CustomerFeedbackRetentionRule[] = [
  {
    dataClass: "response-content",
    duration: `P${retentionDefaultValue.responseContentDays}D`,
    action: "redact",
    startsAt: "submitted-at",
    rationale: "One year supports service recovery and product learning without retaining free text indefinitely.",
  },
  {
    dataClass: "direct-identifiers",
    duration: `P${retentionDefaultValue.directIdentifiersDays}D`,
    action: "redact",
    startsAt: "submitted-at",
    rationale: "Account and source references are no longer needed after the response follow-up window.",
  },
  {
    dataClass: "invitation-diagnostics",
    duration: `P${retentionDefaultValue.invitationDiagnosticsDays}D`,
    action: "redact",
    startsAt: "created-at",
    rationale: "Sampling and delivery diagnosis has short-lived operational value.",
  },
  {
    dataClass: "operator-notes",
    duration: `P${retentionDefaultValue.operatorNotesDays}D`,
    action: "redact",
    startsAt: "closed-at",
    rationale: "Case notes follow the closed case recovery window.",
  },
  {
    dataClass: "delivery-artifacts",
    duration: `P${retentionDefaultValue.deliveryArtifactDays}D`,
    action: "delete",
    startsAt: "created-at",
    rationale: "Delivery artifacts are retry aids, not records of customer intent.",
  },
  {
    dataClass: "export-artifacts",
    duration: `PT${retentionDefaultValue.exportArtifactHours}H`,
    action: "delete",
    startsAt: "created-at",
    rationale: "Sensitive exports are ephemeral and must be regenerated under current authority.",
  },
  {
    dataClass: "structural-audit",
    duration: `P${retentionDefaultValue.structuralAuditDays}D`,
    action: "retain",
    startsAt: "created-at",
    rationale: "Seven-year content-free audit facts support security and compliance investigations.",
  },
] as const;

export const customerFeedbackRedactionScopes = ["response-content", "direct-identifiers", "all-sensitive"] as const;
export type CustomerFeedbackRedactionScope = (typeof customerFeedbackRedactionScopes)[number];

export const customerFeedbackPrivacyCapabilities = [
  "view-comments",
  "export-sensitive-feedback",
  "follow-up",
  "redact-feedback",
  "manage-feedback-holds",
  "audit-feedback-privacy",
] as const;
export type CustomerFeedbackPrivacyCapability = (typeof customerFeedbackPrivacyCapabilities)[number];

export function privacyPermission(capability: CustomerFeedbackPrivacyCapability): string {
  return `customer-feedback.privacy.${capability}`;
}

export function retentionRule(dataClass: CustomerFeedbackDataClass): CustomerFeedbackRetentionRule {
  const rule = customerFeedbackRetentionSchedule.find((candidate) => candidate.dataClass === dataClass);
  if (!rule) throw new Error(`Missing Customer Feedback retention rule for ${dataClass}.`);
  return rule;
}

export function normalizePrivacyReason(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(normalized)) {
    throw new Error("Privacy reasons must be stable content-free codes.");
  }
  return normalized;
}

function decodeRetentionPolicy(raw: JsonValue): CustomerFeedbackRetentionPolicyValue {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Customer Feedback retention policy must be an object.");
  }
  const record = raw as Record<string, unknown>;
  return {
    responseContentDays: positiveInteger(record.responseContentDays, "responseContentDays"),
    directIdentifiersDays: positiveInteger(record.directIdentifiersDays, "directIdentifiersDays"),
    invitationDiagnosticsDays: positiveInteger(record.invitationDiagnosticsDays, "invitationDiagnosticsDays"),
    operatorNotesDays: positiveInteger(record.operatorNotesDays, "operatorNotesDays"),
    deliveryArtifactDays: positiveInteger(record.deliveryArtifactDays, "deliveryArtifactDays"),
    exportArtifactHours: positiveInteger(record.exportArtifactHours, "exportArtifactHours"),
    structuralAuditDays: positiveInteger(record.structuralAuditDays, "structuralAuditDays"),
  };
}

function positiveInteger(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 10_000) {
    throw new Error(`${field} must be an integer from 1 through 10000.`);
  }
  return number;
}
