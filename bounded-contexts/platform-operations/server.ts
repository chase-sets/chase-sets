import {
  activeWorkerCount,
  buildAttentionItems,
  buildProjectionRepairQueue,
  normalizeProjectionOperationsSnapshot,
  staleWorkerCount,
} from "./features/projection-operations/read-model/contracts";
import {
  buildWakeAttentionItems,
  normalizeWakeStatusSnapshot,
} from "./features/projection-operations/read-model/wake-status-contracts";

export function deriveProjectionTriage(body: unknown) {
  const snapshot = normalizeProjectionOperationsSnapshot(body);
  return {
    attentionItems: buildAttentionItems(snapshot),
    repairQueue: buildProjectionRepairQueue(snapshot),
    activeWorkerCount: activeWorkerCount(snapshot),
    staleWorkerCount: staleWorkerCount(snapshot),
  } as const;
}

export function deriveWakeAttentionItems(body: unknown) {
  return buildWakeAttentionItems(normalizeWakeStatusSnapshot(body));
}

export type {
  PlatformFeedbackDetail,
  PlatformFeedbackListItem,
  PlatformFeedbackMetrics,
  PlatformFeedbackPromptEligibility,
} from "./features/platform-feedback/api/contracts";
export type {
  ReportedContentModerationAction,
  ReportedContentQueueDetail,
  ReportedContentQueueItem,
  ReportedContentQueueMetrics,
} from "./features/reported-content/api/contracts";
export type {
  RiskAlertAction,
  RiskAlertQueueDetail,
  RiskAlertQueueItem,
  RiskAlertQueueMetrics,
} from "./features/risk-alerts/api/contracts";
export { createExperienceRequestApiClient } from "./support/request-support/api-client";
export { createReportedContentRequestApiClient } from "./support/request-support/reported-content-client";
export { createRiskAlertRequestApiClient } from "./support/request-support/risk-alert-client";
export {
  platformFeedbackPlacementContract,
  platformFeedbackPlacementContracts,
  platformFeedbackWorkflowFromSearchParams,
} from "./features/platform-feedback/domain/placement-contract";
export type {
  PlatformFeedbackPlacementContract,
  PlatformFeedbackPlacementKey,
} from "./features/platform-feedback/domain/placement-contract";
export type {
  PlatformFeedbackRelatedEntity,
  PlatformFeedbackTopic,
  PlatformFeedbackWorkflow,
} from "./features/platform-feedback/domain/common";
export { createSupportRequestApiClient } from "./support/request-support/support-request-api-client";
export {
  openSupportEvidenceCanonicalizer,
  createSupportEvidenceCanonicalizationQueue,
} from "./features/support-requests/api/evidence-canonicalization";
export type { SupportRequestDetail } from "./support/request-support/support-request-api-client";
export {
  attachmentOperationStreamId,
  createAttachmentManifest,
} from "./features/support-requests/domain/attachment-operation";
export {
  assertSupportEvidenceCleanupCapability,
  parseSupportEvidenceCleanupBinding,
  SUPPORT_EVIDENCE_CLEANUP_RUNNER,
} from "./features/support-requests/api/attachment-cleanup";
export type {
  SupportEvidenceCleanupBinding,
  SupportEvidenceCleanupCapability,
  SupportEvidenceCleanupRunResult,
  SupportEvidenceCleanupStorage,
} from "./features/support-requests/api/attachment-cleanup";
export type { PlatformOperationsHostPorts, PlatformOperationsServices } from "./support/runtime-support/services";
export {
  createNoopRateLimitPolicyResolver,
  createRateLimitPolicyResolver,
} from "./features/rate-limit-policy/api/rate-limit-policy-resolver";
export { rateLimitPolicy } from "./features/rate-limit-policy/domain/rate-limit-policy";
export { supportDeadlinePolicy } from "./features/support-requests/domain/support-deadline-policy";
export { createSupportEvidenceSeedContext } from "./features/support-requests/domain/common";
export { platformRemedyPolicy } from "./features/support-requests/domain/platform-remedy-policy";
export type {
  PolicyConsoleCrossContextPort,
  PolicyConsoleCrossContextSource,
  PolicyConsoleWritePort,
} from "./features/policy-console/api/contracts";
export type {
  SupportReferenceLookupCrossContextPort,
  SupportReferenceLookupResult,
  SupportReferenceLookupSource,
} from "./features/support-reference-lookup/api/contracts";
export type {
  OpsGmvSeriesPoint,
  OpsGranularity,
  OpsKpiSummary,
  OpsLiquiditySummary,
  OpsMarketAnalyticsCrossContextPort,
  OpsTopCatalogItem,
} from "./features/insights-dashboards/api/ops-contracts";
export type {
  OfferEconomicsCrossContextPort,
  OfferEconomicsLockedFeeCohortSummary,
  OfferEconomicsPlatformGmvSummary,
  OfferEconomicsSellerCohortGmvSummary,
  OfferEconomicsSellerCohortWeeklyGmvPoint,
  OfferEconomicsStandardScheduleTerms,
} from "./features/offer-economics/api/offer-economics-contracts";
export type { OfferEconomicsSnapshot } from "./features/offer-economics/read-model/offer-economics-policy";
export type { ProviderConnectionsCrossContextPort } from "./features/provider-connections/api/contracts";
