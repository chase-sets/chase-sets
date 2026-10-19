// Behavior-owned primary workbench validators.
import { catalogPrimaryWorkbenchActions, catalogPrimaryWorkbenchBlockers } from "./primary-workbench-contract-descriptors-implementation";
import { catalogPrimaryWorkbenchContractVersion, catalogPrimaryWorkbenchRouteSections } from "./primary-workbench-contract-implementation";
import type { CatalogPrimaryWorkbenchContractVersion, CatalogPrimaryWorkbenchSectionKey, CatalogPrimaryWorkbenchCommandKey, CatalogPrimaryWorkbenchSourceObservationRowActionKey, CatalogPrimaryWorkbenchActionState, CatalogPrimaryWorkbenchBlockerCategory, CatalogPrimaryWorkbenchProviderTransportCategory, CatalogPrimaryWorkbenchPromotionDisposition, CatalogPrimaryWorkbenchPromotionScopeKind, CatalogPrimaryWorkbenchPromotionOutcomeCountKey, CatalogPrimaryWorkbenchPromotionStaleProtectionKey, CatalogPrimaryWorkbenchPromotionProfileSemantics, CatalogPrimaryWorkbenchRouteContextKey, CatalogPrimaryWorkbenchCopyKey, CatalogPrimaryWorkbenchInstrumentationDimension, CatalogPrimaryWorkbenchDeploySkewMode, CatalogPrimaryWorkbenchDeploySkewPolicy, CatalogPrimaryWorkbenchRetirementPolicy, CatalogPrimaryWorkbenchBlockerContract, CatalogPrimaryWorkbenchSectionContract, CatalogPrimaryWorkbenchActionContract, CatalogPrimaryWorkbenchDownstreamIssueKey, CatalogPrimaryWorkbenchDownstreamContract, CatalogPrimaryWorkbenchReadModel, CatalogPrimaryWorkbenchRouteContext, CatalogPrimaryWorkbenchScopeContext, CatalogPrimaryWorkbenchProviderScopeReadModel, CatalogPrimaryWorkbenchSourceOptionsStatus, CatalogPrimaryWorkbenchSourceOptionPageState, CatalogPrimaryWorkbenchSourceOptionKindReadModel, CatalogPrimaryWorkbenchSourceOptionPageReadModel, CatalogPrimaryWorkbenchSourceOptionsReadModel, CatalogPrimaryWorkbenchCatalogSyncStatus, CatalogPrimaryWorkbenchCatalogSyncReadModel, CatalogPrimaryWorkbenchCatalogSyncUnitReadModel, CatalogPrimaryWorkbenchSourceScopeWorksetStatus, CatalogPrimaryWorkbenchSourceScopeWorksetUnitState, CatalogPrimaryWorkbenchSourceScopeWorksetReadModel, CatalogPrimaryWorkbenchSourceScopeWorksetUnitReadModel, CatalogPrimaryWorkbenchReadinessReadModel, CatalogPrimaryWorkbenchHealthTriageStatus, CatalogPrimaryWorkbenchHealthTriageReadModel, CatalogPrimaryWorkbenchHealthTriageReadModelState, CatalogPrimaryWorkbenchHealthTriageUnit, CatalogPrimaryWorkbenchHealthTriageProvider, CatalogPrimaryWorkbenchValidationReadinessStatus, CatalogPrimaryWorkbenchValidationFixtureFlowStatus, CatalogPrimaryWorkbenchValidationReadinessReadModel, CatalogPrimaryWorkbenchValidationEvidenceRow, CatalogPrimaryWorkbenchLifecycleOperation, CatalogPrimaryWorkbenchLifecycleRecoveryStatus, CatalogPrimaryWorkbenchLifecycleRecoveryReadModel, CatalogPrimaryWorkbenchLifecycleOperationReadModel, CatalogPrimaryWorkbenchGovernanceControlsStatus, CatalogPrimaryWorkbenchGovernanceControlKind, CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey, CatalogPrimaryWorkbenchGovernanceControlsReadModel, CatalogPrimaryWorkbenchAuditEvidenceStatus, CatalogPrimaryWorkbenchAuditEvidenceFilterKey, CatalogPrimaryWorkbenchAuditEvidenceTargetType, CatalogPrimaryWorkbenchAuditEvidenceReadModel, CatalogPrimaryWorkbenchAuditEvidenceLink, CatalogPrimaryWorkbenchHealthTriageRolloutControl, CatalogPrimaryWorkbenchHealthTriageJob, CatalogPrimaryWorkbenchHealthTriageAuditPreview, CatalogPrimaryWorkbenchProfileAuthoringStatus, CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode, CatalogPrimaryWorkbenchProfileImmutableFactKey, CatalogPrimaryWorkbenchProfileImmutableFact, CatalogPrimaryWorkbenchProfileLifecycleRestriction, CatalogPrimaryWorkbenchProfileOption, CatalogPrimaryWorkbenchProfileOverview, CatalogPrimaryWorkbenchProfileSectionGroupKey, CatalogPrimaryWorkbenchProfileSectionSaveOutcome, CatalogPrimaryWorkbenchProfileSectionFieldControl, CatalogPrimaryWorkbenchProfileSectionField, CatalogPrimaryWorkbenchProfileOptionQueryDetail, CatalogPrimaryWorkbenchProfileImportScopeControl, CatalogPrimaryWorkbenchProfileMappingRow, CatalogPrimaryWorkbenchProfileSectionWorkspace, CatalogPrimaryWorkbenchProfileCloneDraftReadModel, CatalogPrimaryWorkbenchProfileAuthoringReadModel, CatalogPrimaryWorkbenchImportJobsReadModel, CatalogPrimaryWorkbenchSourceObservationReviewReadModel, CatalogPrimaryWorkbenchSourceObservationReviewRow, CatalogPrimaryWorkbenchSourceObservationEvidenceDetail, CatalogPrimaryWorkbenchProductContentsEvidenceState, CatalogPrimaryWorkbenchProductContentsEvidenceReview, CatalogPrimaryWorkbenchProductContentsEvidenceLine, CatalogPrimaryWorkbenchSourceObservationEvidenceRouteData, CatalogPrimaryWorkbenchMergeCandidateActionKey, CatalogPrimaryWorkbenchMergeCandidateReviewReadModel, CatalogPrimaryWorkbenchMergeCandidateReviewRow, CatalogPrimaryWorkbenchMergeCandidateEditFieldOverride, CatalogPrimaryWorkbenchMergeCandidateEditReference, CatalogPrimaryWorkbenchMergeCandidateEditFormReadModel, CatalogPrimaryWorkbenchConflictResolutionStatus, CatalogPrimaryWorkbenchConflictResolutionState, CatalogPrimaryWorkbenchConflictResolutionReadModel, CatalogPrimaryWorkbenchConflictResolutionRow, CatalogPrimaryWorkbenchPromotionValidationReadModel, CatalogPrimaryWorkbenchPromotionIdentityDiagnostic, CatalogPrimaryWorkbenchPromotionPreviewReadModel, CatalogPrimaryWorkbenchPromotionResultReadModel, CatalogPrimaryWorkbenchActionReadModel, CatalogPrimaryWorkbenchSecurityPrivacyReadModel, CatalogPrimaryWorkbenchInstrumentationReadModel } from "./primary-workbench-contract-implementation";
export function assertCatalogPrimaryWorkbenchBlockerCategory(
  value: string,
): asserts value is CatalogPrimaryWorkbenchBlockerCategory {
  if (!catalogPrimaryWorkbenchBlockers.some((blockerEntry) => blockerEntry.category === value)) {
    throw new Error(`Unknown primary workbench blocker category '${value}' must fail closed.`);
  }
}

export function assertCatalogPrimaryWorkbenchActionState(
  value: string,
): asserts value is CatalogPrimaryWorkbenchActionState {
  const knownStates: readonly CatalogPrimaryWorkbenchActionState[] = [
    "available",
    "disabled",
    "denied",
    "blocked",
    "unavailable",
    "unsafe",
    "degraded",
  ];
  if (!knownStates.includes(value as CatalogPrimaryWorkbenchActionState)) {
    throw new Error(`Unknown primary workbench action state '${value}' must fail closed.`);
  }
}

export function validateCatalogPrimaryWorkbenchReadModelContract(
  value: Partial<CatalogPrimaryWorkbenchReadModel>,
): void {
  if (value.schemaVersion !== catalogPrimaryWorkbenchContractVersion) {
    throw new Error("Primary workbench schema version mismatch must fail closed.");
  }
  if (!value.routeContext) {
    throw new Error("Primary workbench route context is required for context preservation.");
  }
  validatePrimaryWorkbenchRouteContext(value.routeContext);
  if (!value.securityPrivacy) {
    throw new Error("Primary workbench security/privacy fields are required and must fail closed when missing.");
  }
  if (!value.deploySkew) {
    throw new Error("Primary workbench deploy-skew policy is required.");
  }
  if (!value.deploySkew.supported) {
    throw new Error("Primary workbench deploy-skew policy is unsupported and must fail closed.");
  }
  if (!value.instrumentation?.redactionSafe) {
    throw new Error("Primary workbench instrumentation must be redaction-safe.");
  }
  assertPrimaryWorkbenchHealthTriage(value.healthTriage);
  for (const actionEntry of value.actions ?? []) {
    assertCatalogPrimaryWorkbenchActionState(actionEntry.state);
    assertPrimaryWorkbenchBlockers(actionEntry.blockers);
  }
  assertPrimaryWorkbenchBlockers(value.readiness?.blockers);
  assertPrimaryWorkbenchBlockers(value.sourceOptions?.refresh.blockers);
  assertPrimaryWorkbenchBlockers(value.sourceOptions?.pages.flatMap((page) => page.blockers));
  assertPrimaryWorkbenchBlockers(
    value.sourceScopeWorkset?.units.flatMap((unit) => [
      ...unit.actions.import.blockers,
      ...unit.actions.previewPromotion.blockers,
      ...unit.actions.reapply.blockers,
    ]),
  );
  assertPrimaryWorkbenchBlockers(value.importJobs?.selectedScope?.readiness.blockers);
  assertPrimaryWorkbenchBlockers(value.importJobs?.jobs.flatMap((job) => job.blockers));
  assertPrimaryWorkbenchImportJobs(value.importJobs);
  assertPrimaryWorkbenchBlockers(
    value.sourceObservationReview?.rows.flatMap((row) => [
      ...row.promotionReadiness.blockers,
      ...row.actions.flatMap((actionEntry) => actionEntry.blockers),
    ]),
  );
  assertPrimaryWorkbenchBlockers(
    value.mergeCandidateReview?.rows.flatMap((row) => [
      ...row.promoteReadiness.blockers,
      ...row.actions.flatMap((actionEntry) => actionEntry.blockers),
    ]),
  );
  assertPrimaryWorkbenchBlockers(
    value.conflictResolution?.rows.flatMap((row) => [...row.blockers, ...row.overrideAction.blockers]),
  );
  assertPrimaryWorkbenchBlockers(value.governanceControls?.controls.flatMap((control) => control.blockers));
  assertPrimaryWorkbenchBlockers(value.governanceControls?.rbacMatrix.flatMap((actionEntry) => actionEntry.blockers));
  assertPrimaryWorkbenchBlockers(value.conflictResolution?.overridePolicy.blockers);
  assertPrimaryWorkbenchBlockers(value.promotionPreview?.blockers);
  assertPrimaryWorkbenchConflictResolution(value.conflictResolution);
  assertPrimaryWorkbenchSourceOptions(value.sourceOptions);
  assertPrimaryWorkbenchSourceScopeWorkset(value.sourceScopeWorkset);
  assertPrimaryWorkbenchMergeCandidateReview(value.mergeCandidateReview);
  assertPrimaryWorkbenchGovernanceControls(value.governanceControls);
  assertPrimaryWorkbenchAuditEvidence(value.auditEvidence);
  assertPrimaryWorkbenchPromotionPreview(value.promotionPreview);
  assertPrimaryWorkbenchPromotionResult(value.promotionResult);
  assertPrimaryWorkbenchProfileAuthoring(value.profileAuthoring);
  assertPrimaryWorkbenchValidationReadiness(value.validationReadiness);
  assertPrimaryWorkbenchLifecycleRecovery(value.lifecycleRecovery);
}

function assertPrimaryWorkbenchPromotionResult(
  value: CatalogPrimaryWorkbenchReadModel["promotionResult"] | undefined,
): void {
  if (value == null) {
    return;
  }
  if (!value.resultId || !value.jobId || !value.completedAt) {
    throw new Error("Primary workbench promotion results require durable outcome identity and timing.");
  }
  if (!["completed", "partial", "failed"].includes(value.status)) {
    throw new Error("Primary workbench promotion results require an explicit terminal status.");
  }
  const counts = [value.requestedCount, value.promotedCount, value.skippedCount, value.failedCount];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("Primary workbench promotion result counts must be non-negative integers.");
  }
  if (value.promotedCount + value.skippedCount + value.failedCount !== value.requestedCount) {
    throw new Error("Primary workbench promotion result counts must reconcile to the requested count.");
  }
  if (!Array.isArray(value.redactedFailureReasons)) {
    throw new Error("Primary workbench promotion results must expose redacted failure reasons.");
  }
  for (const reason of value.redactedFailureReasons) {
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.includes("\n") ||
      /\b(api[-_ ]?key|x-api-key|x-team-id|authorization|bearer|token|secret|password)\s*[=:]\s*(?!\[redacted\])/i.test(
        reason,
      )
    ) {
      throw new Error("Primary workbench promotion failure reasons must stay redaction-safe.");
    }
  }
}

function validatePrimaryWorkbenchRouteContext(context: CatalogPrimaryWorkbenchRouteContext): void {
  if (
    !context.section ||
    !catalogPrimaryWorkbenchRouteSections.includes(
      context.section as (typeof catalogPrimaryWorkbenchRouteSections)[number],
    ) ||
    /legacy|compat|raw-json|god-page|provider-profile-review/i.test(context.section)
  ) {
    throw new Error("Primary workbench route context section must be a rebuilt workspace or primary section key.");
  }
  if (!Array.isArray(context.selectedObservationIds)) {
    throw new Error("Primary workbench route context selectedObservationIds must be an array.");
  }
  if (context.selectedObservationIds.some((id) => !id || /[?#]/.test(id))) {
    throw new Error("Primary workbench route context selectedObservationIds must be clean identifiers.");
  }
  if (!context.sourceObservationFilters || typeof context.sourceObservationFilters !== "object") {
    throw new Error("Primary workbench route context Source Observation filters are required.");
  }
  for (const [key, value] of Object.entries(context.sourceObservationFilters)) {
    if (!key || key.includes("=") || key.includes("&") || value.includes("\n")) {
      throw new Error("Primary workbench route context filters must be clean query values.");
    }
  }
  if (context.scope) {
    validatePrimaryWorkbenchScopeContext(context.scope);
  }
  if (
    context.returnPath &&
    (!isSafePrimaryWorkbenchReturnPath(context.returnPath) ||
      /legacy|compat|raw-json|god-page/i.test(context.returnPath))
  ) {
    throw new Error("Primary workbench returnPath must be a safe rebuilt Catalog admin path.");
  }
}

function validatePrimaryWorkbenchScopeContext(scope: CatalogPrimaryWorkbenchScopeContext): void {
  for (const [key, value] of Object.entries(scope)) {
    if (
      ![
        "providerKey",
        "productId",
        "languageCode",
        "productLineId",
        "productLineName",
        "seriesId",
        "seriesName",
        "expansionId",
        "expansionName",
        "status",
      ].includes(key) ||
      (value !== null && (typeof value !== "string" || value.includes("\n")))
    ) {
      throw new Error("Primary workbench route scope must use clean structured scope fields.");
    }
  }
}

function assertPrimaryWorkbenchImportJobs(value: CatalogPrimaryWorkbenchReadModel["importJobs"] | undefined): void {
  if (!value) {
    throw new Error("Primary workbench import jobs contract is required.");
  }
  for (const job of value.jobs) {
    if (!job.result) {
      continue;
    }
    if (!Array.isArray(job.result.redactedFailureReasons)) {
      throw new Error("Primary workbench import job results must expose redacted failure reasons.");
    }
    if (job.result.usage) {
      const counts = Object.values(job.result.usage);
      if (counts.some((count) => count !== null && (!Number.isSafeInteger(count) || count < 0))) {
        throw new Error("Primary workbench import job usage counts must be non-negative integers.");
      }
    }
    for (const reason of job.result.redactedFailureReasons) {
      if (
        typeof reason !== "string" ||
        !reason.trim() ||
        reason.includes("\n") ||
        /\b(api[-_ ]?key|x-api-key|x-team-id|authorization|bearer|token|secret|password)\s*[=:]\s*(?!\[redacted\])/i.test(
          reason,
        )
      ) {
        throw new Error("Primary workbench import job failure reasons must stay redaction-safe.");
      }
    }
  }
}

// The four audience surface routes that make up the rebuilt integrations
// workbench. The daily base route plus three nested surface routes are
// all safe in-workbench destinations; ?section= only names a workspace within a
// surface, so it never changes which route a link targets.
const safePrimaryWorkbenchSurfacePaths = new Set<string>([
  "/catalog/integrations",
  "/catalog/integrations/governance",
  "/catalog/integrations/health",
  // The v2 Provider detail page's own bare fallback when no provider is
  // selected (catalogProviderDetailHref(null)).
  "/catalog/providers",
]);
// The v2 Provider detail page (/catalog/providers/:providerKey) is a
// real path-param route, not a fixed workspace path, so it is recognized by
// prefix rather than exact match.
const safePrimaryWorkbenchDynamicSurfacePathPrefix = "/catalog/providers/";

function isSafePrimaryWorkbenchReturnPath(path: string): boolean {
  if (path.startsWith("//")) {
    return false;
  }
  try {
    const parsedUrl = new URL(path, "https://admin.example");
    if (parsedUrl.origin !== "https://admin.example") {
      return false;
    }
    return (
      safePrimaryWorkbenchSurfacePaths.has(parsedUrl.pathname) ||
      (parsedUrl.pathname.startsWith(safePrimaryWorkbenchDynamicSurfacePathPrefix) &&
        parsedUrl.pathname.length > safePrimaryWorkbenchDynamicSurfacePathPrefix.length)
    );
  } catch {
    return false;
  }
}

function isSafePrimaryWorkbenchObservabilityLink(path: string): boolean {
  if (isSafePrimaryWorkbenchReturnPath(path)) {
    return true;
  }
  if (path.startsWith("//")) {
    return false;
  }
  try {
    const parsedUrl = new URL(path);
    if (parsedUrl.protocol !== "https:") {
      return false;
    }
    if (
      ["grafana.chasesets.com", "grafana.staging.chasesets.com"].includes(parsedUrl.hostname) &&
      parsedUrl.pathname.startsWith("/d/chase-sets-catalog-control-plane")
    ) {
      return true;
    }

    return (
      parsedUrl.hostname === "github.com" &&
      (parsedUrl.pathname.startsWith("/chase-sets/chase-sets/blob/main/docs/runbooks/") ||
        parsedUrl.pathname.startsWith("/chase-sets/chase-sets/blob/main/bounded-contexts/catalog/docs/"))
    );
  } catch {
    return false;
  }
}

function assertPrimaryWorkbenchSourceOptions(
  value: CatalogPrimaryWorkbenchReadModel["sourceOptions"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench source options contract is required.");
  }
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench source options status must be explicit.");
  }
  if (!["fresh", "stale", "lagging", "partial", "unavailable"].includes(value.freshness)) {
    throw new Error("Primary workbench source options freshness must be explicit.");
  }
  for (const kind of value.optionKinds) {
    if (!kind.queryKind || !kind.displayName || !kind.scope) {
      throw new Error("Primary workbench source option kinds must expose canonical query metadata.");
    }
    if (kind.parent.required && !kind.parent.scope) {
      throw new Error("Primary workbench source option required parents must name the parent scope.");
    }
    if (kind.parent.missing && !kind.parent.diagnosticText) {
      throw new Error("Primary workbench source option missing parents require diagnostic text.");
    }
  }
  for (const page of value.pages) {
    if (!page.queryKind || !page.displayName || !page.scope) {
      throw new Error("Primary workbench source option pages must preserve option kind identity.");
    }
    if (!["live", "cached", "stale", "unavailable", "rollout-blocked", "not-requested"].includes(page.state)) {
      throw new Error("Primary workbench source option page state must be explicit.");
    }
    assertCatalogPrimaryWorkbenchActionState(page.actionState);
    assertPrimaryWorkbenchBlockers(page.blockers);
    if (page.request.limit < 1 || page.page.limit < 1) {
      throw new Error("Primary workbench source option pages must expose positive limits.");
    }
    if (page.page.count !== page.items.length) {
      throw new Error("Primary workbench source option page count must match item count.");
    }
    if (!["fresh", "stale", "miss", "bypass", "unavailable"].includes(page.cache.status)) {
      throw new Error("Primary workbench source option cache status must be explicit.");
    }
    if (!["cache", "live", "none"].includes(page.cache.source)) {
      throw new Error("Primary workbench source option cache source must be explicit.");
    }
    if ((page.state === "live" || page.state === "cached" || page.state === "stale") && !page.cache.cacheKey) {
      throw new Error("Primary workbench source option cached/live pages must include the cache key.");
    }
    if (!page.queryHref || /raw-json|legacy|compat/i.test(page.queryHref)) {
      throw new Error("Primary workbench source option query links must stay on typed option routes.");
    }
    if (page.refreshHref && /raw-json|legacy|compat/i.test(page.refreshHref)) {
      throw new Error("Primary workbench source option refresh links must stay on typed option routes.");
    }
  }
  if (value.summary.declaredKinds !== value.optionKinds.length || value.pages.length !== value.optionKinds.length) {
    throw new Error("Primary workbench source options must expose one page state per declared option kind.");
  }
  assertCatalogPrimaryWorkbenchActionState(value.refresh.state);
  assertPrimaryWorkbenchBlockers(value.refresh.blockers);
}

function assertPrimaryWorkbenchConflictResolution(
  value: CatalogPrimaryWorkbenchReadModel["conflictResolution"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench conflict resolution contract is required.");
  }
  if (!["ready", "empty", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench conflict resolution status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench conflict resolution return link must target the rebuilt workbench.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.auditEvidenceUrl)) {
    throw new Error("Primary workbench conflict resolution audit link must target the rebuilt workbench.");
  }
  if (value.rows.length > 0 && value.precedenceRules.length === 0) {
    throw new Error("Primary workbench conflict resolution rows require precedence rule evidence.");
  }
  if (value.overridePolicy.supported && value.overridePolicy.state === "available") {
    throw new Error("Primary workbench conflict overrides need a rebuilt backend command before becoming available.");
  }
  assertCatalogPrimaryWorkbenchActionState(value.overridePolicy.state);
  for (const row of value.rows) {
    if (!row.observationId || !row.affectedFact || !row.precedenceRuleId) {
      throw new Error("Primary workbench conflict resolution rows must name observation, fact, and precedence rule.");
    }
    if (!["blocks-promotion", "requires-review", "auto-resolved"].includes(row.resolutionState)) {
      throw new Error("Primary workbench conflict resolution row state must be explicit.");
    }
    if (row.candidateValues.length < 2) {
      throw new Error("Primary workbench conflict resolution rows must show winning and losing candidate values.");
    }
    if (row.evidencePaths.length === 0 || row.diagnostics.length === 0) {
      throw new Error("Primary workbench conflict resolution rows must expose evidence paths and diagnostics.");
    }
    assertCatalogPrimaryWorkbenchActionState(row.overrideAction.state);
  }
}

function assertPrimaryWorkbenchSourceScopeWorkset(
  value: CatalogPrimaryWorkbenchReadModel["sourceScopeWorkset"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench source-scope workset contract is required.");
  }
  if (!["not-configured", "scope-required", "ready", "blocked", "degraded"].includes(value.status)) {
    throw new Error("Primary workbench source-scope workset status must be explicit.");
  }
  if (!value.selectedScope.label) {
    throw new Error("Primary workbench source-scope workset must label the selected scope state.");
  }
  if (value.summary.unitCount !== value.units.length) {
    throw new Error("Primary workbench source-scope workset unit summary must match unit rows.");
  }
  const unitKeys = new Set<string>();
  for (const unit of value.units) {
    const unitIdentity = `${unit.providerKey}:${unit.unitKey ?? "none"}`;
    if (unitKeys.has(unitIdentity)) {
      throw new Error("Primary workbench source-scope workset unit rows must be unique by provider and unit.");
    }
    unitKeys.add(unitIdentity);
    if (
      !unit.providerKey ||
      !unit.displayName ||
      !unit.currentWorkbenchHref ||
      /api\/|raw-json|legacy|compat/i.test(unit.currentWorkbenchHref)
    ) {
      throw new Error("Primary workbench source-scope workset rows must link back to the typed workbench.");
    }
    if (!["not-imported", "imported", "changed", "promoted", "blocked"].includes(unit.state)) {
      throw new Error("Primary workbench source-scope workset row state must be explicit.");
    }
    if (!unit.commandContext.providerKey || unit.commandContext.providerKey !== unit.providerKey) {
      throw new Error("Primary workbench source-scope workset command context must preserve provider identity.");
    }
    if (!value.selectedScope.hasConcreteScope || !unit.importScope) {
      for (const action of [unit.actions.import, unit.actions.previewPromotion, unit.actions.reapply] as const) {
        if (action.state !== "disabled" || !action.blockers.includes("import-scope-required")) {
          throw new Error("Primary workbench source-scope workset must fail closed until a source scope is selected.");
        }
      }
    }
    for (const action of [unit.actions.import, unit.actions.previewPromotion, unit.actions.reapply] as const) {
      assertCatalogPrimaryWorkbenchActionState(action.state);
      assertPrimaryWorkbenchBlockers(action.blockers);
    }
  }
}

function assertPrimaryWorkbenchGovernanceControls(
  value: CatalogPrimaryWorkbenchReadModel["governanceControls"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench governance controls contract is required.");
  }
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench governance controls status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench governance controls return link must target the rebuilt workbench.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.auditEvidenceUrl)) {
    throw new Error("Primary workbench governance controls audit link must target the rebuilt workbench.");
  }
  if (value.controls.length === 0) {
    throw new Error("Primary workbench governance controls must expose rollout, worker, and removal evidence.");
  }
  for (const control of value.controls) {
    if (!control.controlId || !control.kind || !control.label || !control.metricKey) {
      throw new Error("Primary workbench governance controls must name control, metric, and label.");
    }
    if (!["open", "degraded", "blocked", "removed"].includes(control.status)) {
      throw new Error("Primary workbench governance control status must be explicit.");
    }
    if (!isSafePrimaryWorkbenchReturnPath(control.evidenceUrl)) {
      throw new Error("Primary workbench governance control evidence link must target the rebuilt workbench.");
    }
  }

  const sensitiveActions = catalogPrimaryWorkbenchActions.filter(
    (actionEntry) => actionEntry.requiredPermission === "catalog.manage" || actionEntry.confirmationRequired,
  );
  const matrixKeys = new Set(value.rbacMatrix.map((entry) => entry.actionKey));
  for (const actionEntry of sensitiveActions) {
    if (!matrixKeys.has(actionEntry.key)) {
      throw new Error(`Primary workbench governance controls must cover sensitive action '${actionEntry.key}'.`);
    }
  }
  for (const entry of value.rbacMatrix) {
    assertCatalogPrimaryWorkbenchActionState(entry.state);
    if (!entry.deniedCopy) {
      throw new Error("Primary workbench governance RBAC matrix must provide denied-state copy.");
    }
    if (entry.confirmationRequired && !entry.destructive) {
      throw new Error("Primary workbench governance destructive confirmation rows must be explicit.");
    }
    if (/legacy|compat|raw-json/i.test(entry.routePattern)) {
      throw new Error("Primary workbench governance RBAC matrix must not preserve retired route patterns.");
    }
  }

  const requiredSignals: readonly CatalogPrimaryWorkbenchGovernanceObservabilitySignalKey[] = [
    "option-query-latency",
    "job-failure-rate",
    "projection-freshness",
    "source-observation-quarantine",
    "data-quarantine",
    "conflict-spike",
  ];
  const signalKeys = new Set(value.observability.signals.map((signal) => signal.key));
  for (const signal of requiredSignals) {
    if (!signalKeys.has(signal)) {
      throw new Error(`Primary workbench governance observability signal '${signal}' is required.`);
    }
  }
  for (const signal of value.observability.signals) {
    if (!["ready", "degraded", "blocked", "unavailable"].includes(signal.status)) {
      throw new Error("Primary workbench governance observability signal status must be explicit.");
    }
    if (signal.alertLinks.length === 0 || signal.runbookLinks.length === 0) {
      throw new Error("Primary workbench governance observability signals require alert and runbook links.");
    }
    for (const link of [...signal.alertLinks, ...signal.runbookLinks]) {
      if (!link.label || !isSafePrimaryWorkbenchObservabilityLink(link.href)) {
        throw new Error("Primary workbench governance alert and runbook links must target approved observability.");
      }
    }
    if (signal.stale && signal.status === "ready") {
      throw new Error("Primary workbench governance stale observability data must be degraded or unavailable.");
    }
  }

  if (value.legacyRemovalEvidence.status !== "removed") {
    throw new Error("Primary workbench governance retired compatibility evidence must be removed.");
  }
  if (value.legacyRemovalEvidence.requiredDisposition !== "complete-removal") {
    throw new Error("Primary workbench governance retired compatibility evidence must require complete removal.");
  }
  for (const surface of [
    "runtime code",
    "product patterns",
    "tests",
    "fixtures",
    "screenshots",
    "documentation",
    "runbooks",
    "operator instructions",
  ] as const) {
    if (!value.legacyRemovalEvidence.removedSurfaces.includes(surface)) {
      throw new Error(`Primary workbench governance retirement evidence must remove '${surface}'.`);
    }
  }
  for (const evidence of value.legacyRemovalEvidence.evidence) {
    if (evidence.status !== "removed" || !isSafePrimaryWorkbenchReturnPath(evidence.evidenceUrl)) {
      throw new Error("Primary workbench governance retirement evidence rows must be removed and linked.");
    }
  }
  const removalText = `${value.legacyRemovalEvidence.evidence.map((evidence) => evidence.detail).join(" ")} ${value.legacyRemovalEvidence.launchBlockerIfPresent.join(
    " ",
  )}`;
  if (/holding area/i.test(removalText)) {
    throw new Error("Primary workbench governance controls must not preserve a compatibility holding area.");
  }
}

function assertPrimaryWorkbenchAuditEvidence(
  value: CatalogPrimaryWorkbenchReadModel["auditEvidence"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench audit evidence contract is required.");
  }
  if (!["ready", "partial", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench audit evidence status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench audit evidence return link must target the rebuilt workbench.");
  }
  if (value.projectionState.queryKey !== "audit-evidence-timeline") {
    throw new Error("Primary workbench audit evidence projection must use the canonical audit timeline query.");
  }
  if (value.projectionState.missingProjection && value.status !== "unavailable") {
    throw new Error("Primary workbench missing audit projection must be unavailable.");
  }
  if (value.projectionState.partialProjection && value.status === "ready") {
    throw new Error("Primary workbench partial audit projection cannot report ready.");
  }

  const requiredFilterKeys: readonly CatalogPrimaryWorkbenchAuditEvidenceFilterKey[] = [
    "provider",
    "unit",
    "profile-version",
    "job",
    "observation",
    "action-category",
    "actor",
    "time",
  ];
  const filterKeys = new Set(value.filters.map((filter) => filter.key));
  for (const filterKey of requiredFilterKeys) {
    if (!filterKeys.has(filterKey)) {
      throw new Error(`Primary workbench audit evidence filter '${filterKey}' is required.`);
    }
  }

  if (
    value.redactionPolicy.sourcePayloadAccess !== "not-required" ||
    value.redactionPolicy.profileSnapshotAccess !== "not-required"
  ) {
    throw new Error("Primary workbench audit evidence must not require source payload or profile snapshot access.");
  }
  if (value.redactionPolicy.forbiddenEvidenceRequests.length === 0) {
    throw new Error("Primary workbench audit evidence must list forbidden evidence request patterns.");
  }

  const links = [...value.evidenceLinks, ...value.timeline.flatMap((event) => event.evidenceLinks)];
  for (const link of links) {
    assertPrimaryWorkbenchAuditEvidenceLink(link);
  }
  for (const event of value.timeline) {
    if (!event.eventId || !event.occurredAt || !event.eventName || !event.category || !event.targetId) {
      throw new Error("Primary workbench audit timeline rows must name event, time, category, and target.");
    }
    if (event.evidenceLinks.length === 0) {
      throw new Error("Primary workbench audit timeline rows must expose redacted evidence links.");
    }
  }

  const evidenceText = JSON.stringify(value);
  if (/raw\s+json|payload\s+json|profile\s+json|compatibility holding area/i.test(evidenceText)) {
    throw new Error(
      "Primary workbench audit evidence must expose redacted summaries without legacy document workflows.",
    );
  }
}

function assertPrimaryWorkbenchAuditEvidenceLink(link: CatalogPrimaryWorkbenchAuditEvidenceLink): void {
  if (!link.key || !link.label || !link.summary || !isSafePrimaryWorkbenchReturnPath(link.href)) {
    throw new Error("Primary workbench audit evidence links must be named and target rebuilt workbench evidence.");
  }
  if (
    link.sourcePayloadAccess !== "not-required" ||
    link.profileSnapshotAccess !== "not-required" ||
    !["not-needed", "redacted", "excluded"].includes(link.redactionState)
  ) {
    throw new Error("Primary workbench audit evidence links must remain redaction-safe.");
  }
}

function assertPrimaryWorkbenchPromotionPreview(
  value: CatalogPrimaryWorkbenchReadModel["promotionPreview"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench promotion preview contract is required.");
  }
  if (!value.scope) {
    throw new Error("Primary workbench promotion preview scope is required.");
  }
  if (value.scope.partialFailureMode !== "per-observation") {
    throw new Error("Primary workbench promotion preview must preserve per-observation partial failure scope.");
  }
  if (!value.validation || !["complete", "partial", "not-previewed"].includes(value.validation.coverage)) {
    throw new Error("Primary workbench promotion preview validation coverage must be explicit.");
  }
  if (typeof value.validation.promoteAsDraft !== "boolean") {
    throw new Error("Primary workbench promotion preview must state the explicit promote-as-draft choice.");
  }
  for (const key of ["eligible", "blocked", "skipped", "conflicting", "failed"] as const) {
    if (typeof value.outcomeCounts?.[key] !== "number") {
      throw new Error(`Primary workbench promotion outcome count '${key}' is required.`);
    }
  }
  if (!value.executionSafeguards?.idempotencyRequired || !value.executionSafeguards.doubleSubmitProtection) {
    throw new Error(
      "Primary workbench promotion execution safeguards must include idempotency and double-submit protection.",
    );
  }
  for (const staleProtection of [
    "observations",
    "profile-version",
    "rollout-state",
    "permissions",
    "command-inputs",
  ] as const) {
    if (!value.executionSafeguards.rejectsWhenChanged.includes(staleProtection)) {
      throw new Error(`Primary workbench promotion execution must reject stale ${staleProtection} previews.`);
    }
  }
  assertPrimaryWorkbenchBlockers(value.executionSafeguards.overlappingActionBlockers);
  if (!value.reviewDecisions?.reject.reasonRequired) {
    throw new Error("Primary workbench rejection decisions must require a reason.");
  }
  if (value.reviewDecisions.defer.stateChange !== "keeps-observation-in-review") {
    throw new Error("Primary workbench defer decisions must preserve review return semantics.");
  }
  if (value.profileWorkflows?.reapply.profileSemantics !== "current-active-profile") {
    throw new Error("Primary workbench reapply must use current active profile semantics.");
  }
  if (value.profileWorkflows.replay.profileSemantics !== "original-source-profile-version") {
    throw new Error("Primary workbench replay must use original source profile version semantics.");
  }
}

function assertPrimaryWorkbenchMergeCandidateReview(
  value: CatalogPrimaryWorkbenchReadModel["mergeCandidateReview"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench merge candidate review contract is required.");
  }
  if (!["fresh", "partial", "stale", "unavailable"].includes(value.freshness)) {
    throw new Error("Primary workbench merge candidate review freshness must be explicit.");
  }
  for (const countKey of ["total", "ready", "conflict", "stale", "deferred", "terminal", "blocked"] as const) {
    if (typeof value.counts[countKey] !== "number") {
      throw new Error(`Primary workbench merge candidate count '${countKey}' is required.`);
    }
  }
  for (const row of value.rows) {
    if (!row.candidateId || !row.identityFingerprint || !row.identityLabel) {
      throw new Error("Primary workbench merge candidate rows must expose identity.");
    }
    if (row.sourceCount < 1 || row.sources.length < 1) {
      throw new Error("Primary workbench merge candidate rows must expose contributing sources.");
    }
    if (row.promoteReadiness.state === "ready" && row.promoteReadiness.blockers.length > 0) {
      throw new Error("Primary workbench ready merge candidates cannot carry promotion blockers.");
    }
    if (!row.proposedMapping.promotionIntent) {
      throw new Error("Primary workbench merge candidate detail must expose proposed Catalog mapping.");
    }
    if (row.fieldProvenance.length === 0 || row.sourceComparison.length === 0) {
      throw new Error("Primary workbench merge candidate detail must expose source comparison and field provenance.");
    }
    if (row.conflicts.blockingConflicts.length !== row.conflicts.blocking) {
      throw new Error(
        "Primary workbench merge candidate blocking conflict count must match its resolvable conflict detail.",
      );
    }
    const actions = new Set(row.actions.map((actionEntry) => actionEntry.key));
    for (const actionKey of [
      "candidate.promote",
      "candidate.split",
      "candidate.edit",
      "candidate.ignore",
      "candidate.defer",
    ] as const) {
      if (!actions.has(actionKey)) {
        throw new Error(`Primary workbench merge candidate rows must expose '${actionKey}'.`);
      }
    }
    for (const actionEntry of row.actions) {
      assertCatalogPrimaryWorkbenchActionState(actionEntry.state);
      assertPrimaryWorkbenchBlockers(actionEntry.blockers);
      if (
        (actionEntry.key === "candidate.split" || actionEntry.key === "candidate.edit") &&
        (actionEntry.state === "available" || actionEntry.state === "degraded") &&
        !actionEntry.commandPreview
      ) {
        throw new Error("Primary workbench split/update merge candidate actions require typed command previews.");
      }
    }
  }
}

function assertPrimaryWorkbenchHealthTriage(value: CatalogPrimaryWorkbenchReadModel["healthTriage"] | undefined): void {
  if (!value) {
    throw new Error("Primary workbench health triage contract is required.");
  }
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench health triage status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench health triage return link must target the rebuilt workbench.");
  }
  for (const unit of value.units) {
    if (!unit.providerKey || !unit.unitKey || !unit.ownerMetricKey || !unit.nextAction) {
      throw new Error("Primary workbench health triage units must name provider, unit, owner metric, and next action.");
    }
  }
  for (const provider of value.providers) {
    if (!provider.providerKey || !provider.ownerMetricKey || !provider.nextAction) {
      throw new Error("Primary workbench health triage providers must name provider, owner metric, and next action.");
    }
  }
}

function assertPrimaryWorkbenchProfileAuthoring(
  value: CatalogPrimaryWorkbenchReadModel["profileAuthoring"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench profile authoring contract is required.");
  }
  if (!["ready", "missing-profile", "stale-selection"].includes(value.status)) {
    throw new Error("Primary workbench profile authoring status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench profile authoring return link must target the rebuilt workbench.");
  }
  if (value.cloneDraft.commandKey !== "provider-profile.clone") {
    throw new Error("Primary workbench profile draft command must use the rebuilt provider-profile.clone boundary.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.cloneDraft.submitHref)) {
    throw new Error("Primary workbench profile draft submit link must target the rebuilt workbench.");
  }
  assertCatalogPrimaryWorkbenchActionState(value.cloneDraft.state);
  assertPrimaryWorkbenchBlockers(value.cloneDraft.blockers);
  if (value.status === "ready" && !value.selectedProfile) {
    throw new Error("Primary workbench profile authoring ready state requires a selected profile.");
  }
  if (value.status !== "ready" && value.cloneDraft.blockers.length === 0) {
    throw new Error("Primary workbench profile draft command must fail closed when profile selection is missing.");
  }
  if (value.selectedProfile) {
    if (
      !value.selectedProfile.providerKey ||
      !value.selectedProfile.profileKey ||
      !value.selectedProfile.profileVersion
    ) {
      throw new Error("Primary workbench selected profile must preserve provider, profile, and version identity.");
    }
    if (value.selectedProfile.immutableIdentityFacts.length === 0) {
      throw new Error("Primary workbench selected profile must expose immutable identity facts.");
    }
    if (
      value.cloneDraft.sourceProviderKey !== value.selectedProfile.providerKey ||
      value.cloneDraft.sourceProfileVersion !== value.selectedProfile.profileVersion
    ) {
      throw new Error("Primary workbench profile draft command must preserve source provider and version context.");
    }
  }
  if (value.selectedProfile && value.sectionWorkspaces.length === 0) {
    throw new Error("Primary workbench profile authoring must expose guided section workspaces.");
  }
  const groupedSections = new Set(value.sectionGroups.flatMap((group) => group.sections));
  for (const workspace of value.sectionWorkspaces) {
    if (!groupedSections.has(workspace.sectionKey)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must belong to a navigation group.`);
    }
    if (workspace.commandKey !== "provider-profile.edit-section") {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must use section-scoped saves.`);
    }
    if (!isSafePrimaryWorkbenchReturnPath(workspace.submitHref)) {
      throw new Error(
        `Primary workbench profile section ${workspace.sectionKey} submit link must stay in the rebuilt workbench.`,
      );
    }
    if (workspace.fields.length === 0) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must expose guided controls.`);
    }
    if (workspace.fields.some((field) => /json/i.test(`${field.key} ${field.label} ${field.helpText ?? ""}`))) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must not expose raw JSON controls.`);
    }
    if (!Array.isArray(workspace.optionQueries)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} option-query details are required.`);
    }
    if (!Array.isArray(workspace.importScopeControls)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} import-scope controls are required.`);
    }
    if (!Array.isArray(workspace.mappingRows)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} mapping rows are required.`);
    }
    for (const optionQuery of workspace.optionQueries) {
      if (!optionQuery.queryKind || !optionQuery.displayName || !optionQuery.scope || !optionQuery.operation) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} option queries must expose canonical query metadata.`,
        );
      }
      if (optionQuery.outputMappings.length === 0) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} option queries must expose output mappings.`,
        );
      }
      if (!optionQuery.cacheState.label || !optionQuery.cacheState.description) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} option-query cache state must be explainable.`,
        );
      }
    }
    for (const importScope of workspace.importScopeControls) {
      if (!importScope.scope || !importScope.label) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} import-scope controls must name the scope.`,
        );
      }
      if (importScope.state === "unavailable" && !importScope.reason) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} unavailable import scopes need a reason.`,
        );
      }
    }
    for (const mappingRow of workspace.mappingRows) {
      if (!mappingRow.key || !mappingRow.label || !mappingRow.path || !mappingRow.summary) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} mapping rows must expose row metadata.`,
        );
      }
      if (!mappingRow.affordances.inlineDiagnostics || !mappingRow.affordances.longPathSafe) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} mapping rows must support diagnostics and long paths.`,
        );
      }
    }
    assertCatalogPrimaryWorkbenchActionState(workspace.actionState);
    assertPrimaryWorkbenchBlockers(workspace.blockers);
    if (!["fresh", "stale", "conflict"].includes(workspace.staleState)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} stale state must be explicit.`);
    }
    if (!["not-submitted", "saved", "conflict", "invalid", "failed"].includes(workspace.saveOutcome)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} save outcome must be explicit.`);
    }
  }
}

function assertPrimaryWorkbenchValidationReadiness(
  value: CatalogPrimaryWorkbenchReadModel["validationReadiness"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench validation readiness contract is required.");
  }
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench validation readiness status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench validation readiness return link must target the rebuilt workbench.");
  }
  if (value.selectedProfileVersion && value.fixtureFlows.length === 0) {
    throw new Error("Primary workbench validation readiness must expose fixture flows for the selected profile.");
  }
  for (const flow of value.fixtureFlows) {
    if (!flow.flow || !["ready", "warning", "blocked", "not-covered"].includes(flow.status)) {
      throw new Error("Primary workbench validation fixture flows must be named and explicitly statused.");
    }
    assertPrimaryWorkbenchBlockers(flow.blockers);
    assertCatalogPrimaryWorkbenchActionState(flow.actionState);
  }
  for (const evidence of value.dryRunEvidence) {
    if (!["completed", "blocked", "not-run"].includes(evidence.status)) {
      throw new Error("Primary workbench validation dry-run evidence status must be explicit.");
    }
    if (evidence.redactionSummary.length === 0) {
      throw new Error("Primary workbench validation dry-run evidence must summarize redaction.");
    }
  }
  if (!["ready", "blocked"].includes(value.activationReadiness.status)) {
    throw new Error("Primary workbench activation readiness status must be explicit.");
  }
  if (!value.activationDecision || value.activationDecision.activationCommandKey !== "provider-profile.activate") {
    throw new Error("Primary workbench activation decision must expose the rebuilt activation command.");
  }
  if (value.activationDecision.evidenceCommandKey !== "provider-profile.edit-section") {
    throw new Error("Primary workbench activation decision must save evidence through typed profile sections.");
  }
  if (!["ready", "blocked", "unavailable"].includes(value.activationDecision.status)) {
    throw new Error("Primary workbench activation decision status must be explicit.");
  }
  assertCatalogPrimaryWorkbenchActionState(value.activationDecision.actionState);
  assertCatalogPrimaryWorkbenchActionState(value.activationDecision.saveEvidenceState);
  assertPrimaryWorkbenchBlockers(value.activationDecision.blockers);
  assertPrimaryWorkbenchBlockers(value.activationDecision.saveEvidenceBlockers);
  if (value.activationDecision.status === "ready" && value.activationDecision.actionState !== "available") {
    throw new Error("Primary workbench activation decision must make ready activation actionable.");
  }
  const validationText = JSON.stringify(value);
  if (/raw\s+json/i.test(validationText)) {
    throw new Error("Primary workbench validation readiness must not expose raw JSON workflow copy.");
  }
}

function assertPrimaryWorkbenchLifecycleRecovery(
  value: CatalogPrimaryWorkbenchReadModel["lifecycleRecovery"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench lifecycle recovery contract is required.");
  }
  if (!["ready", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench lifecycle recovery status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench lifecycle recovery return link must target the rebuilt workbench.");
  }
  if (value.strictRetirement.requiredDisposition !== "complete-removal") {
    throw new Error("Primary workbench lifecycle recovery must preserve complete-removal retirement semantics.");
  }
  const operations = new Set(value.operations.map((operation) => operation.operation));
  for (const operation of ["activation", "rollback", "deprecate", "retire"] as const) {
    if (!operations.has(operation)) {
      throw new Error(`Primary workbench lifecycle recovery must expose ${operation} evidence.`);
    }
  }
  for (const operation of value.operations) {
    assertCatalogPrimaryWorkbenchActionState(operation.state);
    assertPrimaryWorkbenchBlockers(operation.blockers);
    if (!isSafePrimaryWorkbenchReturnPath(operation.submitHref)) {
      throw new Error("Primary workbench lifecycle recovery submit link must stay in the rebuilt workbench.");
    }
    if (
      (operation.operation === "rollback" || operation.operation === "deprecate" || operation.operation === "retire") &&
      !operation.confirmationRequired
    ) {
      throw new Error("Primary workbench lifecycle recovery destructive lifecycle actions require confirmation.");
    }
    if (operation.operation === "retire" && operation.blockers.includes("profile-retirement-references")) {
      const referenceCount =
        operation.impact.referencedObservationCount +
        operation.impact.sourceProfileReferenceCount +
        operation.impact.promotionProfileReferenceCount;
      if (referenceCount === 0) {
        throw new Error("Primary workbench profile retirement reference blocker must name concrete references.");
      }
    }
  }
}

function deploySkew(
  mode: CatalogPrimaryWorkbenchDeploySkewMode,
  supported: boolean,
  forbiddenFallbacks: readonly string[],
): CatalogPrimaryWorkbenchDeploySkewPolicy {
  return {
    mode,
    supported,
    failClosedBlocker: "deploy-skew-unsupported-version",
    forbiddenFallbacks,
  };
}

function downstream(
  issue: CatalogPrimaryWorkbenchDownstreamIssueKey,
  consumes: readonly CatalogPrimaryWorkbenchSectionKey[],
  requiredFields: readonly string[],
): CatalogPrimaryWorkbenchDownstreamContract {
  return {
    issue,
    consumes,
    requiredFields,
  };
}

function assertPrimaryWorkbenchBlockers(blockers: readonly string[] | undefined): void {
  for (const blockerEntry of blockers ?? []) {
    assertCatalogPrimaryWorkbenchBlockerCategory(blockerEntry);
  }
}
