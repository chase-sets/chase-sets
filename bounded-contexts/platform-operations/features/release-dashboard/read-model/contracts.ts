import { readReleaseLockStatus, type ReleaseLockStatus } from "../../release-controls/domain/release-lock";

export type ReleaseDashboardPhase = "success" | "failure" | "cancelled" | "skipped" | "unknown";
export type ReleaseDashboardPosture = "current" | "drift" | "locked" | "failed" | "unknown";

export type ReleaseDashboardSource = Readonly<{
  repository: string;
  mainSha: string | null;
  productionMarkerSha: string | null;
  mainCommittedAt: string | null;
  productionMarkerUpdatedAt: string | null;
  latestPrRequired: ReleaseDashboardPhase;
  latestPlatformDeploy: ReleaseDashboardPhase;
  latestStagingDeploy: ReleaseDashboardPhase;
  latestProductionDeploy: ReleaseDashboardPhase;
  latestPrRunUrl: string | null;
  latestDeployRunUrl: string | null;
  productionMarkerUrl: string | null;
  releaseHealth: ReleaseHealthRecord | null;
}>;

export type ReleaseHealthRecord = Readonly<{
  releaseCommit?: string;
  workflowRunId?: string;
  releaseMode?: string;
  checkedAt?: string;
  mainToProductionDrift?: Readonly<{ commits?: number; seconds?: number }>;
  staging?: Readonly<{ result?: string; startedAt?: string | null; completedAt?: string | null }>;
  canary?: Readonly<{
    result?: string;
    startedAt?: string | null;
    completedAt?: string | null;
    promotionDecision?: string | null;
  }>;
  production?: Readonly<{ result?: string; startedAt?: string | null; completedAt?: string | null }>;
  releaseLock?: Readonly<{
    locked?: boolean;
    bypassed?: boolean;
    reference?: string | null;
    emergencyReference?: string | null;
  }>;
}>;

export type ReleaseDashboardSnapshot = Readonly<{
  checkedAt: string;
  repository: string;
  posture: ReleaseDashboardPosture;
  explanation: string;
  main: ReleaseDashboardCommit;
  productionMarker: ReleaseDashboardCommit;
  drift: Readonly<{
    commits: number | null;
    seconds: number | null;
    label: string;
  }>;
  checks: Readonly<{
    prRequired: ReleaseDashboardPhase;
    platformDeploy: ReleaseDashboardPhase;
    stagingDeploy: ReleaseDashboardPhase;
    productionDeploy: ReleaseDashboardPhase;
  }>;
  releaseLock: ReleaseLockStatus;
  latestReleaseHealth: Readonly<{
    releaseCommit: string | null;
    workflowRunId: string | null;
    releaseMode: string;
    staging: ReleaseDashboardPhase;
    canary: ReleaseDashboardPhase;
    canaryDecision: string | null;
    production: ReleaseDashboardPhase;
    checkedAt: string | null;
  }>;
  links: Readonly<{
    latestPrRun: string | null;
    latestDeployRun: string | null;
    productionMarker: string | null;
  }>;
}>;

type ReleaseDashboardCommit = Readonly<{
  sha: string | null;
  shortSha: string;
  recordedAt: string | null;
}>;

export function buildReleaseDashboardSnapshot(
  source: ReleaseDashboardSource,
  releaseLock: ReleaseLockStatus,
  checkedAt = new Date().toISOString(),
): ReleaseDashboardSnapshot {
  const health = source.releaseHealth;
  const driftCommits = readNumber(health?.mainToProductionDrift?.commits) ?? readShaDrift(source);
  const driftSeconds = readNumber(health?.mainToProductionDrift?.seconds);
  const productionResult = normalizePhase(health?.production?.result ?? source.latestProductionDeploy);
  const stagingResult = normalizePhase(health?.staging?.result ?? source.latestStagingDeploy);
  const posture = resolvePosture({ releaseLock, productionResult, stagingResult, driftCommits });

  return {
    checkedAt,
    repository: source.repository,
    posture,
    explanation: explainPosture(posture, { releaseLock, driftCommits, productionResult, stagingResult }),
    main: buildCommit(source.mainSha, source.mainCommittedAt),
    productionMarker: buildCommit(source.productionMarkerSha, source.productionMarkerUpdatedAt),
    drift: {
      commits: driftCommits,
      seconds: driftSeconds,
      label: formatDrift(driftCommits, driftSeconds),
    },
    checks: {
      prRequired: normalizePhase(source.latestPrRequired),
      platformDeploy: normalizePhase(source.latestPlatformDeploy),
      stagingDeploy: stagingResult,
      productionDeploy: productionResult,
    },
    releaseLock,
    latestReleaseHealth: {
      releaseCommit: health?.releaseCommit ?? null,
      workflowRunId: health?.workflowRunId ?? null,
      releaseMode: health?.releaseMode ?? "unknown",
      staging: stagingResult,
      canary: normalizePhase(health?.canary?.result),
      canaryDecision: health?.canary?.promotionDecision ?? null,
      production: productionResult,
      checkedAt: health?.checkedAt ?? null,
    },
    links: {
      latestPrRun: source.latestPrRunUrl,
      latestDeployRun: source.latestDeployRunUrl,
      productionMarker: source.productionMarkerUrl,
    },
  };
}

export function readReleaseDashboardSource(
  env: Readonly<Record<string, string | undefined>>,
  repositoryDefault = "todd-skelton/chase-sets",
): ReleaseDashboardSource {
  const repository =
    readEnv(env, "RELEASE_DASHBOARD_REPOSITORY") ?? readEnv(env, "GITHUB_REPOSITORY") ?? repositoryDefault;
  const productionMarkerSha =
    readEnv(env, "RELEASE_DASHBOARD_PRODUCTION_MARKER_SHA") ?? readEnv(env, "PRODUCTION_MARKER_SHA");

  return {
    repository,
    mainSha: readEnv(env, "RELEASE_DASHBOARD_MAIN_SHA") ?? readEnv(env, "GITHUB_SHA"),
    productionMarkerSha,
    mainCommittedAt: readEnv(env, "RELEASE_DASHBOARD_MAIN_COMMITTED_AT"),
    productionMarkerUpdatedAt: readEnv(env, "RELEASE_DASHBOARD_PRODUCTION_MARKER_UPDATED_AT"),
    latestPrRequired: normalizePhase(readEnv(env, "RELEASE_DASHBOARD_PR_REQUIRED_RESULT")),
    latestPlatformDeploy: normalizePhase(readEnv(env, "RELEASE_DASHBOARD_PLATFORM_DEPLOY_RESULT")),
    latestStagingDeploy: normalizePhase(readEnv(env, "RELEASE_DASHBOARD_STAGING_RESULT")),
    latestProductionDeploy: normalizePhase(readEnv(env, "RELEASE_DASHBOARD_PRODUCTION_RESULT")),
    latestPrRunUrl: readEnv(env, "RELEASE_DASHBOARD_PR_RUN_URL"),
    latestDeployRunUrl: readEnv(env, "RELEASE_DASHBOARD_DEPLOY_RUN_URL"),
    productionMarkerUrl:
      readEnv(env, "RELEASE_DASHBOARD_PRODUCTION_MARKER_URL") ??
      (productionMarkerSha ? `https://github.com/${repository}/tree/production` : null),
    releaseHealth: readReleaseHealthJson(readEnv(env, "RELEASE_DASHBOARD_RELEASE_HEALTH_JSON")),
  };
}

export function loadReleaseDashboardSnapshot(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReleaseDashboardSnapshot {
  return buildReleaseDashboardSnapshot(readReleaseDashboardSource(env), readReleaseLockStatus(env, "production"));
}

function resolvePosture(
  input: Readonly<{
    releaseLock: ReleaseLockStatus;
    productionResult: ReleaseDashboardPhase;
    stagingResult: ReleaseDashboardPhase;
    driftCommits: number | null;
  }>,
): ReleaseDashboardPosture {
  if (input.releaseLock.locked) {
    return "locked";
  }
  if (
    ["failure", "cancelled"].includes(input.productionResult) ||
    ["failure", "cancelled"].includes(input.stagingResult)
  ) {
    return "failed";
  }
  if (input.driftCommits !== null && input.driftCommits > 0) {
    return "drift";
  }
  if (input.driftCommits === 0 && input.productionResult === "success") {
    return "current";
  }
  return "unknown";
}

function explainPosture(
  posture: ReleaseDashboardPosture,
  input: Readonly<{
    releaseLock: ReleaseLockStatus;
    driftCommits: number | null;
    productionResult: ReleaseDashboardPhase;
    stagingResult: ReleaseDashboardPhase;
  }>,
) {
  if (posture === "locked") {
    return `Production promotion is locked: ${input.releaseLock.reason || "reason not recorded"}.`;
  }
  if (posture === "failed") {
    return `Production is not current because the latest deploy health is ${input.productionResult} and staging is ${input.stagingResult}.`;
  }
  if (posture === "drift") {
    return `Production is ${input.driftCommits} commit${input.driftCommits === 1 ? "" : "s"} behind main.`;
  }
  if (posture === "current") {
    return "Production is current with main and the latest production health passed.";
  }
  return "Release state is incomplete until GitHub run metadata and release-health artifacts are available.";
}

function buildCommit(sha: string | null, recordedAt: string | null): ReleaseDashboardCommit {
  return {
    sha,
    shortSha: shortSha(sha),
    recordedAt,
  };
}

function readShaDrift(source: ReleaseDashboardSource) {
  if (!source.mainSha || !source.productionMarkerSha) {
    return null;
  }
  return source.mainSha === source.productionMarkerSha ? 0 : 1;
}

function readReleaseHealthJson(value: string | null): ReleaseHealthRecord | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function formatDrift(commits: number | null, seconds: number | null) {
  const commitLabel = commits === null ? "unknown commits" : `${commits} commit${commits === 1 ? "" : "s"}`;
  return seconds === null ? commitLabel : `${commitLabel} / ${formatSeconds(seconds)}`;
}

function normalizePhase(value: string | null | undefined): ReleaseDashboardPhase {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["success", "failure", "cancelled", "skipped", "unknown"].includes(normalized)
    ? (normalized as ReleaseDashboardPhase)
    : "unknown";
}

function readNumber(value: unknown) {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function shortSha(value: string | null) {
  return value && value.length >= 8 ? value.slice(0, 8) : "unknown";
}

function readEnv(env: Readonly<Record<string, string | undefined>>, name: string) {
  const value = env[name];
  return value && value.trim() ? value.trim() : null;
}

function formatSeconds(seconds: number) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}
