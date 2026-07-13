/**
 * Sampling policy / cohort metadata.
 *
 * A survey is not sent for every eligible outcome. A sampling policy decides who
 * is included and records WHY (the cohort key), so operators can always explain
 * an invitation and the presentation denominator is trustworthy. #5147 applies
 * these policies when issuing invitations; #5153 surfaces cohort metadata.
 *
 * Launch sampling must not depend on the post-launch beta-cohort / feature-flag
 * machinery (#4340/#4346) — encoded here as `dependsOnBetaCohorts: false`.
 */
import type { CsatWorkflowOutcomeCode } from "./workflow-outcomes";
import type { SurveyVersionId } from "./survey";

export type SamplingPolicyId = string;

/** How a cohort is sampled into a survey for a given outcome + instrument version. */
export type CsatSamplingPolicyV1 = Readonly<{
  policySchemaVersion: 1;
  policyId: SamplingPolicyId;
  outcomeCode: CsatWorkflowOutcomeCode;
  surveyVersion: SurveyVersionId;
  /** Fraction of eligible outcomes sampled, in [0, 1]. 1 = census (survey all). */
  sampleRate: number;
  /** Stable label explaining WHY a subject is included, surfaced to operators. */
  cohortKey: string;
  /** Minimum gap between surveys sent to one subject, as an ISO-8601 duration. */
  perSubjectCooldown: string;
  /** Launch invariant: sampling never depends on beta cohorts / feature flags. */
  dependsOnBetaCohorts: false;
}>;

/** The recorded outcome of applying a sampling policy to one outcome fact. */
export type CsatSamplingDecision = Readonly<{
  policyId: SamplingPolicyId;
  included: boolean;
  /** The cohort the subject fell into (recorded for both include and exclude). */
  cohortKey: string;
  /** Machine-readable reason for the decision (audit + explainability). */
  reason: string;
}>;

export const csatSamplingPolicySchemaVersion = 1 as const;
