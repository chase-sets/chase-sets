import { t } from "@chase-sets/localization";
import { getCatalogAdminControlPlaneReadModelSlo } from "../api/admin-control-plane-read-model-slos";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import type {
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationControlPlaneOverview } from "./contracts";
import { catalogPrimaryWorkbenchReturnPath } from "./primary-workbench-route-context";

// The overview's own generation age, measured against the canonical
// integration-health-summary SLO (admin-control-plane-read-model-slos.ts),
// is the projection/SLO age signal the health-triage badge and revalidate
// affordance must key off of. A present-but-old overview must NOT read as
// "fresh" just because it is non-null; an absent overview has no data to
// measure and is always "unavailable" rather than fabricating a fresh clock.
function healthTriageFreshness(
  overview: CatalogIntegrationControlPlaneOverview | null,
  now: string,
): CatalogPrimaryWorkbenchHealthTriageReadModel["freshness"] {
  if (!overview) {
    return "unavailable";
  }

  const slo = getCatalogAdminControlPlaneReadModelSlo("integration-health-summary").freshness;
  const ageMs = Date.parse(now) - Date.parse(overview.generatedAt);
  if (!Number.isFinite(ageMs) || ageMs <= slo.freshWithinSeconds * 1_000) {
    return "fresh";
  }
  if (ageMs <= slo.unavailableAfterSeconds * 1_000) {
    return "partial";
  }
  return "unavailable";
}

export function healthTriageFor(input: {
  overview: CatalogIntegrationControlPlaneOverview | null;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  now: string;
}): CatalogPrimaryWorkbenchHealthTriageReadModel {
  // Preserve the overview's own real generated-at provenance whenever one
  // exists (even a stale one); only fall back to the injected clock when no
  // overview was ever produced, and the freshness below never reports that
  // fallback as "fresh".
  const generatedAt = input.overview?.generatedAt ?? input.now;
  const units = input.overview?.readiness.units ?? [];
  const providerRows = (input.overview?.providerReadiness.providers ?? []).map((provider) => {
    const latestDiagnostic = provider.diagnostics.filter((diagnostic) => diagnostic.severity !== "info").at(-1) ?? null;

    return {
      providerKey: provider.providerKey,
      adapterKey: provider.adapterKey,
      status: providerStatus(provider.readiness),
      readiness: provider.readiness,
      credentialReadiness: provider.credentialReadiness,
      credentialReadinessState: provider.credentialReadinessState,
      unitKeys: provider.unitKeys as readonly CatalogIntegrationUnitKey[],
      apiReachability: provider.apiReachability.status,
      optionQueryHealth: provider.optionQueryHealth.status,
      rateLimitStatus: provider.rateLimitStatus.status,
      payloadAcquisition: provider.payloadAcquisition.status,
      usageBudget: provider.usageBudget
        ? {
            creditBalance: provider.usageBudget.creditBalance,
            creditUnit: provider.usageBudget.creditUnit,
            readiness: provider.usageBudget.readiness,
            estimatedCalls: provider.usageBudget.estimatedCalls,
            estimatedScope: provider.usageBudget.estimatedScope,
            refreshedAt: provider.usageBudget.refreshedAt,
          }
        : null,
      diagnosticCodes: [
        ...new Set([
          ...provider.apiReachability.diagnosticCodes,
          ...provider.optionQueryHealth.diagnosticCodes,
          ...provider.rateLimitStatus.diagnosticCodes,
          ...provider.payloadAcquisition.diagnosticCodes,
          ...provider.diagnostics.map((diagnostic) => diagnostic.code),
        ]),
      ],
      latestDiagnosticText:
        latestDiagnostic?.message ??
        provider.apiReachability.message ??
        provider.optionQueryHealth.message ??
        provider.rateLimitStatus.message ??
        provider.payloadAcquisition.message ??
        null,
      ownerMetricKey: providerOwnerMetric(provider),
      nextAction: providerNextAction(provider),
    } satisfies CatalogPrimaryWorkbenchHealthTriageReadModel["providers"][number];
  });
  const rolloutControls = (input.overview?.readiness.rolloutControls.controls ?? []).map((control) => ({
    controlId: control.controlId,
    status: control.status,
    severity: control.severity,
    metricKey: control.metricKey,
    message: control.message,
    providerKeys: control.providerKeys,
    unitKeys: control.unitKeys,
    nextAction:
      control.status === "open"
        ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.rollout.next.open")
        : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.rollout.next.owner"),
  }));
  const unitRows = units.map((unit) => {
    const status = unitStatus(unit);

    return {
      unitKey: unit.unitKey as CatalogIntegrationUnitKey,
      providerKey: unit.providerKey,
      displayName: unit.displayName,
      productDomain: unit.productDomain,
      productForm: unit.productForm,
      ingestionPurpose: unit.ingestionPurpose,
      profileVersion: unit.profileVersion,
      status,
      semanticReadiness: unit.semanticReadiness,
      credentialReadiness: unit.credentialReadiness,
      credentialReadinessState: unit.credentialReadinessState,
      transportReadiness: unit.transportReadiness,
      fixtureValidationStatus: unit.fixtureValidationStatus,
      dryRunStatus: unit.dryRunStatus,
      observationFacts: unit.observationFacts,
      diagnosticCounts: unit.diagnosticCounts,
      diagnosticCodes: unit.diagnostics.map((diagnostic) => diagnostic.code),
      latestDiagnosticText: unit.latestDiagnosticText ?? unit.diagnostics.at(-1)?.message ?? null,
      affectedPrimaryAction: unitAffectedPrimaryAction(unit),
      ownerMetricKey: unitOwnerMetric(unit),
      nextAction: unitNextAction(unit),
    } satisfies CatalogPrimaryWorkbenchHealthTriageReadModel["units"][number];
  });
  const recentJobs = input.importJobs
    .filter((job) => job.state === "queued" || job.state === "running" || job.state === "failed")
    .slice(0, 8)
    .map((job) => ({
      jobId: job.jobId,
      providerKey: job.providerKey,
      unitKey: job.unitKey,
      operatorStatus: job.operatorStatus,
      phase: job.state,
      progressLabel: t("catalog.features.sourceObservations.ui.primaryWorkbench.health.job.progress", {
        completed: String(job.completed),
        total: String(job.total),
        percent: String(job.progressPercent),
      }),
      summary: job.summary,
      ownerMetricKey: job.state === "failed" ? "catalog.integration.job.failed" : "catalog.integration.job.active",
      nextAction:
        job.state === "failed"
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.job.next.failed")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.job.next.active"),
    }));
  const blockedUnits = unitRows.filter((unit) => unit.status === "blocked").length;
  const readyUnits = unitRows.filter((unit) => unit.status === "ready").length;
  const degradedProviders = providerRows.filter((provider) => provider.status !== "ready").length;
  const rolloutStops = rolloutControls.filter((control) => control.status !== "open").length;
  const activeJobs = recentJobs.filter((job) => job.phase === "queued" || job.phase === "running").length;
  const failedJobs = recentJobs.filter((job) => job.phase === "failed").length;
  const auditFreshness =
    !input.overview || input.overview.auditLifecycle.projectionStatus === "unavailable" ? "unavailable" : "partial";
  const status = !input.overview
    ? "unavailable"
    : blockedUnits > 0 || rolloutControls.some((control) => control.status === "blocked")
      ? "blocked"
      : degradedProviders > 0 ||
          unitRows.some((unit) => unit.status === "degraded") ||
          rolloutControls.some((control) => control.status === "degraded") ||
          failedJobs > 0 ||
          input.overview.auditLifecycle.projectionStatus === "unavailable"
        ? "degraded"
        : "ready";

  return {
    status,
    freshness: healthTriageFreshness(input.overview, input.now),
    generatedAt,
    selectedProviderKey: input.routeContext.providerKey,
    selectedUnitKey: input.routeContext.unitKey,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    summary: {
      readyUnits,
      totalUnits: unitRows.length,
      blockedUnits,
      degradedProviders,
      activeJobs,
      rolloutStops,
      auditEntries: input.overview?.auditLifecycle.entries.length ?? 0,
    },
    readModels: [
      readModelState(
        "integration-health-summary",
        input.overview ? "fresh" : "partial",
        input.overview?.readiness.generatedAt ?? null,
        input.overview
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.semantic")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.partial"),
        "catalog.integration.health.generated_at",
      ),
      readModelState(
        "provider-transport-readiness-summary",
        input.overview ? "fresh" : "partial",
        input.overview?.providerReadiness.generatedAt ?? null,
        input.overview
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.transport")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.partial"),
        "catalog.integration.provider_transport.generated_at",
      ),
      readModelState(
        "import-job-progress-summary",
        input.overview ? "fresh" : "partial",
        input.overview?.unitActivity.generatedAt ?? null,
        input.overview
          ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.jobs")
          : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.partial"),
        "catalog.integration.job_progress.generated_at",
      ),
      readModelState(
        "audit-evidence-timeline",
        auditFreshness,
        input.overview?.auditLifecycle.generatedAt ?? null,
        input.overview?.auditLifecycle.statusMessage ??
          t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.audit.unavailable"),
        "catalog.integration.audit.generated_at",
      ),
    ],
    units: unitRows,
    providers: providerRows,
    rolloutControls,
    recentJobs,
    auditPreview: {
      generatedAt: input.overview?.auditLifecycle.generatedAt ?? null,
      projectionStatus: input.overview?.auditLifecycle.projectionStatus ?? "unavailable",
      statusMessage:
        input.overview?.auditLifecycle.statusMessage ??
        t("catalog.features.sourceObservations.ui.primaryWorkbench.health.readModel.audit.unavailable"),
      entries:
        input.overview?.auditLifecycle.entries.slice(0, 6).map((entry) => ({
          eventId: entry.eventId,
          occurredAt: entry.occurredAt,
          eventName: entry.eventName,
          category: entry.category,
          providerKey: entry.providerKey,
          unitKey: entry.unitKey as CatalogIntegrationUnitKey | null,
          summary: entry.summary,
        })) ?? [],
    },
  };
}

function readModelState(
  queryKey: CatalogPrimaryWorkbenchHealthTriageReadModel["readModels"][number]["queryKey"],
  freshness: CatalogPrimaryWorkbenchHealthTriageReadModel["readModels"][number]["freshness"],
  generatedAt: string | null,
  statusMessage: string,
  ownerMetricKey: string,
): CatalogPrimaryWorkbenchHealthTriageReadModel["readModels"][number] {
  return { queryKey, freshness, generatedAt, statusMessage, ownerMetricKey };
}

function unitStatus(
  unit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number],
): CatalogPrimaryWorkbenchHealthTriageReadModel["units"][number]["status"] {
  if (
    unit.semanticReadiness === "blocked" ||
    unit.credentialReadiness === "blocked" ||
    unit.transportReadiness === "blocked" ||
    unit.fixtureValidationStatus === "blocked" ||
    unit.dryRunStatus === "blocked" ||
    unit.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    return "blocked";
  }
  if (unit.diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return "degraded";
  }

  return "ready";
}

function providerStatus(
  readiness: CatalogIntegrationControlPlaneOverview["providerReadiness"]["providers"][number]["readiness"],
): CatalogPrimaryWorkbenchHealthTriageReadModel["providers"][number]["status"] {
  if (readiness === "blocked") {
    return "blocked";
  }
  if (readiness === "degraded") {
    return "degraded";
  }

  return "ready";
}

function unitAffectedPrimaryAction(
  unit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number],
): CatalogPrimaryWorkbenchHealthTriageReadModel["units"][number]["affectedPrimaryAction"] {
  if (unit.transportReadiness === "blocked" || unit.credentialReadiness === "blocked") {
    return "pull-provider-data";
  }
  if (
    unit.diagnostics.some((diagnostic) => diagnostic.source === "provider-adapter" && diagnostic.severity !== "info")
  ) {
    return "pull-provider-data";
  }
  if (
    unit.semanticReadiness === "blocked" ||
    unit.fixtureValidationStatus === "blocked" ||
    unit.dryRunStatus === "blocked"
  ) {
    return "observation.promote";
  }

  return "review-source-observations";
}

function unitOwnerMetric(unit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number]): string {
  if (unit.credentialReadiness === "blocked") {
    return `catalog.integration.credential.${unit.credentialReadinessState}`;
  }
  if (unit.transportReadiness === "blocked") {
    return "catalog.integration.provider_transport.blocked";
  }
  if (unit.semanticReadiness === "blocked") {
    return "catalog.integration.semantic_readiness.blocked";
  }
  if (unit.fixtureValidationStatus === "blocked") {
    return "catalog.integration.fixture_validation.blocked";
  }
  if (unit.dryRunStatus === "blocked") {
    return "catalog.integration.dry_run.blocked";
  }
  if (unit.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return unit.diagnostics.some((diagnostic) => diagnostic.source === "provider-adapter")
      ? "catalog.integration.provider_transport.diagnostic.error"
      : "catalog.integration.semantic_readiness.diagnostic.error";
  }
  if (unit.diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return unit.diagnostics.some((diagnostic) => diagnostic.source === "provider-adapter")
      ? "catalog.integration.provider_transport.diagnostic.warning"
      : "catalog.integration.semantic_readiness.diagnostic.warning";
  }

  return "catalog.integration.unit.ready";
}

function unitNextAction(unit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number]): string {
  if (unit.credentialReadiness === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.credentials");
  }
  if (unit.transportReadiness === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.transport");
  }
  if (unit.semanticReadiness === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.semantic");
  }
  if (unit.fixtureValidationStatus === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.fixtures");
  }
  if (unit.dryRunStatus === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.dryRun");
  }
  if (unit.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return unit.diagnostics.some((diagnostic) => diagnostic.source === "provider-adapter")
      ? t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.transport")
      : t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.semantic");
  }
  if (unit.diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.warning");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.unit.next.ready");
}

function providerOwnerMetric(
  provider: CatalogIntegrationControlPlaneOverview["providerReadiness"]["providers"][number],
): string {
  if (provider.credentialReadiness === "blocked") {
    return `catalog.integration.provider_credential.${provider.credentialReadinessState}`;
  }
  if (provider.apiReachability.status !== "ready" && provider.apiReachability.status !== "unknown") {
    return "catalog.integration.provider_api.reachability";
  }
  if (provider.optionQueryHealth.status !== "ready" && provider.optionQueryHealth.status !== "unknown") {
    return "catalog.integration.provider_options.health";
  }
  if (provider.rateLimitStatus.status !== "ready" && provider.rateLimitStatus.status !== "unknown") {
    return "catalog.integration.provider_rate_limit.status";
  }
  if (provider.payloadAcquisition.status !== "ready" && provider.payloadAcquisition.status !== "unknown") {
    return "catalog.integration.provider_payload.acquisition";
  }

  return "catalog.integration.provider.ready";
}

function providerNextAction(
  provider: CatalogIntegrationControlPlaneOverview["providerReadiness"]["providers"][number],
): string {
  if (provider.credentialReadiness === "blocked") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.credentials");
  }
  if (provider.apiReachability.status === "blocked" || provider.apiReachability.status === "degraded") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.api");
  }
  if (provider.optionQueryHealth.status === "blocked" || provider.optionQueryHealth.status === "degraded") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.options");
  }
  if (provider.rateLimitStatus.status === "blocked" || provider.rateLimitStatus.status === "degraded") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.rateLimit");
  }
  if (provider.payloadAcquisition.status === "blocked" || provider.payloadAcquisition.status === "degraded") {
    return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.payload");
  }

  return t("catalog.features.sourceObservations.ui.primaryWorkbench.health.provider.next.ready");
}
