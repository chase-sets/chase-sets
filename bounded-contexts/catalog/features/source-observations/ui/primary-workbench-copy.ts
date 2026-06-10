import { t } from "@chase-sets/localization";
import type {
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchCopyKey,
  CatalogPrimaryWorkbenchProviderTransportCategory,
} from "../api/primary-workbench-admin-contracts";

export type CatalogPrimaryWorkbenchSupportTarget =
  | "import-to-promotion"
  | "health-triage"
  | "profile-authoring"
  | "validation-readiness"
  | "adapter-readiness"
  | "lifecycle-recovery"
  | "governance-controls"
  | "audit-evidence";

export type CatalogPrimaryWorkbenchCopyGroup =
  | "permission"
  | "readiness"
  | "rollout"
  | "job"
  | "profile"
  | "fixture"
  | "credential"
  | "provider-transport"
  | "source-observation"
  | "promotion"
  | "security-privacy"
  | "resilience"
  | "retirement";

export type CatalogPrimaryWorkbenchOperatorCopy = Readonly<{
  label: string;
  reason: string;
  nextStep: string;
  supportTarget: CatalogPrimaryWorkbenchSupportTarget;
  group: CatalogPrimaryWorkbenchCopyGroup;
}>;

export type CatalogPrimaryWorkbenchEmptyStateKey =
  | "provider-scopes"
  | "import-context"
  | "import-jobs"
  | "source-observations"
  | "promotion-eligible"
  | "audit-evidence";

export type CatalogPrimaryWorkbenchResilienceStateKey =
  | "route-load-failure"
  | "api-failure"
  | "detail-panel-failure"
  | "telemetry-unavailable"
  | "read-model-degraded";

export type CatalogPrimaryWorkbenchCompletionStateKey =
  | "provider-import-complete"
  | "promotion-complete"
  | "reject-complete"
  | "defer-complete"
  | "reapply-complete"
  | "replay-complete";

export type CatalogPrimaryWorkbenchGlossaryTerm = Readonly<{
  term: string;
  definition: string;
  useWhen: string;
  avoid: string;
}>;

const catalogPrimaryWorkbenchCopyLabels = {
  providerContextRequired: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.context.required",
  ),
  providerPullBlocked: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.pull.blocked"),
  providerPullDenied: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.pull.denied"),
  importCompletedWithPartialData: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.import.completed.with.partial.data",
  ),
  nothingReadyToReview: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.nothing.ready.to.review"),
  reviewEvidenceDegraded: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.review.evidence.degraded",
  ),
  promotionPreviewRequired: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.promotion.preview.required",
  ),
  promotionPreviewIsStale: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.promotion.preview.is.stale",
  ),
  securityOrPrivacyBlock: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.security.or.privacy.block",
  ),
  profileEvidenceMissing: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.profile.evidence.missing",
  ),
  unsupportedControlPlaneVersion: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.unsupported.control.plane.version",
  ),
  rateLimitCooldown: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.rate.limit.cooldown"),
  providerThrottle: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.throttle"),
  providerQuotaExhausted: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.quota.exhausted",
  ),
  providerTimeout: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.timeout"),
  providerPaginationFailed: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.pagination.failed",
  ),
  partialProviderData: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.partial.provider.data"),
  staleProviderCache: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.stale.provider.cache"),
  providerDegraded: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.degraded"),
  permissionDenied: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.permission.denied"),
  authorizationDenied: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.authorization.denied"),
  rolloutStopped: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.rollout.stopped"),
  killSwitchActive: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.kill.switch.active"),
  rbacGrantMissing: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.rbac.grant.missing"),
  importAlreadyRunning: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.import.already.running"),
  concurrentJobsDetected: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.concurrent.jobs.detected",
  ),
  activeProfileMissing: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.active.profile.missing"),
  profileVersionMissing: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.profile.version.missing",
  ),
  fixtureCoverageMissing: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.fixture.coverage.missing",
  ),
  fixtureValidationBlocked: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.fixture.validation.blocked",
  ),
  providerCredentialMissing: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.credential.missing",
  ),
  providerCredentialInvalid: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.credential.invalid",
  ),
  providerCredentialExpired: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.credential.expired",
  ),
  sourceObservationProjectionStale: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.source.observation.projection.stale",
  ),
  readModelDegraded: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.read.model.degraded"),
  readModelPartial: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.read.model.partial"),
  readModelUnavailable: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.read.model.unavailable"),
  jobNotFound: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.job.not.found"),
  sourceObservationNotFound: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.source.observation.not.found",
  ),
  noObservationsSelected: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.no.observations.selected",
  ),
  noPromotableObservations: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.no.promotable.observations",
  ),
  duplicateEvidenceConflict: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.duplicate.evidence.conflict",
  ),
  promotionConflict: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.promotion.conflict"),
  confirmationRequired: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.confirmation.required"),
  stalePromotionPreview: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.stale.promotion.preview",
  ),
  staleReplayCheckpoint: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.stale.replay.checkpoint",
  ),
  idempotencyReplayInProgress: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.idempotency.replay.in.progress",
  ),
  securityOrPrivacyBlocker: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.security.or.privacy.blocker",
  ),
  commandUnavailable: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.command.unavailable"),
  unsupportedDeployedVersion: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.unsupported.deployed.version",
  ),
  payloadEscapeHatchRemoved: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.payload.escape.hatch.removed",
  ),
  oldSelectorRemoved: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.old.selector.removed"),
  ready: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.ready"),
  needsInput: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.needs.input"),
  blocked: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.blocked"),
  unavailable: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.unavailable"),
  unsafe: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.unsafe"),
  degraded: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.degraded"),
  noProviderScopesAreReadyForImport: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.no.provider.scopes.are.ready.for.import",
  ),
  importContextIsIncomplete: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.import.context.is.incomplete",
  ),
  noDurableImportJobsForThisContext: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.no.durable.import.jobs.for.this.context",
  ),
  noSourceObservationsInThisContext: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.no.source.observations.in.this.context",
  ),
  noAuditEvidenceForThisContext: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.no.audit.evidence.for.this.context",
  ),
  routeCouldNotLoad: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.route.could.not.load"),
  catalogApiUnavailable: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.catalog.api.unavailable",
  ),
  evidencePanelFailed: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.evidence.panel.failed"),
  telemetryUnavailable: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.telemetry.unavailable"),
  providerDataPulled: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.provider.data.pulled"),
  catalogPromotionComplete: t(
    "catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.catalog.promotion.complete",
  ),
  observationsRejected: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.observations.rejected"),
  observationsDeferred: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.observations.deferred"),
  reapplyComplete: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.reapply.complete"),
  replayComplete: t("catalog.features.sourceObservations.ui.primaryWorkbench.copy.label.replay.complete"),
} as const;

export const catalogPrimaryWorkbenchCopyMessages = {
  "catalog.primary.providerScope.required": copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerContextRequired,
    reason: "The primary path needs a provider, ingestion unit, import scope, and active profile before import.",
    nextStep: "Choose the provider context, then return to Pull provider data.",
    supportTarget: "import-to-promotion",
    group: "readiness",
  }),
  "catalog.primary.import.blocked": copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerPullBlocked,
    reason: "Readiness, transport, rollout, job, or profile evidence is preventing a new provider import.",
    nextStep: "Resolve the named blocker, then retry the scoped provider pull from this workbench.",
    supportTarget: "health-triage",
    group: "readiness",
  }),
  "catalog.primary.import.denied": copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerPullDenied,
    reason: "The operator account does not have permission to run this Catalog import command.",
    nextStep: "Open governance controls or use an account with catalog.manage before retrying.",
    supportTarget: "governance-controls",
    group: "permission",
  }),
  "catalog.primary.job.partial": copy({
    label: catalogPrimaryWorkbenchCopyLabels.importCompletedWithPartialData,
    reason: "The durable job finished some work units but did not acquire every provider payload.",
    nextStep: "Review grouped failures, retry recoverable work units, then review the affected Source Observations.",
    supportTarget: "import-to-promotion",
    group: "job",
  }),
  "catalog.primary.review.empty": copy({
    label: catalogPrimaryWorkbenchCopyLabels.nothingReadyToReview,
    reason: "The current provider context has no Source Observations that can move into promotion preview.",
    nextStep: "Pull provider data or adjust the review filters to find changed observations.",
    supportTarget: "import-to-promotion",
    group: "source-observation",
  }),
  "catalog.primary.review.blocked": copy({
    label: catalogPrimaryWorkbenchCopyLabels.reviewEvidenceDegraded,
    reason: "The Source Observation review read model is stale, partial, unavailable, or behind projection replay.",
    nextStep: "Open health triage for projection status, then return to the same review filters.",
    supportTarget: "health-triage",
    group: "resilience",
  }),
  "catalog.primary.promotion.previewRequired": copy({
    label: catalogPrimaryWorkbenchCopyLabels.promotionPreviewRequired,
    reason: "Catalog writes need a fresh command plan with duplicate, conflict, and stale-input protection.",
    nextStep: "Preview promotion impact for the selected Source Observations before executing promotion.",
    supportTarget: "import-to-promotion",
    group: "promotion",
  }),
  "catalog.primary.promotion.stalePreview": copy({
    label: catalogPrimaryWorkbenchCopyLabels.promotionPreviewIsStale,
    reason: "Observations, profile version, rollout state, permissions, or command inputs changed after preview.",
    nextStep: "Queue a fresh promotion preview in this provider context.",
    supportTarget: "import-to-promotion",
    group: "promotion",
  }),
  "catalog.primary.promotion.securityBlocked": copy({
    label: catalogPrimaryWorkbenchCopyLabels.securityOrPrivacyBlock,
    reason: "Promotion would expose governed provider payload, operator evidence, or unsafe source details.",
    nextStep: "Open governance controls, confirm redaction evidence, then retry from the workbench.",
    supportTarget: "governance-controls",
    group: "security-privacy",
  }),
  "catalog.primary.reapply.originalProfileMissing": copy({
    label: catalogPrimaryWorkbenchCopyLabels.profileEvidenceMissing,
    reason: "Reapply or replay needs the correct active or original source profile version.",
    nextStep: "Open lifecycle recovery with this profile context, then return to the affected observations.",
    supportTarget: "lifecycle-recovery",
    group: "profile",
  }),
  "catalog.primary.deploySkew.failClosed": copy({
    label: catalogPrimaryWorkbenchCopyLabels.unsupportedControlPlaneVersion,
    reason: "The workbench detected an unsupported UI/API pairing or a removed launch-only fallback.",
    nextStep: "Refresh after deployment completes, or open release evidence if the unsupported version persists.",
    supportTarget: "audit-evidence",
    group: "retirement",
  }),
} as const satisfies Record<CatalogPrimaryWorkbenchCopyKey, CatalogPrimaryWorkbenchOperatorCopy>;

export const catalogPrimaryWorkbenchProviderTransportCopy = {
  "rate-limit": copy({
    label: catalogPrimaryWorkbenchCopyLabels.rateLimitCooldown,
    reason: "The provider is limiting request volume for this import scope.",
    nextStep: "Wait for the cooldown or reduce the pull cadence before retrying provider data import.",
    supportTarget: "adapter-readiness",
    group: "provider-transport",
  }),
  throttle: copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerThrottle,
    reason: "The provider asked the adapter to slow down, often with a retry-after signal.",
    nextStep: "Let the throttle window pass, then resume or retry the durable import job.",
    supportTarget: "adapter-readiness",
    group: "provider-transport",
  }),
  quota: copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerQuotaExhausted,
    reason: "The provider quota for this credential or account is exhausted.",
    nextStep: "Pause imports until quota resets or update provider credentials before retrying.",
    supportTarget: "adapter-readiness",
    group: "provider-transport",
  }),
  timeout: copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerTimeout,
    reason: "The adapter timed out before receiving a complete provider response.",
    nextStep: "Retry the provider pull after checking health triage for provider reachability.",
    supportTarget: "health-triage",
    group: "provider-transport",
  }),
  "pagination-failure": copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerPaginationFailed,
    reason: "The adapter could not finish a cursor or page sequence for this import scope.",
    nextStep: "Open adapter readiness to inspect cursor diagnostics, then resume from durable job progress.",
    supportTarget: "adapter-readiness",
    group: "provider-transport",
  }),
  "partial-data": copy({
    label: catalogPrimaryWorkbenchCopyLabels.partialProviderData,
    reason: "The provider returned only part of the expected payload set.",
    nextStep: "Review grouped failures, retry recoverable work units, and promote only complete observations.",
    supportTarget: "import-to-promotion",
    group: "provider-transport",
  }),
  "stale-cache": copy({
    label: catalogPrimaryWorkbenchCopyLabels.staleProviderCache,
    reason: "The workbench is using cached provider data because live acquisition is stale or degraded.",
    nextStep: "Refresh provider readiness, then pull provider data again when live acquisition is fresh.",
    supportTarget: "adapter-readiness",
    group: "provider-transport",
  }),
  "degraded-provider": copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerDegraded,
    reason: "Provider reachability, option queries, rate limits, or payload acquisition are degraded.",
    nextStep: "Use health triage to identify the degraded provider capability before retrying import.",
    supportTarget: "health-triage",
    group: "provider-transport",
  }),
} as const satisfies Record<CatalogPrimaryWorkbenchProviderTransportCategory, CatalogPrimaryWorkbenchOperatorCopy>;

export const catalogPrimaryWorkbenchBlockerCopy = {
  "permission-denied": copy({
    label: catalogPrimaryWorkbenchCopyLabels.permissionDenied,
    reason: "This operator account cannot run the requested Catalog command.",
    nextStep: "Ask an admin to grant catalog.manage or switch to a permitted operator account.",
    supportTarget: "governance-controls",
    group: "permission",
  }),
  "authorization-denied": copy({
    label: catalogPrimaryWorkbenchCopyLabels.authorizationDenied,
    reason: "Server-side policy rejected the command for this provider context.",
    nextStep: "Open governance controls with this context and verify the policy grant before retrying.",
    supportTarget: "governance-controls",
    group: "permission",
  }),
  "rollout-disabled": copy({
    label: catalogPrimaryWorkbenchCopyLabels.rolloutStopped,
    reason: "A rollout control is blocking this primary-path action.",
    nextStep: "Resolve the rollout stop in governance controls, then return to this provider context.",
    supportTarget: "governance-controls",
    group: "rollout",
  }),
  "kill-switch-active": copy({
    label: catalogPrimaryWorkbenchCopyLabels.killSwitchActive,
    reason: "A safety stop is quarantining this provider or workflow.",
    nextStep: "Review the stop owner and release evidence before any provider pull or promotion retry.",
    supportTarget: "governance-controls",
    group: "rollout",
  }),
  "rbac-missing": copy({
    label: catalogPrimaryWorkbenchCopyLabels.rbacGrantMissing,
    reason: "The workbench has no Catalog role grant for this operation.",
    nextStep: "Open governance controls and add the required role before retrying.",
    supportTarget: "governance-controls",
    group: "permission",
  }),
  "active-job-conflict": copy({
    label: catalogPrimaryWorkbenchCopyLabels.importAlreadyRunning,
    reason: "A durable import, reapply, or replay job is already active for this context.",
    nextStep: "Monitor, cancel, or let the active job finish before starting another provider pull.",
    supportTarget: "import-to-promotion",
    group: "job",
  }),
  "concurrent-job": copy({
    label: catalogPrimaryWorkbenchCopyLabels.concurrentJobsDetected,
    reason: "More than one active job could write overlapping Source Observation evidence.",
    nextStep: "Use import job monitoring to settle or cancel the duplicate job before retrying.",
    supportTarget: "import-to-promotion",
    group: "job",
  }),
  "missing-active-profile": copy({
    label: catalogPrimaryWorkbenchCopyLabels.activeProfileMissing,
    reason: "Provider import needs an active provider profile snapshot.",
    nextStep: "Activate a typed provider profile, then return to Pull provider data.",
    supportTarget: "profile-authoring",
    group: "profile",
  }),
  "profile-version-missing": copy({
    label: catalogPrimaryWorkbenchCopyLabels.profileVersionMissing,
    reason: "The command needs a specific active or source profile version.",
    nextStep: "Open lifecycle recovery with this provider and choose the correct profile version.",
    supportTarget: "lifecycle-recovery",
    group: "profile",
  }),
  "missing-fixture-coverage": copy({
    label: catalogPrimaryWorkbenchCopyLabels.fixtureCoverageMissing,
    reason: "The provider profile is missing required fixture evidence for safe import.",
    nextStep: "Run fixture validation for the provider profile, then return to the blocked import.",
    supportTarget: "validation-readiness",
    group: "fixture",
  }),
  "fixture-validation-blocked": copy({
    label: catalogPrimaryWorkbenchCopyLabels.fixtureValidationBlocked,
    reason: "Fixture or dry-run validation failed for the active provider profile.",
    nextStep: "Open validation readiness, fix the failing section, and rerun validation.",
    supportTarget: "validation-readiness",
    group: "fixture",
  }),
  "provider-credential-missing": copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerCredentialMissing,
    reason: "This provider requires credentials before payload acquisition can run.",
    nextStep: "Configure the provider credential in adapter readiness, then retry the provider pull.",
    supportTarget: "adapter-readiness",
    group: "credential",
  }),
  "provider-credential-invalid": copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerCredentialInvalid,
    reason: "The provider credential was rejected or revoked.",
    nextStep: "Replace the credential in adapter readiness before retrying import.",
    supportTarget: "adapter-readiness",
    group: "credential",
  }),
  "provider-credential-expired": copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerCredentialExpired,
    reason: "The provider credential has expired and cannot acquire payloads.",
    nextStep: "Refresh the credential in adapter readiness, then pull provider data again.",
    supportTarget: "adapter-readiness",
    group: "credential",
  }),
  "provider-transport-rate-limited": catalogPrimaryWorkbenchProviderTransportCopy["rate-limit"],
  "provider-transport-throttled": catalogPrimaryWorkbenchProviderTransportCopy.throttle,
  "provider-transport-quota-exceeded": catalogPrimaryWorkbenchProviderTransportCopy.quota,
  "provider-transport-timeout": catalogPrimaryWorkbenchProviderTransportCopy.timeout,
  "provider-transport-pagination-failure": catalogPrimaryWorkbenchProviderTransportCopy["pagination-failure"],
  "provider-transport-partial-data": catalogPrimaryWorkbenchProviderTransportCopy["partial-data"],
  "provider-transport-stale-cache": catalogPrimaryWorkbenchProviderTransportCopy["stale-cache"],
  "provider-transport-degraded": catalogPrimaryWorkbenchProviderTransportCopy["degraded-provider"],
  "source-projection-stale": copy({
    label: catalogPrimaryWorkbenchCopyLabels.sourceObservationProjectionStale,
    reason: "The review projection has not caught up to provider import evidence.",
    nextStep: "Open health triage for projection status, then return to the same filters.",
    supportTarget: "health-triage",
    group: "resilience",
  }),
  "read-model-degraded": copy({
    label: catalogPrimaryWorkbenchCopyLabels.readModelDegraded,
    reason: "The workbench is using partial or degraded read-model evidence.",
    nextStep: "Use health triage to confirm projection recovery before executing high-impact commands.",
    supportTarget: "health-triage",
    group: "resilience",
  }),
  "read-model-partial": copy({
    label: catalogPrimaryWorkbenchCopyLabels.readModelPartial,
    reason: "Some expected provider, job, review, or promotion evidence is unavailable.",
    nextStep: "Refresh the workbench or inspect health triage before promoting.",
    supportTarget: "health-triage",
    group: "resilience",
  }),
  "read-model-unavailable": copy({
    label: catalogPrimaryWorkbenchCopyLabels.readModelUnavailable,
    reason: "The primary workbench cannot load the required Catalog read model.",
    nextStep: "Open health triage or release evidence; commands remain unavailable until the read model returns.",
    supportTarget: "health-triage",
    group: "resilience",
  }),
  "job-not-found": copy({
    label: catalogPrimaryWorkbenchCopyLabels.jobNotFound,
    reason: "The route references a durable job that is no longer available in this context.",
    nextStep: "Return to import job monitoring and choose a current job.",
    supportTarget: "import-to-promotion",
    group: "job",
  }),
  "observation-not-found": copy({
    label: catalogPrimaryWorkbenchCopyLabels.sourceObservationNotFound,
    reason: "The selected Source Observation is not in the current provider scope or filters.",
    nextStep: "Reset review filters or pull provider data to refresh the observation set.",
    supportTarget: "import-to-promotion",
    group: "source-observation",
  }),
  "selection-empty": copy({
    label: catalogPrimaryWorkbenchCopyLabels.noObservationsSelected,
    reason: "This action needs at least one eligible Source Observation.",
    nextStep: "Select changed observations from review, then preview promotion.",
    supportTarget: "import-to-promotion",
    group: "source-observation",
  }),
  "no-promotion-eligible-observations": copy({
    label: catalogPrimaryWorkbenchCopyLabels.noPromotableObservations,
    reason: "The current selection or filter has no Source Observations eligible for promotion.",
    nextStep: "Pull provider data, adjust filters, or review rejected/already-promoted rows.",
    supportTarget: "import-to-promotion",
    group: "source-observation",
  }),
  "duplicate-conflict": copy({
    label: catalogPrimaryWorkbenchCopyLabels.duplicateEvidenceConflict,
    reason: "Promotion preview found duplicate Catalog-owned reference evidence.",
    nextStep: "Review duplicate evidence before queueing another promotion preview.",
    supportTarget: "import-to-promotion",
    group: "promotion",
  }),
  "promotion-conflict": copy({
    label: catalogPrimaryWorkbenchCopyLabels.promotionConflict,
    reason: "The command plan found conflicting Catalog Item or reference outcomes.",
    nextStep: "Review conflict evidence and queue a fresh promotion preview after resolving it.",
    supportTarget: "import-to-promotion",
    group: "promotion",
  }),
  "destructive-confirmation-required": copy({
    label: catalogPrimaryWorkbenchCopyLabels.confirmationRequired,
    reason: "The command could change or replace existing Catalog-owned facts.",
    nextStep: "Review the command plan and confirm the high-impact action before executing.",
    supportTarget: "import-to-promotion",
    group: "promotion",
  }),
  "stale-promotion-preview": copy({
    label: catalogPrimaryWorkbenchCopyLabels.stalePromotionPreview,
    reason: "The saved preview no longer matches observations, profile, rollout, permissions, or inputs.",
    nextStep: "Queue a fresh promotion preview from the current context.",
    supportTarget: "import-to-promotion",
    group: "promotion",
  }),
  "stale-replay": copy({
    label: catalogPrimaryWorkbenchCopyLabels.staleReplayCheckpoint,
    reason: "Replay or resume evidence is older than the current provider/profile context.",
    nextStep: "Open lifecycle recovery and restart from a current profile checkpoint.",
    supportTarget: "lifecycle-recovery",
    group: "job",
  }),
  "idempotency-replay": copy({
    label: catalogPrimaryWorkbenchCopyLabels.idempotencyReplayInProgress,
    reason: "A duplicate command is being protected by the durable idempotency guard.",
    nextStep: "Wait for the existing command result, then retry only if the job remains failed or stale.",
    supportTarget: "import-to-promotion",
    group: "job",
  }),
  "security-privacy-blocked": copy({
    label: catalogPrimaryWorkbenchCopyLabels.securityOrPrivacyBlocker,
    reason: "Governed provider payload or operator evidence is not safe to expose or write.",
    nextStep: "Verify redaction and governance evidence before retrying the command.",
    supportTarget: "governance-controls",
    group: "security-privacy",
  }),
  "unsupported-command": copy({
    label: catalogPrimaryWorkbenchCopyLabels.commandUnavailable,
    reason: "The rebuilt workbench does not support this command in the current context.",
    nextStep: "Return to the primary import-to-promotion flow or open release evidence if this looks wrong.",
    supportTarget: "audit-evidence",
    group: "resilience",
  }),
  "deploy-skew-unsupported-version": copy({
    label: catalogPrimaryWorkbenchCopyLabels.unsupportedDeployedVersion,
    reason: "The UI and API contracts are out of sync and fail closed.",
    nextStep: "Refresh after deployment completes or verify release evidence for the current version.",
    supportTarget: "audit-evidence",
    group: "resilience",
  }),
  "raw-json-retired": copy({
    label: catalogPrimaryWorkbenchCopyLabels.payloadEscapeHatchRemoved,
    reason: "Launch cleanup removed the old provider payload editing path.",
    nextStep: "Use typed provider profile sections and Source Observation evidence instead.",
    supportTarget: "profile-authoring",
    group: "retirement",
  }),
  "legacy-selector-retired": copy({
    label: catalogPrimaryWorkbenchCopyLabels.oldSelectorRemoved,
    reason: "Launch cleanup removed the old provider selector pattern.",
    nextStep: "Choose provider, ingestion unit, scope, and profile in the rebuilt workbench.",
    supportTarget: "import-to-promotion",
    group: "retirement",
  }),
} as const satisfies Record<CatalogPrimaryWorkbenchBlockerCategory, CatalogPrimaryWorkbenchOperatorCopy>;

export const catalogPrimaryWorkbenchActionStateCopy = {
  available: copy({
    label: catalogPrimaryWorkbenchCopyLabels.ready,
    reason: "The action has no known blockers in the current provider context.",
    nextStep: "Run the action when the provider context is correct.",
    supportTarget: "import-to-promotion",
    group: "readiness",
  }),
  disabled: copy({
    label: catalogPrimaryWorkbenchCopyLabels.needsInput,
    reason: "The action needs a selection, provider context, or fresh preview before it can run.",
    nextStep: "Complete the missing primary-path input, then try again.",
    supportTarget: "import-to-promotion",
    group: "readiness",
  }),
  denied: copy({
    label: catalogPrimaryWorkbenchCopyLabels.permissionDenied,
    reason: "The operator account cannot run this command.",
    nextStep: "Resolve the role or policy grant in governance controls.",
    supportTarget: "governance-controls",
    group: "permission",
  }),
  blocked: copy({
    label: catalogPrimaryWorkbenchCopyLabels.blocked,
    reason: "A readiness, job, rollout, transport, profile, or promotion blocker is present.",
    nextStep: "Resolve the listed blocker before running the command.",
    supportTarget: "health-triage",
    group: "readiness",
  }),
  unavailable: copy({
    label: catalogPrimaryWorkbenchCopyLabels.unavailable,
    reason: "The command is not exposed for this route, version, or provider context.",
    nextStep: "Return to the rebuilt primary workbench or verify release evidence.",
    supportTarget: "audit-evidence",
    group: "resilience",
  }),
  unsafe: copy({
    label: catalogPrimaryWorkbenchCopyLabels.unsafe,
    reason: "Security, privacy, destructive-change, or stale-preview safeguards are blocking execution.",
    nextStep: "Review governance and command-plan evidence before retrying.",
    supportTarget: "governance-controls",
    group: "security-privacy",
  }),
  degraded: copy({
    label: catalogPrimaryWorkbenchCopyLabels.degraded,
    reason: "The action can proceed only with degraded provider or read-model evidence.",
    nextStep: "Prefer resolving the degraded signal before running high-impact commands.",
    supportTarget: "health-triage",
    group: "resilience",
  }),
} as const satisfies Record<CatalogPrimaryWorkbenchActionState, CatalogPrimaryWorkbenchOperatorCopy>;

export const catalogPrimaryWorkbenchEmptyStateCopy = {
  "provider-scopes": copy({
    label: catalogPrimaryWorkbenchCopyLabels.noProviderScopesAreReadyForImport,
    reason: "The primary workbench needs an active typed provider profile and import scope.",
    nextStep: "Create or activate a provider profile, then return to Pull provider data.",
    supportTarget: "profile-authoring",
    group: "profile",
  }),
  "import-context": copy({
    label: catalogPrimaryWorkbenchCopyLabels.importContextIsIncomplete,
    reason: "A provider, ingestion unit, scope, or active profile is missing.",
    nextStep: "Choose the missing context at the top of the workbench.",
    supportTarget: "import-to-promotion",
    group: "readiness",
  }),
  "import-jobs": copy({
    label: catalogPrimaryWorkbenchCopyLabels.noDurableImportJobsForThisContext,
    reason: "No provider pull has run for the selected context yet.",
    nextStep: "Pull provider data to create durable job and Source Observation evidence.",
    supportTarget: "import-to-promotion",
    group: "job",
  }),
  "source-observations": copy({
    label: catalogPrimaryWorkbenchCopyLabels.noSourceObservationsInThisContext,
    reason: "The selected provider filters do not currently return reviewable observations.",
    nextStep: "Pull provider data or adjust filters to review changed observations.",
    supportTarget: "import-to-promotion",
    group: "source-observation",
  }),
  "promotion-eligible": copy({
    label: catalogPrimaryWorkbenchCopyLabels.noPromotableObservations,
    reason: "The current selection has no observations that can enter promotion preview.",
    nextStep: "Select changed observations or pull fresh provider data before previewing promotion.",
    supportTarget: "import-to-promotion",
    group: "promotion",
  }),
  "audit-evidence": copy({
    label: catalogPrimaryWorkbenchCopyLabels.noAuditEvidenceForThisContext,
    reason: "No primary-path action has produced auditable evidence for the selected context.",
    nextStep: "Run provider import, review, preview, or promotion to generate evidence.",
    supportTarget: "import-to-promotion",
    group: "readiness",
  }),
} as const satisfies Record<CatalogPrimaryWorkbenchEmptyStateKey, CatalogPrimaryWorkbenchOperatorCopy>;

export const catalogPrimaryWorkbenchResilienceCopy = {
  "route-load-failure": copy({
    label: catalogPrimaryWorkbenchCopyLabels.routeCouldNotLoad,
    reason: "The workbench route failed before loading provider context.",
    nextStep: "Reload the route, then verify release evidence if the route keeps failing.",
    supportTarget: "audit-evidence",
    group: "resilience",
  }),
  "api-failure": copy({
    label: catalogPrimaryWorkbenchCopyLabels.catalogApiUnavailable,
    reason: "The primary workbench API failed or returned an unavailable response.",
    nextStep: "Retry after health triage confirms the Catalog API is serving fresh read models.",
    supportTarget: "health-triage",
    group: "resilience",
  }),
  "detail-panel-failure": copy({
    label: catalogPrimaryWorkbenchCopyLabels.evidencePanelFailed,
    reason: "The detail panel could not load redacted Source Observation evidence.",
    nextStep: "Close the panel and reopen it from the same row after the review model refreshes.",
    supportTarget: "import-to-promotion",
    group: "resilience",
  }),
  "telemetry-unavailable": copy({
    label: catalogPrimaryWorkbenchCopyLabels.telemetryUnavailable,
    reason: "Instrumentation evidence is missing, so release proof may be incomplete.",
    nextStep: "Open audit evidence and verify telemetry before release signoff.",
    supportTarget: "audit-evidence",
    group: "resilience",
  }),
  "read-model-degraded": catalogPrimaryWorkbenchBlockerCopy["read-model-degraded"],
} as const satisfies Record<CatalogPrimaryWorkbenchResilienceStateKey, CatalogPrimaryWorkbenchOperatorCopy>;

export const catalogPrimaryWorkbenchCompletionCopy = {
  "provider-import-complete": copy({
    label: catalogPrimaryWorkbenchCopyLabels.providerDataPulled,
    reason: "The durable import completed for this provider context.",
    nextStep: "Review changed Source Observations and queue a promotion preview.",
    supportTarget: "import-to-promotion",
    group: "job",
  }),
  "promotion-complete": copy({
    label: catalogPrimaryWorkbenchCopyLabels.catalogPromotionComplete,
    reason: "Eligible Source Observations were promoted into Catalog Items or Catalog-owned references.",
    nextStep: "Review promotion result evidence and release audit proof.",
    supportTarget: "audit-evidence",
    group: "promotion",
  }),
  "reject-complete": copy({
    label: catalogPrimaryWorkbenchCopyLabels.observationsRejected,
    reason: "Rejected observations remain auditable and are excluded from promotion.",
    nextStep: "Continue review or pull provider data again when new facts arrive.",
    supportTarget: "import-to-promotion",
    group: "source-observation",
  }),
  "defer-complete": copy({
    label: catalogPrimaryWorkbenchCopyLabels.observationsDeferred,
    reason: "Deferred observations stay in review instead of being promoted or rejected.",
    nextStep: "Return to them after the next provider pull or filter reset.",
    supportTarget: "import-to-promotion",
    group: "source-observation",
  }),
  "reapply-complete": copy({
    label: catalogPrimaryWorkbenchCopyLabels.reapplyComplete,
    reason: "Promoted observations were reprocessed with the current active profile.",
    nextStep: "Review affected Catalog facts and promotion evidence.",
    supportTarget: "audit-evidence",
    group: "profile",
  }),
  "replay-complete": copy({
    label: catalogPrimaryWorkbenchCopyLabels.replayComplete,
    reason: "Source Observation evidence was replayed with its original source profile version.",
    nextStep: "Review replay evidence before rerunning promotion preview.",
    supportTarget: "audit-evidence",
    group: "profile",
  }),
} as const satisfies Record<CatalogPrimaryWorkbenchCompletionStateKey, CatalogPrimaryWorkbenchOperatorCopy>;

export const catalogPrimaryWorkbenchGlossaryTerms = [
  glossary(
    "Source Observation",
    "A redaction-safe Catalog-owned record of provider facts, provenance, normalized summaries, and review status.",
    "Use when operators review provider data before promotion.",
    "Do not call it raw provider data or an imported Catalog Item.",
  ),
  glossary(
    "Catalog Item",
    "The Catalog-owned product entity that promotion may create or update after preview.",
    "Use only after promotion writes Catalog-owned facts.",
    "Do not imply every Source Observation already is a Catalog Item.",
  ),
  glossary(
    "Catalog-owned reference",
    "A Catalog-managed external reference that links provider identifiers to Catalog facts.",
    "Use for promoted external references owned by Catalog.",
    "Do not call it a provider-owned reference.",
  ),
  glossary(
    "Provider profile",
    "The typed mapping and governance contract that turns provider payloads into Source Observations and command plans.",
    "Use for profile authoring, activation, reapply, and replay decisions.",
    "Do not describe it as editable payload JSON.",
  ),
  glossary(
    "Ingestion unit",
    "The provider/product-form/import-purpose unit that scopes readiness, imports, jobs, and review evidence.",
    "Use when selecting or preserving import context.",
    "Do not collapse it to provider alone.",
  ),
  glossary(
    "Provider scope",
    "The selected provider, ingestion unit, import scope, and active profile context for the primary path.",
    "Use when explaining where a pull, review, or promotion applies.",
    "Do not use all providers as an implicit fallback.",
  ),
  glossary(
    "Promotion",
    "The command that writes eligible Source Observation facts into Catalog Items or Catalog-owned references after preview.",
    "Use after a fresh command preview exists.",
    "Do not use for provider import or review-only actions.",
  ),
  glossary(
    "Reject",
    "A review decision that excludes Source Observations from promotion with an auditable reason.",
    "Use when the operator decides provider evidence should not be promoted.",
    "Do not use when the operator only wants to revisit later.",
  ),
  glossary(
    "Defer",
    "A review decision that keeps Source Observations in review for a later pull or filter reset.",
    "Use when evidence is incomplete or needs later judgment.",
    "Do not treat defer as rejection.",
  ),
  glossary(
    "Reapply",
    "A recovery workflow that reprocesses promoted observations with the current active provider profile.",
    "Use after profile changes should affect already promoted observations.",
    "Do not use for original source-profile replay.",
  ),
  glossary(
    "Replay",
    "A recovery workflow that replays Source Observation evidence with the original source profile version.",
    "Use when rebuilding or auditing original import evidence.",
    "Do not use as a shortcut for changing active mapping behavior.",
  ),
  glossary(
    "Audit evidence",
    "Redacted proof of operator actions, provider context, command safeguards, and release-signoff facts.",
    "Use for release verification and incident/recovery trails.",
    "Do not expose provider payloads or operator secrets.",
  ),
  glossary(
    "Provider transport",
    "The adapter-facing provider connectivity, throttle, quota, pagination, payload acquisition, and cache state.",
    "Use when import is blocked or degraded before Catalog semantics run.",
    "Do not merge it with profile validation or Catalog promotion conflicts.",
  ),
  glossary(
    "Rollout stop",
    "A governance control that intentionally blocks or quarantines a provider, unit, or command.",
    "Use when controls stop primary-path commands.",
    "Do not present it as a permission denial.",
  ),
  glossary(
    "Security/privacy blocker",
    "A fail-closed state caused by unsafe evidence, missing redaction, or governed data exposure risk.",
    "Use when commands or evidence cannot be shown or executed safely.",
    "Do not route operators to raw provider evidence.",
  ),
  glossary(
    "Retire",
    "Complete removal of associated code, product patterns, route/API/client behavior, tests, fixtures, screenshots, documentation, runbooks, release notes, and operator instructions.",
    "Use only when associated code, product patterns, route/API/client behavior, tests, fixtures, screenshots, documentation, runbooks, release notes, and operator instructions have been deleted.",
    "Do not use for soft deprecation, compatibility redirects, hidden support paths, aliases, shims, or preserved tests.",
  ),
] as const satisfies readonly CatalogPrimaryWorkbenchGlossaryTerm[];

export function getCatalogPrimaryWorkbenchBlockerCopy(
  blocker: CatalogPrimaryWorkbenchBlockerCategory,
): CatalogPrimaryWorkbenchOperatorCopy {
  return catalogPrimaryWorkbenchBlockerCopy[blocker];
}

export function getCatalogPrimaryWorkbenchProviderTransportCopy(
  category: CatalogPrimaryWorkbenchProviderTransportCategory,
): CatalogPrimaryWorkbenchOperatorCopy {
  return catalogPrimaryWorkbenchProviderTransportCopy[category];
}

export function catalogPrimaryWorkbenchProviderTransportSummary(
  categories: readonly CatalogPrimaryWorkbenchProviderTransportCategory[],
): string {
  return unique(categories)
    .map((category) => getCatalogPrimaryWorkbenchProviderTransportCopy(category).label)
    .join(", ");
}

export function catalogPrimaryWorkbenchHasOperatorCopyForCopyKey(copyKey: CatalogPrimaryWorkbenchCopyKey): boolean {
  return Boolean(catalogPrimaryWorkbenchCopyMessages[copyKey]);
}

function copy(input: CatalogPrimaryWorkbenchOperatorCopy): CatalogPrimaryWorkbenchOperatorCopy {
  return input;
}

function glossary(
  term: string,
  definition: string,
  useWhen: string,
  avoid: string,
): CatalogPrimaryWorkbenchGlossaryTerm {
  return { term, definition, useWhen, avoid };
}

function unique<T extends string>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
