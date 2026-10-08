import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { encodePolicyValue } from "@chase-sets/platform-policy/define-policy";
import {
  decodeStagingProofPolicy,
  requireProof,
  STAGING_PROOF_DOCUMENT,
  stagingProofCreditPolicy,
} from "../domain/staging-proof-credit";

/** Settlement's console write boundary. The generic policy runtime does not own the immutable pin. */
export function guardStagingProofPolicy(base: PolicyRuntime): PolicyRuntime {
  const isProof = (key: string) => key === stagingProofCreditPolicy.policyKey;
  const guarded: PolicyRuntime = {
    ...base,
    async commandHandler(input) {
      requireProof(
        input.streamId !== `platform-policy.document-${STAGING_PROOF_DOCUMENT}` &&
          !(input.command.type === "CreatePolicyDocument" && isProof(input.command.policyKey)),
        "proof_policy_write_boundary_required",
      );
      return base.commandHandler(input);
    },
    async createPolicyDocument(definition, params, context) {
      if (!isProof(definition.policyKey)) return base.createPolicyDocument(definition, params, context);
      decodeStagingProofPolicy(encodePolicyValue(params.value));
      // The console calls create when its projection has no active document (including expiry).
      // Retain the fixed document rather than minting replacement authority from that stale read.
      const existing = await base.readPolicyDocumentState(STAGING_PROOF_DOCUMENT);
      if (existing.version > 0)
        return guarded.revisePolicyDocument(definition, STAGING_PROOF_DOCUMENT, params, context, {
          expectedVersion: existing.version,
        });
      return base.createPolicyDocumentWithId(
        stagingProofCreditPolicy,
        STAGING_PROOF_DOCUMENT,
        { ...params, value: decodeStagingProofPolicy(encodePolicyValue(params.value)) },
        context,
      );
    },
    async createPolicyDocumentWithId(definition, documentId, params, context) {
      requireProof(documentId !== STAGING_PROOF_DOCUMENT || isProof(definition.policyKey), "proof_policy_invalid");
      if (!isProof(definition.policyKey))
        return base.createPolicyDocumentWithId(definition, documentId, params, context);
      requireProof(documentId === STAGING_PROOF_DOCUMENT, "proof_policy_replacement_refused");
      return base.createPolicyDocumentWithId(
        stagingProofCreditPolicy,
        documentId,
        { ...params, value: decodeStagingProofPolicy(encodePolicyValue(params.value)) },
        context,
      );
    },
    async revisePolicyDocument(definition, documentId, params, context, options) {
      requireProof(documentId !== STAGING_PROOF_DOCUMENT || isProof(definition.policyKey), "proof_policy_invalid");
      if (!isProof(definition.policyKey))
        return base.revisePolicyDocument(definition, documentId, params, context, options);
      requireProof(documentId === STAGING_PROOF_DOCUMENT, "proof_policy_replacement_refused");
      const { state, version } = await base.readPolicyDocumentState(STAGING_PROOF_DOCUMENT);
      requireProof(
        state.documentId === STAGING_PROOF_DOCUMENT && isProof(state.policyKey ?? ""),
        "proof_policy_invalid",
      );
      const before = decodeStagingProofPolicy(state.value);
      const after = decodeStagingProofPolicy(encodePolicyValue(params.value));
      requireProof(
        before.proofAccountId === null || before.proofAccountId === after.proofAccountId,
        "proof_pin_immutable",
      );
      requireProof(
        options?.expectedVersion === undefined || options.expectedVersion === version,
        "proof_policy_conflict",
      );
      return base.revisePolicyDocument(stagingProofCreditPolicy, documentId, { ...params, value: after }, context, {
        expectedVersion: version,
      });
    },
  };
  return guarded;
}
