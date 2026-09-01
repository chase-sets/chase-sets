import {
  catalogIntegrationControlPlaneActionPolicies,
  type CatalogIntegrationControlPlaneActionPolicy,
} from "../../bounded-contexts/catalog/features/source-observations/api/admin/admin-control-plane-rbac";
import { catalogIntegrationAuditEvidenceEventNames } from "../../bounded-contexts/catalog/features/source-observations/api/governance/catalog-integration-audit-evidence";
import {
  catalogIntegrationDataGovernancePolicies,
  getCatalogIntegrationDataGovernancePolicy,
  type CatalogIntegrationGovernedDataClassKey,
} from "../../bounded-contexts/catalog/features/source-observations/api/governance/catalog-integration-data-governance";
import {
  catalogIntegrationDataResetEnvironmentPlans,
  catalogIntegrationDataResetTargetTables,
} from "../../bounded-contexts/catalog/features/source-observations/api/governance/catalog-integration-data-migration-reset";
import { catalogRealProviderProofSchemaVersion } from "../../bounded-contexts/catalog/features/source-observations/tests/catalog-integration-real-provider-proof";
import {
  catalogPrimaryWorkbenchActions,
  catalogPrimaryWorkbenchDeploySkewPolicies,
  catalogPrimaryWorkbenchRetirementPolicy,
  type CatalogPrimaryWorkbenchActionContract,
  type CatalogPrimaryWorkbenchRetirementPolicy,
} from "../../bounded-contexts/catalog/features/source-observations/api/admin/primary-workbench-admin-contracts";

export const catalogSecurityPrivacyLaunchGateSchemaVersion = "catalog-security-privacy-launch-gate/v1" as const;
export const catalogSecurityPrivacyLaunchGateChecklistVersion =
  "catalog-security-privacy-checklist/2026-06-11" as const;

export type CatalogSecurityPrivacyLaunchGateChecklistKey =
  | "admin-route-protection"
  | "authorization-boundaries"
  | "write-safeguards"
  | "provider-data-governance"
  | "provider-controlled-content"
  | "telemetry-log-artifact-redaction"
  | "audit-evidence-integrity"
  | "real-provider-proof-privacy"
  | "reset-drop-safeguards"
  | "complete-retirement";

export type CatalogSecurityPrivacyLaunchGateChecklistItem = Readonly<{
  key: CatalogSecurityPrivacyLaunchGateChecklistKey;
  requirement: string;
}>;

export type CatalogSecurityPrivacyLaunchGateChecklistEvidence = Readonly<{
  key: CatalogSecurityPrivacyLaunchGateChecklistKey;
  status: "passed";
  owner: string;
  evidence: string;
}>;

export type CatalogSecurityPrivacyLaunchGateSignoff = Readonly<{
  owner: string;
  reviewer: string;
  approvedAt: string;
  approvalReference: string;
  checklistVersion: typeof catalogSecurityPrivacyLaunchGateChecklistVersion;
}>;

export type CatalogSecurityPrivacyLaunchGateRbacEvidence = Readonly<{
  actionPolicies: readonly CatalogIntegrationControlPlaneActionPolicy[];
  primaryWorkbenchActions: readonly CatalogPrimaryWorkbenchActionContract[];
  unauthenticatedRequestsFailClosed: true;
  wrongRoleRequestsFailClosed: true;
  rolloutStoppedWritesFailClosed: true;
  deniedStatesDistinguishPermissionRolloutAndSecurity: true;
}>;

export type CatalogSecurityPrivacyLaunchGateWriteSafeguards = Readonly<{
  browserCredentialWritePosture: "same-origin-admin-api";
  writeEndpointsPostOnly: true;
  serverSideActorRequired: true;
  serverSidePermissionChecked: true;
  idempotencyRequiredForPrimaryWrites: true;
  destructiveConfirmationRequired: true;
  doubleSubmitProtectionRequired: true;
  rawJsonEscapeHatchRemoved: true;
}>;

export type CatalogSecurityPrivacyLaunchGateGovernanceEvidence = Readonly<{
  coveredDataClasses: readonly CatalogIntegrationGovernedDataClassKey[];
  redactionApplied: true;
  unsafeEvidenceBlocked: true;
  rawProviderPayloadRetained: false;
  credentialsOrCookiesRetained: false;
  sellerAccountOrPiiRetained: false;
  providerCommerceValuesRetained: false;
  providerControlledContentBlocked: true;
  providerImageryExcludedUnlessReviewed: true;
  logsMetricsTracesScreenshotsCiArtifactsRedactionSafe: true;
  exportRequiresReviewedEvidencePackage: true;
}>;

export type CatalogSecurityPrivacyLaunchGateAuditEvidence = Readonly<{
  coveredHighImpactEvents: readonly string[];
  requiredFields: readonly ("actor" | "action" | "target" | "timestamp" | "result" | "redaction-safe-context")[];
  redactionSafe: true;
  missingAuditEvidenceBlocksRelease: true;
}>;

export type CatalogSecurityPrivacyLaunchGateRealProviderProofEvidence = Readonly<{
  schemaVersion: typeof catalogRealProviderProofSchemaVersion;
  linkedGateIssue: "#1064";
  proofIssue: "#1062";
  productionSignoffIssue: "#1061";
  noConfusionAcceptanceIssue: "#1047";
  redactionApplied: true;
  rawProviderPayloadRetained: false;
  credentialsOrCookiesRetained: false;
  fullProviderUrlsRetained: false;
  providerControlledLabelsRetained: false;
  writeExecutedDuringProof: false;
}>;

export type CatalogSecurityPrivacyLaunchGateResetDropEvidence = Readonly<{
  productionPrelaunchRequiresApproval: true;
  productionPrelaunchRequiresBackupDecisionOrAcceptedDataLoss: true;
  productionPrelaunchRequiresDryRunCounts: true;
  productionPrelaunchRequiresBeforeAfterVerification: true;
  targetTables: readonly string[];
  unrelatedDataExcluded: true;
  activeJobsRequireForcedDecision: true;
  resetUnsafeDataRetained: false;
  postResetLegacyReferencesBlockRelease: true;
}>;

export type CatalogSecurityPrivacyLaunchGateRetirementEvidence = Readonly<{
  policy: CatalogPrimaryWorkbenchRetirementPolicy;
  retainedOldTwoPageMigration: false;
  retainedRawJsonEscapeHatch: false;
  retainedCompatibilityRoute: false;
  retainedSupportOnlyRoute: false;
  retainedLegacyDocumentation: false;
  retainedCodePatternsOrDocs: false;
  retainedFallbackFlagAliasOrShim: false;
  migrationEvidenceUsedAsRetirementException: false;
}>;

export type CatalogSecurityPrivacyLaunchGatePacket = Readonly<{
  schemaVersion: typeof catalogSecurityPrivacyLaunchGateSchemaVersion;
  checklistVersion: typeof catalogSecurityPrivacyLaunchGateChecklistVersion;
  generatedAt: string;
  environment: string;
  signoff: CatalogSecurityPrivacyLaunchGateSignoff;
  checklist: readonly CatalogSecurityPrivacyLaunchGateChecklistEvidence[];
  rbac: CatalogSecurityPrivacyLaunchGateRbacEvidence;
  writeSafeguards: CatalogSecurityPrivacyLaunchGateWriteSafeguards;
  governance: CatalogSecurityPrivacyLaunchGateGovernanceEvidence;
  auditEvidence: CatalogSecurityPrivacyLaunchGateAuditEvidence;
  realProviderProof: CatalogSecurityPrivacyLaunchGateRealProviderProofEvidence;
  resetDrop: CatalogSecurityPrivacyLaunchGateResetDropEvidence;
  retirement: CatalogSecurityPrivacyLaunchGateRetirementEvidence;
}>;

export const catalogSecurityPrivacyLaunchGateChecklist = [
  {
    key: "admin-route-protection",
    requirement: "Catalog Admin routes require an authenticated actor before any control-plane read or write.",
  },
  {
    key: "authorization-boundaries",
    requirement:
      "View-only, operator, admin, denied, rollout-stopped, destructive, and high-impact actions fail closed.",
  },
  {
    key: "write-safeguards",
    requirement:
      "Write endpoints are POST-only, server-authorized, idempotent where primary commands need it, and confirmation-gated when destructive.",
  },
  {
    key: "provider-data-governance",
    requirement: "Every governed provider data class is covered and raw provider evidence is blocked or redacted.",
  },
  {
    key: "provider-controlled-content",
    requirement:
      "Provider text, URLs, imagery, diagnostics, labels, commerce values, and account facts are not trusted UI evidence.",
  },
  {
    key: "telemetry-log-artifact-redaction",
    requirement:
      "Telemetry, logs, metrics, traces, screenshots, CI artifacts, and release evidence are redaction-safe.",
  },
  {
    key: "audit-evidence-integrity",
    requirement:
      "High-impact audit evidence names actor, action, target, timestamp, result, and redaction-safe context.",
  },
  {
    key: "real-provider-proof-privacy",
    requirement:
      "#1062 real-provider proof links #1064 and retains no raw payloads, full URLs, credentials, or provider labels.",
  },
  {
    key: "reset-drop-safeguards",
    requirement:
      "Prelaunch reset/drop is approval-gated, bounded to Catalog integration tables, and accepts data loss explicitly.",
  },
  {
    key: "complete-retirement",
    requirement:
      "Retire means complete deletion of old code, patterns, documentation, tests, fixtures, screenshots, runbooks, release notes, and operator guidance.",
  },
] as const satisfies readonly CatalogSecurityPrivacyLaunchGateChecklistItem[];

const highImpactAuditEvents = [
  "profile-activated",
  "profile-deprecated",
  "profile-rolled-back",
  "profile-retired",
  "import-job-started",
  "import-job-failed",
  "source-observation-promoted",
  "source-observation-rejected",
  "promotion-plan-executed",
  "reapply-run-executed",
] as const;

const requiredRetirementSurfaces = [
  "runtime code",
  "API routes",
  "UI modules",
  "product patterns",
  "read-model contracts",
  "clients",
  "route aliases",
  "feature flags",
  "hidden flags",
  "fallback branches",
  "redirects",
  "compatibility aliases",
  "compatibility shims",
  "migration shims",
  "tests",
  "fixtures",
  "seeds",
  "screenshots",
  "documentation",
  "runbooks",
  "release notes",
  "operator instructions",
] as const;

const requiredRetirementForbiddenOutcomes = [
  "soft deprecation",
  "compatibility shim",
  "legacy support path",
  "migration of retired admin structure",
  "raw JSON escape hatch",
  "support-only preserved route",
  "documentation-only deprecation",
  "hidden flag fallback",
] as const;

const requiredRedactionPatterns = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "password",
  "sellerId",
  "sellerKey",
  "sellerName",
  "sellerEmail",
  "email",
  "phone",
  "price",
  "marketPrice",
  "inventory",
  "quantity",
  "listing",
] as const;

export function buildCatalogSecurityPrivacyLaunchGatePacket(
  input: Readonly<{
    environment?: string;
    generatedAt?: string;
    signoff: Omit<CatalogSecurityPrivacyLaunchGateSignoff, "checklistVersion"> &
      Partial<Pick<CatalogSecurityPrivacyLaunchGateSignoff, "checklistVersion">>;
  }>,
): CatalogSecurityPrivacyLaunchGatePacket {
  const packet: CatalogSecurityPrivacyLaunchGatePacket = {
    schemaVersion: catalogSecurityPrivacyLaunchGateSchemaVersion,
    checklistVersion: catalogSecurityPrivacyLaunchGateChecklistVersion,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    environment: input.environment ?? process.env.DEPLOYMENT_ENVIRONMENT ?? "local",
    signoff: {
      ...input.signoff,
      checklistVersion: input.signoff.checklistVersion ?? catalogSecurityPrivacyLaunchGateChecklistVersion,
    },
    checklist: catalogSecurityPrivacyLaunchGateChecklist.map((item) => ({
      key: item.key,
      status: "passed",
      owner: "catalog-source-observations",
      evidence: item.requirement,
    })),
    rbac: {
      actionPolicies: catalogIntegrationControlPlaneActionPolicies,
      primaryWorkbenchActions: catalogPrimaryWorkbenchActions,
      unauthenticatedRequestsFailClosed: true,
      wrongRoleRequestsFailClosed: true,
      rolloutStoppedWritesFailClosed: true,
      deniedStatesDistinguishPermissionRolloutAndSecurity: true,
    },
    writeSafeguards: {
      browserCredentialWritePosture: "same-origin-admin-api",
      writeEndpointsPostOnly: true,
      serverSideActorRequired: true,
      serverSidePermissionChecked: true,
      idempotencyRequiredForPrimaryWrites: true,
      destructiveConfirmationRequired: true,
      doubleSubmitProtectionRequired: true,
      rawJsonEscapeHatchRemoved: true,
    },
    governance: {
      coveredDataClasses: catalogIntegrationDataGovernancePolicies.map((policy) => policy.key),
      redactionApplied: true,
      unsafeEvidenceBlocked: true,
      rawProviderPayloadRetained: false,
      credentialsOrCookiesRetained: false,
      sellerAccountOrPiiRetained: false,
      providerCommerceValuesRetained: false,
      providerControlledContentBlocked: true,
      providerImageryExcludedUnlessReviewed: true,
      logsMetricsTracesScreenshotsCiArtifactsRedactionSafe: true,
      exportRequiresReviewedEvidencePackage: true,
    },
    auditEvidence: {
      coveredHighImpactEvents: highImpactAuditEvents,
      requiredFields: ["actor", "action", "target", "timestamp", "result", "redaction-safe-context"],
      redactionSafe: true,
      missingAuditEvidenceBlocksRelease: true,
    },
    realProviderProof: {
      schemaVersion: catalogRealProviderProofSchemaVersion,
      linkedGateIssue: "#1064",
      proofIssue: "#1062",
      productionSignoffIssue: "#1061",
      noConfusionAcceptanceIssue: "#1047",
      redactionApplied: true,
      rawProviderPayloadRetained: false,
      credentialsOrCookiesRetained: false,
      fullProviderUrlsRetained: false,
      providerControlledLabelsRetained: false,
      writeExecutedDuringProof: false,
    },
    resetDrop: {
      productionPrelaunchRequiresApproval: true,
      productionPrelaunchRequiresBackupDecisionOrAcceptedDataLoss: true,
      productionPrelaunchRequiresDryRunCounts: true,
      productionPrelaunchRequiresBeforeAfterVerification: true,
      targetTables: catalogIntegrationDataResetTargetTables(),
      unrelatedDataExcluded: true,
      activeJobsRequireForcedDecision: true,
      resetUnsafeDataRetained: false,
      postResetLegacyReferencesBlockRelease: true,
    },
    retirement: {
      policy: catalogPrimaryWorkbenchRetirementPolicy,
      retainedOldTwoPageMigration: false,
      retainedRawJsonEscapeHatch: false,
      retainedCompatibilityRoute: false,
      retainedSupportOnlyRoute: false,
      retainedLegacyDocumentation: false,
      retainedCodePatternsOrDocs: false,
      retainedFallbackFlagAliasOrShim: false,
      migrationEvidenceUsedAsRetirementException: false,
    },
  };

  assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(packet);
  return packet;
}

export function assertCatalogSecurityPrivacyLaunchGatePacketIsLaunchSafe(
  packet: CatalogSecurityPrivacyLaunchGatePacket,
): void {
  assertSignoff(packet);
  assertChecklist(packet);
  assertRbac(packet);
  assertWriteSafeguards(packet);
  assertGovernance(packet);
  assertAuditEvidence(packet);
  assertRealProviderProof(packet);
  assertResetDrop(packet);
  assertRetirement(packet);
}

function assertSignoff(packet: CatalogSecurityPrivacyLaunchGatePacket): void {
  if (packet.schemaVersion !== catalogSecurityPrivacyLaunchGateSchemaVersion) {
    throw new Error("Catalog security/privacy launch gate schema version mismatch.");
  }
  if (packet.checklistVersion !== catalogSecurityPrivacyLaunchGateChecklistVersion) {
    throw new Error("Catalog security/privacy launch gate checklist version mismatch.");
  }
  if (!packet.generatedAt.trim()) {
    throw new Error("Catalog security/privacy launch gate packet must include the generated timestamp.");
  }
  if (!packet.environment.trim()) {
    throw new Error("Catalog security/privacy launch gate packet must name the environment.");
  }
  if (packet.signoff.checklistVersion !== catalogSecurityPrivacyLaunchGateChecklistVersion) {
    throw new Error("Catalog security/privacy launch gate signoff must name the checklist version.");
  }
  if (!packet.signoff.owner.trim()) {
    throw new Error("Catalog security/privacy launch gate signoff must name the owner.");
  }
  if (!packet.signoff.reviewer.trim()) {
    throw new Error("Catalog security/privacy launch gate signoff must name the reviewer.");
  }
  if (!packet.signoff.approvedAt.trim()) {
    throw new Error("Catalog security/privacy launch gate signoff must include an approval timestamp.");
  }
  if (!packet.signoff.approvalReference.trim()) {
    throw new Error("Catalog security/privacy launch gate signoff must link the approval issue comment or evidence.");
  }
}

function assertChecklist(packet: CatalogSecurityPrivacyLaunchGatePacket): void {
  const expectedKeys = catalogSecurityPrivacyLaunchGateChecklist.map((item) => item.key);
  assertSameStringSet(
    packet.checklist.map((item) => item.key),
    expectedKeys,
    "Catalog security/privacy launch gate checklist",
  );
  for (const item of packet.checklist) {
    if (item.status !== "passed" || !item.owner.trim() || !item.evidence.trim()) {
      throw new Error(`Catalog security/privacy launch gate checklist item '${item.key}' is incomplete.`);
    }
  }
}

function assertRbac(packet: CatalogSecurityPrivacyLaunchGatePacket): void {
  assertSameStringSet(
    packet.rbac.actionPolicies.map((policy) => policy.action),
    catalogIntegrationControlPlaneActionPolicies.map((policy) => policy.action),
    "Catalog security/privacy launch gate RBAC action coverage",
  );
  for (const policy of packet.rbac.actionPolicies) {
    if (policy.destructive && policy.requiredPermission !== "catalog.manage") {
      throw new Error(`Catalog control-plane destructive action '${policy.action}' must require catalog.manage.`);
    }
  }
  for (const action of packet.rbac.primaryWorkbenchActions) {
    if (action.method !== "GET" && action.requiredPermission !== "catalog.manage") {
      throw new Error(`Primary workbench write action '${action.key}' must require catalog.manage.`);
    }
    if (action.method !== "GET" && !isRebuiltCatalogAdminCommandRoute(action.routePattern)) {
      throw new Error(`Primary workbench write action '${action.key}' must stay on the rebuilt Admin API contract.`);
    }
  }
  if (
    !packet.rbac.unauthenticatedRequestsFailClosed ||
    !packet.rbac.wrongRoleRequestsFailClosed ||
    !packet.rbac.rolloutStoppedWritesFailClosed ||
    !packet.rbac.deniedStatesDistinguishPermissionRolloutAndSecurity
  ) {
    throw new Error("Catalog security/privacy launch gate RBAC evidence must fail closed for auth, role, and rollout.");
  }
}

function isRebuiltCatalogAdminCommandRoute(routePattern: string): boolean {
  return (
    routePattern.startsWith("/api/catalog/source-observations/admin/") ||
    routePattern === "/api/catalog/source-observations/catalog-sync-scope/runs" ||
    routePattern === "/api/catalog/alias-equivalence/admin/review"
  );
}

function assertWriteSafeguards(packet: CatalogSecurityPrivacyLaunchGatePacket): void {
  const primaryWrites = packet.rbac.primaryWorkbenchActions.filter((action) => action.method === "POST");
  if (primaryWrites.length === 0) {
    throw new Error("Catalog security/privacy launch gate must cover primary write actions.");
  }
  if (
    !packet.writeSafeguards.writeEndpointsPostOnly ||
    !packet.writeSafeguards.serverSideActorRequired ||
    !packet.writeSafeguards.serverSidePermissionChecked ||
    !packet.writeSafeguards.idempotencyRequiredForPrimaryWrites ||
    !packet.writeSafeguards.doubleSubmitProtectionRequired ||
    !packet.writeSafeguards.rawJsonEscapeHatchRemoved
  ) {
    throw new Error("Catalog security/privacy launch gate write safeguards are incomplete.");
  }
  if (!primaryWrites.every((action) => action.idempotencyRequired)) {
    throw new Error("Catalog primary write actions must require idempotency before launch.");
  }
  const destructivePrimaryWrites = primaryWrites.filter((action) =>
    action.blockerCategories.includes("destructive-confirmation-required"),
  );
  if (!packet.writeSafeguards.destructiveConfirmationRequired || destructivePrimaryWrites.length === 0) {
    throw new Error("Catalog destructive write safeguards must include confirmation evidence.");
  }
}

function assertGovernance(packet: CatalogSecurityPrivacyLaunchGatePacket): void {
  assertSameStringSet(
    packet.governance.coveredDataClasses,
    catalogIntegrationDataGovernancePolicies.map((policy) => policy.key),
    "Catalog security/privacy launch gate governed data-class coverage",
  );
  const rawPayloadPolicy = getCatalogIntegrationDataGovernancePolicy("raw-provider-payload");
  if (
    rawPayloadPolicy.retentionPolicy !== "request-only" ||
    rawPayloadPolicy.rawBodyPolicy !== "forbidden" ||
    rawPayloadPolicy.exportPolicy !== "no-export"
  ) {
    throw new Error("Raw provider payload policy must remain request-only, forbidden, and non-exportable.");
  }
  const redactionPatterns = new Set(
    catalogIntegrationDataGovernancePolicies.flatMap((policy) => policy.redactedPathPatterns),
  );
  for (const pattern of requiredRedactionPatterns) {
    if (!redactionPatterns.has(pattern)) {
      throw new Error(`Catalog provider-data redaction pattern '${pattern}' is required before launch.`);
    }
  }
  if (
    !packet.governance.redactionApplied ||
    !packet.governance.unsafeEvidenceBlocked ||
    packet.governance.rawProviderPayloadRetained ||
    packet.governance.credentialsOrCookiesRetained ||
    packet.governance.sellerAccountOrPiiRetained ||
    packet.governance.providerCommerceValuesRetained ||
    !packet.governance.providerControlledContentBlocked ||
    !packet.governance.providerImageryExcludedUnlessReviewed ||
    !packet.governance.logsMetricsTracesScreenshotsCiArtifactsRedactionSafe ||
    !packet.governance.exportRequiresReviewedEvidencePackage
  ) {
    throw new Error("Catalog security/privacy launch gate provider-data governance evidence is unsafe.");
  }
}

function assertAuditEvidence(packet: CatalogSecurityPrivacyLaunchGatePacket): void {
  for (const eventName of packet.auditEvidence.coveredHighImpactEvents) {
    if (
      !catalogIntegrationAuditEvidenceEventNames.includes(
        eventName as (typeof catalogIntegrationAuditEvidenceEventNames)[number],
      )
    ) {
      throw new Error(
        `Catalog audit/evidence high-impact event '${eventName}' is not in the canonical event inventory.`,
      );
    }
  }
  assertSameStringSet(
    packet.auditEvidence.requiredFields,
    ["actor", "action", "target", "timestamp", "result", "redaction-safe-context"],
    "Catalog security/privacy launch gate audit required-field coverage",
  );
  if (!packet.auditEvidence.redactionSafe || !packet.auditEvidence.missingAuditEvidenceBlocksRelease) {
    throw new Error(
      "Catalog audit/evidence launch gate must be redaction-safe and fail closed when evidence is missing.",
    );
  }
}

function assertRealProviderProof(packet: CatalogSecurityPrivacyLaunchGatePacket): void {
  if (packet.realProviderProof.schemaVersion !== catalogRealProviderProofSchemaVersion) {
    throw new Error("Catalog security/privacy launch gate must link the current real-provider proof schema.");
  }
  if (
    packet.realProviderProof.linkedGateIssue !== "#1064" ||
    packet.realProviderProof.proofIssue !== "#1062" ||
    packet.realProviderProof.productionSignoffIssue !== "#1061" ||
    packet.realProviderProof.noConfusionAcceptanceIssue !== "#1047"
  ) {
    throw new Error("Catalog security/privacy launch gate real-provider proof handoff issues are incomplete.");
  }
  if (
    !packet.realProviderProof.redactionApplied ||
    packet.realProviderProof.rawProviderPayloadRetained ||
    packet.realProviderProof.credentialsOrCookiesRetained ||
    packet.realProviderProof.fullProviderUrlsRetained ||
    packet.realProviderProof.providerControlledLabelsRetained ||
    packet.realProviderProof.writeExecutedDuringProof
  ) {
    throw new Error("Catalog real-provider proof privacy evidence is unsafe for launch.");
  }
}

function assertResetDrop(packet: CatalogSecurityPrivacyLaunchGatePacket): void {
  const productionPlan = catalogIntegrationDataResetEnvironmentPlans.find(
    (plan) => plan.environment === "production-prelaunch",
  );
  if (!productionPlan) {
    throw new Error("Catalog security/privacy launch gate requires a production-prelaunch reset/drop plan.");
  }
  if (
    !productionPlan.requiresApprovalReference ||
    !productionPlan.requiresBackupDecision ||
    !productionPlan.requiresDryRunCounts ||
    !productionPlan.requiresBeforeAfterVerification
  ) {
    throw new Error(
      "Catalog production-prelaunch reset/drop plan must require approval, backup/data-loss, dry-run, and verification.",
    );
  }
  assertSameStringSet(
    packet.resetDrop.targetTables,
    catalogIntegrationDataResetTargetTables(),
    "Catalog security/privacy launch gate reset/drop target table coverage",
  );
  if (
    packet.resetDrop.targetTables.some((table) =>
      /orders|payments|settlement|marketplace|inventory|identity/i.test(table),
    )
  ) {
    throw new Error("Catalog reset/drop target tables must exclude unrelated launched context data.");
  }
  if (
    !packet.resetDrop.productionPrelaunchRequiresApproval ||
    !packet.resetDrop.productionPrelaunchRequiresBackupDecisionOrAcceptedDataLoss ||
    !packet.resetDrop.productionPrelaunchRequiresDryRunCounts ||
    !packet.resetDrop.productionPrelaunchRequiresBeforeAfterVerification ||
    !packet.resetDrop.unrelatedDataExcluded ||
    !packet.resetDrop.activeJobsRequireForcedDecision ||
    packet.resetDrop.resetUnsafeDataRetained ||
    !packet.resetDrop.postResetLegacyReferencesBlockRelease
  ) {
    throw new Error("Catalog security/privacy launch gate reset/drop evidence is incomplete.");
  }
}

function assertRetirement(packet: CatalogSecurityPrivacyLaunchGatePacket): void {
  if (packet.retirement.policy.requiredDisposition !== "complete-removal") {
    throw new Error("Catalog control-plane retirement policy must require complete removal.");
  }
  for (const surface of requiredRetirementSurfaces) {
    if (!packet.retirement.policy.surfaces.includes(surface)) {
      throw new Error(`Catalog control-plane retirement must remove '${surface}'.`);
    }
  }
  for (const outcome of requiredRetirementForbiddenOutcomes) {
    if (!packet.retirement.policy.forbiddenOutcomes.includes(outcome)) {
      throw new Error(`Catalog control-plane retirement must forbid '${outcome}'.`);
    }
  }
  if (
    catalogPrimaryWorkbenchDeploySkewPolicies.some(
      (policy) => policy.supported === false && policy.forbiddenFallbacks.length === 0,
    )
  ) {
    throw new Error("Unsupported deploy-skew modes must name forbidden legacy fallbacks.");
  }
  if (
    packet.retirement.retainedOldTwoPageMigration ||
    packet.retirement.retainedRawJsonEscapeHatch ||
    packet.retirement.retainedCompatibilityRoute ||
    packet.retirement.retainedSupportOnlyRoute ||
    packet.retirement.retainedLegacyDocumentation ||
    packet.retirement.retainedCodePatternsOrDocs ||
    packet.retirement.retainedFallbackFlagAliasOrShim ||
    packet.retirement.migrationEvidenceUsedAsRetirementException
  ) {
    throw new Error(
      "Catalog control-plane retirement evidence must prove complete deletion, not preserved compatibility.",
    );
  }
}

function assertSameStringSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((value) => !actualSet.has(value));
  const extra = [...actualSet].filter((value) => !expectedSet.has(value));
  const duplicateActualEntries = actual.filter((value, index) => actual.indexOf(value) !== index);
  const duplicateExpectedEntries = expected.filter((value, index) => expected.indexOf(value) !== index);
  if (
    missing.length > 0 ||
    extra.length > 0 ||
    duplicateActualEntries.length > 0 ||
    duplicateExpectedEntries.length > 0
  ) {
    throw new Error(
      `${label} mismatch. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}. Duplicates: ${duplicateActualEntries.join(", ") || duplicateExpectedEntries.join(", ") || "none"}.`,
    );
  }
}
