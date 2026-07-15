import { t } from "@chase-sets/localization";
import {
  catalogPrimaryWorkbenchActions,
  catalogPrimaryWorkbenchRetirementPolicy,
  type CatalogPrimaryWorkbenchActionReadModel,
  type CatalogPrimaryWorkbenchBlockerCategory,
  type CatalogPrimaryWorkbenchCommandKey,
  type CatalogPrimaryWorkbenchHealthTriageReadModel,
  type CatalogPrimaryWorkbenchReadModel,
  type CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationControlPlaneOverview } from "./contracts";
import {
  catalogPrimaryWorkbenchReturnPath,
  catalogPrimaryWorkbenchSupportingHref,
} from "./primary-workbench-route-context";
import type { ConflictResolution } from "./primary-workbench-conflict-resolution";

export type GovernanceControls = CatalogPrimaryWorkbenchReadModel["governanceControls"];
export type GovernanceControlRow = GovernanceControls["controls"][number];
export type GovernanceRbacRow = GovernanceControls["rbacMatrix"][number];
export type GovernanceObservabilitySignal = GovernanceControls["observability"]["signals"][number];

const catalogIntegrationGrafanaDashboardHref =
  "https://grafana.chasesets.com/d/chase-sets-catalog-control-plane/catalog-integration-control-plane";
const catalogIntegrationOperationsRunbookHref =
  "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/catalog-integration-operations.md";

export function governanceControlsFor(input: {
  actions: readonly CatalogPrimaryWorkbenchActionReadModel[];
  canManage: boolean;
  conflictResolution: ConflictResolution;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  healthTriage: CatalogPrimaryWorkbenchHealthTriageReadModel;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  rolloutEnabled: boolean;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
}): GovernanceControls {
  const auditEvidenceUrl = catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence");
  const rolloutControls = input.controlPlaneOverview?.readiness.rolloutControls.controls ?? [];
  const activeRolloutStops = rolloutControls.filter((control) => control.status === "blocked").length;
  const controls = [
    ...rolloutControls.map((control) =>
      governanceRolloutControlFor(control, {
        auditEvidenceUrl,
      }),
    ),
    governanceWorkerControlFor({
      activeRolloutStops,
      auditEvidenceUrl,
      importJobs: input.importJobs,
    }),
    governanceLegacyRemovalControlFor(auditEvidenceUrl),
  ];
  const rbacMatrix = governanceRbacMatrixFor({
    actions: input.actions,
    canManage: input.canManage,
  });
  const observability = governanceObservabilityFor({
    auditEvidenceUrl,
    conflictResolution: input.conflictResolution,
    generatedAt: input.controlPlaneOverview?.generatedAt ?? null,
    healthTriage: input.healthTriage,
    importJobs: input.importJobs,
    overviewAvailable: Boolean(input.controlPlaneOverview),
    readinessBlockers: input.readinessBlockers,
    sourceObservationReview: input.sourceObservationReview,
  });
  const degradedSignals = observability.signals.filter((signal) => signal.status !== "ready").length;
  const alertCount = observability.signals.reduce((total, signal) => total + signal.alertLinks.length, 0);
  const deniedCommands = rbacMatrix.filter((entry) => entry.state === "denied").length;
  const blockedCommands = rbacMatrix.filter((entry) => entry.state === "blocked" || entry.state === "unsafe").length;
  const legacyRemovalEvidence = governanceLegacyRemovalEvidenceFor(auditEvidenceUrl);
  const status: GovernanceControls["status"] =
    !input.controlPlaneOverview && degradedSignals > 0
      ? "degraded"
      : activeRolloutStops > 0 || deniedCommands > 0 || blockedCommands > 0
        ? "blocked"
        : degradedSignals > 0
          ? "degraded"
          : "ready";

  return {
    status,
    freshness: input.controlPlaneOverview ? "fresh" : "partial",
    generatedAt: input.generatedAt,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    auditEvidenceUrl,
    summary: {
      activeRolloutStops,
      deniedCommands,
      blockedCommands,
      degradedSignals,
      alertCount,
      deletionEvidenceCount: legacyRemovalEvidence.evidence.length,
    },
    rolloutMode: {
      label:
        activeRolloutStops > 0
          ? "Staged rollout stopped"
          : rolloutControls.length > 0
            ? "Staged rollout open"
            : "Launch rollout open",
      state:
        activeRolloutStops > 0
          ? "stopped"
          : rolloutControls.some((control) => control.status === "degraded")
            ? "degraded"
            : rolloutControls.length > 0
              ? "staged"
              : "open",
      rolloutEnabled: input.rolloutEnabled,
      workerState: activeRolloutStops > 0 ? "paused" : input.controlPlaneOverview ? "running" : "unknown",
      providerEmergencyStopCount: rolloutControls.filter((control) => control.defaultState === "quarantined").length,
      importKillSwitchActive: hasCapabilityStop(rolloutControls, "import"),
      promotionKillSwitchActive: hasCapabilityStop(rolloutControls, "promotion"),
      reapplyKillSwitchActive: hasCapabilityStop(rolloutControls, "reapply"),
    },
    controls,
    rbacMatrix,
    observability,
    legacyRemovalEvidence,
  };
}

function governanceRolloutControlFor(
  control: CatalogIntegrationControlPlaneOverview["readiness"]["rolloutControls"]["controls"][number],
  input: { auditEvidenceUrl: string },
): GovernanceControlRow {
  const commandKeys = governanceControlCommandKeys(control.capabilities);
  const blockers = governanceControlBlockers(control);

  return {
    controlId: control.controlId,
    kind: governanceControlKind(control, commandKeys),
    label: governanceControlLabel(control, commandKeys),
    status: control.status,
    metricKey: control.metricKey,
    evidenceUrl: input.auditEvidenceUrl,
    commandKeys,
    blockers,
    providerKeys: control.providerKeys,
    unitKeys: control.unitKeys,
    message: control.message,
  };
}

function governanceWorkerControlFor(input: {
  activeRolloutStops: number;
  auditEvidenceUrl: string;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
}): GovernanceControlRow {
  const activeJobs = input.importJobs.filter((job) => job.state === "queued" || job.state === "running").length;
  const paused = input.activeRolloutStops > 0;

  return {
    controlId: "catalog-import-worker-state",
    kind: "worker-pause",
    label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.worker.label"),
    status: paused ? "blocked" : "open",
    metricKey: "catalog.integration.worker.state",
    evidenceUrl: input.auditEvidenceUrl,
    commandKeys: ["scope.import", "observation.reapply", "observation.replay"],
    blockers: paused ? ["kill-switch-active"] : [],
    providerKeys: [],
    unitKeys: [],
    message: paused
      ? t("catalog.features.sourceObservations.ui.governanceControls.readModel.worker.paused")
      : t("catalog.features.sourceObservations.ui.governanceControls.readModel.worker.running", {
          count: activeJobs,
        }),
  };
}

function governanceLegacyRemovalControlFor(auditEvidenceUrl: string): GovernanceControlRow {
  return {
    controlId: "catalog-retired-compatibility-removal",
    kind: "legacy-removal",
    label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.label"),
    status: "removed",
    metricKey: "catalog.integration.retired_surfaces.removed",
    evidenceUrl: auditEvidenceUrl,
    commandKeys: [],
    blockers: ["raw-json-retired", "legacy-selector-retired"],
    providerKeys: [],
    unitKeys: [],
    message: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.message"),
  };
}

function governanceControlCommandKeys(capabilities: readonly string[]): readonly CatalogPrimaryWorkbenchCommandKey[] {
  const text = capabilities.join(" ").toLowerCase();
  const keys = new Set<CatalogPrimaryWorkbenchCommandKey>();
  if (text.includes("import") || text.includes("source-observation")) {
    keys.add("scope.import");
  }
  if (text.includes("promotion") || text.includes("promote")) {
    keys.add("observation.promote");
    keys.add("observation.promote");
  }
  if (text.includes("reapply")) {
    keys.add("observation.reapply");
  }
  if (text.includes("replay")) {
    keys.add("observation.replay");
  }
  if (keys.size === 0) {
    keys.add("scope.import");
    keys.add("observation.promote");
    keys.add("observation.promote");
  }

  return [...keys];
}

function governanceControlBlockers(
  control: CatalogIntegrationControlPlaneOverview["readiness"]["rolloutControls"]["controls"][number],
): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  if (control.status !== "blocked") {
    return [];
  }

  return [control.defaultState === "quarantined" ? "kill-switch-active" : "rollout-disabled"];
}

function governanceControlKind(
  control: CatalogIntegrationControlPlaneOverview["readiness"]["rolloutControls"]["controls"][number],
  commandKeys: readonly CatalogPrimaryWorkbenchCommandKey[],
): GovernanceControlRow["kind"] {
  if (control.defaultState === "quarantined") {
    return "provider-emergency-stop";
  }
  if (commandKeys.includes("scope.import")) {
    return "import-kill-switch";
  }
  if (commandKeys.includes("observation.promote")) {
    return "promotion-kill-switch";
  }
  if (commandKeys.includes("observation.reapply") || commandKeys.includes("observation.replay")) {
    return "reapply-kill-switch";
  }

  return "staged-rollout";
}

function governanceControlLabel(
  control: CatalogIntegrationControlPlaneOverview["readiness"]["rolloutControls"]["controls"][number],
  commandKeys: readonly CatalogPrimaryWorkbenchCommandKey[],
): string {
  if (control.defaultState === "quarantined") {
    return "Provider emergency stop";
  }
  if (commandKeys.includes("scope.import")) {
    return "Provider import kill switch";
  }
  if (commandKeys.includes("observation.promote")) {
    return "Promotion kill switch";
  }
  if (commandKeys.includes("observation.reapply") || commandKeys.includes("observation.replay")) {
    return "Reapply/replay kill switch";
  }

  return "Staged rollout control";
}

function hasCapabilityStop(
  controls: readonly CatalogIntegrationControlPlaneOverview["readiness"]["rolloutControls"]["controls"][number][],
  capability: "import" | "promotion" | "reapply",
): boolean {
  return controls.some((control) => {
    if (control.status !== "blocked") {
      return false;
    }
    const keys = governanceControlCommandKeys(control.capabilities);
    switch (capability) {
      case "import":
        return keys.includes("scope.import");
      case "promotion":
        return keys.includes("observation.promote");
      case "reapply":
        return keys.includes("observation.reapply") || keys.includes("observation.replay");
    }
  });
}

function governanceRbacMatrixFor(input: {
  actions: readonly CatalogPrimaryWorkbenchActionReadModel[];
  canManage: boolean;
}): readonly GovernanceRbacRow[] {
  const readModelActions = new Map(input.actions.map((actionEntry) => [actionEntry.key, actionEntry]));

  return catalogPrimaryWorkbenchActions
    .filter((actionEntry) => actionEntry.requiredPermission === "catalog.manage" || actionEntry.confirmationRequired)
    .map((actionEntry) => {
      const readModelAction = readModelActions.get(actionEntry.key);
      const blockers = readModelAction?.blockers ?? (input.canManage ? ["unsupported-command"] : ["permission-denied"]);
      const state =
        blockers.includes("permission-denied") || blockers.includes("authorization-denied")
          ? "denied"
          : (readModelAction?.state ?? (input.canManage ? "unavailable" : "denied"));

      return {
        actionKey: actionEntry.key,
        requiredPermission: actionEntry.requiredPermission,
        routePattern: actionEntry.routePattern,
        state,
        blockers,
        confirmationRequired: actionEntry.confirmationRequired,
        destructive: actionEntry.confirmationRequired,
        deniedCopy:
          state === "denied"
            ? "catalog.manage is required; the command remains denied and no bypass is exposed."
            : `${actionEntry.requiredPermission} checked; command state is ${state}.`,
      } satisfies GovernanceRbacRow;
    });
}

function governanceObservabilityFor(input: {
  auditEvidenceUrl: string;
  conflictResolution: ConflictResolution;
  generatedAt: string | null;
  healthTriage: CatalogPrimaryWorkbenchHealthTriageReadModel;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  overviewAvailable: boolean;
  readinessBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
}): GovernanceControls["observability"] {
  const totalJobs = input.importJobs.length;
  const failedJobs = input.importJobs.filter((job) => job.state === "failed").length;
  const failedPercent = totalJobs > 0 ? Math.round((failedJobs / totalJobs) * 100) : 0;
  const providerOptionHealth = input.healthTriage.providers.map((provider) => provider.optionQueryHealth);
  const optionStatus = statusFromHealthValues(providerOptionHealth, input.overviewAvailable);
  const projectionFreshnessStatus = projectionFreshnessStatusFor(input.healthTriage, input.overviewAvailable);
  const sourceQuarantineCount =
    input.sourceObservationReview.counts.blocked +
    input.readinessBlockers.filter((blocker) => blocker.includes("provider-transport")).length;
  const dataQuarantineCount = input.readinessBlockers.filter(
    (blocker) => blocker === "security-privacy-blocked",
  ).length;
  const conflictSpikeCount = input.conflictResolution.summary.blockingCount;
  const signals: readonly GovernanceObservabilitySignal[] = [
    governanceSignal({
      key: "option-query-latency",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.optionLatency"),
      status: optionStatus,
      value:
        providerOptionHealth.length > 0
          ? providerOptionHealth.join(", ")
          : input.overviewAvailable
            ? "no provider option queries reported"
            : "unavailable",
      threshold: "p95 stays within provider option query budget",
      ownerMetricKey: "catalog.integration.option_query.latency",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: !input.overviewAvailable,
    }),
    governanceSignal({
      key: "job-failure-rate",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.jobFailureRate"),
      status: failedJobs > 0 ? "blocked" : input.overviewAvailable ? "ready" : "unavailable",
      value: `${failedJobs}/${totalJobs} failed (${failedPercent}%)`,
      threshold: "0 failed jobs in selected launch scope",
      ownerMetricKey: "catalog.integration.jobs.failure_rate",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: !input.overviewAvailable,
    }),
    governanceSignal({
      key: "projection-freshness",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.projectionFreshness"),
      status: projectionFreshnessStatus,
      value: input.healthTriage.readModels.map((row) => `${row.queryKey}:${row.freshness}`).join(", ") || "unavailable",
      threshold: "read models are fresh or explicitly degraded",
      ownerMetricKey: "catalog.integration.projections.freshness",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: projectionFreshnessStatus !== "ready",
    }),
    governanceSignal({
      key: "source-observation-quarantine",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.sourceQuarantine"),
      status: sourceQuarantineCount > 0 ? "degraded" : "ready",
      value: `${sourceQuarantineCount} quarantined or blocked source signal(s)`,
      threshold: "0 unresolved quarantine blockers",
      ownerMetricKey: "catalog.integration.source_observation.quarantine",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: !input.overviewAvailable,
    }),
    governanceSignal({
      key: "data-quarantine",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.dataQuarantine"),
      status: dataQuarantineCount > 0 ? "blocked" : "ready",
      value: `${dataQuarantineCount} security/privacy quarantine blocker(s)`,
      threshold: "0 unsafe data blockers",
      ownerMetricKey: "catalog.integration.data_quarantine.count",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: !input.overviewAvailable,
    }),
    governanceSignal({
      key: "conflict-spike",
      label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.signal.conflictSpike"),
      status:
        conflictSpikeCount > 0 ? "blocked" : input.conflictResolution.summary.conflictCount > 0 ? "degraded" : "ready",
      value: `${input.conflictResolution.summary.conflictCount} conflict(s), ${conflictSpikeCount} blocking`,
      threshold: "0 blocking promotion conflicts",
      ownerMetricKey: "catalog.integration.conflicts.spike",
      auditEvidenceUrl: input.auditEvidenceUrl,
      stale: input.conflictResolution.freshness !== "fresh",
    }),
  ];

  return {
    status: signals.some((signal) => signal.status === "blocked")
      ? "blocked"
      : signals.some((signal) => signal.status === "unavailable")
        ? "unavailable"
        : signals.some((signal) => signal.status === "degraded")
          ? "degraded"
          : "ready",
    generatedAt: input.generatedAt,
    signals,
  };
}

function governanceSignal(input: {
  key: GovernanceObservabilitySignal["key"];
  label: string;
  status: GovernanceObservabilitySignal["status"];
  value: string;
  threshold: string;
  ownerMetricKey: string;
  auditEvidenceUrl: string;
  stale: boolean;
}): GovernanceObservabilitySignal {
  const status = input.stale && input.status === "ready" ? "degraded" : input.status;

  return {
    key: input.key,
    label: input.label,
    status,
    value: input.value,
    threshold: input.threshold,
    ownerMetricKey: input.ownerMetricKey,
    evidenceUrl: input.auditEvidenceUrl,
    stale: input.stale,
    alertLinks: [
      {
        label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.alert", {
          value: input.ownerMetricKey,
        }),
        href: catalogIntegrationGrafanaDashboardHref,
      },
    ],
    runbookLinks: [
      {
        label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.runbook", {
          value: input.label,
        }),
        href: catalogIntegrationOperationsRunbookHref,
      },
    ],
  };
}

function statusFromHealthValues(
  values: readonly string[],
  overviewAvailable: boolean,
): GovernanceObservabilitySignal["status"] {
  if (!overviewAvailable || values.length === 0) {
    return "unavailable";
  }
  if (values.some((value) => value === "blocked")) {
    return "blocked";
  }
  if (values.some((value) => value === "degraded")) {
    return "degraded";
  }

  return "ready";
}

function projectionFreshnessStatusFor(
  healthTriage: CatalogPrimaryWorkbenchHealthTriageReadModel,
  overviewAvailable: boolean,
): GovernanceObservabilitySignal["status"] {
  if (!overviewAvailable || healthTriage.readModels.length === 0) {
    return "unavailable";
  }
  if (healthTriage.readModels.some((row) => row.freshness === "unavailable")) {
    return "unavailable";
  }
  if (healthTriage.readModels.some((row) => row.freshness === "partial" || row.freshness === "stale")) {
    return "degraded";
  }

  return "ready";
}

function governanceLegacyRemovalEvidenceFor(auditEvidenceUrl: string): GovernanceControls["legacyRemovalEvidence"] {
  const forbiddenSupportPaths =
    catalogPrimaryWorkbenchRetirementPolicy.forbiddenOutcomes.map(sanitizeRetiredSurfaceLabel);

  return {
    status: "removed",
    requiredDisposition: catalogPrimaryWorkbenchRetirementPolicy.requiredDisposition,
    removedSurfaces: catalogPrimaryWorkbenchRetirementPolicy.surfaces,
    forbiddenSupportPaths,
    evidence: [
      {
        key: "payload-escape-hatch",
        label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.payload.label"),
        status: "removed",
        evidenceUrl: auditEvidenceUrl,
        detail: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.payload.detail"),
      },
      {
        key: "broad-patch-compatibility",
        label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.broadPatch.label"),
        status: "removed",
        evidenceUrl: auditEvidenceUrl,
        detail: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.broadPatch.detail"),
      },
      {
        key: "legacy-selector-pattern",
        label: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.selector.label"),
        status: "removed",
        evidenceUrl: auditEvidenceUrl,
        detail: t("catalog.features.sourceObservations.ui.governanceControls.readModel.removal.selector.detail"),
      },
    ],
    launchBlockerIfPresent: forbiddenSupportPaths,
  };
}

function sanitizeRetiredSurfaceLabel(value: string): string {
  return value
    .replace(/raw JSON/gi, "payload")
    .replace(/support-only preserved route/gi, "support route still present")
    .replace(/support-only legacy route/gi, "legacy support route still present")
    .replace(/support-only/gi, "support route still present");
}
