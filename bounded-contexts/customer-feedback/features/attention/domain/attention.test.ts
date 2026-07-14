import { describe, expect, it } from "vitest";
import { transactionalCsatV1 } from "../../csat/domain/survey";
import type { CsatSurveySubmittedEvent } from "../../csat/domain/invitation";
import {
  decideFeedbackCase,
  evolveFeedbackCase,
  initialFeedbackCaseState,
} from "../../cases/domain/feedback-case-decider";
import { buildFeedbackAttentionDigest, classifyFeedbackAttention, feedbackCaseSlaState } from "./attention";

const manager = { actorId: "usr_manager", authority: "manage-feedback-cases" } as const;
const submission = {
  eventSchemaVersion: 1,
  invitationId: "csatinv_attention" as never,
  surveyVersion: transactionalCsatV1.id,
  rating: 1,
  comment: "must not be copied",
  followUpConsent: true,
  followUpConsentVersion: "feedback-follow-up-v1",
  followUpConsentAt: "2026-07-13T12:00:00.000Z",
  submissionIdempotencyKey: "attention-submission",
  submittedAt: "2026-07-13T12:00:00.000Z",
} satisfies CsatSurveySubmittedEvent["data"];

describe("feedback attention policy", () => {
  it("classifies only ratings one and two under the versioned launch rule", () => {
    expect(classifyFeedbackAttention(1)).toMatchObject({ requiresAttention: true, ruleVersion: "low-score-v1" });
    expect(classifyFeedbackAttention(2).requiresAttention).toBe(true);
    expect(classifyFeedbackAttention(3).requiresAttention).toBe(false);
  });

  it("raises one explainable attention event and deduplicates digest entries", () => {
    const events = decideFeedbackCase(initialFeedbackCaseState, {
      type: "OpenFeedbackCase",
      caseId: "fbcase_attention" as never,
      submission,
      openReason: "low-score",
      actor: manager,
      actedAt: "2026-07-13T12:01:00.000Z",
    });
    expect(events.filter((event) => event.type === "customer-feedback.case.attention-requested")).toHaveLength(1);
    const digest = buildFeedbackAttentionDigest(
      [
        {
          attentionId: "a1",
          caseId: "case-1",
          teamKey: "support",
          ownerId: null,
          priority: "high",
          reason: "low-score",
          dueAt: null,
          adminHref: "/support/customer-feedback/attention",
        },
        {
          attentionId: "a1",
          caseId: "case-1",
          teamKey: "support",
          ownerId: null,
          priority: "high",
          reason: "low-score",
          dueAt: null,
          adminHref: "/support/customer-feedback/attention",
        },
        {
          attentionId: "a2",
          caseId: "case-2",
          teamKey: "support",
          ownerId: null,
          priority: "urgent",
          reason: "sla-breach",
          dueAt: "2026-07-13T12:30:00.000Z",
          adminHref: "/support/customer-feedback/attention",
        },
      ],
      { start: "2026-07-13T00:00:00.000Z", end: "2026-07-14T00:00:00.000Z" },
      { maxItems: 1 },
    );
    expect(digest).toMatchObject({ capped: true });
    expect(digest.groups[0]?.items).toHaveLength(1);
    expect(digest.groups[0]?.items[0]?.attentionId).toBe("a2");
    expect(JSON.stringify(events)).not.toContain(submission.comment);
  });

  it("reports triage and manual due-date breaches without aging closed cases", () => {
    const overdue = feedbackCaseSlaState(
      {
        openedAt: "2026-07-13T12:00:00.000Z",
        priority: "urgent",
        triagedAt: null,
        dueAt: null,
        status: "new",
        closedAt: null,
      },
      "2026-07-13T13:01:00.000Z",
    );
    expect(overdue).toMatchObject({ breach: "triage", overdue: true });
    const closed = feedbackCaseSlaState(
      {
        openedAt: "2026-07-13T12:00:00.000Z",
        priority: "urgent",
        triagedAt: null,
        dueAt: null,
        status: "closed",
        closedAt: "2026-07-13T12:05:00.000Z",
      },
      "2026-07-14T13:01:00.000Z",
    );
    expect(closed).toMatchObject({ breach: null, overdue: false });
  });
});

describe("consented follow-up delivery state", () => {
  it("rejects delivery requests without affirmative consent", () => {
    const noConsent = {
      ...submission,
      followUpConsent: false,
      followUpConsentAt: null,
    } satisfies CsatSurveySubmittedEvent["data"];
    const opened = decideFeedbackCase(initialFeedbackCaseState, {
      type: "OpenFeedbackCase",
      caseId: "fbcase_no_consent" as never,
      submission: noConsent,
      openReason: "low-score",
      actor: manager,
      actedAt: "2026-07-13T12:01:00.000Z",
    });
    const openedState = opened.reduce(evolveFeedbackCase, initialFeedbackCaseState);
    const triaged = decideFeedbackCase(openedState, {
      type: "TriageFeedbackCase",
      actor: manager,
      actedAt: "2026-07-13T12:02:00.000Z",
    });

    expect(() =>
      decideFeedbackCase(triaged.reduce(evolveFeedbackCase, openedState), {
        type: "RequestFeedbackCaseFollowUp",
        consentVersion: "feedback-follow-up-v1",
        recipientAccountId: "acc_customer",
        actor: manager,
        actedAt: "2026-07-13T12:03:00.000Z",
      }),
    ).toThrow("affirmative consent");
  });

  it("keeps delivery pending only when the requested recipient is present", () => {
    const opened = decideFeedbackCase(initialFeedbackCaseState, {
      type: "OpenFeedbackCase",
      caseId: "fbcase_delivery" as never,
      submission,
      openReason: "low-score",
      actor: manager,
      actedAt: "2026-07-13T12:01:00.000Z",
    });
    const openedState = opened.reduce(evolveFeedbackCase, initialFeedbackCaseState);
    const triaged = decideFeedbackCase(openedState, {
      type: "TriageFeedbackCase",
      actor: manager,
      actedAt: "2026-07-13T12:02:00.000Z",
    });
    const requested = decideFeedbackCase(triaged.reduce(evolveFeedbackCase, openedState), {
      type: "RequestFeedbackCaseFollowUp",
      consentVersion: "feedback-follow-up-v1",
      recipientAccountId: "acc_customer",
      actor: manager,
      actedAt: "2026-07-13T12:03:00.000Z",
    }).reduce(evolveFeedbackCase, triaged.reduce(evolveFeedbackCase, openedState));
    expect(requested.feedbackCase).toMatchObject({ followUpStatus: "requested", followUpDeliveryStatus: "pending" });
    const sent = decideFeedbackCase(requested, {
      type: "MarkFeedbackCaseFollowUpSent",
      deliveryReference: "delivery_1",
      actor: manager,
      actedAt: "2026-07-13T12:04:00.000Z",
    }).reduce(evolveFeedbackCase, requested);
    expect(sent.feedbackCase).toMatchObject({
      followUpDeliveryStatus: "sent",
      followUpDeliveryReference: "delivery_1",
    });
  });
});
