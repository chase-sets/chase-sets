import { t } from "@chase-sets/localization";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";
import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationControlPlaneOverview } from "./contracts";
import {
  catalogPrimaryWorkbenchReturnPath,
  catalogPrimaryWorkbenchSupportingHref,
} from "./primary-workbench-route-context";

export type ConflictResolution = CatalogPrimaryWorkbenchReadModel["conflictResolution"];
export type ConflictResolutionRow = ConflictResolution["rows"][number];

export function conflictResolutionFor(input: {
  canManage: boolean;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
}): ConflictResolution {
  const selectedIds = new Set(input.routeContext.selectedObservationIds);
  const sourceRows =
    selectedIds.size > 0
      ? input.sourceObservationReview.rows.filter((row) => selectedIds.has(row.observationId))
      : input.sourceObservationReview.rows;
  const rows = sourceRows.filter(hasConflictResolutionEvidence).map((row) =>
    conflictResolutionRowFor(row, {
      canManage: input.canManage,
      promotionPreview: input.promotionPreview,
    }),
  );
  const blockingCount = rows.filter((row) => row.resolutionState === "blocks-promotion").length;
  const autoResolvedCount = rows.filter((row) => row.resolutionState === "auto-resolved").length;
  const reviewRequiredCount = rows.filter((row) => row.resolutionState === "requires-review").length;
  const recentAuditEvents = conflictResolutionAuditEventsFor(input.controlPlaneOverview, input.routeContext);
  const status: ConflictResolution["status"] =
    input.sourceObservationReview.freshness === "unavailable"
      ? "unavailable"
      : blockingCount > 0
        ? "blocked"
        : rows.length > 0
          ? "ready"
          : "empty";
  const overrideBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] = input.canManage
    ? ["unsupported-command"]
    : ["permission-denied", "unsupported-command"];

  return {
    status,
    freshness: input.sourceObservationReview.freshness,
    generatedAt: input.generatedAt,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence"),
    selectedObservationIds: input.routeContext.selectedObservationIds,
    summary: {
      conflictCount: rows.length,
      blockingCount,
      autoResolvedCount,
      reviewRequiredCount,
      overrideAvailableCount: rows.filter((row) => row.overrideAction.state === "available").length,
      auditEventCount: recentAuditEvents.length,
    },
    rows,
    precedenceRules: conflictResolutionPrecedenceRules(rows),
    overridePolicy: {
      supported: false,
      requiredPermission: "catalog.manage",
      state: input.canManage ? "unavailable" : "denied",
      blockers: overrideBlockers,
      auditRequired: true,
      reason: t("catalog.features.sourceObservations.ui.conflictResolution.override.policy.reason"),
    },
    recentAuditEvents,
  };
}

function hasConflictResolutionEvidence(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
): boolean {
  return (
    row.duplicateEvidence.length > 0 ||
    row.conflictEvidence.length > 0 ||
    row.promotionReadiness.blockers.includes("promotion-conflict") ||
    row.commandPreview.disposition === "conflicting"
  );
}

function conflictResolutionRowFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
  input: {
    canManage: boolean;
    promotionPreview: CatalogPrimaryWorkbenchReadModel["promotionPreview"];
  },
): ConflictResolutionRow {
  const resolutionState = conflictResolutionStateFor(row);
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>(row.promotionReadiness.blockers);
  if (row.duplicateEvidence.length > 0) {
    blockers.add("duplicate-conflict");
  }
  if (
    row.promotionReadiness.blockers.includes("promotion-conflict") ||
    input.promotionPreview.blockers.includes("promotion-conflict")
  ) {
    blockers.add("promotion-conflict");
  }
  const overrideBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[] = input.canManage
    ? ["unsupported-command"]
    : ["permission-denied", "unsupported-command"];

  return {
    observationId: row.observationId,
    displayName: row.displayName,
    providerKey: row.providerKey,
    externalKey: row.externalKey,
    affectedFact: row.normalizedFactSummaries[0] ?? row.displayName,
    factKey: conflictFactKeyFor(row),
    resolutionState,
    promotionReadinessState: row.promotionReadiness.state,
    precedenceRuleId: conflictPrecedenceRuleIdFor(row, resolutionState),
    candidateValues: conflictCandidateValuesFor(row),
    evidencePaths: conflictEvidencePathsFor(row),
    diagnostics: conflictDiagnosticsFor(row, blockers),
    blockers: [...blockers],
    auditTrail: row.auditTrail,
    detailHref: row.detailHref,
    overrideAction: {
      state: input.canManage ? "unavailable" : "denied",
      blockers: overrideBlockers,
      auditRequired: true,
    },
  };
}

function conflictResolutionStateFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
): ConflictResolutionRow["resolutionState"] {
  if (row.promotionReadiness.blockers.includes("promotion-conflict")) {
    return "blocks-promotion";
  }
  if (row.duplicateEvidence.length > 0) {
    return "requires-review";
  }

  return "auto-resolved";
}

function conflictFactKeyFor(row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number]): string {
  if (row.duplicateEvidence.length > 0) {
    return "merge-identity";
  }
  if (row.statusReason) {
    return "status-reason";
  }

  return "normalized-facts";
}

function conflictPrecedenceRuleIdFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
  resolutionState: ConflictResolutionRow["resolutionState"],
): string {
  if (resolutionState === "blocks-promotion") {
    return "promotion-command.conflict-blocking.v1";
  }
  if (row.duplicateEvidence.length > 0) {
    return "duplicate-prevention.merge-identity.v1";
  }

  return "source-observation.field-precedence.v1";
}

function conflictCandidateValuesFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
): ConflictResolutionRow["candidateValues"] {
  const primaryValue = row.normalizedFactSummaries[0] ?? row.displayName;
  const competingValue = row.conflictEvidence[0] ?? row.duplicateEvidence[0] ?? row.externalKey;
  const unresolvedPromotionConflict = row.promotionReadiness.blockers.includes("promotion-conflict");
  const values: ConflictResolutionRow["candidateValues"] = [
    {
      source: t("catalog.features.sourceObservations.ui.conflictResolution.source.catalogCandidate"),
      value: primaryValue,
      role: unresolvedPromotionConflict ? "candidate" : "winner",
      evidencePath: "sourceObservationReview.rows.normalizedFactSummaries",
    },
    {
      source: t("catalog.features.sourceObservations.ui.conflictResolution.source.providerEvidence"),
      value: competingValue,
      role: unresolvedPromotionConflict ? "candidate" : "loser",
      evidencePath:
        row.conflictEvidence.length > 0
          ? "sourceObservationReview.rows.conflictEvidence"
          : "sourceObservationReview.rows.duplicateEvidence",
    },
  ];
  if (row.duplicateEvidence[0] && row.duplicateEvidence[0] !== competingValue) {
    return [
      ...values,
      {
        source: t("catalog.features.sourceObservations.ui.conflictResolution.source.duplicateEvidence"),
        value: row.duplicateEvidence[0],
        role: "candidate",
        evidencePath: "sourceObservationReview.rows.duplicateEvidence",
      },
    ];
  }

  return values;
}

function conflictEvidencePathsFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
): readonly string[] {
  return [
    "sourceObservationReview.rows.normalizedFactSummaries",
    ...(row.conflictEvidence.length > 0 ? ["sourceObservationReview.rows.conflictEvidence"] : []),
    ...(row.duplicateEvidence.length > 0 ? ["sourceObservationReview.rows.duplicateEvidence"] : []),
    "sourceObservationReview.rows.promotionReadiness",
  ];
}

function conflictDiagnosticsFor(
  row: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"]["rows"][number],
  blockers: ReadonlySet<CatalogPrimaryWorkbenchBlockerCategory>,
): readonly string[] {
  const diagnostics = [
    ...row.conflictEvidence,
    ...row.duplicateEvidence,
    ...[...blockers].map((blocker) => getConflictResolutionBlockerDiagnostic(blocker)),
  ].filter(Boolean);

  return diagnostics.length > 0
    ? [...new Set(diagnostics)]
    : [t("catalog.features.sourceObservations.ui.conflictResolution.diagnostic.autoResolved")];
}

function getConflictResolutionBlockerDiagnostic(blocker: CatalogPrimaryWorkbenchBlockerCategory): string {
  if (blocker === "duplicate-conflict") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.diagnostic.duplicateConflict");
  }
  if (blocker === "promotion-conflict") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.diagnostic.promotionConflict");
  }
  if (blocker === "permission-denied") {
    return t("catalog.features.sourceObservations.ui.conflictResolution.diagnostic.permissionDenied");
  }

  return blocker;
}

function conflictResolutionPrecedenceRules(
  rows: readonly ConflictResolutionRow[],
): ConflictResolution["precedenceRules"] {
  const ruleIds = new Set(rows.map((row) => row.precedenceRuleId));
  if (ruleIds.size === 0) {
    return [];
  }

  const rules: ConflictResolution["precedenceRules"] = [
    {
      ruleId: "promotion-command.conflict-blocking.v1",
      label: t("catalog.features.sourceObservations.ui.conflictResolution.rule.promotionBlocking.label"),
      description: t("catalog.features.sourceObservations.ui.conflictResolution.rule.promotionBlocking.description"),
      blockingBehavior: "promotion-blocking",
      sourceAuthority: t("catalog.features.sourceObservations.ui.conflictResolution.rule.catalogAuthority"),
      evidencePaths: ["promotionPreview.blockers", "sourceObservationReview.rows.promotionReadiness"],
    },
    {
      ruleId: "duplicate-prevention.merge-identity.v1",
      label: t("catalog.features.sourceObservations.ui.conflictResolution.rule.duplicate.label"),
      description: t("catalog.features.sourceObservations.ui.conflictResolution.rule.duplicate.description"),
      blockingBehavior: "review-required",
      sourceAuthority: t("catalog.features.sourceObservations.ui.conflictResolution.rule.catalogAuthority"),
      evidencePaths: ["sourceObservationReview.rows.duplicateEvidence"],
    },
    {
      ruleId: "source-observation.field-precedence.v1",
      label: t("catalog.features.sourceObservations.ui.conflictResolution.rule.fieldPrecedence.label"),
      description: t("catalog.features.sourceObservations.ui.conflictResolution.rule.fieldPrecedence.description"),
      blockingBehavior: "auto-resolved",
      sourceAuthority: t("catalog.features.sourceObservations.ui.conflictResolution.rule.catalogAuthority"),
      evidencePaths: ["sourceObservationReview.rows.conflictEvidence"],
    },
  ];

  return rules.filter((rule) => ruleIds.has(rule.ruleId));
}

function conflictResolutionAuditEventsFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  context: CatalogPrimaryWorkbenchRouteContext,
): ConflictResolution["recentAuditEvents"] {
  return (
    overview?.auditLifecycle.entries
      .filter((entry) => {
        if (context.providerKey && entry.providerKey !== context.providerKey) {
          return false;
        }
        if (context.unitKey && entry.unitKey && entry.unitKey !== context.unitKey) {
          return false;
        }
        return (
          entry.eventName === "import-job-started" ||
          entry.eventName === "reapply-run-executed" ||
          entry.eventName === "profile-activated" ||
          entry.eventName === "profile-section-edited"
        );
      })
      .slice(0, 8)
      .map((entry) => ({
        eventId: entry.eventId,
        occurredAt: entry.occurredAt,
        eventName: entry.eventName,
        providerKey: entry.providerKey,
        unitKey: entry.unitKey as CatalogIntegrationUnitKey | null,
        observationId: null,
        summary: entry.summary,
      })) ?? []
  );
}
