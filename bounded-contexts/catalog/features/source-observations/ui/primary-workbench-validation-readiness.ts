import { t } from "@chase-sets/localization";
import { catalogProviderRequiredFixtureFlows } from "../api/provider-integration-mapping-contract";
import type { CatalogProviderProfileEditableSectionKey } from "../api/provider-profile-section-registry";
import type {
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
  CatalogPrimaryWorkbenchRouteContext,
  CatalogPrimaryWorkbenchValidationEvidenceRow,
} from "../api/primary-workbench-admin-contracts";
import type {
  CatalogIntegrationControlPlaneOverview,
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileVersionReview,
} from "./contracts";
import {
  catalogPrimaryWorkbenchReturnPath,
  catalogPrimaryWorkbenchSupportingHref,
} from "./primary-workbench-route-context";
import { catalogProviderDetailHref } from "./admin-control-plane/provider-detail/provider-detail-links";
import {
  actionStateForBlockers,
  arrayValue,
  compactMappingSummary,
  expressionSummary,
  recordValue,
  stringArrayValue,
  stringValue,
} from "./primary-workbench-read-model-support";
import {
  profileDiagnosticsBySection,
  profileSectionDomainConcept,
  sectionForDiagnosticPath,
} from "./primary-workbench-profile-section-workspaces";
import { profileSectionMappingRows } from "./primary-workbench-profile-mapping-rows";

export type ValidationReadiness = CatalogPrimaryWorkbenchReadModel["validationReadiness"];
export type ValidationFixtureFlow = ValidationReadiness["fixtureFlows"][number];
export type ValidationDryRunEvidence = ValidationReadiness["dryRunEvidence"][number];
export type ValidationSemanticSection = ValidationReadiness["semanticCompare"]["sections"][number];
export type ValidationActivationGroup = ValidationReadiness["activationReadiness"]["groups"][number];
export type ValidationActivationDecision = ValidationReadiness["activationDecision"];

export function validationReadinessFor(input: {
  activeJobCount: number;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  canManage: boolean;
  controlPlaneOverview: CatalogIntegrationControlPlaneOverview | null;
  generatedAt: string;
  profileAuthoring: CatalogPrimaryWorkbenchReadModel["profileAuthoring"];
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  selectedProfile: CatalogProviderProfileVersionReview | null;
}): ValidationReadiness {
  const profile = input.selectedProfile;
  const authoringModel = authoringModelForProfile(input.authoringModel, profile);
  const readinessUnit = validationReadinessUnitFor(input.controlPlaneOverview, input.routeContext, profile);
  const fixtureFlows = validationFixtureFlowsFor({
    activeJobCount: input.activeJobCount,
    authoringModel,
    canManage: input.canManage,
    profile,
    readinessUnit,
  });
  const dryRunEvidence = validationDryRunEvidenceFor({
    authoringModel,
    profile,
    readinessUnit,
    routeContext: input.routeContext,
  });
  const semanticCompare = validationSemanticCompareFor({
    authoringModel,
    fixtureFlows,
    profile,
    profileAuthoring: input.profileAuthoring,
  });
  const activationReadiness = validationActivationReadinessFor({
    authoringModel,
    fixtureFlows,
    profile,
    readinessUnit,
    semanticCompare,
  });
  const activationDecision = validationActivationDecisionFor({
    activationReadiness,
    activeJobCount: input.activeJobCount,
    canManage: input.canManage,
    profile,
    routeContext: input.routeContext,
    semanticCompare,
  });
  const blockedFixtureFlows = fixtureFlows.filter(
    (flow) => flow.status === "blocked" || flow.status === "not-covered",
  ).length;
  const blockingReadinessChecks = activationReadiness.groups.flatMap((group) =>
    group.checks.filter((check) => check.status === "blocked"),
  ).length;
  const semanticChangeCount = semanticCompare.sections.reduce(
    (count, sectionEntry) => count + sectionEntry.changeCount,
    0,
  );
  const auditEvidenceCount = dryRunEvidence.reduce((count, evidence) => count + evidence.auditEvidence.length, 0);
  const status: ValidationReadiness["status"] = !profile
    ? "unavailable"
    : blockedFixtureFlows > 0 || blockingReadinessChecks > 0 || readinessUnit?.dryRunStatus === "blocked"
      ? "blocked"
      : fixtureFlows.some((flow) => flow.status === "warning") || semanticChangeCount > 0
        ? "degraded"
        : "ready";

  return {
    status,
    freshness: authoringModel && input.controlPlaneOverview ? "fresh" : profile ? "partial" : "unavailable",
    generatedAt: authoringModel ? authoringModel.dryRunInputTemplate.observedAt : input.generatedAt,
    selectedProviderKey: input.routeContext.providerKey ?? profile?.providerKey ?? null,
    selectedUnitKey: input.routeContext.unitKey,
    selectedProfileVersion: profile?.profileVersion ?? null,
    selectedFixtureFlow:
      authoringModel?.dryRunInputTemplate.defaultFlow ??
      fixtureFlows.find((flow) => flow.status === "ready")?.flow ??
      null,
    returnToPrimaryHref: catalogPrimaryWorkbenchReturnPath(input.routeContext),
    summary: {
      readyFixtureFlows: fixtureFlows.filter((flow) => flow.status === "ready").length,
      totalFixtureFlows: fixtureFlows.length,
      blockedFixtureFlows,
      dryRunEvidenceCount: dryRunEvidence.length,
      semanticChangeCount,
      unchangedSectionCount: semanticCompare.unchangedSections.length,
      blockingReadinessChecks,
      auditEvidenceCount,
    },
    fixtureFlows,
    dryRunEvidence,
    semanticCompare,
    activationReadiness,
    activationDecision,
  };
}

function authoringModelForProfile(
  authoringModel: CatalogProviderProfileAuthoringModel | null,
  profile: CatalogProviderProfileVersionReview | null,
): CatalogProviderProfileAuthoringModel | null {
  if (!authoringModel || !profile) {
    return null;
  }

  return authoringModel.review.providerKey === profile.providerKey &&
    authoringModel.review.profileVersion === profile.profileVersion
    ? authoringModel
    : null;
}

function validationReadinessUnitFor(
  overview: CatalogIntegrationControlPlaneOverview | null,
  routeContext: CatalogPrimaryWorkbenchRouteContext,
  profile: CatalogProviderProfileVersionReview | null,
): CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null {
  const units = overview?.readiness.units ?? [];
  return (
    units.find((unit) => routeContext.unitKey && unit.unitKey === routeContext.unitKey) ??
    units.find(
      (unit) =>
        profile &&
        unit.providerKey === profile.providerKey &&
        (!unit.profileVersion || unit.profileVersion === profile.profileVersion),
    ) ??
    units.find((unit) => routeContext.providerKey && unit.providerKey === routeContext.providerKey) ??
    null
  );
}

function validationFixtureFlowsFor(input: {
  activeJobCount: number;
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  canManage: boolean;
  profile: CatalogProviderProfileVersionReview | null;
  readinessUnit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null;
}): readonly ValidationFixtureFlow[] {
  if (!input.profile) {
    return [];
  }
  const profile = input.profile;
  const requiredFlows = new Set<string>(catalogProviderRequiredFixtureFlows);
  const fixtureCasesByFlow = new Map(
    (input.authoringModel?.fixtureCases ?? []).map((fixtureCase) => [fixtureCase.flow, fixtureCase]),
  );
  for (const flow of profile.fixtures.coveredFlows) {
    requiredFlows.add(flow);
  }
  for (const fixtureCase of fixtureCasesByFlow.values()) {
    requiredFlows.add(fixtureCase.flow);
  }

  return [...requiredFlows].sort().map((flow) => {
    const fixtureCase = fixtureCasesByFlow.get(flow) ?? null;
    const diagnostics = validationDiagnosticsForFixtureFlow(profile, flow);
    const blockers = validationFixtureFlowBlockers({
      activeJobCount: input.activeJobCount,
      canManage: input.canManage,
      covered: profile.fixtures.coveredFlows.includes(flow),
      diagnostics,
      readinessUnit: input.readinessUnit,
    });
    const status = validationFixtureFlowStatus({
      blockers,
      covered: profile.fixtures.coveredFlows.includes(flow),
      diagnostics,
    });

    return {
      flow,
      label: flowLabel(flow),
      status,
      payloadFile: fixtureCase?.payloadFile ?? null,
      payloadPath: fixtureCase?.payloadPath ?? null,
      expectedStatus: fixtureCase?.expectedStatus ?? null,
      expectedDiagnosticPaths: fixtureCase?.expectedDiagnosticPaths ?? [],
      expectedHashEvidencePaths: fixtureCase?.expectedHashEvidencePaths ?? [],
      expectedMergeEvidencePaths: fixtureCase?.expectedMergeEvidencePaths ?? [],
      expectedPromotionCommands: fixtureCase?.expectedPromotionCommands ?? [],
      samplePayloadAvailable: fixtureCase?.samplePayloadAvailable ?? false,
      diagnostics,
      actionState: actionStateForBlockers(blockers, input.canManage ? "available" : "denied"),
      blockers,
    };
  });
}

function validationFixtureFlowBlockers(input: {
  activeJobCount: number;
  canManage: boolean;
  covered: boolean;
  diagnostics: readonly { severity: "error" | "warning" }[];
  readinessUnit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null;
}): readonly CatalogPrimaryWorkbenchBlockerCategory[] {
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!input.canManage) {
    blockers.add("permission-denied");
  }
  if (!input.covered) {
    blockers.add("missing-fixture-coverage");
  }
  if (
    input.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
    input.readinessUnit?.fixtureValidationStatus === "blocked"
  ) {
    blockers.add("fixture-validation-blocked");
  }
  if (input.activeJobCount > 0) {
    blockers.add("active-job-conflict");
  }
  if (input.activeJobCount > 1) {
    blockers.add("concurrent-job");
  }

  return [...blockers];
}

function validationFixtureFlowStatus(input: {
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  covered: boolean;
  diagnostics: readonly { severity: "error" | "warning" }[];
}): ValidationFixtureFlow["status"] {
  if (!input.covered) {
    return "not-covered";
  }
  if (input.blockers.includes("fixture-validation-blocked")) {
    return "blocked";
  }
  if (input.diagnostics.length > 0) {
    return "warning";
  }

  return "ready";
}

function validationDiagnosticsForFixtureFlow(
  profile: CatalogProviderProfileVersionReview,
  flow: string,
): readonly { path: string; diagnosticText: string; severity: "error" | "warning" }[] {
  return profile.validation.diagnostics
    .filter((diagnostic) => {
      const normalizedPath = diagnostic.path.toLowerCase();
      const normalizedFlow = flow.toLowerCase();
      return (
        normalizedPath.includes("fixture") &&
        (normalizedPath.includes(normalizedFlow) || normalizedPath.endsWith("coveredflows"))
      );
    })
    .map((diagnostic) => ({
      path: diagnostic.path,
      diagnosticText: diagnostic.diagnosticText,
      severity: diagnostic.severity,
    }));
}

function validationDryRunEvidenceFor(input: {
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  profile: CatalogProviderProfileVersionReview | null;
  readinessUnit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
}): readonly ValidationDryRunEvidence[] {
  if (!input.profile) {
    return [];
  }
  const duplicateCandidates = validationEvidenceRowsForSection(input.profile, "duplicate-prevention");
  const selectedOptions = validationEvidenceRowsForSection(input.profile, "selected-options");
  const promotionCommandPreview = validationPromotionCommandPreviewFor(input.profile);
  const diagnostics = validationDiagnosticLinksFor(input.profile, input.authoringModel);
  const auditEvidence = validationAuditEvidenceFor(input.profile);
  const unitEvidence = input.readinessUnit?.dryRunEvidence ?? [];

  if (unitEvidence.length === 0) {
    return [
      {
        externalKey:
          input.routeContext.providerKey ??
          input.profile.providerKey ??
          t("catalog.features.sourceObservations.ui.primaryWorkbench.not.selected"),
        sourceUrl: null,
        sourceHash: null,
        status: input.readinessUnit?.dryRunStatus ?? "not-run",
        normalizedFacts: [],
        redactionSummary: validationRedactionSummary(0, false),
        duplicateCandidates,
        selectedOptions,
        promotionCommandPreview,
        diagnostics,
        auditEvidence,
      },
    ];
  }

  return unitEvidence.map((evidence) => {
    const normalizedFacts = Object.entries(evidence.normalizedFacts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value }));

    return {
      externalKey: evidence.externalKey,
      sourceUrl: evidence.sourceUrl,
      sourceHash: evidence.sourceHash,
      status: input.readinessUnit?.dryRunStatus ?? "completed",
      normalizedFacts,
      redactionSummary: validationRedactionSummary(normalizedFacts.length, Boolean(evidence.sourceHash)),
      duplicateCandidates,
      selectedOptions,
      promotionCommandPreview,
      diagnostics,
      auditEvidence,
    };
  });
}

function validationEvidenceRowsForSection(
  profile: CatalogProviderProfileVersionReview,
  section: CatalogProviderProfileEditableSectionKey,
): readonly CatalogPrimaryWorkbenchValidationEvidenceRow[] {
  const diagnostics = profileDiagnosticsBySection(profile).get(section) ?? [];
  return profileSectionMappingRows(profile, section, diagnostics).map((row) => ({
    key: row.key,
    label: row.label,
    path: row.path,
    summary: row.summary,
    owner: row.owner,
    uses: row.uses,
    diagnostics: row.diagnostics,
  }));
}

function validationPromotionCommandPreviewFor(
  profile: CatalogProviderProfileVersionReview,
): ValidationDryRunEvidence["promotionCommandPreview"] {
  const commandPlan = recordValue(recordValue(profile.executableMappingContract)?.promotionCommandPlan);

  return arrayValue(commandPlan?.commands).map((command, index) => {
    const commandRecord = recordValue(command);
    const inputs = Object.entries(recordValue(commandRecord?.inputs) ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([inputKey, expression]) =>
        validationExpressionEvidenceRow({
          key: `promotion-command.${index}.${inputKey}`,
          label: inputKey,
          path: `executableMappingContract.promotionCommandPlan.commands.${index}.inputs.${inputKey}`,
          expression,
        }),
      );

    return {
      commandName: stringValue(commandRecord?.commandName) ?? `Command ${index + 1}`,
      inputs,
    };
  });
}

function validationExpressionEvidenceRow(input: {
  key: string;
  label: string;
  path: string;
  expression: unknown;
}): CatalogPrimaryWorkbenchValidationEvidenceRow {
  const expression = recordValue(input.expression);

  return {
    key: input.key,
    label: input.label,
    path: input.path,
    summary: compactMappingSummary(expressionSummary(expression)),
    owner: stringValue(expression?.owner),
    uses: stringArrayValue(expression?.uses),
    diagnostics: [],
  };
}

function validationDiagnosticLinksFor(
  profile: CatalogProviderProfileVersionReview,
  authoringModel: CatalogProviderProfileAuthoringModel | null,
): ValidationDryRunEvidence["diagnostics"] {
  const authoringChecks =
    authoringModel?.activationReadiness.checks
      .filter((check) => check.status === "blocked")
      .map((check) => ({
        code: check.code,
        path: check.path,
        sectionKey: check.sectionKey,
        domainConcept: check.domainConcept,
        diagnosticText: check.diagnosticText,
        severity: check.severity,
        fixtureFlow: check.flow ?? null,
      })) ?? [];
  if (authoringChecks.length > 0) {
    return authoringChecks;
  }

  return profile.validation.diagnostics.map((diagnostic, index) => {
    const section = sectionForDiagnosticPath(diagnostic.path);

    return {
      code: `profile-validation-${index + 1}`,
      path: diagnostic.path,
      sectionKey: section,
      domainConcept: profileSectionDomainConcept(section),
      diagnosticText: diagnostic.diagnosticText,
      severity: diagnostic.severity,
      fixtureFlow: fixtureFlowFromPath(diagnostic.path),
    };
  });
}

function validationRedactionSummary(
  normalizedFactCount: number,
  sourceHashAvailable: boolean,
): ValidationDryRunEvidence["redactionSummary"] {
  return [
    {
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.redaction.payload"),
      value: "not retained",
    },
    {
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.redaction.normalizedFacts"),
      value: `${normalizedFactCount} redacted summaries`,
    },
    {
      label: t("catalog.features.sourceObservations.ui.primaryWorkbench.validation.redaction.sourceHash"),
      value: sourceHashAvailable ? "captured" : "not captured",
    },
  ];
}

function validationAuditEvidenceFor(profile: CatalogProviderProfileVersionReview): readonly string[] {
  return [
    profile.migrationEvidence?.fixtureRunId ? `fixture-run:${profile.migrationEvidence.fixtureRunId}` : null,
    profile.migrationEvidence?.recordedAt ? `migration-evidence:${profile.migrationEvidence.recordedAt}` : null,
    profile.authoringAudit?.updatedAt ? `profile-authoring:${profile.authoringAudit.updatedAt}` : null,
  ].filter((value): value is string => Boolean(value));
}

function validationSemanticCompareFor(input: {
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  fixtureFlows: readonly ValidationFixtureFlow[];
  profile: CatalogProviderProfileVersionReview | null;
  profileAuthoring: CatalogPrimaryWorkbenchReadModel["profileAuthoring"];
}): ValidationReadiness["semanticCompare"] {
  if (input.authoringModel) {
    const semanticDiff = input.authoringModel.semanticDiff;
    const sections = semanticDiff.sections.map((sectionEntry) => ({
      sectionKey: sectionEntry.sectionKey,
      domainConcept: sectionEntry.domainConcept,
      status: sectionEntry.status,
      changeCount: sectionEntry.changes.filter((change) => change.changed).length,
      changes: sectionEntry.changes.map((change) => ({
        path: change.path,
        label: change.label,
        candidateSummary: summarizeValidationValue(change.candidate),
        activeSummary: summarizeValidationValue(change.active),
        changed: change.changed,
        severity: change.severity,
        activationImpact: change.activationImpact,
      })),
    }));

    return {
      mappingFingerprint: semanticDiff.mappingFingerprint,
      activationImpact: uniqueStrings(
        semanticDiff.changes.filter((change) => change.changed).map((change) => change.activationImpact),
      ),
      fixtureCoverage: input.fixtureFlows.map((flow) => ({ flow: flow.flow, status: flow.status })),
      sections,
      unchangedSections: sections
        .filter((sectionEntry) => sectionEntry.changeCount === 0)
        .map((sectionEntry) => ({
          sectionKey: sectionEntry.sectionKey,
          domainConcept: sectionEntry.domainConcept,
        })),
    };
  }

  const profile = input.profile;
  const sections = input.profileAuthoring.sectionWorkspaces.map((workspace) => {
    const changes = [
      ...workspace.diagnostics.map((diagnostic) => ({
        path: diagnostic.path,
        label: workspace.displayName,
        candidateSummary: diagnostic.diagnosticText,
        activeSummary: "previous validated profile",
        changed: true,
        severity: diagnostic.severity,
        activationImpact: `Blocks or degrades ${workspace.domainConcept}.`,
      })),
      ...(workspace.semanticChangeCount > 0
        ? [
            {
              path: workspace.sectionKey,
              label: workspace.displayName,
              candidateSummary: "updated section evidence",
              activeSummary: "active section evidence",
              changed: true,
              severity: "warning" as const,
              activationImpact: `Review ${workspace.domainConcept} before activation.`,
            },
          ]
        : []),
    ];

    return {
      sectionKey: workspace.sectionKey,
      domainConcept: workspace.domainConcept,
      status: workspace.status === "blocked" ? "error" : workspace.status,
      changeCount: changes.filter((change) => change.changed).length,
      changes,
    } satisfies ValidationSemanticSection;
  });
  const mappingFingerprint = {
    candidate:
      profile?.migrationEvidence?.mappingFingerprintAfter ??
      profile?.migrationEvidence?.mappingFingerprintBefore ??
      null,
    active: profile?.migrationEvidence?.mappingFingerprintBefore ?? null,
    changed: Boolean(
      profile?.migrationEvidence?.mappingFingerprintBefore &&
      profile?.migrationEvidence?.mappingFingerprintAfter &&
      profile.migrationEvidence.mappingFingerprintBefore !== profile.migrationEvidence.mappingFingerprintAfter,
    ),
  };

  return {
    mappingFingerprint,
    activationImpact: uniqueStrings(
      sections.flatMap((sectionEntry) => sectionEntry.changes.map((change) => change.activationImpact)),
    ),
    fixtureCoverage: input.fixtureFlows.map((flow) => ({ flow: flow.flow, status: flow.status })),
    sections,
    unchangedSections: sections
      .filter((sectionEntry) => sectionEntry.changeCount === 0)
      .map((sectionEntry) => ({
        sectionKey: sectionEntry.sectionKey,
        domainConcept: sectionEntry.domainConcept,
      })),
  };
}

function validationActivationReadinessFor(input: {
  authoringModel: CatalogProviderProfileAuthoringModel | null;
  fixtureFlows: readonly ValidationFixtureFlow[];
  profile: CatalogProviderProfileVersionReview | null;
  readinessUnit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null;
  semanticCompare: ValidationReadiness["semanticCompare"];
}): ValidationReadiness["activationReadiness"] {
  if (input.authoringModel) {
    return {
      status: input.authoringModel.activationReadiness.status,
      requiresMigrationEvidence: input.authoringModel.activationReadiness.requiresMigrationEvidence,
      referenceCount: input.authoringModel.activationReadiness.referenceCount,
      groups: input.authoringModel.activationReadiness.groups.map((group) => ({
        domainConcept: group.domainConcept,
        status: group.status,
        checks: group.checks.map((check) => ({
          checkKey: check.checkKey,
          code: check.code,
          sectionKey: check.sectionKey,
          status: check.status,
          path: check.path,
          diagnosticText: check.diagnosticText,
          severity: check.severity,
          remediation: check.remediation,
          blockingBehavior: check.blockingBehavior,
          flow: check.flow ?? null,
        })),
      })),
    };
  }

  const groups = validationActivationGroupsFromProfile(input);
  return {
    status: groups.some((group) => group.status === "blocked") ? "blocked" : "ready",
    requiresMigrationEvidence: Boolean(
      input.profile?.referenceCount && input.semanticCompare.mappingFingerprint.changed,
    ),
    referenceCount: input.profile?.referenceCount ?? 0,
    groups,
  };
}

function validationActivationDecisionFor(input: {
  activationReadiness: ValidationReadiness["activationReadiness"];
  activeJobCount: number;
  canManage: boolean;
  profile: CatalogProviderProfileVersionReview | null;
  routeContext: CatalogPrimaryWorkbenchRouteContext;
  semanticCompare: ValidationReadiness["semanticCompare"];
}): ValidationActivationDecision {
  const profile = input.profile;
  const migrationEvidenceRecorded = Boolean(profile?.migrationEvidence?.evidenceText);
  const migrationEvidenceRequired = input.activationReadiness.requiresMigrationEvidence;
  const blockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();

  if (!profile) {
    blockers.add("profile-version-missing");
  }
  if (!input.canManage) {
    blockers.add("permission-denied");
  }
  if (input.activeJobCount > 0) {
    blockers.add("active-job-conflict");
  }
  if (input.activeJobCount > 1) {
    blockers.add("concurrent-job");
  }
  if (input.activationReadiness.status === "blocked") {
    blockers.add("activation-readiness-blocked");
  }
  if (migrationEvidenceRequired && !migrationEvidenceRecorded) {
    blockers.add("migration-evidence-missing");
  }
  if (migrationEvidenceRequired && input.activationReadiness.referenceCount > 0 && !migrationEvidenceRecorded) {
    blockers.add("reference-impact-review-required");
  }

  const saveEvidenceBlockers = new Set<CatalogPrimaryWorkbenchBlockerCategory>();
  if (!profile) {
    saveEvidenceBlockers.add("profile-version-missing");
  }
  if (!input.canManage) {
    saveEvidenceBlockers.add("permission-denied");
  }

  const blockerList = [...blockers];
  const saveEvidenceBlockerList = [...saveEvidenceBlockers];
  const status: ValidationActivationDecision["status"] = !profile
    ? "unavailable"
    : blockerList.length > 0
      ? "blocked"
      : "ready";

  return {
    status,
    actionState: actionStateForBlockers(blockerList, input.canManage ? "available" : "denied"),
    blockers: blockerList,
    saveEvidenceState: actionStateForBlockers(saveEvidenceBlockerList, input.canManage ? "available" : "denied"),
    saveEvidenceBlockers: saveEvidenceBlockerList,
    activationCommandKey: "activate-provider-profile",
    evidenceCommandKey: "update-provider-profile-section",
    workspaceHref: catalogProviderDetailHref(profile?.providerKey ?? input.routeContext.providerKey ?? null, {
      profileVersion: profile?.profileVersion ?? input.routeContext.profileVersion,
    }),
    providerKey: profile?.providerKey ?? input.routeContext.providerKey ?? null,
    profileVersion: profile?.profileVersion ?? input.routeContext.profileVersion ?? null,
    lifecycle: profile?.lifecycle ?? null,
    importEligibility: !profile
      ? "not-selected"
      : input.activationReadiness.status === "ready"
        ? "eligible"
        : "blocked",
    affectedReferences: {
      referenceCount: input.activationReadiness.referenceCount,
      requiresMigrationEvidence: migrationEvidenceRequired,
      replayImplications: validationReplayImplicationsFor({
        referenceCount: input.activationReadiness.referenceCount,
        mappingFingerprintChanged: input.semanticCompare.mappingFingerprint.changed,
      }),
    },
    migrationEvidence: {
      state: migrationEvidenceRecorded ? "recorded" : migrationEvidenceRequired ? "required" : "not-required",
      evidenceText: profile?.migrationEvidence?.evidenceText ?? "",
      fixtureRunId: profile?.migrationEvidence?.fixtureRunId ?? null,
      mappingFingerprintBefore: profile?.migrationEvidence?.mappingFingerprintBefore ?? null,
      mappingFingerprintAfter: profile?.migrationEvidence?.mappingFingerprintAfter ?? null,
      recordedAt: profile?.migrationEvidence?.recordedAt ?? null,
      recordedByUserId: profile?.migrationEvidence?.recordedByUserId ?? null,
    },
    auditConsequences: {
      auditEvidenceUrl: catalogPrimaryWorkbenchSupportingHref(input.routeContext, "audit-evidence"),
      eventNames: ["activation-readiness-evaluated", "profile-activated"],
      summary:
        status === "ready"
          ? "Activation records readiness evaluation and profile activation audit evidence."
          : "Blocked activation keeps readiness, migration evidence, and remediation visible before activation.",
    },
  };
}

function validationReplayImplicationsFor(input: {
  referenceCount: number;
  mappingFingerprintChanged: boolean;
}): readonly string[] {
  const implications: string[] = [];
  if (input.referenceCount > 0) {
    implications.push(
      `${input.referenceCount} existing references may need replay or reapply review after activation.`,
    );
  }
  implications.push(
    input.mappingFingerprintChanged
      ? "Mapping fingerprint changed; replay and reapply decisions must use this activation evidence."
      : "No mapping fingerprint change detected for replay or reapply decisions.",
  );

  return implications;
}

function validationActivationGroupsFromProfile(input: {
  fixtureFlows: readonly ValidationFixtureFlow[];
  profile: CatalogProviderProfileVersionReview | null;
  readinessUnit: CatalogIntegrationControlPlaneOverview["readiness"]["units"][number] | null;
}): readonly ValidationActivationGroup[] {
  const groups = new Map<string, ValidationActivationGroup["checks"][number][]>();
  const addCheck = (domainConcept: string, check: ValidationActivationGroup["checks"][number]) => {
    groups.set(domainConcept, [...(groups.get(domainConcept) ?? []), check]);
  };

  for (const diagnostic of input.profile?.validation.diagnostics ?? []) {
    const section = sectionForDiagnosticPath(diagnostic.path);
    const domainConcept = profileSectionDomainConcept(section);
    addCheck(domainConcept, {
      checkKey: `profile-diagnostic:${diagnostic.path}`,
      code: "profile-section-invalid",
      sectionKey: section,
      status: "blocked",
      path: diagnostic.path,
      diagnosticText: diagnostic.diagnosticText,
      severity: diagnostic.severity,
      remediation: `Resolve ${diagnostic.path} before activation.`,
      blockingBehavior: "fail-closed",
      flow: fixtureFlowFromPath(diagnostic.path),
    });
  }

  for (const flow of input.fixtureFlows.filter((fixtureFlow) => fixtureFlow.status !== "ready")) {
    addCheck("Fixture Coverage", {
      checkKey: `fixture:${flow.flow}`,
      code: flow.status === "not-covered" ? "missing-fixture-coverage" : "fixture-validation-blocked",
      sectionKey: "fixtures",
      status: flow.status === "warning" ? "passed" : "blocked",
      path: `fixtures.coveredFlows.${flow.flow}`,
      diagnosticText:
        flow.status === "not-covered"
          ? `Profile fixture contract must cover ${flow.flow}.`
          : `Fixture ${flow.flow} has blocking validation diagnostics.`,
      severity: flow.status === "warning" ? "warning" : "error",
      remediation:
        flow.status === "not-covered"
          ? `Add ${flow.flow} to covered fixture flows and rerun validation.`
          : `Resolve fixture diagnostics for ${flow.flow}.`,
      blockingBehavior: "fail-closed",
      flow: flow.flow,
    });
  }

  if (input.readinessUnit?.dryRunStatus === "blocked") {
    addCheck("Dry Run Evidence", {
      checkKey: "dry-run:evidence",
      code: "fixture-validation-blocked",
      sectionKey: "fixtures",
      status: "blocked",
      path: "dryRunEvidence",
      diagnosticText: input.readinessUnit.latestDiagnosticText ?? "Dry-run evidence is blocked.",
      severity: "error",
      remediation: "Run fixture-backed dry-run proof until it completes without error diagnostics.",
      blockingBehavior: "fail-closed",
      flow: null,
    });
  }

  if (groups.size === 0) {
    groups.set("Activation", [
      {
        checkKey: "activation:ready",
        code: "activation-ready",
        sectionKey: "readiness",
        status: "passed",
        path: "activationReadiness",
        diagnosticText: "Activation readiness has no blocking checks.",
        severity: "warning",
        remediation: "No remediation required.",
        blockingBehavior: "allow",
        flow: null,
      },
    ]);
  }

  return [...groups.entries()].map(([domainConcept, checks]) => ({
    domainConcept,
    status: checks.some((check) => check.severity === "error" && check.blockingBehavior === "fail-closed")
      ? "blocked"
      : "ready",
    checks,
  }));
}

function summarizeValidationValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "not set";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  const keys = Object.keys(recordValue(value) ?? {});
  return keys.length > 0 ? `structured value: ${keys.slice(0, 4).join(", ")}` : "structured value";
}

function fixtureFlowFromPath(pathValue: string): string | null {
  const normalizedPath = pathValue.toLowerCase();
  return catalogProviderRequiredFixtureFlows.find((flow) => normalizedPath.includes(flow.toLowerCase())) ?? null;
}

function flowLabel(flow: string): string {
  return flow
    .split("-")
    .map((segment) => segment.replace(/^\w/, (char) => char.toUpperCase()))
    .join(" ");
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}
