import {
  isCsatWorkflowOutcomeCode,
  sourceContextForOutcomeCode,
  type CsatOutcomeFactV1,
  type OutcomeSubjectKind,
} from "@chase-sets/customer-feedback/server";

export const reputationCsatOutcomeFactEventType = "marketplace.csat-outcome-fact.v1" as const;

function normalizeRequiredText(value: string, message: string) {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(message);
  }
  return normalized;
}

function ensureIsoTimestamp(value: string, message: string) {
  const normalized = normalizeRequiredText(value, message);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(message);
  }
  return normalized;
}

export function createReputationCsatOutcomeFact(
  input: Readonly<{
    outcomeCode: string;
    subjectAccountId: string;
    subjectKind: OutcomeSubjectKind;
    subjectEntityType: string;
    subjectEntityId: string;
    outcomeOccurredAt: string;
    idempotencyKey: string;
    correlationId?: string | null;
  }>,
): CsatOutcomeFactV1 {
  if (!isCsatWorkflowOutcomeCode(input.outcomeCode)) {
    throw new Error(`Unsupported CSAT workflow outcome code: ${input.outcomeCode}`);
  }
  if (sourceContextForOutcomeCode(input.outcomeCode) !== "marketplace") {
    throw new Error(`Marketplace cannot publish CSAT outcome code: ${input.outcomeCode}`);
  }

  return {
    factSchemaVersion: 1,
    outcomeCode: input.outcomeCode,
    sourceContext: "marketplace",
    subjectAccountId: normalizeRequiredText(input.subjectAccountId, "CSAT outcome requires a subject account."),
    subjectKind: input.subjectKind,
    subject: {
      entityType: normalizeRequiredText(input.subjectEntityType, "CSAT outcome requires a subject type."),
      entityId: normalizeRequiredText(input.subjectEntityId, "CSAT outcome requires a subject id."),
    },
    outcomeOccurredAt: ensureIsoTimestamp(input.outcomeOccurredAt, "CSAT outcome requires an occurrence timestamp."),
    idempotencyKey: normalizeRequiredText(input.idempotencyKey, "CSAT outcome requires an idempotency key."),
    correlationId: input.correlationId ?? null,
  };
}
