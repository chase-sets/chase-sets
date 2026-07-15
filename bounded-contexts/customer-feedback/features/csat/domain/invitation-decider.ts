import type { AggregateDecider, AggregateEvolver } from "@chase-sets/event-core";
import type { CsatOutcomeFactV1 } from "./outcome-fact";
import {
  customerFeedbackEventSchemaVersion,
  type CsatInvitation,
  type CsatInvitationId,
  type CsatInvitationPublicReference,
  type CsatRevocationReason,
  type CsatSuppressionDiagnostic,
  type CustomerFeedbackInvitationEvent,
  isCsatInvitationSourceEntityType,
} from "./invitation";
import {
  cooldownEndsAt,
  decideCsatSampling,
  invitationExpiresAt,
  validateCsatSamplingPolicy,
  type CsatSamplingDecision,
  type CsatSamplingPolicyV1,
} from "./sampling";
import { findSurveyDefinition, surveyVersionsEqual, type CsatRatingValue, type SurveyVersionId } from "./survey";
import { isProvenanceAuthoritative } from "./workflow-outcomes";
import {
  customerFeedbackPrivacyPolicyVersion,
  normalizePrivacyReason,
  type CustomerFeedbackRedactionScope,
} from "../../privacy/domain/policy";

export type CsatEligibilityControls = Readonly<{
  subjectEligible: boolean;
  consentAllowed: boolean;
  trafficKind: "customer" | "automated" | "test";
  /** Server-derived last issuance for this subject and workflow outcome. */
  lastIssuedAt: string | null;
}>;

export type EvaluateCsatOutcomeFactCommand = Readonly<{
  type: "EvaluateCsatOutcomeFact";
  invitationId: CsatInvitationId;
  publicReference: CsatInvitationPublicReference;
  fact: CsatOutcomeFactV1;
  policy: CsatSamplingPolicyV1;
  controls: CsatEligibilityControls;
  evaluatedAt: string;
}>;

type InvitationAuthority = Readonly<{
  publicReference: CsatInvitationPublicReference;
  subjectAccountId: string;
  surveyVersion: SurveyVersionId;
  actedAt: string;
}>;

export type PresentCsatInvitationCommand = Readonly<{ type: "PresentCsatInvitation" }> & InvitationAuthority;
export type DismissCsatInvitationCommand = Readonly<{ type: "DismissCsatInvitation" }> & InvitationAuthority;
export type ExpireCsatInvitationCommand = Readonly<{ type: "ExpireCsatInvitation"; expiredAt: string }>;
export type RevokeCsatInvitationCommand = Readonly<{
  type: "RevokeCsatInvitation";
  reason: CsatRevocationReason;
  revokedAt: string;
}>;
export type SubmitCsatSurveyCommand = Readonly<{
  type: "SubmitCsatSurvey";
  publicReference: CsatInvitationPublicReference;
  subjectAccountId: string;
  surveyVersion: SurveyVersionId;
  rating: CsatRatingValue;
  comment: string | null;
  followUpConsent: boolean;
  followUpConsentVersion: string;
  followUpConsentAt: string | null;
  submissionIdempotencyKey: string;
  submittedAt: string;
}>;
export type PlaceCsatResponsePrivacyHoldCommand = Readonly<{
  type: "PlaceCsatResponsePrivacyHold";
  holdId: string;
  reason: string;
  actorId: string;
  placedAt: string;
}>;
export type ReleaseCsatResponsePrivacyHoldCommand = Readonly<{
  type: "ReleaseCsatResponsePrivacyHold";
  holdId: string;
  reason: string;
  actorId: string;
  releasedAt: string;
}>;
export type RedactCsatResponseCommand = Readonly<{
  type: "RedactCsatResponse";
  scope: CustomerFeedbackRedactionScope;
  reason: string;
  actorId: string;
  idempotencyKey: string;
  redactedAt: string;
}>;

export type CsatInvitationCommand =
  | EvaluateCsatOutcomeFactCommand
  | PresentCsatInvitationCommand
  | DismissCsatInvitationCommand
  | SubmitCsatSurveyCommand
  | ExpireCsatInvitationCommand
  | RevokeCsatInvitationCommand
  | PlaceCsatResponsePrivacyHoldCommand
  | ReleaseCsatResponsePrivacyHoldCommand
  | RedactCsatResponseCommand;

type AcceptedSubmission = Readonly<{
  rating: CsatRatingValue;
  comment: string | null;
  followUpConsent: boolean;
  followUpConsentVersion: string;
  followUpConsentStatement: string;
  followUpConsentAt: string | null;
  followUpConsentSubjectAccountId: string;
  followUpConsentPurpose: "case-specific-follow-up";
  followUpConsentApplicability: "this-response-only";
  submissionIdempotencyKey: string;
}>;

export type CsatInvitationAggregateState = Readonly<{
  invitation: CsatInvitation | null;
  acceptedSubmission: AcceptedSubmission | null;
  privacyIdempotencyKeys: readonly string[];
}>;

export const initialCsatInvitationState: CsatInvitationAggregateState = {
  invitation: null,
  acceptedSubmission: null,
  privacyIdempotencyKeys: [],
};

export type CsatInvitationDecisionErrorCode =
  | "invalid-outcome-fact"
  | "invalid-policy"
  | "already-redeemed"
  | "invitation-not-found"
  | "invitation-authority-mismatch"
  | "survey-version-mismatch"
  | "invitation-not-redeemable"
  | "invitation-not-presented"
  | "invitation-not-expired"
  | "submission-conflict"
  | "invalid-submission"
  | "privacy-hold-active"
  | "privacy-hold-mismatch"
  | "invalid-privacy-command";

export class CsatInvitationDecisionError extends Error {
  readonly name = "CsatInvitationDecisionError";

  constructor(
    readonly code: CsatInvitationDecisionErrorCode,
    message: string,
    readonly diagnostics: Readonly<{ state: string | null; outcomeCode: string | null }>,
  ) {
    super(message);
  }
}

export const decideCsatInvitation: AggregateDecider<
  CsatInvitationAggregateState,
  CsatInvitationCommand,
  CustomerFeedbackInvitationEvent
> = (state, command) => {
  switch (command.type) {
    case "EvaluateCsatOutcomeFact":
      return evaluateOutcomeFact(state, command);
    case "PresentCsatInvitation": {
      const invitation = requireAuthorizedInvitation(state, command);
      if (isExpiredAt(invitation, command.actedAt)) {
        return [expiredEvent(invitation, command.actedAt)];
      }
      requireRedeemable(invitation);
      if (invitation.presentedAt !== null) {
        return [];
      }
      return [
        {
          type: "customer-feedback.invitation.presented",
          data: {
            eventSchemaVersion: customerFeedbackEventSchemaVersion,
            invitationId: invitation.invitationId,
            presentedAt: requireTimestamp(command.actedAt, "presentation timestamp"),
          },
        },
      ];
    }
    case "DismissCsatInvitation": {
      const invitation = requireAuthorizedInvitation(state, command);
      if (isExpiredAt(invitation, command.actedAt)) {
        return [expiredEvent(invitation, command.actedAt)];
      }
      requireRedeemable(invitation);
      if (invitation.dismissedAt !== null) {
        return [];
      }
      return [
        {
          type: "customer-feedback.invitation.dismissed",
          data: {
            eventSchemaVersion: customerFeedbackEventSchemaVersion,
            invitationId: invitation.invitationId,
            dismissedAt: requireTimestamp(command.actedAt, "dismissal timestamp"),
          },
        },
      ];
    }
    case "SubmitCsatSurvey":
      return submitSurvey(state, command);
    case "ExpireCsatInvitation": {
      const invitation = requireInvitation(state);
      if (["expired", "suppressed", "revoked", "submitted"].includes(invitation.state)) {
        return [];
      }
      if (!isExpiredAt(invitation, command.expiredAt)) {
        fail("invitation-not-expired", "Invitation has not reached its expiry time.", invitation);
      }
      return [expiredEvent(invitation, command.expiredAt)];
    }
    case "RevokeCsatInvitation": {
      const invitation = requireInvitation(state);
      if (invitation.state === "revoked") {
        return [];
      }
      if (["submitted", "expired", "suppressed"].includes(invitation.state)) {
        fail("invitation-not-redeemable", "Invitation can no longer be revoked.", invitation);
      }
      return [
        {
          type: "customer-feedback.invitation.revoked",
          data: {
            eventSchemaVersion: customerFeedbackEventSchemaVersion,
            invitationId: invitation.invitationId,
            reason: command.reason,
            revokedAt: requireTimestamp(command.revokedAt, "revocation timestamp"),
          },
        },
      ];
    }
    case "PlaceCsatResponsePrivacyHold": {
      const invitation = requireInvitation(state);
      const holdId = requireText(command.holdId, "Privacy hold id is required.", invitation);
      const reason = requirePrivacyReason(command.reason, invitation);
      const actorId = requireText(command.actorId, "Privacy hold actor is required.", invitation);
      if (invitation.privacyHold?.holdId === holdId) return [];
      if (invitation.privacyHold && invitation.privacyHold.releasedAt === null) {
        fail("privacy-hold-active", "A privacy hold is already active.", invitation);
      }
      return [
        {
          type: "customer-feedback.response.privacy-hold-placed",
          data: {
            eventSchemaVersion: customerFeedbackEventSchemaVersion,
            invitationId: invitation.invitationId,
            holdId,
            reason,
            actorId,
            placedAt: requireTimestamp(command.placedAt, "privacy hold timestamp"),
          },
        },
      ];
    }
    case "ReleaseCsatResponsePrivacyHold": {
      const invitation = requireInvitation(state);
      if (invitation.privacyHold?.holdId === command.holdId && invitation.privacyHold.releasedAt !== null) return [];
      if (!invitation.privacyHold || invitation.privacyHold.holdId !== command.holdId) {
        fail("privacy-hold-mismatch", "Privacy hold does not match the active hold.", invitation);
      }
      return [
        {
          type: "customer-feedback.response.privacy-hold-released",
          data: {
            eventSchemaVersion: customerFeedbackEventSchemaVersion,
            invitationId: invitation.invitationId,
            holdId: command.holdId,
            reason: requirePrivacyReason(command.reason, invitation),
            actorId: requireText(command.actorId, "Privacy hold release actor is required.", invitation),
            releasedAt: requireTimestamp(command.releasedAt, "privacy hold release timestamp"),
          },
        },
      ];
    }
    case "RedactCsatResponse": {
      const invitation = requireInvitation(state);
      const idempotencyKey = requireText(command.idempotencyKey, "Redaction idempotency key is required.", invitation);
      if (state.privacyIdempotencyKeys.includes(idempotencyKey) || scopeAlreadyRedacted(invitation, command.scope)) {
        return [];
      }
      if (invitation.privacyHold?.releasedAt === null) {
        fail("privacy-hold-active", "An active privacy hold prevents redaction.", invitation);
      }
      return [
        {
          type: "customer-feedback.response.redacted",
          data: {
            eventSchemaVersion: customerFeedbackEventSchemaVersion,
            invitationId: invitation.invitationId,
            scope: command.scope,
            reason: requirePrivacyReason(command.reason, invitation),
            actorId: requireText(command.actorId, "Redaction actor is required.", invitation),
            idempotencyKey,
            redactedAt: requireTimestamp(command.redactedAt, "redaction timestamp"),
            policyVersion: customerFeedbackPrivacyPolicyVersion,
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolveCsatInvitation: AggregateEvolver<CsatInvitationAggregateState, CustomerFeedbackInvitationEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "customer-feedback.invitation.eligible":
      return {
        invitation: {
          invitationId: event.data.invitationId,
          publicReference: null,
          surveyVersion: event.data.surveyVersion,
          provenance: event.data.provenance,
          subjectAccountId: event.data.subjectAccountId,
          subjectKind: event.data.subjectKind,
          state: "eligible",
          samplingDecision: null,
          samplingPolicySchemaVersion: null,
          eligibleAt: event.data.eligibleAt,
          issuedAt: null,
          expiresAt: null,
          presentedAt: null,
          submittedAt: null,
          dismissedAt: null,
          expiredAt: null,
          suppressedAt: null,
          revokedAt: null,
          revocationReason: null,
          suppressionDiagnostic: null,
          privacyHold: null,
          redactedScopes: [],
        },
        acceptedSubmission: null,
        privacyIdempotencyKeys: [],
      };
    case "customer-feedback.invitation.issued":
      return updateInvitation(state, {
        publicReference: event.data.publicReference,
        state: "issued",
        samplingDecision: event.data.samplingDecision,
        samplingPolicySchemaVersion: event.data.samplingPolicySchemaVersion,
        issuedAt: event.data.issuedAt,
        expiresAt: event.data.expiresAt,
      });
    case "customer-feedback.invitation.presented":
      return updateInvitation(state, { state: "presented", presentedAt: event.data.presentedAt });
    case "customer-feedback.invitation.dismissed":
      return updateInvitation(state, { state: "dismissed", dismissedAt: event.data.dismissedAt });
    case "customer-feedback.survey.submitted":
      return {
        ...updateInvitation(state, { state: "submitted", submittedAt: event.data.submittedAt }),
        acceptedSubmission: {
          rating: event.data.rating,
          comment: event.data.comment,
          followUpConsent: event.data.followUpConsent,
          followUpConsentVersion: event.data.followUpConsentVersion,
          followUpConsentStatement: event.data.followUpConsentStatement,
          followUpConsentAt: event.data.followUpConsentAt,
          followUpConsentSubjectAccountId: event.data.followUpConsentSubjectAccountId,
          followUpConsentPurpose: event.data.followUpConsentPurpose,
          followUpConsentApplicability: event.data.followUpConsentApplicability,
          submissionIdempotencyKey: event.data.submissionIdempotencyKey,
        },
      };
    case "customer-feedback.invitation.expired":
      return updateInvitation(state, { state: "expired", expiredAt: event.data.expiredAt });
    case "customer-feedback.invitation.suppressed":
      return updateInvitation(state, {
        state: "suppressed",
        samplingDecision: event.data.samplingDecision,
        samplingPolicySchemaVersion: event.data.samplingDecision.policySchemaVersion,
        suppressedAt: event.data.suppressedAt,
        suppressionDiagnostic: event.data.diagnostic,
      });
    case "customer-feedback.invitation.revoked":
      return updateInvitation(state, {
        state: "revoked",
        revokedAt: event.data.revokedAt,
        revocationReason: event.data.reason,
      });
    case "customer-feedback.response.privacy-hold-placed":
      return updateInvitation(state, {
        privacyHold: {
          holdId: event.data.holdId,
          reason: event.data.reason,
          actorId: event.data.actorId,
          placedAt: event.data.placedAt,
          releasedAt: null,
        },
      });
    case "customer-feedback.response.privacy-hold-released":
      return updateInvitation(state, {
        privacyHold: state.invitation?.privacyHold
          ? { ...state.invitation.privacyHold, releasedAt: event.data.releasedAt }
          : null,
      });
    case "customer-feedback.response.redacted": {
      const redactContent = event.data.scope !== "direct-identifiers";
      const redactIdentifiers = event.data.scope !== "response-content";
      const invitation = requireInvitation(state);
      return {
        ...updateInvitation(state, {
          subjectAccountId: redactIdentifiers ? "[redacted]" : invitation.subjectAccountId,
          provenance: redactIdentifiers
            ? {
                ...invitation.provenance,
                subject: { ...invitation.provenance.subject, entityId: "[redacted]" },
                outcomeIdempotencyKey: "[redacted]",
                correlationId: null,
              }
            : invitation.provenance,
          redactedScopes: [...invitation.redactedScopes, event.data.scope],
        }),
        acceptedSubmission: state.acceptedSubmission
          ? {
              ...state.acceptedSubmission,
              comment: redactContent ? null : state.acceptedSubmission.comment,
              followUpConsent: redactIdentifiers ? false : state.acceptedSubmission.followUpConsent,
              followUpConsentAt: redactIdentifiers ? null : state.acceptedSubmission.followUpConsentAt,
              followUpConsentSubjectAccountId: redactIdentifiers
                ? "[redacted]"
                : state.acceptedSubmission.followUpConsentSubjectAccountId,
            }
          : null,
        privacyIdempotencyKeys: [...state.privacyIdempotencyKeys, event.data.idempotencyKey],
      };
    }
    default:
      return assertNever(event);
  }
};

function evaluateOutcomeFact(
  state: CsatInvitationAggregateState,
  command: EvaluateCsatOutcomeFactCommand,
): readonly CustomerFeedbackInvitationEvent[] {
  if (state.invitation) {
    if (
      state.invitation.provenance.outcomeIdempotencyKey === command.fact.idempotencyKey &&
      state.invitation.provenance.sourceContext === command.fact.sourceContext
    ) {
      return [];
    }
    fail("already-redeemed", "Invitation aggregate already redeemed a different outcome fact.", state.invitation);
  }

  validateFact(command.fact);
  try {
    validateCsatSamplingPolicy(command.policy);
  } catch (error) {
    throw new CsatInvitationDecisionError("invalid-policy", messageOf(error), {
      state: null,
      outcomeCode: command.fact.outcomeCode,
    });
  }
  if (
    command.policy.outcomeCode !== command.fact.outcomeCode ||
    command.policy.surveyVersion.surveyKind !== "transactional-csat" ||
    !findSurveyDefinition(command.policy.surveyVersion)
  ) {
    throw new CsatInvitationDecisionError("invalid-policy", "Sampling policy does not match the redeemed outcome.", {
      state: null,
      outcomeCode: command.fact.outcomeCode,
    });
  }
  if (!/^csatref_[0-9a-f]{8}-[0-9a-f-]{27}$/.test(command.publicReference)) {
    throw new CsatInvitationDecisionError("invalid-policy", "Invitation public reference must be opaque.", {
      state: null,
      outcomeCode: command.fact.outcomeCode,
    });
  }

  const evaluatedAt = requireTimestamp(command.evaluatedAt, "eligibility timestamp");
  const samplingDecision = decideCsatSampling(command.policy, command.fact);
  const provenance = {
    outcomeCode: command.fact.outcomeCode,
    sourceContext: command.fact.sourceContext,
    subject: command.fact.subject,
    outcomeOccurredAt: command.fact.outcomeOccurredAt,
    outcomeIdempotencyKey: command.fact.idempotencyKey,
    correlationId: command.fact.correlationId ?? null,
    samplingCohortKey: samplingDecision.cohortKey,
  } as const;
  const eligible = {
    type: "customer-feedback.invitation.eligible",
    data: {
      eventSchemaVersion: customerFeedbackEventSchemaVersion,
      invitationId: command.invitationId,
      surveyVersion: command.policy.surveyVersion,
      provenance,
      subjectAccountId: command.fact.subjectAccountId,
      subjectKind: command.fact.subjectKind,
      eligibleAt: evaluatedAt,
    },
  } as const;
  const diagnostic = suppressionDiagnostic(command, samplingDecision, evaluatedAt);

  if (diagnostic) {
    return [
      eligible,
      {
        type: "customer-feedback.invitation.suppressed",
        data: {
          eventSchemaVersion: customerFeedbackEventSchemaVersion,
          invitationId: command.invitationId,
          samplingDecision,
          diagnostic,
          suppressedAt: evaluatedAt,
        },
      },
    ];
  }

  return [
    eligible,
    {
      type: "customer-feedback.invitation.issued",
      data: {
        eventSchemaVersion: customerFeedbackEventSchemaVersion,
        invitationId: command.invitationId,
        publicReference: command.publicReference,
        surveyVersion: command.policy.surveyVersion,
        provenance,
        subjectAccountId: command.fact.subjectAccountId,
        subjectKind: command.fact.subjectKind,
        samplingDecision,
        samplingPolicySchemaVersion: command.policy.policySchemaVersion,
        issuedAt: evaluatedAt,
        expiresAt: invitationExpiresAt(evaluatedAt, command.policy),
      },
    },
  ];
}

function suppressionDiagnostic(
  command: EvaluateCsatOutcomeFactCommand,
  samplingDecision: CsatSamplingDecision,
  evaluatedAt: string,
): CsatSuppressionDiagnostic | null {
  let reason: CsatSuppressionDiagnostic["reason"] | null = null;
  let cooldownUntil: string | null = null;

  if (!command.controls.subjectEligible) reason = "subject-ineligible";
  else if (!command.controls.consentAllowed) reason = "consent-revoked";
  else if (command.controls.trafficKind !== "customer") reason = "automated-or-test-traffic";
  else if (!command.policy.issuanceEnabled) reason = "issuance-disabled";
  else if (!samplingDecision.included) reason = "sampled-out";
  else if (command.controls.lastIssuedAt) {
    cooldownUntil = cooldownEndsAt(
      requireTimestamp(command.controls.lastIssuedAt, "last issuance timestamp"),
      command.policy,
    );
    if (Date.parse(evaluatedAt) < Date.parse(cooldownUntil)) reason = "subject-cooldown";
  }

  return reason
    ? {
        reason,
        outcomeCode: command.fact.outcomeCode,
        policyId: command.policy.policyId,
        policySchemaVersion: command.policy.policySchemaVersion,
        cohortKey: command.policy.cohortKey,
        cooldownUntil: reason === "subject-cooldown" ? cooldownUntil : null,
      }
    : null;
}

function submitSurvey(
  state: CsatInvitationAggregateState,
  command: SubmitCsatSurveyCommand,
): readonly CustomerFeedbackInvitationEvent[] {
  const invitation = requireAuthorizedInvitation(state, {
    publicReference: command.publicReference,
    subjectAccountId: command.subjectAccountId,
    surveyVersion: command.surveyVersion,
    actedAt: command.submittedAt,
  });
  const normalized = normalizeSubmission(command, invitation);

  if (invitation.state === "submitted") {
    if (sameSubmission(state.acceptedSubmission, normalized)) return [];
    fail("submission-conflict", "Invitation already accepted a different submission.", invitation);
  }
  if (isExpiredAt(invitation, command.submittedAt)) {
    return [expiredEvent(invitation, command.submittedAt)];
  }
  requireRedeemable(invitation);
  if (invitation.presentedAt === null) {
    fail("invitation-not-presented", "Invitation must be presented before submission.", invitation);
  }

  return [
    {
      type: "customer-feedback.survey.submitted",
      data: {
        eventSchemaVersion: customerFeedbackEventSchemaVersion,
        invitationId: invitation.invitationId,
        subjectAccountId: invitation.subjectAccountId,
        surveyVersion: invitation.surveyVersion,
        ...normalized,
        submittedAt: requireTimestamp(command.submittedAt, "submission timestamp"),
      },
    },
  ];
}

function normalizeSubmission(command: SubmitCsatSurveyCommand, invitation: CsatInvitation): AcceptedSubmission {
  const definition = findSurveyDefinition(invitation.surveyVersion);
  if (!definition || !definition.ratingScale.valueLabelKeys[command.rating]) {
    fail("invalid-submission", "Submission contains an unsupported rating.", invitation);
  }
  const comment = command.comment?.trim() || null;
  if (comment && comment.length > 2_000) {
    fail("invalid-submission", "Submission comment exceeds the supported length.", invitation);
  }
  if (!command.submissionIdempotencyKey.trim()) {
    fail("invalid-submission", "Submission requires an idempotency key.", invitation);
  }
  if (command.followUpConsentVersion !== definition.followUpConsentVersion) {
    fail("invalid-submission", "Submission follow-up consent version is stale.", invitation);
  }
  if (command.followUpConsent !== (command.followUpConsentAt !== null)) {
    fail("invalid-submission", "Follow-up consent and timestamp must agree.", invitation);
  }
  if (command.followUpConsentAt) requireTimestamp(command.followUpConsentAt, "follow-up consent timestamp");

  return {
    rating: command.rating,
    comment,
    followUpConsent: command.followUpConsent,
    followUpConsentVersion: command.followUpConsentVersion,
    followUpConsentStatement: definition.followUpConsentStatement,
    followUpConsentAt: command.followUpConsentAt,
    followUpConsentSubjectAccountId: invitation.subjectAccountId,
    followUpConsentPurpose: definition.followUpConsentPurpose,
    followUpConsentApplicability: definition.followUpConsentApplicability,
    submissionIdempotencyKey: command.submissionIdempotencyKey.trim(),
  };
}

function validateFact(fact: CsatOutcomeFactV1): void {
  if (
    fact.factSchemaVersion !== 1 ||
    !isProvenanceAuthoritative(String(fact.outcomeCode), fact.sourceContext) ||
    !fact.subjectAccountId.trim() ||
    !fact.subjectAccountId.startsWith("acc_") ||
    !fact.subject.entityType.trim() ||
    !isCsatInvitationSourceEntityType(fact.outcomeCode, fact.subject.entityType) ||
    !fact.subject.entityId.trim() ||
    !fact.idempotencyKey.trim()
  ) {
    throw new CsatInvitationDecisionError("invalid-outcome-fact", "Outcome fact failed provenance validation.", {
      state: null,
      outcomeCode: String(fact.outcomeCode || "") || null,
    });
  }
  requireTimestamp(fact.outcomeOccurredAt, "outcome occurrence timestamp");
}

function requireAuthorizedInvitation(
  state: CsatInvitationAggregateState,
  authority: InvitationAuthority,
): CsatInvitation {
  const invitation = requireInvitation(state);
  if (
    invitation.publicReference !== authority.publicReference ||
    invitation.subjectAccountId !== authority.subjectAccountId
  ) {
    fail("invitation-authority-mismatch", "Invitation authority does not match.", invitation);
  }
  if (!surveyVersionsEqual(invitation.surveyVersion, authority.surveyVersion)) {
    fail("survey-version-mismatch", "Invitation survey version does not match.", invitation);
  }
  return invitation;
}

function requireInvitation(state: CsatInvitationAggregateState): CsatInvitation {
  if (!state.invitation) {
    throw new CsatInvitationDecisionError("invitation-not-found", "Invitation does not exist.", {
      state: null,
      outcomeCode: null,
    });
  }
  return state.invitation;
}

function requireRedeemable(invitation: CsatInvitation): void {
  if (!["issued", "presented", "dismissed"].includes(invitation.state)) {
    fail("invitation-not-redeemable", "Invitation is not redeemable.", invitation);
  }
}

function isExpiredAt(invitation: CsatInvitation, actedAt: string): boolean {
  const actionTime = Date.parse(requireTimestamp(actedAt, "action timestamp"));
  return invitation.expiresAt !== null && actionTime >= Date.parse(invitation.expiresAt);
}

function expiredEvent(
  invitation: CsatInvitation,
  expiredAt: string,
): Extract<CustomerFeedbackInvitationEvent, { type: "customer-feedback.invitation.expired" }> {
  return {
    type: "customer-feedback.invitation.expired",
    data: {
      eventSchemaVersion: customerFeedbackEventSchemaVersion,
      invitationId: invitation.invitationId,
      expiredAt: requireTimestamp(expiredAt, "expiry timestamp"),
    },
  };
}

function updateInvitation(
  state: CsatInvitationAggregateState,
  updates: Partial<CsatInvitation>,
): CsatInvitationAggregateState {
  const invitation = requireInvitation(state);
  return { ...state, invitation: { ...invitation, ...updates } };
}

function sameSubmission(left: AcceptedSubmission | null, right: AcceptedSubmission): boolean {
  return (
    left !== null &&
    left.submissionIdempotencyKey === right.submissionIdempotencyKey &&
    left.rating === right.rating &&
    left.comment === right.comment &&
    left.followUpConsent === right.followUpConsent &&
    left.followUpConsentVersion === right.followUpConsentVersion &&
    left.followUpConsentStatement === right.followUpConsentStatement &&
    left.followUpConsentAt === right.followUpConsentAt &&
    left.followUpConsentSubjectAccountId === right.followUpConsentSubjectAccountId &&
    left.followUpConsentPurpose === right.followUpConsentPurpose &&
    left.followUpConsentApplicability === right.followUpConsentApplicability
  );
}

function scopeAlreadyRedacted(invitation: CsatInvitation, scope: CustomerFeedbackRedactionScope): boolean {
  if (invitation.redactedScopes.includes("all-sensitive")) return true;
  if (scope === "all-sensitive") {
    return (
      invitation.redactedScopes.includes("response-content") && invitation.redactedScopes.includes("direct-identifiers")
    );
  }
  return invitation.redactedScopes.includes(scope);
}

function requireText(value: string, message: string, invitation: CsatInvitation): string {
  const normalized = value.trim();
  if (!normalized) fail("invalid-privacy-command", message, invitation);
  return normalized;
}

function requirePrivacyReason(value: string, invitation: CsatInvitation): string {
  try {
    return normalizePrivacyReason(value);
  } catch {
    fail("invalid-privacy-command", "Privacy reason must be a stable content-free code.", invitation);
  }
}

function requireTimestamp(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new CsatInvitationDecisionError("invalid-policy", `Invalid ${label}.`, {
      state: null,
      outcomeCode: null,
    });
  }
  return value;
}

function fail(code: CsatInvitationDecisionErrorCode, message: string, invitation: CsatInvitation): never {
  throw new CsatInvitationDecisionError(code, message, {
    state: invitation.state,
    outcomeCode: invitation.provenance.outcomeCode,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid sampling policy.";
}

function assertNever(value: never): never {
  throw new Error(`Unsupported invitation command or event: ${JSON.stringify(value)}.`);
}
