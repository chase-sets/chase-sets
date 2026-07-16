import { t } from "@chase-sets/localization";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import type {
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchSourceObservationEvidenceDetail,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationControlPlaneOverview } from "./contracts";
import {
  catalogPrimaryWorkbenchReturnPath,
  catalogPrimaryWorkbenchSupportingHref,
} from "./primary-workbench-route-context";
import type { ConflictResolution } from "./primary-workbench-conflict-resolution";
import type { ValidationReadiness } from "./primary-workbench-validation-readiness";

export type AuditEvidence = CatalogPrimaryWorkbenchReadModel["auditEvidence"];
export type AuditEvidenceLink = AuditEvidence["evidenceLinks"][number];
export type AuditTimelineRow = AuditEvidence["timeline"][number];

export function auditEvidenceFor(input: {
  conflictResolution: ConflictResolution;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  healthTriage: CatalogPrimaryWorkbenchHealthTriageReadModel;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  securityPrivacy: CatalogPrimaryWorkbenchReadModel["securityPrivacy"];
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
  // Deep-evidence index keyed by observationId. The slim review row does not
  // carry duplicate/conflict evidence, so the source-observation audit
  // rows read those diagnostic codes from the index instead.
  reviewEvidenceByObservationId: ReadonlyMap<string, CatalogPrimaryWorkbenchSourceObservationEvidenceDetail>;
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
      reviewEvidenceByObservationId: input.reviewEvidenceByObservationId,
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
  ])
    .filter((row) => auditTimelineRowMatchesContext(row, input.routeContext))
    .slice(0, 50);
  const evidenceLinks = dedupeAuditEvidenceLinks(timeline.flatMap((row) => row.evidenceLinks));
  const partialProjectionCount =
    (projectionState.partialProjection ? 1 : 0) +
    input.healthTriage.readModels.filter((state) => state.freshness === "partial" || state.freshness === "stale")
      .length;
  const status: AuditEvidence["status"] = projectionState.missingProjection
    ? "unavailable"
    : projectionState.partialProjection
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
      partialProjectionCount,
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
      job.action === "scope.import" && job.state === "failed"
        ? "import-job-failed"
        : job.action === "scope.import" && job.state === "completed"
          ? "import-job-completed"
          : job.action === "scope.import"
            ? "import-job-started"
            : "reapply-run-executed";
    return {
      eventId: `job:${job.jobId}:${job.state}`,
      occurredAt: job.startedAt ?? job.createdAt,
      eventName,
      category: job.action === "scope.import" ? "import-job" : "reapply",
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
  reviewEvidenceByObservationId: ReadonlyMap<string, CatalogPrimaryWorkbenchSourceObservationEvidenceDetail>;
}): readonly AuditTimelineRow[] {
  return input.rows.slice(0, 16).map((row) => {
    // The slim review row omits the source profile version and the deep
    // duplicate/conflict evidence; read them from the in-process evidence
    // index, defaulting empty so the audit timeline stays total even if absent.
    const evidence = input.reviewEvidenceByObservationId.get(row.observationId);
    return {
      eventId: `source-observation:${row.observationId}:${row.status}`,
      occurredAt: row.changedAt ?? evidence?.observedAt ?? row.changedAt,
      eventName: row.status === "changed" ? "source-observation-changed" : "source-observation-recorded",
      category: "source-observation",
      actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.providerAdapter"),
      targetType: "source-observation",
      targetId: row.observationId,
      providerKey: row.providerKey,
      unitKey: input.routeContext.unitKey,
      profileVersion: evidence?.sourceProfileVersion ?? null,
      jobId: input.routeContext.jobId,
      observationId: row.observationId,
      catalogItemId: null,
      summary: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.sourceObservation.summary", {
        name: row.displayName,
        summary: row.redactionSummary,
      }),
      diagnosticCodes: [
        ...row.promotionReadiness.blockers,
        ...(evidence?.duplicateEvidence ?? []),
        ...(evidence?.conflictEvidence ?? []),
      ].slice(0, 8),
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
    } satisfies AuditTimelineRow;
  });
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
