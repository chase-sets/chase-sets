import type { ConsentActivationGuard } from "@chase-sets/platform-policy/consent-activation-authority";
import {
  consentBundleMemberActivationPolicyKey,
  type ConsentActivationAuthorityReader,
} from "../domain/consent-bundle";
import { isIdentityConsentPolicyKey } from "../domain/terms-of-service-policy";
import type { RecordConsentCommand } from "../domain/domain";

/**
 * The activation half of the Consent recording admission -- the half that needs
 * I/O, and therefore the half that cannot live in the decider.
 *
 * It runs strictly AFTER the authorization and publication halves have already
 * decided, and strictly BEFORE the append it guards. The guard token it returns
 * is minted by the same authority read that produced the activation state, so
 * the pair can never describe two different moments, and it is carried into the
 * append transaction as a zero-event participant: if the authority moves between
 * this read and the commit, the whole transaction rolls back and nothing is
 * written.
 */

export type ConsentActivationAdmissionErrorCode =
  /** The key is consent-activatable but its authority does not report it active. */
  | "consent_policy_not_activated"
  /** The authority is active at a different version than the one being recorded. */
  | "consent_policy_activation_version_mismatch"
  /** The authority snapshot could not be trusted, or the key is outside the bundle registry. */
  | "consent_policy_activation_unresolved";

export class ConsentActivationAdmissionError extends Error {
  public constructor(
    public readonly code: ConsentActivationAdmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConsentActivationAdmissionError";
  }
}

/**
 * Reads the member's Consent Activation Authority once and returns the guard the
 * append must carry. Throws a named, coded refusal rather than returning a
 * nullable guard, so no caller can proceed with an absent one.
 */
export async function admitConsentRecordingActivation(
  command: RecordConsentCommand,
  readAuthority: ConsentActivationAuthorityReader,
): Promise<ConsentActivationGuard> {
  if (!isIdentityConsentPolicyKey(command.policyKey)) {
    // Unreachable through the decider, which refuses a non-member key first.
    // Kept as an explicit refusal so this function is safe in isolation too.
    throw new ConsentActivationAdmissionError(
      "consent_policy_activation_unresolved",
      `Policy '${command.policyKey}' has no Consent Activation Authority because no bundle declares it.`,
    );
  }

  const activationPolicyKey = consentBundleMemberActivationPolicyKey(command.policyKey);
  const snapshot = await readAuthority(activationPolicyKey);

  if (snapshot.policyKey !== activationPolicyKey || snapshot.guard?.policyKey !== activationPolicyKey) {
    throw new ConsentActivationAdmissionError(
      "consent_policy_activation_unresolved",
      `The activation authority snapshot for '${activationPolicyKey}' does not name the key it was read for.`,
    );
  }
  if (!snapshot.isActive) {
    throw new ConsentActivationAdmissionError(
      "consent_policy_not_activated",
      `The Consent Activation Authority for '${activationPolicyKey}' is ${snapshot.status}; '${command.policyKey}' cannot carry a recorded acceptance.`,
    );
  }
  if (snapshot.activeVersion !== command.policyVersion) {
    throw new ConsentActivationAdmissionError(
      "consent_policy_activation_version_mismatch",
      `Consent for '${command.policyKey}' was offered at '${command.policyVersion}' while the activation authority is active at '${String(snapshot.activeVersion)}'.`,
    );
  }

  return snapshot.guard;
}
