export type RolloutEnvironment = "development" | "test" | "preview" | "staging" | "production";

export type RolloutSubjectType = "account" | "membership" | "operator" | "anonymous";

export type RolloutSubject = Readonly<{
  subjectType: RolloutSubjectType;
  subjectId: string;
}>;

export type FeatureRolloutPolicy = Readonly<{
  featureKey: string;
  environment: RolloutEnvironment;
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

export type ReleaseControlPolicyDecision = FeatureRolloutDecision &
  Readonly<{
    featureKey: string;
    environment: RolloutEnvironment;
    subject: RolloutSubject;
    cohortSize: number;
  }>;

export const rolloutEnvironments = ["development", "test", "preview", "staging", "production"] as const;
export const rolloutSubjectTypes = ["account", "membership", "operator", "anonymous"] as const;

export function rolloutSubjectKey(subject: RolloutSubject): string {
  return `${subject.subjectType}:${normalizeRequiredText(subject.subjectId, "Rollout subject ID is required.")}`;
}

export function evaluateFeatureRollout(policy: FeatureRolloutPolicy, subject: RolloutSubject): FeatureRolloutDecision {
  const percentage = normalizePercentage(policy.percentage);
  const subjectKey = rolloutSubjectKey(subject);
  const bucket = rolloutBucket(policy.featureKey, policy.environment, subjectKey);

  if (policy.killSwitchActive) {
    return { enabled: false, reason: "kill-switch", bucket };
  }

  if (normalizedSubjectSet(policy.optOutSubjects).has(subjectKey)) {
    return { enabled: false, reason: "subject-opt-out", bucket };
  }

  if (normalizedSubjectSet(policy.allowSubjects).has(subjectKey)) {
    return { enabled: true, reason: "subject-allowlist", bucket };
  }

  if (bucket < percentage) {
    return { enabled: true, reason: "percentage-rollout", bucket };
  }

  return { enabled: false, reason: "percentage-rollout-miss", bucket };
}

export function rolloutBucket(featureKey: string, environment: string, subjectKey: string): number {
  const key = `${normalizeRequiredText(featureKey, "Feature key is required.")}:${normalizeRequiredText(
    environment,
    "Environment is required.",
  )}:${normalizeRequiredText(subjectKey, "Rollout subject is required.")}`;
  let hash = 2166136261;

  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) % 100;
}

export function normalizeRolloutEnvironment(value: unknown): RolloutEnvironment {
  return rolloutEnvironments.find((candidate) => candidate === value) ?? "production";
}

export function normalizeRolloutSubjectType(value: unknown): RolloutSubjectType {
  return rolloutSubjectTypes.find((candidate) => candidate === value) ?? "account";
}

export function normalizeSubjectList(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.map(String).map(normalizeSubjectEntry).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split(/[\n,]/).map(normalizeSubjectEntry).filter(Boolean);
  }

  return [];
}

function normalizedSubjectSet(value: unknown): ReadonlySet<string> {
  return new Set(normalizeSubjectList(value));
}

function normalizeSubjectEntry(value: string): string {
  return value.trim();
}

function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function normalizePercentage(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("Feature rollout percentage must be an integer between 0 and 100.");
  }
  return value;
}
