export { channelsServicesMembers, isChannelsServices, type ChannelsServices } from "./support/runtime-support/services";
export type { ChannelStorageLocationAuthorityResolver } from "./features/connections/domain/contracts";
export { parseChannelCredentialKeyring, assertKeyringContinuity } from "./features/credentials/domain/codecs";
export {
  ChannelCredentialError,
  type ChannelCredentialKeyring,
  type ChannelCredentialEnvelope,
  type ChannelOAuthTokenSet,
} from "./features/credentials/domain/contracts";
export type {
  ChannelCredentialServices,
  ChannelCredentialBinding,
  ChannelCredentialExpectation,
  ChannelCredentialCapabilityBinding,
} from "./features/credentials/api/runtime";
export type {
  ConnectionHealthServices,
  ChannelHealthObservation,
  ChannelHealthRead,
  ChannelHealthChanged,
  ChannelHealthReasonGeneration,
} from "./features/connection-health/domain/contracts";
export { deriveChannelHealthSourceWorkId } from "./features/connection-health/domain/identity";
export {
  decodeChannelHealthObservation,
  decodeChannelHealthChanged,
  decodeChannelHealthRead,
} from "./features/connection-health/domain/codecs";
export { channelHealthPolicy } from "./features/connection-health/domain/policy";
export {
  OutboundSyncError,
  type ClaimedOperationClaimant,
  type ClaimedOperationOutcome,
  type ClaimedOperationReservation,
  type ClaimedOutboundOperation,
  type EnqueueOutboundReconciliationRepair,
  type OutboundOperationLogItem,
  type OutboundOperationLogPage,
  type OutboundOperationSummary,
  type OutboundSyncServices,
} from "./features/outbound-sync/domain/contracts";
export { createChannelReconciliationRuntime, readChannelOutboundHold } from "./features/reconciliation/api/runtime";
export { classifyChannelDrift } from "./features/reconciliation/domain/classification";
export { mapChannelDriftToHealthObservation } from "./features/reconciliation/domain/health";
export {
  channelDriftClassifications,
  type AcceptChannelDrift,
  type AcceptedChannelDrift,
  type ChannelDriftAttentionContribution,
  type ChannelDriftClassification,
  type ChannelDriftDecision,
  ChannelDriftError,
  type ChannelDriftDetail,
  type ChannelDriftDetailRow,
  type ChannelDriftObservationV1,
  type ChannelDriftObservation,
  type ChannelObservedMaterial,
  type ClaimedChannelStateRead,
  type ChannelHealthObservationV1,
  type ChannelHealthObservationIdentity,
  type ChannelOutboundHold,
  type ChannelOutboundHoldSource,
  type ChannelReconciliationCounts,
  type ChannelReconciliationMetrics,
  type ChannelReconciliationRunResult,
  type ChannelReconciliationRuntimeDependencies,
  type ChannelReconciliationServices,
  type RepushChannelListing,
} from "./features/reconciliation/domain/contracts";
export {
  CHANNEL_OUTBOUND_KILL_SWITCH_FALLBACK,
  CHANNEL_RECONCILIATION_POLICY_FALLBACK,
  channelOutboundKillSwitchPolicy,
  channelReconciliationPolicy,
  decodeChannelOutboundKillSwitchPolicy,
  decodeChannelReconciliationPolicy,
  type ChannelOutboundKillSwitchPolicyValue,
  type ChannelReconciliationPolicyValue,
} from "./features/reconciliation/domain/policy";
export {
  channelExternalSaleUnmappableReasons,
  resolveChannelExternalSaleTarget,
  type ChannelExternalSaleTarget,
  type ChannelExternalSaleUnmappableReason,
} from "./features/reconciliation/read-model/sale-target";
export { createChannelActionAttentionSourceFromReadModel } from "./features/connection-attention/read-model/attention-source";
export type {
  ConnectionAttentionServices,
  ChannelAttentionFact,
  ChannelAttentionResolve,
  ChannelConnectionAttention,
} from "./features/connection-attention/domain/contracts";
export {
  decodeChannelAttentionFact,
  decodeChannelAttentionResolve,
} from "./features/connection-attention/domain/codecs";
