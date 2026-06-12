import { t } from "@chase-sets/localization";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import type {
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationControlPlaneOverview } from "./contracts";
import {
  catalogPrimaryWorkbenchReturnPath,
  catalogPrimaryWorkbenchSupportingHref,
} from "./primary-workbench-route-context";
import type { ConflictResolution } from "./primary-workbench-conflict-resolution";
import type { GovernanceControls } from "./primary-workbench-governance-controls";
import type { LifecycleRecovery } from "./primary-workbench-lifecycle-recovery";
import type { ValidationReadiness } from "./primary-workbench-validation-readiness";

export type AuditEvidence = CatalogPrimaryWorkbenchReadModel["auditEvidence"];
export type AuditEvidenceLink = AuditEvidence["evidenceLinks"][number];
export type AuditTimelineRow = AuditEvidence["timeline"][number];
export type ReleaseEvidenceChecklistRow = AuditEvidence["releaseChecklist"][number];

export function auditEvidenceFor(input: {
  conflictResolution: ConflictResolution;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  governanceControls: GovernanceControls;
  healthTriage: CatalogPrimaryWorkbenchHealthTriageReadModel;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  lifecycleRecovery: LifecycleRecovery;
  promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  securityPrivacy: CatalogPrimaryWorkbenchReadModel["securityPrivacy"];
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
  validationReadiness: ValidationReadiness;
}): AuditEvidence {
  const auditTimelineHref = catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence");
  const projection = input.controlPlaneOverview?.auditLifecycle ?? null;
  const projectionState: AuditEvidence["projectionState"] = {
    queryKey: "audit-evidence-timeline",
    freshness: !projection || projection.projectionStatus === "unavailable" ? "unavailable" : "partial",
    generatedAt: projection?.generatedAt ?? null,
    statusMessage:
      projection?.statusMessage ??
      t("catalog.features.sourceObservations.ui.auditEvidence.readModel.projection.unavailable"),
    missingProjection: !projection || projection.projectionStatus === "unavailable",
    partialProjection: Boolean(projection && projection.projectionStatus === "partial"),
  };
  const timeline = dedupeAuditTimelineRows([
    ...auditProjectionRowsFor({
      auditTimelineHref,
      entries: projection?.entries ?? [],
      routeContext: input.routeContext,
    }),
    ...auditJobRowsFor({ auditTimelineHref, jobs: input.importJobs }),
    ...auditSourceObservationRowsFor({
      auditTimelineHref,
      routeContext: input.routeContext,
      rows: input.sourceObservationReview.rows,
    }),
    ...auditDryRunRowsFor({
      auditTimelineHref,
      routeContext: input.routeContext,
      rows: input.validationReadiness.dryRunEvidence,
    }),
    ...auditPromotionRowsFor({
      auditTimelineHref,
      promotionPreview: input.promotionPreview,
      routeContext: input.routeContext,
    }),
    ...auditConflictRowsFor({
      auditTimelineHref,
      events: input.conflictResolution.recentAuditEvents,
    }),
    auditGovernanceRemovalRowFor({
      auditTimelineHref,
      generatedAt: input.generatedAt,
      governanceControls: input.governanceControls,
      routeContext: input.routeContext,
    }),
  ])
    .filter((row) => auditTimelineRowMatchesContext(row, input.routeContext))
    .slice(0, 50);
  const releaseChecklist = auditReleaseChecklistFor({
    auditTimelineHref,
    conflictResolution: input.conflictResolution,
    governanceControls: input.governanceControls,
    importJobs: input.importJobs,
    lifecycleRecovery: input.lifecycleRecovery,
    projectionState,
    promotionPreview: input.promotionPreview,
    routeContext: input.routeContext,
    sourceObservationReview: input.sourceObservationReview,
    validationReadiness: input.validationReadiness,
  });
  const evidenceLinks = dedupeAuditEvidenceLinks([
    ...timeline.flatMap((row) => row.evidenceLinks),
    ...releaseChecklist.flatMap((row) => row.proofLinks),
  ]);
  const missingEvidence = releaseChecklist.filter((row) => row.status === "missing" || row.status === "blocked").length;
  const partialProjectionCount =
    (projectionState.partialProjection ? 1 : 0) +
    input.healthTriage.readModels.filter((state) => state.freshness === "partial" || state.freshness === "stale")
      .length;
  const residualDebtItems = releaseChecklist.reduce((count, row) => count + row.residualDebt.length, 0);
  const status: AuditEvidence["status"] = projectionState.missingProjection
    ? "unavailable"
    : releaseChecklist.some((row) => row.status === "blocked" && row.blocksRelease)
      ? "blocked"
      : projectionState.partialProjection ||
          releaseChecklist.some((row) => row.status === "partial" || row.status === "missing")
        ? "partial"
        : "ready";

  return {
    status,
    freshness: projectionState.freshness,
    generatedAt: input.generatedAt,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    summary: {
      timelineEvents: timeline.length,
      redactedEvidenceLinks: evidenceLinks.length,
      releaseChecklistItems: releaseChecklist.length,
      missingEvidence,
      partialProjectionCount,
      residualDebtItems,
    },
    filters: auditFiltersFor(input.routeContext, timeline),
    projectionState,
    redactionPolicy: {
      sourcePayloadAccess: "not-required",
      profileSnapshotAccess: "not-required",
      unsafeEvidenceBlocked: input.securityPrivacy.unsafeEvidenceBlocked,
      governedDataClasses: input.securityPrivacy.governedDataClasses,
      forbiddenEvidenceRequests: [
        "source payload body download",
        "provider profile snapshot document",
        "compatibility fallback export",
        "operator identity expansion",
      ],
      summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.redaction.summary"),
    },
    timeline,
    evidenceLinks,
    releaseChecklist,
  };
}

function auditProjectionRowsFor(input: {
  auditTimelineHref: string;
  entries: readonly CatalogIntegrationControlPlaneOverview["auditLifecycle"]["entries"][number][];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): readonly AuditTimelineRow[] {
  return input.entries.map((entry) => {
    const targetType = auditTargetTypeForCategory(entry.category);
    const targetId =
      entry.relatedJobId ??
      entry.profileVersion ??
      entry.unitKey ??
      entry.providerKey ??
      t("catalog.features.sourceObservations.ui.auditEvidence.readModel.target.controlPlane");

    return {
      eventId: entry.eventId,
      occurredAt: entry.occurredAt,
      eventName: entry.eventName,
      category: entry.category,
      actorLabel: entry.actorUserId
        ? t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.operator", {
            value: entry.actorUserId,
          })
        : t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.system"),
      targetType,
      targetId,
      providerKey: entry.providerKey,
      unitKey: entry.unitKey as CatalogIntegrationUnitKey | null,
      profileVersion: entry.profileVersion,
      jobId: entry.relatedJobId,
      observationId: null,
      catalogItemId: null,
      summary: entry.summary,
      diagnosticCodes: entry.diagnosticCodes,
      redactionState: "redacted",
      evidenceLinks: [
        auditEvidenceLink({
          href: input.auditTimelineHref,
          key: `audit:${entry.eventId}`,
          kind: "audit-event",
          label: entry.eventName,
          summary: entry.summary,
        }),
      ],
    } satisfies AuditTimelineRow;
  });
}

function auditJobRowsFor(input: {
  auditTimelineHref: string;
  jobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
}): readonly AuditTimelineRow[] {
  return input.jobs.slice(0, 12).map((job) => {
    const eventName =
      job.action === "start-provider-import" && job.state === "failed"
        ? "import-job-failed"
        : job.action === "start-provider-import" && job.state === "completed"
          ? "import-job-completed"
          : job.action === "start-provider-import"
            ? "import-job-started"
            : "reapply-run-executed";
    return {
      eventId: `job:${job.jobId}:${job.state}`,
      occurredAt: job.startedAt ?? job.createdAt,
      eventName,
      category: job.action === "start-provider-import" ? "import-job" : "reapply",
      actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.jobWorker"),
      targetType: "import-job",
      targetId: job.jobId,
      providerKey: job.providerKey,
      unitKey: job.unitKey,
      profileVersion: job.profileVersion,
      jobId: job.jobId,
      observationId: null,
      catalogItemId: null,
      summary: job.summary,
      diagnosticCodes: job.failureGroups.map((group) => group.key),
      redactionState: "redacted",
      evidenceLinks: [
        auditEvidenceLink({
          href: input.auditTimelineHref,
          key: `job:${job.jobId}`,
          kind: job.failureGroups.length > 0 ? "diagnostic" : "audit-event",
          label: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.link.job", { value: job.jobId }),
          summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.job.summary", {
            completed: String(job.completed),
            percent: String(job.progressPercent),
            status: job.operatorStatus,
            total: String(job.total),
          }),
        }),
      ],
    } satisfies AuditTimelineRow;
  });
}

function auditSourceObservationRowsFor(input: {
  auditTimelineHref: string;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  rows: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"];
}): readonly AuditTimelineRow[] {
  return input.rows.slice(0, 16).map((row) => ({
    eventId: `source-observation:${row.observationId}:${row.status}`,
    occurredAt: row.changedAt ?? row.observedAt,
    eventName: row.status === "changed" ? "source-observation-changed" : "source-observation-recorded",
    category: "source-observation",
    actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.providerAdapter"),
    targetType: "source-observation",
    targetId: row.observationId,
    providerKey: row.providerKey,
    unitKey: input.routeContext.unitKey,
    profileVersion: row.sourceProfileVersion,
    jobId: input.routeContext.jobId,
    observationId: row.observationId,
    catalogItemId: null,
    summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.sourceObservation.summary", {
      name: row.displayName,
      summary: row.redactionSummary,
    }),
    diagnosticCodes: [...row.promotionReadiness.blockers, ...row.duplicateEvidence, ...row.conflictEvidence].slice(
      0,
      8,
    ),
    redactionState: "redacted",
    evidenceLinks: [
      auditEvidenceLink({
        href: row.detailHref || input.auditTimelineHref,
        key: `source-observation:${row.observationId}`,
        kind: row.promotionReadiness.blockers.length > 0 ? "diagnostic" : "audit-event",
        label: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.link.observation", {
          value: row.observationId,
        }),
        summary: row.payloadSummary,
      }),
    ],
  }));
}

function auditDryRunRowsFor(input: {
  auditTimelineHref: string;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  rows: ValidationReadiness["dryRunEvidence"];
}): readonly AuditTimelineRow[] {
  return input.rows.slice(0, 8).map((row) => ({
    eventId: `dry-run:${row.externalKey}`,
    occurredAt: new Date(0).toISOString(),
    eventName: "dry-run-executed",
    category: "dry-run",
    actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.system"),
    targetType: "provider-profile",
    targetId: input.routeContext.profileVersion ?? row.externalKey,
    providerKey: input.routeContext.providerKey,
    unitKey: input.routeContext.unitKey,
    profileVersion: input.routeContext.profileVersion,
    jobId: null,
    observationId: null,
    catalogItemId: null,
    summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.dryRun.summary", {
      evidence: row.auditEvidence.join("; "),
      externalKey: row.externalKey,
      status: row.status,
    }),
    diagnosticCodes: row.diagnostics.map((diagnostic) => diagnostic.code),
    redactionState: "redacted",
    evidenceLinks: [
      auditEvidenceLink({
        href: input.auditTimelineHref,
        key: `dry-run:${row.externalKey}`,
        kind: "proof",
        label: row.externalKey,
        summary:
          row.redactionSummary
            .map((entry) =>
              t("catalog.features.sourceObservations.ui.auditEvidence.readModel.redaction.entry", {
                label: entry.label,
                value: entry.value,
              }),
            )
            .join("; ") || row.status,
      }),
    ],
  }));
}

function auditPromotionRowsFor(input: {
  auditTimelineHref: string;
  promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): readonly AuditTimelineRow[] {
  if (!input.promotionPreview.previewId && !input.promotionPreview.commandPlanHash) {
    return [];
  }

  return [
    {
      eventId: `promotion-preview:${input.promotionPreview.previewId ?? input.promotionPreview.commandPlanHash}`,
      occurredAt: new Date(0).toISOString(),
      eventName: "promotion-plan-generated",
      category: "promotion",
      actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.operatorScope"),
      targetType: "catalog-item",
      targetId: input.promotionPreview.commandPlanHash ?? input.promotionPreview.previewId ?? "promotion-preview",
      providerKey: input.routeContext.providerKey,
      unitKey: input.routeContext.unitKey,
      profileVersion: input.routeContext.profileVersion,
      jobId: input.routeContext.jobId,
      observationId: input.promotionPreview.scope.selectedObservationIds.at(0) ?? null,
      catalogItemId: null,
      summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.promotion.summary", {
        eligible: String(input.promotionPreview.outcomeCounts.eligible),
        blocked: String(input.promotionPreview.outcomeCounts.blocked),
      }),
      diagnosticCodes: input.promotionPreview.blockers,
      redactionState: "redacted",
      evidenceLinks: [
        auditEvidenceLink({
          href: input.auditTimelineHref,
          key: `promotion-preview:${input.promotionPreview.previewId ?? "pending"}`,
          kind: "proof",
          label: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.link.promotion"),
          summary: input.promotionPreview.commandPlanHash ?? "pending promotion command plan",
        }),
      ],
    },
  ];
}

function auditConflictRowsFor(input: {
  auditTimelineHref: string;
  events: ConflictResolution["recentAuditEvents"];
}): readonly AuditTimelineRow[] {
  return input.events.map((event) => ({
    eventId: `conflict:${event.eventId}`,
    occurredAt: event.occurredAt,
    eventName: "diagnostics-present",
    category: "diagnostic",
    actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.system"),
    targetType: event.observationId ? "source-observation" : "control-plane",
    targetId: event.observationId ?? event.providerKey,
    providerKey: event.providerKey,
    unitKey: event.unitKey,
    profileVersion: null,
    jobId: null,
    observationId: event.observationId,
    catalogItemId: null,
    summary: event.summary,
    diagnosticCodes: [event.eventName],
    redactionState: "redacted",
    evidenceLinks: [
      auditEvidenceLink({
        href: input.auditTimelineHref,
        key: `conflict:${event.eventId}`,
        kind: "diagnostic",
        label: event.eventName,
        summary: event.summary,
      }),
    ],
  }));
}

function auditGovernanceRemovalRowFor(input: {
  auditTimelineHref: string;
  generatedAt: string;
  governanceControls: GovernanceControls;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): AuditTimelineRow {
  return {
    eventId: "release:retired-compatibility-removal",
    occurredAt: input.generatedAt,
    eventName: "diagnostics-present",
    category: "diagnostic",
    actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.releaseOwner"),
    targetType: "release",
    targetId: "retired-compatibility-removal",
    providerKey: input.routeContext.providerKey,
    unitKey: input.routeContext.unitKey,
    profileVersion: input.routeContext.profileVersion,
    jobId: input.routeContext.jobId,
    observationId: null,
    catalogItemId: null,
    summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.retirement.summary"),
    diagnosticCodes: input.governanceControls.legacyRemovalEvidence.launchBlockerIfPresent,
    redactionState: "not-needed",
    evidenceLinks: input.governanceControls.legacyRemovalEvidence.evidence.map((evidence) =>
      auditEvidenceLink({
        href: input.auditTimelineHref,
        key: `retirement:${evidence.key}`,
        kind: "release-note",
        label: evidence.label,
        redactionState: "not-needed",
        summary: evidence.detail,
      }),
    ),
  };
}

function auditReleaseChecklistFor(input: {
  auditTimelineHref: string;
  conflictResolution: ConflictResolution;
  governanceControls: GovernanceControls;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  lifecycleRecovery: LifecycleRecovery;
  projectionState: AuditEvidence["projectionState"];
  promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
  validationReadiness: ValidationReadiness;
}): readonly ReleaseEvidenceChecklistRow[] {
  const failedJobs = input.importJobs.filter((job) => job.state === "failed").length;
  const activeJobs = input.importJobs.filter((job) => job.state === "queued" || job.state === "running").length;
  const sourceRows = input.sourceObservationReview.rows.length;
  const promotionReady =
    input.promotionPreview.scope.eligibleCount > 0 &&
    input.promotionPreview.commandPlanHash !== null &&
    input.promotionPreview.blockers.length === 0;
  const dryRunCount = input.validationReadiness.dryRunEvidence.length;
  const lifecycleEvents = input.lifecycleRecovery.recentAuditEvents.length;

  return [
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: failedJobs > 0,
      owner: "catalog-source-observations",
      proofKey: "provider-data-pull",
      proofSummary: `${input.importJobs.length} job(s), ${activeJobs} active, ${failedJobs} failed`,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.provider.releaseNote"),
      requiredEvidence: [
        "import job state",
        "provider/unit scope",
        "adapter readiness",
        "job consistency",
        "redacted job summary",
      ],
      residualDebt:
        input.importJobs.length === 0
          ? [t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.provider.noJobs")]
          : [],
      smokeProof: "production smoke opens protected Catalog integration workbench after sign-in",
      status: failedJobs > 0 ? "blocked" : input.importJobs.length > 0 ? "ready" : "partial",
      tests: [
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-import-jobs.test.ts",
        "deployables/admin-web/e2e/catalog-integrations.spec.ts",
      ],
      workflowKey: "provider-data-pull",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.provider.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: input.sourceObservationReview.freshness === "unavailable",
      owner: "catalog-source-observations",
      proofKey: "source-observation-review",
      proofSummary: `${sourceRows} row(s), ${input.sourceObservationReview.counts.eligible} eligible`,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.review.releaseNote"),
      requiredEvidence: [
        "Source Observation filters",
        "redacted fact summaries",
        "duplicate/conflict evidence",
        "review actions",
      ],
      residualDebt:
        sourceRows === 0
          ? [t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.review.noRows")]
          : [],
      smokeProof: "review table renders with redacted evidence and no document fallback",
      status:
        input.sourceObservationReview.freshness === "unavailable" ? "blocked" : sourceRows > 0 ? "ready" : "partial",
      tests: [
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx",
        "bounded-contexts/catalog/features/source-observations/api/catalog-integration-no-confusion-ux-acceptance.test.ts",
      ],
      workflowKey: "source-observation-review",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.review.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: input.promotionPreview.blockers.length > 0,
      owner: "catalog-source-observations",
      proofKey: "promotion",
      proofSummary: input.promotionPreview.commandPlanHash ?? "promotion command plan pending",
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.promotion.releaseNote"),
      requiredEvidence: [
        "promotion plan hash",
        "eligible/blocked disposition counts",
        "stale preview safeguards",
        "idempotency proof",
      ],
      residualDebt: promotionReady
        ? []
        : input.promotionPreview.blockers.map((blocker) => `promotion blocker: ${blocker}`),
      smokeProof: "promotion preview and confirmation render with stale preview protection",
      status: promotionReady ? "ready" : input.promotionPreview.blockers.length > 0 ? "blocked" : "partial",
      tests: [
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-source-observation-review.test.ts",
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx",
      ],
      workflowKey: "promotion",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.promotion.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: false,
      owner: "catalog-source-observations",
      proofKey: "dry-run-diagnostics",
      proofSummary: `${dryRunCount} dry-run evidence row(s)`,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.dryRun.releaseNote"),
      requiredEvidence: ["fixture coverage", "dry-run summaries", "diagnostics", "activation readiness"],
      residualDebt:
        dryRunCount === 0
          ? [t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.dryRun.noEvidence")]
          : [],
      smokeProof: "validation readiness workspace links back to import workbench",
      status: dryRunCount > 0 ? "ready" : "partial",
      tests: [
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-validation-readiness.test.ts",
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx",
      ],
      workflowKey: "dry-run-diagnostics",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.dryRun.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: false,
      owner: "catalog-source-observations",
      proofKey: "reapply-rollback",
      proofSummary: `${input.lifecycleRecovery.operations.length} lifecycle action(s), ${lifecycleEvents} event(s)`,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.lifecycle.releaseNote"),
      requiredEvidence: ["reapply semantics", "replay semantics", "rollback impact", "retirement impact"],
      residualDebt:
        input.lifecycleRecovery.status === "blocked"
          ? [t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.lifecycle.blocked")]
          : [],
      smokeProof: "lifecycle recovery workspace exposes confirmation and evidence links",
      status: input.lifecycleRecovery.status === "blocked" ? "partial" : lifecycleEvents > 0 ? "ready" : "partial",
      tests: [
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-lifecycle-recovery.test.ts",
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx",
      ],
      workflowKey: "reapply-rollback",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.lifecycle.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: false,
      owner: "catalog-source-observations",
      proofKey: "governance-retirement",
      proofSummary: `${input.governanceControls.legacyRemovalEvidence.evidence.length} deletion evidence row(s)`,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.retirement.releaseNote"),
      requiredEvidence: [
        "complete removal of code, patterns, documentation, tests, fixtures, screenshots, runbooks, release notes, and operator instructions",
        "no hidden flag",
        "no fallback branch",
        "no compatibility redirect",
        "no migration shim",
      ],
      residualDebt: [],
      smokeProof: "governance workspace shows retired compatibility removal as complete-removal",
      status: "ready",
      tests: [
        "bounded-contexts/catalog/features/source-observations/api/primary-workbench-admin-contracts.test.ts",
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-page.test.tsx",
      ],
      workflowKey: "governance-retirement",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.retirement.label"),
    }),
    releaseChecklistRow({
      auditTimelineHref: input.auditTimelineHref,
      blocksRelease: input.projectionState.missingProjection,
      owner: "ops-release",
      proofKey: "release-smoke",
      proofSummary: input.projectionState.statusMessage,
      releaseNote: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.smoke.releaseNote"),
      requiredEvidence: ["unit tests", "E2E proof", "static verification", "staging smoke", "production smoke"],
      residualDebt: input.projectionState.partialProjection
        ? [t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.smoke.partialProjection")]
        : [],
      smokeProof: "release notes link tests, E2E proof, smoke checks, and accepted residual debt",
      status: input.projectionState.missingProjection
        ? "blocked"
        : input.projectionState.partialProjection
          ? "partial"
          : "ready",
      tests: ["pnpm run verify:static", "pnpm --dir bounded-contexts/catalog run test:fast"],
      workflowKey: "release-smoke",
      workflowLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.release.smoke.label"),
    }),
  ];
}

function releaseChecklistRow(
  input: Omit<ReleaseEvidenceChecklistRow, "e2eProof" | "proofLinks"> &
    Readonly<{ auditTimelineHref: string; proofKey: string; proofSummary: string }>,
): ReleaseEvidenceChecklistRow {
  return {
    workflowKey: input.workflowKey,
    workflowLabel: input.workflowLabel,
    status: input.status,
    owner: input.owner,
    requiredEvidence: input.requiredEvidence,
    proofLinks: [
      auditEvidenceLink({
        href: input.auditTimelineHref,
        key: `release:${input.proofKey}`,
        kind: "proof",
        label: input.workflowLabel,
        summary: input.proofSummary,
      }),
    ],
    tests: input.tests,
    e2eProof: "deployables/admin-web/e2e/catalog-integrations.spec.ts",
    smokeProof: input.smokeProof,
    residualDebt: input.residualDebt,
    releaseNote: input.releaseNote,
    blocksRelease: input.blocksRelease,
  };
}

function auditFiltersFor(
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  timeline: readonly AuditTimelineRow[],
): AuditEvidence["filters"] {
  const categories = uniqueSorted(timeline.map((row) => row.category));
  const actorLabels = uniqueSorted(timeline.map((row) => row.actorLabel));
  const occurredAtValues = timeline.map((row) => row.occurredAt).sort();

  return [
    auditFilter("provider", "Provider", routeContext.providerKey, uniqueSorted(timeline.map((row) => row.providerKey))),
    auditFilter("unit", "Unit", routeContext.unitKey, uniqueSorted(timeline.map((row) => row.unitKey))),
    auditFilter(
      "profile-version",
      "Profile version",
      routeContext.profileVersion,
      uniqueSorted(timeline.map((row) => row.profileVersion)),
    ),
    auditFilter("job", "Job", routeContext.jobId, uniqueSorted(timeline.map((row) => row.jobId))),
    auditFilter(
      "observation",
      "Observation",
      routeContext.selectedObservationIds.join(", ") || null,
      uniqueSorted(timeline.map((row) => row.observationId)),
    ),
    auditFilter(
      "action-category",
      "Action category",
      routeContext.sourceObservationFilters.auditCategory ?? null,
      categories,
    ),
    auditFilter("actor", "Actor", routeContext.sourceObservationFilters.actor ?? null, actorLabels),
    auditFilter(
      "time",
      "Time",
      routeContext.sourceObservationFilters.since ?? null,
      occurredAtValues.length > 0 ? [occurredAtValues[0] ?? "", occurredAtValues.at(-1) ?? ""] : [],
    ),
  ];
}

function auditFilter(
  key: AuditEvidence["filters"][number]["key"],
  label: string,
  value: string | null,
  options: readonly (string | null)[],
): AuditEvidence["filters"][number] {
  const normalizedOptions = uniqueSorted(options);
  return {
    key,
    label,
    value,
    options: normalizedOptions,
    active: Boolean(value),
  };
}

function auditTargetTypeForCategory(category: string): AuditTimelineRow["targetType"] {
  switch (category) {
    case "profile":
    case "profile-section":
    case "activation":
    case "dry-run":
    case "fixture-validation":
      return "provider-profile";
    case "import-job":
    case "reapply":
      return "import-job";
    case "source-observation":
      return "source-observation";
    case "promotion":
      return "catalog-item";
    default:
      return "control-plane";
  }
}

export function auditEvidenceLink(input: {
  href: string;
  key: string;
  kind: AuditEvidenceLink["kind"];
  label: string;
  redactionState?: AuditEvidenceLink["redactionState"];
  summary: string;
}): AuditEvidenceLink {
  return {
    key: input.key,
    label: input.label,
    href: input.href,
    kind: input.kind,
    summary: input.summary,
    redactionState: input.redactionState ?? "redacted",
    sourcePayloadAccess: "not-required",
    profileSnapshotAccess: "not-required",
  };
}

function auditTimelineRowMatchesContext(
  row: AuditTimelineRow,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
): boolean {
  if (routeContext.providerKey && row.providerKey && row.providerKey !== routeContext.providerKey) {
    return false;
  }
  if (routeContext.unitKey && row.unitKey && row.unitKey !== routeContext.unitKey) {
    return false;
  }
  if (routeContext.profileVersion && row.profileVersion && row.profileVersion !== routeContext.profileVersion) {
    return false;
  }
  if (routeContext.jobId && row.jobId && row.jobId !== routeContext.jobId) {
    return false;
  }
  if (
    routeContext.selectedObservationIds.length > 0 &&
    row.observationId &&
    !routeContext.selectedObservationIds.includes(row.observationId)
  ) {
    return false;
  }

  return true;
}

function dedupeAuditTimelineRows(rows: readonly AuditTimelineRow[]): readonly AuditTimelineRow[] {
  const seen = new Set<string>();
  const deduped: AuditTimelineRow[] = [];
  for (const row of rows) {
    if (seen.has(row.eventId)) {
      continue;
    }
    seen.add(row.eventId);
    deduped.push(row);
  }

  return deduped.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

function dedupeAuditEvidenceLinks(links: readonly AuditEvidenceLink[]): readonly AuditEvidenceLink[] {
  const seen = new Set<string>();
  const deduped: AuditEvidenceLink[] = [];
  for (const link of links) {
    if (seen.has(link.key)) {
      continue;
    }
    seen.add(link.key);
    deduped.push(link);
  }

  return deduped;
}

function uniqueSorted(values: readonly (string | null)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b));
}
