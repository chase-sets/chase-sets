import type { ConsentRecordingAuthorization } from "./consent-recording-authorization";
import {
  assessConsentRecordingPublication,
  consentBundleForRecording,
  consentBundles,
  consentBundlesDeclaring,
  identityConsentPublicationCorpus,
  type ConsentBundle,
  type ConsentPublicationCorpus,
  type ConsentRecordingPublicationRefusalCode,
} from "./consent-bundle";
import type { RecordConsentCommand } from "./domain";

/**
 * The bundle half of the Consent recording admission, as a PURE rule on the
 * decider path.
 *
 * It lives here, beside the authorization rule, and runs inside
 * `decideAuthorizedConsent` rather than only inside the API runtime, because the
 * Consent decider has more than one production entrypoint: the runtime command
 * handler is one, and personal-identity registration composes the decider
 * directly. A rule proven at one entrypoint and unproven at its sibling is
 * exactly how a bounded repair leaves a reachable write path behind.
 *
 * ORDER IS PART OF THE RULE: authorization is decided first (by the caller,
 * from the shipped Consent Recording Authorization), then publication, and only
 * then -- outside this pure function, where I/O is possible -- activation. Each
 * half is decided before the next input is read, so a refusal never depends on
 * a value the previous half had already rejected.
 *
 * This composes OVER the write-path authorization; it never substitutes for it.
 * The trusted subject values compared below come from the issued authorization,
 * never from the command.
 */

export type ConsentBundleAdmissionErrorCode =
  | ConsentRecordingPublicationRefusalCode
  /** The recording's subject type is not the scope the bundle declares for that policy. */
  | "consent_bundle_scope_mismatch"
  /** The recording names a subject the authorization did not establish. */
  | "consent_bundle_subject_not_authorized";

export class ConsentBundleAdmissionError extends Error {
  public constructor(
    public readonly code: ConsentBundleAdmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConsentBundleAdmissionError";
  }
}

/**
 * Publication plus bundle-declared scope, bound to the already-authorized
 * subject. Throws a named, coded refusal; never returns a partial verdict.
 */
export function assertConsentRecordingBundleAdmission(
  command: RecordConsentCommand,
  authorization: ConsentRecordingAuthorization,
  corpus: ConsentPublicationCorpus = identityConsentPublicationCorpus,
): void {
  const publication = assessConsentRecordingPublication(command.policyKey, command.policyVersion, corpus);
  if (!publication.admitted) {
    throw new ConsentBundleAdmissionError(publication.code, publication.message);
  }

  const bundle = consentBundleForRecording(command.policyKey, command.subjectType);
  if (!bundle) {
    throw new ConsentBundleAdmissionError(
      "consent_bundle_scope_mismatch",
      `Consent for '${command.policyKey}' was offered at '${command.subjectType}' scope, but its bundle declares ${describeDeclaredScopes(command.policyKey)}.`,
    );
  }

  assertBundleSubjectIsAuthorized(command, authorization, bundle);
}

/**
 * The subject a bundle member is recorded for is the subject the consumed
 * authorization already established, at the scope the bundle declares.
 *
 * - A user-scoped member names the authorized User.
 * - An account-scoped member names the authorized Account AND captures the
 *   authorized acting User.
 *
 * Nothing here reads a subject from the command in order to decide whether it is
 * trustworthy: the command's values are only ever compared against the
 * authorization's.
 */
function assertBundleSubjectIsAuthorized(
  command: RecordConsentCommand,
  authorization: ConsentRecordingAuthorization,
  bundle: ConsentBundle,
): void {
  if (bundle.subjectType === "account") {
    if (command.accountId !== authorization.subject.accountId) {
      throw new ConsentBundleAdmissionError(
        "consent_bundle_subject_not_authorized",
        `An account-scoped '${bundle.bundleKey}' Consent must name the authorized Account.`,
      );
    }
    if (command.userId !== authorization.subject.userId) {
      throw new ConsentBundleAdmissionError(
        "consent_bundle_subject_not_authorized",
        `An account-scoped '${bundle.bundleKey}' Consent must capture the authorized acting User.`,
      );
    }
    return;
  }

  if (command.userId !== authorization.subject.userId) {
    throw new ConsentBundleAdmissionError(
      "consent_bundle_subject_not_authorized",
      `A user-scoped '${bundle.bundleKey}' Consent must name the authorized User.`,
    );
  }
  if (command.accountId !== undefined && command.accountId !== authorization.subject.accountId) {
    throw new ConsentBundleAdmissionError(
      "consent_bundle_subject_not_authorized",
      `A user-scoped '${bundle.bundleKey}' Consent must carry the authorized Account context.`,
    );
  }
}

function describeDeclaredScopes(policyKey: string): string {
  const scopes = consentBundlesDeclaring(policyKey).map(
    (bundleKey) => `'${bundleKey}' at ${consentBundles[bundleKey].subjectType} scope`,
  );
  return scopes.length === 0 ? "no bundle scope" : scopes.join(" and ");
}
