import { evaluateFeatureRollout, type FeatureRolloutPolicy, type RolloutSubject } from "../domain/rollout";
import {
  buildReleaseLockCommandPlan,
  readReleaseLockStatus,
  type ReleaseLockCommandPlan,
  type ReleaseLockStatus,
} from "../domain/release-lock";

export type ReleaseControlsQuery = Readonly<{
  releaseAction: "lock" | "unlock";
  releaseReason: string;
  releaseReference: string;
  rolloutFeatureKey: string;
  rolloutEnvironment: FeatureRolloutPolicy["environment"];
  rolloutPercentage: string;
  rolloutSubjectType: RolloutSubject["subjectType"];
  rolloutSubjectId: string;
  rolloutAllowSubjects: string;
  rolloutOptOutSubjects: string;
  rolloutKillSwitchActive: boolean;
}>;

export type RolloutEvaluation = Readonly<{
  enabled: boolean;
  reason: string;
  bucket: number;
  errors: readonly string[];
}>;

export type ReleaseControlsSnapshot = Readonly<{
  releaseLock: ReleaseLockStatus;
  releaseLockCommandPlan: ReleaseLockCommandPlan;
  rolloutEvaluation: RolloutEvaluation;
  query: ReleaseControlsQuery;
}>;

const environmentValues = ["development", "test", "preview", "staging", "production"] as const;
const subjectTypes = ["account", "membership", "operator", "anonymous"] as const;

export function buildReleaseControlsSnapshot(
  query: ReleaseControlsQuery,
  env: Readonly<Record<string, string | undefined>>,
): ReleaseControlsSnapshot {
  return {
    releaseLock: readReleaseLockStatus(env, "production"),
    releaseLockCommandPlan: buildReleaseLockCommandPlan({
      action: query.releaseAction,
      environmentName: "production",
      reason: query.releaseReason,
      reference: query.releaseReference,
    }),
    rolloutEvaluation: buildRolloutEvaluation(query),
    query,
  };
}

export function readReleaseControlsQuery(request: Request): ReleaseControlsQuery {
  const url = new URL(request.url);

  return {
    releaseAction: normalizeReleaseAction(url.searchParams.get("releaseAction")),
    releaseReason: url.searchParams.get("releaseReason") ?? "",
    releaseReference: url.searchParams.get("releaseReference") ?? "",
    rolloutFeatureKey: url.searchParams.get("rolloutFeatureKey") ?? "checkout.deferred-payment-proof",
    rolloutEnvironment: normalizeEnvironment(url.searchParams.get("rolloutEnvironment")),
    rolloutPercentage: url.searchParams.get("rolloutPercentage") ?? "0",
    rolloutSubjectType: normalizeSubjectType(url.searchParams.get("rolloutSubjectType")),
    rolloutSubjectId: url.searchParams.get("rolloutSubjectId") ?? "operator-preview",
    rolloutAllowSubjects: url.searchParams.get("rolloutAllowSubjects") ?? "",
    rolloutOptOutSubjects: url.searchParams.get("rolloutOptOutSubjects") ?? "",
    rolloutKillSwitchActive: url.searchParams.get("rolloutKillSwitchActive") === "true",
  };
}

function buildRolloutEvaluation(query: ReleaseControlsQuery): RolloutEvaluation {
  const errors: string[] = [];
  const percentage = Number(query.rolloutPercentage);

  if (!query.rolloutFeatureKey.trim()) {
    errors.push("Feature key is required.");
  }

  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
    errors.push("Rollout percentage must be an integer between 0 and 100.");
  }

  if (!query.rolloutSubjectId.trim()) {
    errors.push("Subject ID is required.");
  }

  if (errors.length > 0) {
    return { enabled: false, reason: "invalid-policy", bucket: 0, errors };
  }

  const decision = evaluateFeatureRollout(
    {
      featureKey: query.rolloutFeatureKey.trim(),
      environment: query.rolloutEnvironment,
      percentage,
      allowSubjects: parseSubjects(query.rolloutAllowSubjects),
      optOutSubjects: parseSubjects(query.rolloutOptOutSubjects),
      killSwitchActive: query.rolloutKillSwitchActive,
    },
    {
      subjectType: query.rolloutSubjectType,
      subjectId: query.rolloutSubjectId.trim(),
    },
  );

  return { ...decision, errors: [] };
}

function normalizeReleaseAction(value: string | null): ReleaseControlsQuery["releaseAction"] {
  return value === "unlock" ? "unlock" : "lock";
}

function normalizeEnvironment(value: string | null): FeatureRolloutPolicy["environment"] {
  return environmentValues.find((candidate) => candidate === value) ?? "production";
}

function normalizeSubjectType(value: string | null): RolloutSubject["subjectType"] {
  return subjectTypes.find((candidate) => candidate === value) ?? "account";
}

function parseSubjects(value: string) {
  return value
    .split(/[\n,]/)
    .map((subject) => subject.trim())
    .filter(Boolean);
}
