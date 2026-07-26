export {
  decidePolicyDocument,
  evolvePolicyDocument,
  initialPolicyDocumentState,
  normalizePolicyEffectiveWindow,
  PlatformPolicyDomainError,
  type CreatePolicyDocumentCommand,
  type PolicyDocumentCommand,
  type PolicyDocumentCreatedEvent,
  type PolicyDocumentEvent,
  type PolicyDocumentRevisedEvent,
  type PolicyDocumentState,
  type PolicyDocumentStatus,
  type RevisePolicyDocumentCommand,
} from "./domain";
export {
  definePolicy,
  encodePolicyValue,
  isPolicyKey,
  type DefinePolicyConfig,
  type PolicyDefinition,
} from "./define-policy";
export {
  buildCreatePolicyDocumentCommand,
  buildRevisePolicyDocumentCommand,
  type CreatePolicyDocumentParams,
  type RevisePolicyDocumentParams,
} from "./commands";
export {
  PLATFORM_POLICY_DOCUMENTS_TABLE_NAME,
  PLATFORM_POLICY_DOCUMENT_HISTORY_TABLE_NAME,
  platformPolicySchemaSql,
} from "./schema";
export { buildPolicyDocumentProjectionHandlers, type PolicyProjectionOptions } from "./projection";
export {
  findOverlappingActivePolicyDocument,
  getPolicyDocument,
  listActivePolicyDocuments,
  listPolicyDocumentHistory,
  listPolicyRegistry,
  type PolicyDocumentHistoryRow,
  type PolicyDocumentRow,
  type PolicyDocumentWindowCheck,
  type PolicyRegistryRow,
} from "./queries";
export { createPolicyCache, type PolicyCache, type PolicyDocumentCandidate } from "./cache";
export {
  assertConsentCapablePolicyKey,
  consentActivationAuthorityStreamId,
  consentActivationGuardAppendInput,
  CONSENT_ACTIVATION_AUTHORITY_EVENT_TYPES,
  CONSENT_ACTIVATION_AUTHORITY_STREAM_PREFIX,
  ConsentActivationAuthorityError,
  decideConsentActivationAuthority,
  decodeConsentActivationAuthorityEvent,
  evolveConsentActivationAuthority,
  initialConsentActivationAuthorityState,
  readConsentActivationAuthority,
  type ActivateConsentPolicyVersionCommand,
  type ConsentActivationAuthorityCommand,
  type ConsentActivationAuthorityErrorCode,
  type ConsentActivationAuthorityEvent,
  type ConsentActivationAuthoritySnapshot,
  type ConsentActivationAuthorityState,
  type ConsentActivationEnvelope,
  type ConsentActivationGuard,
  type ConsentActivationStatus,
  type ConsentCapablePolicyRegisteredEvent,
  type ConsentCapableRegistration,
  type ConsentDeactivationEnvelope,
  type ConsentPolicyActivatedEvent,
  type ConsentPolicyActivationReplacedEvent,
  type ConsentPolicyDeactivatedEvent,
  type DeactivateConsentPolicyCommand,
  type RegisterConsentCapablePolicyCommand,
} from "./consent-activation-authority";
export {
  createPolicyResolver,
  type CreatePolicyResolverOptions,
  type PolicyResolver,
  type ResolvedPolicy,
} from "./resolver";
export { createPolicyRuntime, type PolicyRuntime, type PolicyRuntimeDeps } from "./runtime";
