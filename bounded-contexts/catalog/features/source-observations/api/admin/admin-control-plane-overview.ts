import { t } from "@chase-sets/localization";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type { CatalogAdminProfileVersionPointer } from "./admin-control-plane-read-model-contracts";
import type {
  CatalogIntegrationControlPlaneDiagnostic,
  CatalogIntegrationControlPlaneReadiness,
  CatalogIntegrationControlPlaneUnitReadiness,
  SourceObservationIntegrationJob,
  SourceObservationIntegrationJobResult,
  SourceObservationIntegrationProfileSnapshot,
  SourceObservationReapplyProfileMode,
} from "../runtime";
import type { CatalogProviderProfileVersionReview } from "../providers/provider-profile-review";

export type CatalogIntegrationControlPlaneOverview = Readonly<{
  generatedAt: string;
  readiness: CatalogIntegrationControlPlaneReadiness;
  unitActivity: CatalogIntegrationUnitActivitySummary;
  providerReadiness: CatalogIntegrationProviderReadinessSummary;
  auditLifecycle: CatalogIntegrationAuditLifecycleSummary;
}>;

export type CatalogIntegrationUnitActivitySummary = Readonly<{
  generatedAt: string;
  units: readonly CatalogIntegrationUnitActivity[];
}>;

export type CatalogIntegrationUnitActivity = Readonly<{
  unitKey: CatalogIntegrationUnitKey;
  recentJobs: readonly CatalogIntegrationRecentJobSummary[];
}>;

export type CatalogIntegrationRecentJobSummary = Readonly<{
  jobId: string;
  action: SourceObservationIntegrationJob["action"];
  operatorStatus: SourceObservationIntegrationJob["operatorStatus"];
  phase: SourceObservationIntegrationJob["progress"]["phase"];
  completed: number;
  total: number;
  unitKey: CatalogIntegrationUnitKey | null;
  providerKey: string;
  importScope: string | null;
  profileVersion: string | null;
  profileSnapshot: CatalogAdminProfileVersionPointer | null;
  reapplyProfileMode: SourceObservationReapplyProfileMode | null;
  result: CatalogIntegrationRecentJobResultSummary | null;
  startedAt: string | null;
  createdAt: string;
  summary: string;
}>;

export type CatalogIntegrationRecentJobResultSummary = Readonly<{
  requested: number;
  imported: number;
  observed: number;
  reapplied: number;
  skipped: number;
  failed: number;
  outcomeCount: number;
  redactedFailureReasons: readonly string[];
  usage: CatalogIntegrationRecentJobUsageSummary | null;
}>;

// Counts are deliberately the only execution data retained in the support
// summary. Provider credit values, account identifiers, and raw responses stay
// in the provider boundary and never cross into the control-plane surface.
export type CatalogIntegrationRecentJobUsageSummary = Readonly<{
  actualRequestCount: number | null;
  pageCount: number | null;
  cacheHitCount: number | null;
  cacheMissCount: number | null;
}>;

export type CatalogIntegrationProviderReadinessSummary = Readonly<{
  generatedAt: string;
  providers: readonly CatalogIntegrationProviderReadiness[];
}>;

export type CatalogIntegrationProviderReadiness = Readonly<{
  providerKey: string;
  adapterKey: string;
  readiness: "ready" | "blocked" | "degraded";
  credentialReadiness: "ready" | "blocked" | "not-required";
  credentialReadinessState: CatalogIntegrationControlPlaneUnitReadiness["credentialReadinessState"];
  credentialRequirement: CatalogIntegrationControlPlaneUnitReadiness["credentialRequirement"];
  unitKeys: readonly CatalogIntegrationUnitKey[];
  apiReachability: CatalogIntegrationProviderCapabilityStatus;
  optionQueryHealth: CatalogIntegrationProviderCapabilityStatus;
  rateLimitStatus: CatalogIntegrationProviderCapabilityStatus;
  payloadAcquisition: CatalogIntegrationProviderCapabilityStatus;
  usageBudget: CatalogIntegrationProviderUsageBudget | null;
  diagnostics: readonly CatalogIntegrationControlPlaneDiagnostic[];
}>;

export type CatalogIntegrationProviderUsageBudget = Readonly<{
  creditBalance: number | null;
  creditUnit: string | null;
  readiness: "ready" | "degraded" | "blocked" | "unknown";
  estimatedCalls: number | null;
  estimatedScope: string | null;
  refreshedAt: string | null;
}>;

export type CatalogIntegrationProviderCapabilityStatus = Readonly<{
  status: "ready" | "blocked" | "degraded" | "unknown";
  diagnosticCodes: readonly string[];
  message: string | null;
}>;

export type CatalogIntegrationAuditLifecycleSummary = Readonly<{
  generatedAt: string;
  projectionStatus: "partial" | "unavailable";
  statusMessage: string;
  entries: readonly CatalogIntegrationAuditLifecycleEntry[];
}>;

export type CatalogIntegrationAuditLifecycleEntry = Readonly<{
  eventId: string;
  occurredAt: string;
  eventName:
    | "profile-created"
    | "profile-section-edited"
    | "profile-activated"
    | "profile-deprecated"
    | "profile-rolled-back"
    | "profile-retired"
    | "import-job-started"
    | "reapply-run-executed";
  category: "profile" | "profile-section" | "activation" | "import-job" | "reapply";
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey | null;
  profileVersion: string | null;
  actorUserId: string | null;
  relatedJobId: string | null;
  summary: string;
  diagnosticCodes: readonly string[];
}>;

// Which audience the overview is being assembled for. The daily import-to-promotion
// surface renders the metric strip, the import-jobs activity strip, and the
// provider-scope selector — derived from `readiness`, `unitActivity`, and
// `providerReadiness`. It never reads the audit-lifecycle entries (those feed only
// the governance/release evidence slices), so `daily` skips assembling that
// projection: the (churn-sized, ~11% of the at-scale payload) audit window is neither
// computed server-side nor serialized for the highest-traffic surface. The
// `auditLifecycle` field stays present as its "unavailable" sentinel so the contract
// shape — and every consumer that reads `projectionStatus`/`entries` — is unchanged.
export type CatalogIntegrationControlPlaneOverviewAudience = "full" | "daily";

const dailyAuditLifecycleStatusMessage =
  "Lifecycle audit evidence is not assembled for the daily import surface; open the governance or release surface for the full lifecycle timeline.";

export function buildCatalogIntegrationControlPlaneOverview(input: {
  readiness: CatalogIntegrationControlPlaneReadiness;
  profiles: readonly CatalogProviderProfileVersionReview[];
  activeJobs: readonly SourceObservationIntegrationJob[];
  generatedAt?: string;
  audience?: CatalogIntegrationControlPlaneOverviewAudience;
}): CatalogIntegrationControlPlaneOverview {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const audience = input.audience ?? "full";

  return {
    generatedAt,
    readiness: input.readiness,
    unitActivity: {
      generatedAt,
      units: buildUnitActivity(input.readiness.units, input.activeJobs),
    },
    providerReadiness: {
      generatedAt,
      providers: buildProviderReadiness(input.readiness.units),
    },
    auditLifecycle:
      audience === "daily"
        ? {
            generatedAt,
            projectionStatus: "unavailable",
            statusMessage: dailyAuditLifecycleStatusMessage,
            entries: [],
          }
        : {
            generatedAt,
            projectionStatus: "partial",
            statusMessage:
              "Lifecycle audit is assembled from current profile and active job metadata until the append-only audit projection is available.",
            entries: buildAuditLifecycleEntries(input.profiles, input.activeJobs, input.readiness.units, generatedAt),
          },
  };
}

// Parse the audience query parameter for the overview endpoint. Defaults to `full`
// so existing callers and the providers/governance/release surfaces keep receiving
// the complete overview; only an explicit `?audience=daily` opts into the
// audit-lifecycle-trimmed projection.
export function parseCatalogIntegrationControlPlaneOverviewAudience(
  value: string | undefined,
): CatalogIntegrationControlPlaneOverviewAudience {
  return value === "daily" ? "daily" : "full";
}

function buildUnitActivity(
  units: readonly CatalogIntegrationControlPlaneUnitReadiness[],
  jobs: readonly SourceObservationIntegrationJob[],
): readonly CatalogIntegrationUnitActivity[] {
  const maxRecentJobsPerUnit = 10;
  const providerUnits = new Map<string, readonly CatalogIntegrationControlPlaneUnitReadiness[]>();
  for (const unit of units) {
    providerUnits.set(unit.providerKey, [...(providerUnits.get(unit.providerKey) ?? []), unit]);
  }

  return units.map((unit) => ({
    unitKey: unit.unitKey,
    recentJobs: jobs
      .filter((job) => jobMatchesUnit(job, unit, providerUnits.get(unit.providerKey) ?? []))
      .sort((left, right) => jobOccurredAt(right).localeCompare(jobOccurredAt(left)))
      .slice(0, maxRecentJobsPerUnit)
      .map((job) => jobSummary(job, unit.providerKey, unit.unitKey)),
  }));
}

function jobMatchesUnit(
  job: SourceObservationIntegrationJob,
  unit: CatalogIntegrationControlPlaneUnitReadiness,
  providerUnits: readonly CatalogIntegrationControlPlaneUnitReadiness[],
): boolean {
  if (jobProviderKey(job) !== unit.providerKey) {
    return false;
  }

  const unitKey = jobIntegrationUnitKey(job);
  if (unitKey) {
    return unitKey === unit.unitKey;
  }

  return providerUnits.length === 1;
}

function buildProviderReadiness(
  units: readonly CatalogIntegrationControlPlaneUnitReadiness[],
): readonly CatalogIntegrationProviderReadiness[] {
  const providers = new Map<string, CatalogIntegrationControlPlaneUnitReadiness[]>();
  for (const unit of units) {
    providers.set(unit.providerKey, [...(providers.get(unit.providerKey) ?? []), unit]);
  }

  return [...providers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([providerKey, providerUnits]) => {
      const diagnostics = dedupeDiagnostics(
        providerUnits.flatMap((unit) =>
          unit.diagnostics.filter((diagnostic) => diagnostic.source === "provider-adapter"),
        ),
      );
      const credentialBlocker = providerUnits.find((unit) => unit.credentialReadiness === "blocked");
      const requiredCredential = providerUnits.find((unit) => unit.credentialRequirement === "required");
      const anyTransportBlocked = providerUnits.some((unit) => unit.transportReadiness === "blocked");
      const anyWarning = diagnostics.some((diagnostic) => diagnostic.severity === "warning");

      return {
        providerKey,
        adapterKey: providerKey,
        readiness: credentialBlocker || anyTransportBlocked ? "blocked" : anyWarning ? "degraded" : "ready",
        credentialReadiness:
          credentialBlocker?.credentialReadiness ??
          requiredCredential?.credentialReadiness ??
          providerUnits[0]?.credentialReadiness ??
          "blocked",
        credentialReadinessState:
          credentialBlocker?.credentialReadinessState ??
          requiredCredential?.credentialReadinessState ??
          providerUnits[0]?.credentialReadinessState ??
          "unknown",
        credentialRequirement: requiredCredential?.credentialRequirement ?? "not-required",
        unitKeys: providerUnits.map((unit) => unit.unitKey),
        apiReachability: summarizeCapability(diagnostics, ["api", "reachability", "network", "http", "authentication"]),
        optionQueryHealth: summarizeCapability(diagnostics, ["option", "query"]),
        rateLimitStatus: summarizeCapability(diagnostics, ["rate-limit", "cooldown", "throttle"]),
        payloadAcquisition: summarizeCapability(diagnostics, ["payload", "fetch", "acquisition", "fixture"]),
        usageBudget: null,
        diagnostics,
      };
    });
}

function buildAuditLifecycleEntries(
  profiles: readonly CatalogProviderProfileVersionReview[],
  jobs: readonly SourceObservationIntegrationJob[],
  units: readonly CatalogIntegrationControlPlaneUnitReadiness[],
  generatedAt: string,
): readonly CatalogIntegrationAuditLifecycleEntry[] {
  return [
    ...profiles.flatMap((profile) => profileAuditEntries(profile, units, generatedAt)),
    ...jobs.map((job) => jobAuditEntry(job, units)),
  ]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, 12);
}

function profileAuditEntries(
  profile: CatalogProviderProfileVersionReview,
  units: readonly CatalogIntegrationControlPlaneUnitReadiness[],
  generatedAt: string,
): readonly CatalogIntegrationAuditLifecycleEntry[] {
  const unitKey = matchingUnitKey(profile.providerKey, units, profile.ingestionUnitKey);
  const entries: CatalogIntegrationAuditLifecycleEntry[] = [];
  const createdAt = profile.authoringAudit?.createdAt ?? null;
  const updatedAt = profile.authoringAudit?.updatedAt ?? null;

  if (createdAt) {
    entries.push({
      eventId: `profile-created:${profile.providerKey}:${profile.profileVersion}`,
      occurredAt: createdAt,
      eventName: "profile-created",
      category: "profile",
      providerKey: profile.providerKey,
      unitKey,
      profileVersion: profile.profileVersion,
      actorUserId: profile.authoringAudit?.createdByUserId ?? null,
      relatedJobId: null,
      summary: t("catalog.features.sourceObservations.api.adminControlPlaneOverview.profile.created", {
        displayName: profile.displayName,
        profileVersion: profile.profileVersion,
      }),
      diagnosticCodes: profile.validation.diagnostics.map((diagnostic) => diagnostic.code),
    });
  }

  if (updatedAt) {
    entries.push({
      eventId: `profile-edited:${profile.providerKey}:${profile.profileVersion}`,
      occurredAt: updatedAt,
      eventName: "profile-section-edited",
      category: "profile-section",
      providerKey: profile.providerKey,
      unitKey,
      profileVersion: profile.profileVersion,
      actorUserId: profile.authoringAudit?.updatedByUserId ?? null,
      relatedJobId: null,
      summary: t("catalog.features.sourceObservations.api.adminControlPlaneOverview.profile.sections.edited", {
        displayName: profile.displayName,
        profileVersion: profile.profileVersion,
      }),
      diagnosticCodes: profile.validation.diagnostics.map((diagnostic) => diagnostic.code),
    });
  }

  const lifecycleEvent = lifecycleEventName(profile.lifecycle);
  if (lifecycleEvent) {
    entries.push({
      eventId: `${lifecycleEvent}:${profile.providerKey}:${profile.profileVersion}`,
      occurredAt: updatedAt ?? createdAt ?? generatedAt,
      eventName: lifecycleEvent,
      category: "activation",
      providerKey: profile.providerKey,
      unitKey,
      profileVersion: profile.profileVersion,
      actorUserId: profile.authoringAudit?.updatedByUserId ?? profile.authoringAudit?.createdByUserId ?? null,
      relatedJobId: null,
      summary: t("catalog.features.sourceObservations.api.adminControlPlaneOverview.profile.lifecycle", {
        displayName: profile.displayName,
        profileVersion: profile.profileVersion,
        lifecycle: profile.lifecycle,
      }),
      diagnosticCodes: profile.validation.diagnostics.map((diagnostic) => diagnostic.code),
    });
  }

  return entries;
}

function jobAuditEntry(
  job: SourceObservationIntegrationJob,
  units: readonly CatalogIntegrationControlPlaneUnitReadiness[],
): CatalogIntegrationAuditLifecycleEntry {
  const providerKey = jobProviderKey(job);
  return {
    eventId: `job:${job.jobId}`,
    occurredAt: jobOccurredAt(job),
    eventName: job.action === "import" ? "import-job-started" : "reapply-run-executed",
    category: job.action === "import" ? "import-job" : "reapply",
    providerKey,
    unitKey: matchingUnitKey(providerKey, units, jobIntegrationUnitKey(job)),
    profileVersion: job.profileSnapshot?.profileVersion ?? null,
    actorUserId: null,
    relatedJobId: job.jobId,
    summary: t("catalog.features.sourceObservations.api.adminControlPlaneOverview.job.summary", {
      action: job.action,
      jobId: job.jobId,
      operatorStatus: job.operatorStatus,
      completed: String(job.progress.completed),
      total: String(job.progress.total),
    }),
    diagnosticCodes: job.errorMessage ? ["job-error"] : [],
  };
}

function jobSummary(
  job: SourceObservationIntegrationJob,
  providerKey: string,
  unitKey: CatalogIntegrationUnitKey | null,
): CatalogIntegrationRecentJobSummary {
  return {
    jobId: job.jobId,
    action: job.action,
    operatorStatus: job.operatorStatus,
    phase: job.progress.phase,
    completed: job.progress.completed,
    total: job.progress.total,
    unitKey: jobIntegrationUnitKey(job) ?? unitKey,
    providerKey,
    importScope: importScopeForIntegrationJob(job.scope),
    profileVersion: job.profileSnapshot?.profileVersion ?? null,
    profileSnapshot: profileSnapshotPointer(job.profileSnapshot),
    reapplyProfileMode: job.reapplyProfileMode,
    result: jobResultSummary(job.result),
    startedAt: job.startedAt ?? null,
    createdAt: job.createdAt,
    summary: t("catalog.features.sourceObservations.api.adminControlPlaneOverview.job.summary", {
      action: job.action,
      jobId: job.jobId,
      operatorStatus: job.operatorStatus,
      completed: String(job.progress.completed),
      total: String(job.progress.total),
    }),
  };
}

function jobResultSummary(
  result: SourceObservationIntegrationJobResult | null,
): CatalogIntegrationRecentJobResultSummary | null {
  if (!result) {
    return null;
  }

  return {
    requested: result.requested,
    imported: result.imported,
    observed: result.observed,
    reapplied: result.reapplied,
    skipped: result.skipped,
    failed: result.failed,
    outcomeCount: result.outcomes.length,
    redactedFailureReasons: redactedJobFailureReasons(result),
    usage: jobUsageSummary(result),
  };
}

function jobUsageSummary(
  result: SourceObservationIntegrationJobResult,
): CatalogIntegrationRecentJobUsageSummary | null {
  const evidence = result.outcomes.map((outcome) => outcome.providerUsageEvidence ?? null);
  if (evidence.every((value) => value === null)) {
    return null;
  }

  return {
    actualRequestCount: summedUsageCount(evidence, (value) => value.actualRequestCount),
    pageCount: summedUsageCount(evidence, (value) => value.pageCount),
    cacheHitCount: summedUsageCount(evidence, (value) => value.cacheHitCount),
    cacheMissCount: summedUsageCount(evidence, (value) => value.cacheMissCount),
  };
}

function summedUsageCount(
  evidence: readonly (NonNullable<
    SourceObservationIntegrationJobResult["outcomes"][number]["providerUsageEvidence"]
  > | null)[],
  select: (
    value: NonNullable<SourceObservationIntegrationJobResult["outcomes"][number]["providerUsageEvidence"]>,
  ) => number | null,
): number | null {
  const counts = evidence.map((value) => (value === null ? null : select(value)));
  return counts.every((value) => value !== null) ? counts.reduce((total, value) => total + (value ?? 0), 0) : null;
}

function redactedJobFailureReasons(result: SourceObservationIntegrationJobResult): readonly string[] {
  const reasons = new Set<string>();
  for (const outcome of result.outcomes) {
    if (outcome.status !== "failed") {
      continue;
    }
    const reason = redactedCatalogJobFailureReason(outcome.reason);
    if (reason) {
      reasons.add(reason);
    }
    if (reasons.size >= 3) {
      break;
    }
  }
  return [...reasons];
}

export function redactedCatalogJobFailureReason(reason: string | null): string | null {
  const normalized = reason?.trim().replace(/\s+/g, " ") ?? "";
  if (!normalized) {
    return null;
  }

  return normalized
    .replace(/https?:\/\/[^\s),]+/gi, redactUrl)
    .replace(
      /\b(api[-_ ]?key|x-api-key|team[-_ ]?id|x-team-id|authorization|bearer|token|secret|password)(\s*[=:]\s*)([^\s,;]+)/gi,
      "$1$2[redacted]",
    )
    .slice(0, 240);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[redacted-url]";
  }
}

function profileSnapshotPointer(
  snapshot: SourceObservationIntegrationProfileSnapshot | null,
): CatalogAdminProfileVersionPointer | null {
  if (!snapshot) {
    return null;
  }

  return {
    schemaVersion: "catalog-provider-profile-version-v1",
    compatibilityPolicy: "provider-profile-version",
    providerKey: snapshot.providerKey,
    profileKey: snapshot.profileKey,
    profileVersion: snapshot.profileVersion,
    lifecycle: snapshot.lifecycle,
    active: snapshot.lifecycle === "active",
    connectorKind: snapshot.connectorKind,
    connectorSourceVersion: snapshot.connectorSourceVersion,
    sourceMappingFingerprint: snapshot.sourceMappingFingerprint,
  };
}

function importScopeForIntegrationJob(scope: SourceObservationIntegrationJob["scope"]): string | null {
  const terminalScope = scope.setId ?? scope.productId ?? scope.setName ?? null;
  const value = [scope.language, scope.productLineId, scope.seriesId, terminalScope].filter(Boolean).join(":");

  return value || null;
}

function jobProviderKey(job: SourceObservationIntegrationJob): string {
  return job.profileSnapshot?.providerKey ?? job.scope.provider ?? "unknown";
}

function jobIntegrationUnitKey(job: SourceObservationIntegrationJob): CatalogIntegrationUnitKey | null {
  return ((job.profileSnapshot?.ingestionUnitKey ?? job.scope.ingestionUnitKey ?? null) ||
    null) as CatalogIntegrationUnitKey | null;
}

function jobOccurredAt(job: SourceObservationIntegrationJob): string {
  return job.startedAt ?? job.createdAt;
}

function lifecycleEventName(
  lifecycle: CatalogProviderProfileVersionReview["lifecycle"],
): CatalogIntegrationAuditLifecycleEntry["eventName"] | null {
  if (lifecycle === "active") {
    return "profile-activated";
  }
  if (lifecycle === "deprecated") {
    return "profile-deprecated";
  }
  if (lifecycle === "retired") {
    return "profile-retired";
  }
  return null;
}

function matchingUnitKey(
  providerKey: string,
  units: readonly CatalogIntegrationControlPlaneUnitReadiness[],
  preferredUnitKey?: CatalogIntegrationUnitKey | string | null,
): CatalogIntegrationUnitKey | null {
  const providerUnits = units.filter((unit) => unit.providerKey === providerKey);
  if (preferredUnitKey) {
    return providerUnits.find((unit) => unit.unitKey === preferredUnitKey)?.unitKey ?? null;
  }

  return providerUnits.length === 1 ? providerUnits[0]!.unitKey : null;
}

function dedupeDiagnostics(
  diagnostics: readonly CatalogIntegrationControlPlaneDiagnostic[],
): readonly CatalogIntegrationControlPlaneDiagnostic[] {
  const seen = new Set<string>();
  const result: CatalogIntegrationControlPlaneDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.code,
      diagnostic.severity,
      diagnostic.message,
      diagnostic.unitKey ?? "",
      diagnostic.retryAfterSeconds ?? "",
      diagnostic.source,
    ].join("\u0000");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(diagnostic);
  }

  return result;
}

function summarizeCapability(
  diagnostics: readonly CatalogIntegrationControlPlaneDiagnostic[],
  tokens: readonly string[],
): CatalogIntegrationProviderCapabilityStatus {
  const matches = diagnostics.filter((diagnostic) => {
    const haystack = `${diagnostic.code} ${diagnostic.message}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });
  const blocker = matches.find((diagnostic) => diagnostic.severity === "error");
  const warning = matches.find((diagnostic) => diagnostic.severity === "warning");

  if (blocker) {
    return {
      status: "blocked",
      diagnosticCodes: matches.map((diagnostic) => diagnostic.code),
      message: blocker.message,
    };
  }
  if (warning) {
    return {
      status: "degraded",
      diagnosticCodes: matches.map((diagnostic) => diagnostic.code),
      message: warning.message,
    };
  }
  if (matches.length > 0) {
    return {
      status: "ready",
      diagnosticCodes: matches.map((diagnostic) => diagnostic.code),
      message: matches.at(-1)?.message ?? null,
    };
  }

  return {
    status: "unknown",
    diagnosticCodes: [],
    message: null,
  };
}
