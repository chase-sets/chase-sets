// Reviewed exceptions for scripts/check-structure/policy-console-registration.mjs.
//
// Every `definePolicy` declaration must be authorable in the platform policy
// console (see docs/architecture/platform-policy-conventions.md). An entry
// below is a declaration that is deliberately not registered there, with the
// reason an operator does not need the console to author it.
//
// Entry shape: { file, symbol, reason }.
//   - `file` is repo-root-relative.
//   - `symbol` is the exported constant the declaration initializes, or the
//     factory function that returns it.
//   - `reason` must name where the policy is authored instead, or why it has
//     no authoring path yet. "Not registered" is not a reason.
//
// The list ratchets: the guard fails on an entry whose declaration is gone or
// is now registered, so delete the entry in the same change.

const noChannelsConsoleSource = "No console source exists for the Channels context yet.";
const consentActivationAuthored =
  "Authored by consent activation (`activateConsentPolicyVersion`), which the console's generic revision does not replace.";
const neverResolvedEbayPolicy =
  "Never resolved, only its compiled default is read; it becomes a compiled constant in a Channels slice.";

export const policyConsoleRegistrationExceptions = [
  {
    file: "bounded-contexts/marketplace/features/listing-evidence-policy/domain/policy.ts",
    symbol: "marketplaceListingEvidencePolicy",
    reason: "Authored by its own runtime, features/listing-evidence-policy/api/runtime.ts.",
  },
  {
    file: "bounded-contexts/commercial-terms/support/runtime-support/terms-policy.ts",
    symbol: "commercialTermsSchedulePolicy",
    reason: "Factory for per-account-type schedule keys, authored on the Commercial Terms /commerce/terms surface.",
  },
  {
    file: "bounded-contexts/commercial-terms/support/runtime-support/terms-policy.ts",
    symbol: "commercialTermsAgreementPolicy",
    reason: "Factory for per-account agreement keys, authored on the Commercial Terms /commerce/terms surface.",
  },
  {
    file: "bounded-contexts/identity/features/consents/domain/terms-of-service-policy.ts",
    symbol: "identityPrivacyPolicyActiveVersionPolicy",
    reason: consentActivationAuthored,
  },
  {
    file: "bounded-contexts/identity/features/consents/domain/terms-of-service-policy.ts",
    symbol: "identitySellerAgreementActiveVersionPolicy",
    reason: consentActivationAuthored,
  },
  {
    file: "bounded-contexts/identity/features/consents/domain/terms-of-service-policy.ts",
    symbol: "identityPaymentsTermsActiveVersionPolicy",
    reason: consentActivationAuthored,
  },
  {
    file: "infrastructure/platform-policy/examples/grace-period-policy.ts",
    symbol: "gracePeriodPolicy",
    reason: "Worked example for the shared machinery, never mounted by a context.",
  },
  {
    file: "bounded-contexts/channels/features/connection-health/domain/policy.ts",
    symbol: "channelHealthPolicy",
    reason: noChannelsConsoleSource,
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/domain/policy.ts",
    symbol: "connectorTransportPolicy",
    reason: noChannelsConsoleSource,
  },
  {
    file: "bounded-contexts/channels/features/connector-feed/domain/staged-import-policy.ts",
    symbol: "tcgplayerStagedImportDispatchPolicy",
    reason: noChannelsConsoleSource,
  },
  {
    file: "bounded-contexts/channels/features/listing-composition/domain/allocation.ts",
    symbol: "channelStockAllocationBufferPolicy",
    reason: noChannelsConsoleSource,
  },
  {
    file: "bounded-contexts/channels/features/manual-sync/domain/policy.ts",
    symbol: "tcgplayerManualClaimLeasePolicy",
    reason: noChannelsConsoleSource,
  },
  {
    file: "bounded-contexts/channels/features/outbound-sync/domain/policy.ts",
    symbol: "outboundOperationBudgetPolicy",
    reason: noChannelsConsoleSource,
  },
  {
    file: "bounded-contexts/channels/features/reconciliation/domain/policy.ts",
    symbol: "channelReconciliationPolicy",
    reason: noChannelsConsoleSource,
  },
  {
    file: "bounded-contexts/channels/features/reconciliation/domain/policy.ts",
    symbol: "channelOutboundKillSwitchPolicy",
    reason: noChannelsConsoleSource,
  },
  {
    file: "bounded-contexts/channels/features/tcgplayer-csv/domain/policy.ts",
    symbol: "tcgplayerStagedImportPolicy",
    reason: noChannelsConsoleSource,
  },
  {
    file: "bounded-contexts/customer-feedback/features/privacy/domain/policy.ts",
    symbol: "customerFeedbackRetentionPolicy",
    reason: "No console source exists for the Customer Feedback context yet.",
  },
  {
    file: "bounded-contexts/channels/features/ebay-connection/domain/credential-maintenance.ts",
    symbol: "ebayCredentialMaintenancePolicy",
    reason: neverResolvedEbayPolicy,
  },
  {
    file: "bounded-contexts/channels/features/ebay-account-deletion/domain/policy.ts",
    symbol: "ebayReceiptRetentionPolicy",
    reason: neverResolvedEbayPolicy,
  },
];
