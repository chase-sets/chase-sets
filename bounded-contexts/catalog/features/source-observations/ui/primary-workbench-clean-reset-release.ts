import { t } from "@chase-sets/localization";
import {
  catalogIntegrationDataResetEnvironmentPlans,
  catalogIntegrationDataResetTargetTables,
  evaluateCatalogIntegrationDataResetEvidence,
  type CatalogIntegrationDataBackfillDecision,
  type CatalogIntegrationDataResetEvidencePacket,
} from "../api/catalog-integration-data-reset-evidence";
import type {
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
} from "../api/primary-workbench-admin-contracts";
import {
  catalogPrimaryWorkbenchReturnPath,
  catalogPrimaryWorkbenchSupportingHref,
} from "./primary-workbench-route-context";
import { auditEvidenceLink, type AuditEvidence, type AuditEvidenceLink } from "./primary-workbench-audit-evidence";

export type CatalogPrimaryWorkbenchTemporaryReleaseScaffoldingInput = Readonly<{
  key: string;
  label: string;
  status: "not-used" | "removal-required" | "removed";
  ownerIssue: "#1054" | "#1061" | "#1090";
  evidenceUrl?: string | null;
  removalEvidence?: string | null;
}>;

export type CleanResetRelease = CatalogPrimaryWorkbenchReadModel["cleanResetRelease"];
export type CleanResetDecisionRow = CleanResetRelease["decisions"][number];
export type CleanResetBackfillRow = CleanResetRelease["backfill"][number];
export type CleanResetScaffoldingRow = CleanResetRelease["temporaryScaffolding"][number];

export function cleanResetReleaseFor(input: {
  auditEvidence: AuditEvidence;
  cleanResetEvidence: CatalogIntegrationDataResetEvidencePacket | null;
  generatedAt: string;
  importJobs: CatalogPrimaryWorkbenchReadModel["importJobs"]["jobs"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  sourceObservationReview: CatalogPrimaryWorkbenchReadModel["sourceObservationReview"];
  temporaryReleaseScaffolding: readonly CatalogPrimaryWorkbenchTemporaryReleaseScaffoldingInput[] | null;
}): CleanResetRelease {
  const environment = input.cleanResetEvidence?.environment ?? "production-prelaunch";
  const environmentPlan =
    catalogIntegrationDataResetEnvironmentPlans.find((plan) => plan.environment === environment) ??
    catalogIntegrationDataResetEnvironmentPlans.find((plan) => plan.environment === "production-prelaunch")!;
  const targetTables =
    input.cleanResetEvidence?.targetTables && input.cleanResetEvidence.targetTables.length > 0
      ? input.cleanResetEvidence.targetTables
      : catalogIntegrationDataResetTargetTables();
  const evidencePacket =
    input.cleanResetEvidence ??
    ({
      environment,
      generatedAt: input.generatedAt,
      operator: "",
      approvalReference: null,
      backupDecision: null,
      stagingRehearsalReference: null,
      smokeVerificationReference: null,
      targetTables,
      dryRun: null,
      before: null,
      after: null,
      forcedActiveJobReset: null,
    } satisfies CatalogIntegrationDataResetEvidencePacket);
  const resetFindings = evaluateCatalogIntegrationDataResetEvidence(evidencePacket).map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    message: finding.message,
    blocksRelease: true as const,
  }));
  const cleanResetHref = catalogPrimaryWorkbenchSupportingHref(input.routeContext, "clean-reset-release");
  const auditEvidenceHref = catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence");
  const temporaryScaffolding = cleanResetScaffoldingFor({
    cleanResetHref,
    temporaryReleaseScaffolding: input.temporaryReleaseScaffolding,
  });
  const backfill = cleanResetBackfillFor({
    activeJobs: input.importJobs.filter((job) => job.state === "queued" || job.state === "running").length,
    after: evidencePacket.after,
    cleanResetEvidencePresent: Boolean(input.cleanResetEvidence),
    reviewRows: input.sourceObservationReview.rows.length,
    resetFindings,
  });
  const decisions = cleanResetDecisionsFor({
    auditEvidence: input.auditEvidence,
    backfill,
    cleanResetEvidencePresent: Boolean(input.cleanResetEvidence),
    environment,
    environmentPlan,
    evidencePacket,
    resetFindings,
    temporaryScaffolding,
  });
  const blockingDecisionCount = decisions.filter((decision) => decision.blocksRelease).length;
  const backfillRequiredCount = backfill.filter((row) => row.required).length;
  const temporaryScaffoldingRemovalRequiredCount = temporaryScaffolding.filter(
    (scaffold) => scaffold.status === "removal-required",
  ).length;
  const completeRemovalEvidenceReady = Boolean(
    decisions.find((decision) => decision.key === "complete-old-surface-removal" && !decision.blocksRelease),
  );
  const hasBlockingEvidence =
    blockingDecisionCount > 0 ||
    resetFindings.length > 0 ||
    backfill.some((row) => row.blocksRelease) ||
    temporaryScaffolding.some((scaffold) => scaffold.blocksRelease);
  const status: CleanResetRelease["status"] = hasBlockingEvidence
    ? "blocked"
    : input.cleanResetEvidence && evidencePacket.after && completeRemovalEvidenceReady
      ? "complete"
      : "partial";

  return {
    status,
    generatedAt: input.generatedAt,
    environment,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    auditEvidenceHref,
    summary: {
      decisionCount: decisions.length,
      blockingDecisionCount,
      findingCount: resetFindings.length,
      p0FindingCount: resetFindings.filter((finding) => finding.severity === "p0").length,
      targetTableCount: targetTables.length,
      backfillRequiredCount,
      temporaryScaffoldingRemovalRequiredCount,
      completeRemovalEvidenceReady,
    },
    environmentPlan: {
      mode: "pre-launch-wipe-and-rebuild",
      destructiveResetDefault: true,
      requiresBackupDecision: environmentPlan.requiresBackupDecision,
      requiresApprovalReference: environmentPlan.requiresApprovalReference,
      requiresStagingRehearsal: environment === "production-prelaunch",
      requiresSmokeVerification: environment !== "local-dev-test",
      unrelatedDataBoundary: environmentPlan.unrelatedDataBoundary,
    },
    decisions,
    resetEvidence: {
      targetTables,
      findings: resetFindings,
    },
    backfill,
    temporaryScaffolding,
    releaseProofLinks: [
      auditEvidenceLink({
        href: cleanResetHref,
        key: "clean-reset:policy",
        kind: "proof",
        label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.link.policy"),
        redactionState: "not-needed",
        summary: environmentPlan.unrelatedDataBoundary,
      }),
      auditEvidenceLink({
        href: auditEvidenceHref,
        key: "clean-reset:audit",
        kind: "audit-event",
        label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.link.audit"),
        redactionState: "redacted",
        summary: input.auditEvidence.projectionState.statusMessage,
      }),
    ],
  };
}

function cleanResetDecisionsFor(input: {
  auditEvidence: AuditEvidence;
  backfill: readonly CleanResetBackfillRow[];
  cleanResetEvidencePresent: boolean;
  environment: CleanResetRelease["environment"];
  environmentPlan: (typeof catalogIntegrationDataResetEnvironmentPlans)[number];
  evidencePacket: CatalogIntegrationDataResetEvidencePacket;
  resetFindings: CleanResetRelease["resetEvidence"]["findings"];
  temporaryScaffolding: readonly CleanResetScaffoldingRow[];
}): readonly CleanResetDecisionRow[] {
  const hasResetFindings = input.resetFindings.length > 0;
  const backupReady = !input.environmentPlan.requiresBackupDecision || Boolean(input.evidencePacket.backupDecision);
  const hasBackfillBlocker = input.backfill.some((row) => row.blocksRelease);
  const hasScaffoldingBlocker = input.temporaryScaffolding.some((row) => row.blocksRelease);
  const auditBlocked = input.auditEvidence.releaseChecklist.some((row) => row.blocksRelease);
  const cleanEvidenceStatus = (blocked: boolean, readyWhenPresent = true): CleanResetDecisionRow["status"] =>
    blocked ? "blocked" : input.cleanResetEvidencePresent && readyWhenPresent ? "complete" : "missing";

  return [
    cleanResetDecision({
      blocksRelease: hasResetFindings,
      evidence: input.cleanResetEvidencePresent
        ? t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.reset.evidenceReady")
        : t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.reset.evidenceMissing"),
      key: "destructive-reset-policy",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.reset.label"),
      owner: "catalog-source-observations",
      ownerIssue: "#1054",
      requiredEvidence: [
        "pre-launch wipe and rebuild mode",
        "dry-run counts",
        "before and after verification",
        "target table scope",
      ],
      status: cleanEvidenceStatus(hasResetFindings),
    }),
    cleanResetDecision({
      blocksRelease: !backupReady,
      evidence: backupReady
        ? backupDecisionLabel(input.evidencePacket.backupDecision)
        : t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backup.missing"),
      key: "backup-or-data-loss",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backup.label"),
      owner: "catalog-source-observations",
      ownerIssue: "#1054",
      requiredEvidence: [
        "backup/snapshot/export decision or accepted data loss",
        "approval reference",
        "restore verification when backup exists",
      ],
      status: cleanEvidenceStatus(!backupReady, backupReady),
    }),
    cleanResetDecision({
      blocksRelease: hasScaffoldingBlocker,
      evidence: hasScaffoldingBlocker
        ? t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.scaffolding.blocked")
        : t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.scaffolding.ready"),
      key: "deploy-skew-removal",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.scaffolding.label"),
      owner: "ops-release",
      ownerIssue: "#1061",
      requiredEvidence: [
        "deploy-skew check complete",
        "temporary reset/backfill/deploy-skew scaffolding deleted",
        "no internal support surface remains",
      ],
      status: hasScaffoldingBlocker ? "blocked" : "ready",
    }),
    cleanResetDecision({
      blocksRelease: hasBackfillBlocker,
      evidence: hasBackfillBlocker
        ? t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backfill.blocked")
        : t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backfill.ready"),
      key: "backfill-clean-state",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backfill.label"),
      owner: "catalog-source-observations",
      ownerIssue: "#1054",
      requiredEvidence: [
        "backfill skipped after clean wipe",
        "or retained data backfilled to clean launch semantics",
        "legacy profile references are zero",
      ],
      status: hasBackfillBlocker ? "blocked" : input.cleanResetEvidencePresent ? "complete" : "missing",
    }),
    cleanResetDecision({
      blocksRelease: auditBlocked || hasResetFindings,
      evidence: input.auditEvidence.releaseChecklist.map((row) => `${row.workflowLabel}: ${row.status}`).join("; "),
      key: "release-acceptance",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.release.label"),
      owner: "ops-release",
      ownerIssue: "#1061",
      requiredEvidence: ["staging smoke", "production/prelaunch smoke", "audit evidence", "release signoff"],
      status: auditBlocked || hasResetFindings ? "blocked" : "ready",
    }),
    cleanResetDecision({
      blocksRelease: hasScaffoldingBlocker,
      evidence:
        "Complete removal of code, patterns, documentation, tests, fixtures, screenshots, runbooks, release notes, and operator instructions is required before launch.",
      key: "complete-old-surface-removal",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.removal.label"),
      owner: "ops-release",
      ownerIssue: "#1090",
      requiredEvidence: [
        "complete removal of code",
        "complete removal of product and UX patterns",
        "complete removal of documentation, runbooks, release notes, and operator instructions",
        "complete removal of tests, fixtures, and screenshots that preserve retired behavior",
        "no hidden flag, fallback branch, compatibility redirect, migration shim, alias, or support-only path",
      ],
      status: hasScaffoldingBlocker ? "blocked" : "ready",
    }),
  ];
}

function cleanResetDecision(input: CleanResetDecisionRow): CleanResetDecisionRow {
  return input;
}

function cleanResetBackfillFor(input: {
  activeJobs: number;
  after: CatalogIntegrationDataResetEvidencePacket["after"];
  cleanResetEvidencePresent: boolean;
  reviewRows: number;
  resetFindings: CleanResetRelease["resetEvidence"]["findings"];
}): readonly CleanResetBackfillRow[] {
  const missingResetEvidence = !input.cleanResetEvidencePresent || input.resetFindings.length > 0 || !input.after;
  const retainedObservations = (input.after?.sourceObservations ?? input.reviewRows) > 0;
  const legacyReferences = (input.after?.legacySourceObservationReferences ?? 0) > 0;
  const retainedJobs =
    (input.after?.integrationDurableJobs ?? input.activeJobs) > 0 ||
    (input.after?.bulkReviewJobs ?? 0) > 0 ||
    input.activeJobs > 0;
  const rows: readonly (CatalogIntegrationDataBackfillDecision & Readonly<{ blocked: boolean; evidence: string }>)[] = [
    {
      key: "profile-section-projections",
      required: missingResetEvidence || Boolean(input.after && input.after.profileSections === 0),
      reason:
        "Profile section projections are rebuilt from retained or seeded profile versions after reset; clean wipe evidence may skip additional backfill.",
      blocked: missingResetEvidence || Boolean(input.after && input.after.profileSections === 0),
      evidence: input.after
        ? `${input.after.profileSections} section row(s), ${input.after.profileSectionDiagnostics} diagnostic row(s)`
        : "reset after-report missing",
    },
    {
      key: "source-observation-profile-references",
      required: missingResetEvidence || retainedObservations || legacyReferences,
      reason:
        "Retained Source Observations must carry clean source and promotion profile references; prelaunch wipe leaves zero retained observations.",
      blocked: missingResetEvidence || retainedObservations || legacyReferences,
      evidence: input.after
        ? `${input.after.sourceObservations} observation(s), ${input.after.legacySourceObservationReferences} legacy reference(s)`
        : "reset after-report missing",
    },
    {
      key: "durable-job-profile-snapshots",
      required: missingResetEvidence || retainedJobs,
      reason:
        "Retained durable jobs must keep readable clean profile snapshots; clean wipe leaves no retained import or review jobs.",
      blocked: missingResetEvidence || retainedJobs,
      evidence: input.after
        ? `${input.after.integrationDurableJobs} import job(s), ${input.after.bulkReviewJobs} review job(s)`
        : "reset after-report missing",
    },
  ];

  return rows.map((row) => ({
    key: row.key,
    required: row.required,
    status: row.blocked ? "blocked" : row.required ? "complete" : ("skipped-clean-reset" as const),
    reason: row.reason,
    evidence: row.evidence,
    blocksRelease: row.blocked,
  }));
}

function cleanResetScaffoldingFor(input: {
  cleanResetHref: string;
  temporaryReleaseScaffolding: readonly CatalogPrimaryWorkbenchTemporaryReleaseScaffoldingInput[] | null;
}): readonly CleanResetScaffoldingRow[] {
  const defaultRows: readonly CatalogPrimaryWorkbenchTemporaryReleaseScaffoldingInput[] = [
    {
      key: "reset-execution-scaffold",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.reset"),
      ownerIssue: "#1054",
      status: "not-used",
    },
    {
      key: "backfill-verification-scaffold",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.backfill"),
      ownerIssue: "#1054",
      status: "not-used",
    },
    {
      key: "deploy-skew-release-scaffold",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.deploySkew"),
      ownerIssue: "#1061",
      status: "not-used",
    },
    {
      key: "old-surface-removal-scaffold",
      label: t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.oldSurface"),
      ownerIssue: "#1090",
      status: "not-used",
    },
  ];

  return (input.temporaryReleaseScaffolding?.length ? input.temporaryReleaseScaffolding : defaultRows).map((row) => ({
    key: row.key,
    label: row.label,
    status: row.status,
    ownerIssue: row.ownerIssue,
    evidenceUrl: row.evidenceUrl ?? input.cleanResetHref,
    deletionRequiredBeforeLaunch: true,
    blocksRelease: row.status === "removal-required",
    removalEvidence:
      row.removalEvidence ??
      (row.status === "not-used"
        ? t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.notUsed")
        : row.status === "removed"
          ? t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.removed")
          : t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.scaffolding.required")),
  }));
}

function backupDecisionLabel(
  decision: CatalogIntegrationDataResetEvidencePacket["backupDecision"] | undefined,
): string {
  if (!decision) {
    return t("catalog.features.sourceObservations.ui.cleanResetRelease.readModel.decision.backup.none");
  }
  if (decision.kind === "create-backup-snapshot-export") {
    return `${decision.reference}; ${decision.restoreVerificationReference}`;
  }
  if (decision.kind === "skip-backup-accepted-data-loss") {
    return `${decision.approver}: ${decision.targetDataSet}`;
  }

  return `${decision.owner}: ${decision.reason}`;
}
