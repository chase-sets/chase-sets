import { describe, expect, it } from "vitest";
import type { CsatOutcomeFactV1 } from "./outcome-fact";
import {
  decideCsatInvitation,
  evolveCsatInvitation,
  initialCsatInvitationState,
  type CsatInvitationAggregateState,
  type CsatInvitationCommand,
} from "./invitation-decider";
import type { CustomerFeedbackInvitationEvent } from "./invitation";
import type { CsatSamplingPolicyV1 } from "./sampling";
import { transactionalCsatV1 } from "./survey";

const publicReference = "csatref_123e4567-e89b-42d3-a456-426614174000" as const;
const fact: CsatOutcomeFactV1 = {
  factSchemaVersion: 1,
  outcomeCode: "checkout.completed",
  sourceContext: "checkout",
  subjectAccountId: "acc_subject",
  subjectKind: "buyer",
  subject: { entityType: "checkout-session", entityId: "chk_source" },
  outcomeOccurredAt: "2026-07-13T10:00:00.000Z",
  idempotencyKey: "checkout.completed:chk_source",
  correlationId: "trace_checkout",
};
const policy: CsatSamplingPolicyV1 = {
  policySchemaVersion: 1,
  policyId: "checkout-csat.v1",
  outcomeCode: "checkout.completed",
  surveyVersion: transactionalCsatV1.id,
  issuanceEnabled: true,
  sampleRate: 1,
  cohortKey: "checkout-completion",
  perSubjectCooldown: "P30D",
  invitationTtl: "P7D",
  dependsOnBetaCohorts: false,
};

function evaluateCommand(
  overrides: Partial<Extract<CsatInvitationCommand, { type: "EvaluateCsatOutcomeFact" }>> = {},
): Extract<CsatInvitationCommand, { type: "EvaluateCsatOutcomeFact" }> {
  return {
    type: "EvaluateCsatOutcomeFact",
    invitationId: "csatinv_01" as never,
    publicReference,
    fact,
    policy,
    controls: { subjectEligible: true, consentAllowed: true, trafficKind: "customer", lastIssuedAt: null },
    evaluatedAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

function apply(
  state: CsatInvitationAggregateState,
  events: readonly CustomerFeedbackInvitationEvent[],
): CsatInvitationAggregateState {
  return events.reduce(evolveCsatInvitation, state);
}

function issuedState(): CsatInvitationAggregateState {
  return apply(initialCsatInvitationState, decideCsatInvitation(initialCsatInvitationState, evaluateCommand()));
}

function authority(actedAt: string) {
  return {
    publicReference,
    subjectAccountId: "acc_subject",
    surveyVersion: transactionalCsatV1.id,
    actedAt,
  } as const;
}

describe("CSAT invitation aggregate", () => {
  it("records eligibility, authoritative provenance, persisted sampling, and an opaque public reference", () => {
    const events = decideCsatInvitation(initialCsatInvitationState, evaluateCommand());
    const state = apply(initialCsatInvitationState, events);

    expect(events.map((event) => event.type)).toEqual([
      "customer-feedback.invitation.eligible",
      "customer-feedback.invitation.issued",
    ]);
    expect(state.invitation).toMatchObject({
      invitationId: "csatinv_01",
      publicReference,
      state: "issued",
      subjectAccountId: fact.subjectAccountId,
      samplingPolicySchemaVersion: 1,
      samplingDecision: {
        policyId: policy.policyId,
        policySchemaVersion: 1,
        included: true,
        reason: "included",
      },
      provenance: {
        outcomeCode: fact.outcomeCode,
        sourceContext: fact.sourceContext,
        subject: fact.subject,
        outcomeIdempotencyKey: fact.idempotencyKey,
        correlationId: fact.correlationId,
      },
    });
    expect(state.invitation?.publicReference).not.toBe(state.invitation?.invitationId);
    expect(state.invitation?.expiresAt).toBe("2026-07-20T12:00:00.000Z");
  });

  it("replays deterministically and ignores at-least-once delivery of the same outcome fact", () => {
    const firstEvents = decideCsatInvitation(initialCsatInvitationState, evaluateCommand());
    const replayed = apply(initialCsatInvitationState, firstEvents);

    expect(apply(initialCsatInvitationState, firstEvents)).toEqual(replayed);
    expect(decideCsatInvitation(replayed, evaluateCommand())).toEqual([]);
  });

  it("rejects arbitrary outcome codes and mismatched source-context provenance", () => {
    const arbitrary = { ...fact, outcomeCode: "client.claimed" as never };
    expect(() => decideCsatInvitation(initialCsatInvitationState, evaluateCommand({ fact: arbitrary }))).toThrowError(
      expect.objectContaining({ code: "invalid-outcome-fact" }),
    );

    const wrongOwner = { ...fact, sourceContext: "marketplace" };
    expect(() => decideCsatInvitation(initialCsatInvitationState, evaluateCommand({ fact: wrongOwner }))).toThrowError(
      expect.objectContaining({ code: "invalid-outcome-fact" }),
    );

    const arbitraryEntity = { ...fact, subject: { entityType: "client-route", entityId: "/admin" } };
    expect(() =>
      decideCsatInvitation(initialCsatInvitationState, evaluateCommand({ fact: arbitraryEntity })),
    ).toThrowError(expect.objectContaining({ code: "invalid-outcome-fact" }));
  });

  it.each([
    ["kill switch", { policy: { ...policy, issuanceEnabled: false } }, "issuance-disabled"],
    [
      "cooldown",
      {
        controls: {
          subjectEligible: true,
          consentAllowed: true,
          trafficKind: "customer" as const,
          lastIssuedAt: "2026-07-01T00:00:00.000Z",
        },
      },
      "subject-cooldown",
    ],
    [
      "automated traffic",
      {
        controls: {
          subjectEligible: true,
          consentAllowed: true,
          trafficKind: "automated" as const,
          lastIssuedAt: null,
        },
      },
      "automated-or-test-traffic",
    ],
  ])("suppresses with structured diagnostics for %s", (_label, overrides, expectedReason) => {
    const events = decideCsatInvitation(initialCsatInvitationState, evaluateCommand(overrides));
    const state = apply(initialCsatInvitationState, events);

    expect(events.at(-1)?.type).toBe("customer-feedback.invitation.suppressed");
    expect(state.invitation?.suppressionDiagnostic).toMatchObject({
      reason: expectedReason,
      outcomeCode: fact.outcomeCode,
      policyId: policy.policyId,
      policySchemaVersion: 1,
    });
    expect(state.invitation?.publicReference).toBeNull();
  });

  it("supports presented, dismissed, then submitted and makes identical submission retries idempotent", () => {
    const issued = issuedState();
    const presented = apply(
      issued,
      decideCsatInvitation(issued, { type: "PresentCsatInvitation", ...authority("2026-07-14T00:00:00.000Z") }),
    );
    const dismissed = apply(
      presented,
      decideCsatInvitation(presented, { type: "DismissCsatInvitation", ...authority("2026-07-14T00:01:00.000Z") }),
    );
    const submission = {
      type: "SubmitCsatSurvey",
      publicReference,
      subjectAccountId: "acc_subject",
      surveyVersion: transactionalCsatV1.id,
      rating: 5,
      comment: "  Great checkout.  ",
      followUpConsent: true,
      followUpConsentVersion: "follow-up-consent.v1",
      followUpConsentAt: "2026-07-14T00:02:00.000Z",
      submissionIdempotencyKey: "submit-01",
      submittedAt: "2026-07-14T00:02:00.000Z",
    } as const;
    const submittedEvents = decideCsatInvitation(dismissed, submission);
    const submitted = apply(dismissed, submittedEvents);

    expect(submitted.invitation?.state).toBe("submitted");
    expect(submitted.acceptedSubmission?.comment).toBe("Great checkout.");
    expect(decideCsatInvitation(submitted, submission)).toEqual([]);
    expect(() => decideCsatInvitation(submitted, { ...submission, rating: 1 })).toThrowError(
      expect.objectContaining({ code: "submission-conflict" }),
    );
  });

  it("rejects tampered references, cross-account replay, stale survey versions, and submit-before-present", () => {
    const issued = issuedState();
    expect(() =>
      decideCsatInvitation(issued, {
        type: "PresentCsatInvitation",
        ...authority("2026-07-14T00:00:00.000Z"),
        publicReference: "csatref_223e4567-e89b-42d3-a456-426614174000" as never,
      }),
    ).toThrowError(expect.objectContaining({ code: "invitation-authority-mismatch" }));
    expect(() =>
      decideCsatInvitation(issued, {
        type: "PresentCsatInvitation",
        ...authority("2026-07-14T00:00:00.000Z"),
        subjectAccountId: "acc_other",
      }),
    ).toThrowError(expect.objectContaining({ code: "invitation-authority-mismatch" }));
    expect(() =>
      decideCsatInvitation(issued, {
        type: "PresentCsatInvitation",
        ...authority("2026-07-14T00:00:00.000Z"),
        surveyVersion: { ...transactionalCsatV1.id, questionVersion: "csat.q.v2" },
      }),
    ).toThrowError(expect.objectContaining({ code: "survey-version-mismatch" }));
    expect(() =>
      decideCsatInvitation(issued, {
        type: "SubmitCsatSurvey",
        publicReference,
        subjectAccountId: "acc_subject",
        surveyVersion: transactionalCsatV1.id,
        rating: 5,
        comment: null,
        followUpConsent: false,
        followUpConsentVersion: "follow-up-consent.v1",
        followUpConsentAt: null,
        submissionIdempotencyKey: "submit-01",
        submittedAt: "2026-07-14T00:00:00.000Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "invitation-not-presented" }));
  });

  it("expires at the exact boundary and rejects redemption after revocation", () => {
    const issued = issuedState();
    const expiryEvents = decideCsatInvitation(issued, {
      type: "PresentCsatInvitation",
      ...authority("2026-07-20T12:00:00.000Z"),
    });
    expect(expiryEvents[0]?.type).toBe("customer-feedback.invitation.expired");

    const revoked = apply(
      issued,
      decideCsatInvitation(issued, {
        type: "RevokeCsatInvitation",
        reason: "policy-revoked",
        revokedAt: "2026-07-14T00:00:00.000Z",
      }),
    );
    expect(() =>
      decideCsatInvitation(revoked, {
        type: "PresentCsatInvitation",
        ...authority("2026-07-14T01:00:00.000Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "invitation-not-redeemable" }));
  });
});
