import type { DomainEvent } from "@chase-sets/event-core";
import type { CsatOutcomeFactV1 } from "./outcome-fact";
import type { CsatWorkflowOutcomeCode } from "./workflow-outcomes";
import type { SurveyVersionId } from "./survey";

export type SamplingPolicyId = string;

export const csatSamplingPolicySchemaVersion = 1 as const;
export const csatSamplingAlgorithmVersion = "fnv1a-32.v1" as const;

/**
 * Versioned issuance policy for one workflow outcome and survey instrument.
 * `issuanceEnabled` is the explicit operational kill switch. A zero sample rate
 * remains an ordinary sampling configuration and is never interpreted as a
 * hidden disable control.
 */
export type CsatSamplingPolicyV1 = Readonly<{
  policySchemaVersion: 1;
  policyId: SamplingPolicyId;
  outcomeCode: CsatWorkflowOutcomeCode;
  surveyVersion: SurveyVersionId;
  issuanceEnabled: boolean;
  sampleRate: number;
  cohortKey: string;
  perSubjectCooldown: string;
  invitationTtl: string;
  dependsOnBetaCohorts: false;
}>;

export type CsatSamplingDecisionReason = "included" | "sampled-out" | "issuance-disabled";

/** Complete, persisted result of applying a sampling policy to an outcome fact. */
export type CsatSamplingDecision = Readonly<{
  policySchemaVersion: 1;
  policyId: SamplingPolicyId;
  algorithmVersion: typeof csatSamplingAlgorithmVersion;
  included: boolean;
  cohortKey: string;
  bucket: number;
  sampleRate: number;
  reason: CsatSamplingDecisionReason;
}>;

/** Internal policy fact used to serialize cooldown decisions across invitation streams. */
export type CsatSamplingCooldownClaimedEvent = DomainEvent<
  "customer-feedback.sampling.cooldown-claimed",
  Readonly<{
    eventSchemaVersion: 1;
    subjectAccountId: string;
    outcomeCode: CsatWorkflowOutcomeCode;
    outcomeIdempotencyKey: string;
    issuedAt: string;
  }>
>;

export function decideCsatSampling(policy: CsatSamplingPolicyV1, fact: CsatOutcomeFactV1): CsatSamplingDecision {
  validateCsatSamplingPolicy(policy);

  const bucket = deterministicUnitInterval(
    `${policy.policyId}\u0000${policy.cohortKey}\u0000${fact.subjectAccountId}\u0000${fact.idempotencyKey}`,
  );
  const included = policy.issuanceEnabled && bucket < policy.sampleRate;

  return {
    policySchemaVersion: policy.policySchemaVersion,
    policyId: policy.policyId,
    algorithmVersion: csatSamplingAlgorithmVersion,
    included,
    cohortKey: policy.cohortKey,
    bucket,
    sampleRate: policy.sampleRate,
    reason: !policy.issuanceEnabled ? "issuance-disabled" : included ? "included" : "sampled-out",
  };
}

export function validateCsatSamplingPolicy(policy: CsatSamplingPolicyV1): void {
  if (policy.policySchemaVersion !== csatSamplingPolicySchemaVersion) {
    throw new Error(`Unsupported CSAT sampling policy schema version: ${String(policy.policySchemaVersion)}.`);
  }
  if (!policy.policyId.trim() || !policy.cohortKey.trim()) {
    throw new Error("CSAT sampling policies require a policy id and cohort key.");
  }
  if (!Number.isFinite(policy.sampleRate) || policy.sampleRate < 0 || policy.sampleRate > 1) {
    throw new Error("CSAT sample rate must be between 0 and 1 inclusive.");
  }
  durationMilliseconds(policy.perSubjectCooldown);
  if (durationMilliseconds(policy.invitationTtl) <= 0) {
    throw new Error("CSAT invitation TTL must be greater than zero.");
  }
}

export function durationMilliseconds(value: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || match.slice(1).every((part) => part === undefined)) {
    throw new Error(`Unsupported ISO-8601 duration: ${value}.`);
  }
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return Number(days) * 86_400_000 + Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000;
}

export function cooldownEndsAt(issuedAt: string, policy: CsatSamplingPolicyV1): string {
  return new Date(requireTimestamp(issuedAt) + durationMilliseconds(policy.perSubjectCooldown)).toISOString();
}

export function invitationExpiresAt(issuedAt: string, policy: CsatSamplingPolicyV1): string {
  return new Date(requireTimestamp(issuedAt) + durationMilliseconds(policy.invitationTtl)).toISOString();
}

export function policyAppliesToOutcome(policy: CsatSamplingPolicyV1, outcomeCode: CsatWorkflowOutcomeCode): boolean {
  return policy.outcomeCode === outcomeCode;
}

function deterministicUnitInterval(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

function requireTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid timestamp: ${value}.`);
  }
  return parsed;
}
