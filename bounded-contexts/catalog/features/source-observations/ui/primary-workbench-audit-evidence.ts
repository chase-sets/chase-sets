import { t } from "@chase-sets/localization";
import { catalogScopeRecordIdFromPath } from "../api/admin/scope-detail-workbench-location";
import { isSafePrimaryWorkbenchReturnPath } from "../api/admin/primary-workbench-shared-contracts";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import type {
  CatalogPrimaryWorkbenchHealthTriageReadModel,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchSourceObservationEvidenceDetail,
} from "../api/primary-workbench-admin-contracts";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogMergeCandidateListItem,
  CatalogProviderProfileVersionReview,
  SourceObservationListItem,
} from "./contracts";
import type { CatalogAliasReviewCandidateSummary } from "../../alias-equivalence/api/alias-review-admin-contracts";
import { resolveCatalogAuditSelection } from "./primary-workbench-audit-selection";
import {
  catalogEntityEvidenceHref,
  parseCatalogEvidenceReference,
  type CatalogEvidenceReference,
} from "./primary-workbench-evidence-reference";
import type { ConflictResolution } from "./primary-workbench-conflict-resolution";
import type { ValidationReadiness } from "./primary-workbench-validation-readiness";

export type AuditEvidence = CatalogPrimaryWorkbenchReadModel["auditEvidence"];
export type AuditEvidenceLink = AuditEvidence["evidenceLinks"][number];
export type AuditTimelineRow = AuditEvidence["timeline"][number];

export function auditEvidenceFor(input: {
  requestUrl: string | URL;
  observations: readonly SourceObservationListItem[];
  candidates: readonly CatalogMergeCandidateListItem[];
  providerKeys: readonly string[];
  profiles: readonly CatalogProviderProfileVersionReview[];
  aliases: readonly CatalogAliasReviewCandidateSummary[];
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
  const owner = new URL(input.requestUrl);
  const scopePageVerified = Boolean(
    input.routeContext.scopeRecordId &&
    catalogScopeRecordIdFromPath(owner.pathname) === input.routeContext.scopeRecordId,
  );
  if (input.routeContext.scopeRecordId)
    owner.pathname = `/catalog/scopes/${encodeURIComponent(input.routeContext.scopeRecordId)}`;
  if (!isSafePrimaryWorkbenchReturnPath(owner.pathname)) {
    owner.pathname = input.routeContext.providerKey
      ? `/catalog/providers/${encodeURIComponent(input.routeContext.providerKey)}`
      : "/catalog/integrations";
  }
  const auditTimelineHref = `${owner.pathname}${owner.search}`;
  const { selection, matches } = resolveCatalogAuditSelection({
    routeContext: input.routeContext,
    scopePageVerified,
    jobs: input.importJobs,
    observations: input.observations,
    candidates: input.candidates,
    providerKeys: input.providerKeys,
    profiles: input.profiles,
    aliases: input.aliases,
  });
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
  const timeline = dedupeAuditTimelineRows(
    [
      ...auditProjectionRowsFor({
        auditTimelineHref,
        entries: projection?.entries ?? [],
        routeContext: input.routeContext,
      }),
      ...auditJobRowsFor({ auditTimelineHref, jobs: input.importJobs }).filter(matches).slice(0, 12),
      ...[
        ...auditSourceObservationRowsFor({
          auditTimelineHref,
          routeContext: input.routeContext,
          rows: input.sourceObservationReview.rows,
          reviewEvidenceByObservationId: input.reviewEvidenceByObservationId,
          observations: input.observations,
        }),
        ...auditAssociationRowsFor(input, auditTimelineHref),
      ]
        .filter(matches)
        .slice(0, 16),
      ...auditDryRunRowsFor({
        auditTimelineHref,
        routeContext: input.routeContext,
        rows: input.validationReadiness.dryRunEvidence,
      })
        .filter(matches)
        .slice(0, 8),
      ...auditPromotionRowsFor({
        auditTimelineHref,
        promotionPreview: input.promotionPreview,
        routeContext: input.routeContext,
      }),
      ...auditConflictRowsFor({
        auditTimelineHref,
        events: input.conflictResolution.recentAuditEvents,
      }),
    ].filter(matches),
  )
    .slice(0, 50)
    .map((row) => {
      const reference: CatalogEvidenceReference =
        parseCatalogEvidenceReference(selection.reference) ??
        (row.targetType === "provider-profile" && row.providerKey
          ? { kind: "provider-profile", id: row.profileVersion ?? row.targetId, providerKey: row.providerKey }
          : { kind: row.targetType, id: row.targetType === "control-plane" ? "settings" : row.targetId });
      const location =
        row.targetType === "control-plane" && !selection.reference
          ? "/catalog/integrations/settings"
          : row.targetType === "provider-profile" && row.providerKey && !selection.reference
            ? `/catalog/providers/${encodeURIComponent(row.providerKey)}?profileVersion=${encodeURIComponent(row.profileVersion ?? row.targetId)}`
            : auditTimelineHref;
      return {
        ...row,
        evidenceLinks: row.evidenceLinks.map((link) => ({
          ...link,
          href: catalogEntityEvidenceHref(location, reference),
        })),
      };
    });
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
    selection,
    status,
    freshness: projectionState.freshness,
    generatedAt: input.generatedAt,
    returnToPrimaryHref: (() => {
      const url = new URL(owner);
      url.searchParams.delete("evidenceRef");
      return `${url.pathname}${url.search}`;
    })(),
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

function auditAssociationRowsFor(
  input: Parameters<typeof auditEvidenceFor>[0],
  href: string,
): readonly AuditTimelineRow[] {
  const members = input.candidates.flatMap((candidate) =>
    candidate.membership_json.map((member) => ({
      eventId: `candidate-observation:${candidate.candidate_id}:${member.observationId}`,
      occurredAt: member.observedAt,
      eventName: "source-observation-recorded" as const,
      category: "source-observation" as const,
      actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.providerAdapter"),
      targetType: "source-observation" as const,
      targetId: member.observationId,
      providerKey: member.providerKey,
      unitKey: null,
      profileVersion: member.sourceProfileVersion,
      jobId: null,
      observationId: member.observationId,
      catalogItemId: candidate.matched_catalog_item_id,
      summary: member.externalKey,
      diagnosticCodes: [],
      redactionState: "redacted" as const,
      evidenceLinks: [
        auditEvidenceLink({
          href,
          key: `candidate-observation:${member.observationId}`,
          kind: "audit-event",
          label: member.observationId,
          summary: member.externalKey,
        }),
      ],
    })),
  );
  const aliases = input.aliases.flatMap((alias): readonly AuditTimelineRow[] => {
    const targetType = alias.observationId
      ? "source-observation"
      : alias.targetKind === "catalog-item"
        ? "catalog-item"
        : null;
    const targetId = alias.observationId ?? alias.targetId;
    if (!targetType || !targetId) return [];
    return [
      {
        eventId: `alias:${alias.aliasHash}`,
        occurredAt: alias.updatedAt,
        eventName: "diagnostics-present",
        category: "diagnostic",
        actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.providerAdapter"),
        targetType,
        targetId,
        providerKey: alias.providerKey,
        unitKey: null,
        profileVersion: alias.sourceProfileVersion,
        jobId: null,
        observationId: alias.observationId,
        catalogItemId: alias.targetKind === "catalog-item" ? alias.targetId : null,
        summary: alias.evidence.map((line) => `${line.label}: ${line.value}`).join("; ") || alias.proposedAlias,
        diagnosticCodes: [...alias.warnings],
        redactionState: "redacted",
        evidenceLinks: [
          auditEvidenceLink({
            href,
            key: `alias:${alias.aliasHash}`,
            kind: "diagnostic",
            label: alias.proposedAlias,
            summary: alias.reviewStatus,
          }),
        ],
      },
    ];
  });
  return [...members, ...aliases];
}

function auditProjectionRowsFor(input: {
  auditTimelineHref: string;
  entries: readonly CatalogIntegrationControlPlaneOverview["auditLifecycle"]["entries"][number][];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): readonly AuditTimelineRow[] {
  return input.entries.flatMap((entry) => {
    const targetType = auditTargetTypeForCategory(entry.category);
    const targetId = targetType === "import-job" ? entry.relatedJobId : entry.profileVersion;
    if (!targetId) return [];

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
  return input.jobs.map((job) => {
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
  observations: readonly SourceObservationListItem[];
}): readonly AuditTimelineRow[] {
  return input.rows.map((row) => {
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
      jobId: null,
      observationId: row.observationId,
      catalogItemId:
        input.observations.find((observation) => observation.observation_id === row.observationId)
          ?.promoted_catalog_item_id ?? null,
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
  return input.rows.flatMap((row): readonly AuditTimelineRow[] =>
    !row.profileVersion || !row.providerKey
      ? []
      : [
          {
            eventId: `dry-run:${row.providerKey}:${row.profileVersion}:${row.externalKey}`,
            occurredAt: new Date(0).toISOString(),
            eventName: "dry-run-executed",
            category: "dry-run",
            actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.system"),
            targetType: "provider-profile",
            targetId: row.profileVersion,
            providerKey: row.providerKey,
            unitKey: input.routeContext.unitKey,
            profileVersion: row.profileVersion,
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
          },
        ],
  );
}

function auditPromotionRowsFor(input: {
  auditTimelineHref: string;
  promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): readonly AuditTimelineRow[] {
  const observationId = input.promotionPreview.scope.selectedObservationIds.at(0);
  if ((!input.promotionPreview.previewId && !input.promotionPreview.commandPlanHash) || !observationId) {
    return [];
  }

  return [
    {
      eventId: `promotion-preview:${input.promotionPreview.previewId ?? input.promotionPreview.commandPlanHash}`,
      occurredAt: new Date(0).toISOString(),
      eventName: "promotion-plan-generated",
      category: "promotion",
      actorLabel: t("catalog.features.sourceObservations.ui.auditEvidence.readModel.actor.operatorScope"),
      targetType: "source-observation",
      targetId: observationId,
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
