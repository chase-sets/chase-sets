export type RolloutSubject = Readonly<{
  subjectType: "account" | "membership" | "operator" | "anonymous";
  subjectId: string;
}>;

export type FeatureRolloutPolicy = Readonly<{
  featureKey: string;
  environment: "preview" | "staging" | "production" | "development" | "test";
  percentage: number;
  allowSubjects?: readonly string[];
  optOutSubjects?: readonly string[];
  killSwitchActive?: boolean;
}>;

export type FeatureRolloutDecision = Readonly<{
  enabled: boolean;
  reason: "kill-switch" | "subject-opt-out" | "subject-allowlist" | "percentage-rollout" | "percentage-rollout-miss";
  bucket: number;
}>;

export function evaluateFeatureRollout(policy: FeatureRolloutPolicy, subject: RolloutSubject): FeatureRolloutDecision {
  const percentage = normalizePercentage(policy.percentage);
  const subjectKey = `${subject.subjectType}:${subject.subjectId}`;
  const bucket = rolloutBucket(policy.featureKey, policy.environment, subjectKey);

  if (policy.killSwitchActive) {
    return { enabled: false, reason: "kill-switch", bucket };
  }

  if (policy.optOutSubjects?.includes(subjectKey)) {
    return { enabled: false, reason: "subject-opt-out", bucket };
  }

  if (policy.allowSubjects?.includes(subjectKey)) {
    return { enabled: true, reason: "subject-allowlist", bucket };
  }

  if (bucket < percentage) {
    return { enabled: true, reason: "percentage-rollout", bucket };
  }

  return { enabled: false, reason: "percentage-rollout-miss", bucket };
}

export function rolloutBucket(featureKey: string, environment: string, subjectKey: string): number {
  const key = `${featureKey}:${environment}:${subjectKey}`;
  let hash = 2166136261;

  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) % 100;
}

function normalizePercentage(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("Feature rollout percentage must be an integer between 0 and 100.");
  }
  return value;
}
