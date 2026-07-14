import { describe, expect, it } from "vitest";
import { transactionalCsatV1 } from "../../csat/domain/survey";
import type { CsatSurveySubmittedEvent } from "../../csat/domain/invitation";
import {
  decideFeedbackCase,
  evolveFeedbackCase,
  initialFeedbackCaseState,
  type FeedbackCaseAggregateState,
  type FeedbackCaseCommand,
} from "./feedback-case-decider";
import type { FeedbackCaseEvent } from "./feedback-case";

const manager = { actorId: "usr_manager", authority: "manage-feedback-cases" } as const;
const viewOnly = { actorId: "usr_viewer", authority: "view-feedback-cases" } as const;
const submission = {
  eventSchemaVersion: 1,
  invitationId: "csatinv_01" as never,
  surveyVersion: transactionalCsatV1.id,
  rating: 2,
  comment: "Never copied into the case stream",
  followUpConsent: true,
  followUpConsentVersion: "feedback-follow-up-v1",
  followUpConsentAt: "2026-07-13T12:00:00.000Z",
  submissionIdempotencyKey: "submission-01",
  submittedAt: "2026-07-13T12:00:00.000Z",
} satisfies CsatSurveySubmittedEvent["data"];

function apply(state: FeedbackCaseAggregateState, command: FeedbackCaseCommand): FeedbackCaseAggregateState {
  return decideFeedbackCase(state, command).reduce(evolveFeedbackCase, state);
}

function openState(overrides: Partial<CsatSurveySubmittedEvent["data"]> = {}): FeedbackCaseAggregateState {
  return apply(initialFeedbackCaseState, {
    type: "OpenFeedbackCase",
    caseId: "fbcase_01" as never,
    submission: { ...submission, ...overrides },
    openReason: "low-score",
    actor: manager,
    actedAt: "2026-07-13T12:01:00.000Z",
  });
}

function triagedState(overrides: Partial<CsatSurveySubmittedEvent["data"]> = {}): FeedbackCaseAggregateState {
  return apply(openState(overrides), {
    type: "TriageFeedbackCase",
    actor: manager,
    actedAt: "2026-07-13T12:02:00.000Z",
  });
}

describe("feedback case replay", () => {
  it("rebuilds a complete case deterministically without copying customer comments", () => {
    let state = triagedState();
    const commands: FeedbackCaseCommand[] = [
      {
        type: "AssignFeedbackCase",
        ownerId: "usr_owner",
        actor: manager,
        actedAt: "2026-07-13T12:03:00.000Z",
      },
      {
        type: "SetFeedbackCasePriority",
        priority: "urgent",
        actor: manager,
        actedAt: "2026-07-13T12:04:00.000Z",
      },
      {
        type: "SetFeedbackCaseDueDate",
        dueAt: "2026-07-14T12:00:00.000Z",
        actor: manager,
        actedAt: "2026-07-13T12:05:00.000Z",
      },
      {
        type: "LinkFeedbackCaseWorkItem",
        workItem: { kind: "support-request", reference: "sreq_01" },
        actor: manager,
        actedAt: "2026-07-13T12:06:00.000Z",
      },
      {
        type: "RequestFeedbackCaseFollowUp",
        consentVersion: "feedback-follow-up-v1",
        actor: manager,
        actedAt: "2026-07-13T12:07:00.000Z",
      },
      {
        type: "MarkFeedbackCaseFollowUpSent",
        deliveryReference: "notification_01",
        actor: manager,
        actedAt: "2026-07-13T12:08:00.000Z",
      },
      {
        type: "RecordFeedbackCaseFollowUpOutcome",
        outcome: "resolved",
        actor: manager,
        actedAt: "2026-07-13T12:09:00.000Z",
      },
      {
        type: "SetFeedbackCaseDisposition",
        disposition: "support-resolved",
        actor: manager,
        actedAt: "2026-07-13T12:10:00.000Z",
      },
      { type: "CloseFeedbackCase", actor: manager, actedAt: "2026-07-13T12:11:00.000Z" },
    ];
    const events: FeedbackCaseEvent[] = [];
    for (const command of commands) {
      const decided = decideFeedbackCase(state, command);
      events.push(...decided);
      state = decided.reduce(evolveFeedbackCase, state);
    }

    const opening = decideFeedbackCase(initialFeedbackCaseState, {
      type: "OpenFeedbackCase",
      caseId: "fbcase_01" as never,
      submission,
      openReason: "low-score",
      actor: manager,
      actedAt: "2026-07-13T12:01:00.000Z",
    });
    const triage = decideFeedbackCase(opening.reduce(evolveFeedbackCase, initialFeedbackCaseState), {
      type: "TriageFeedbackCase",
      actor: manager,
      actedAt: "2026-07-13T12:02:00.000Z",
    });
    const replayed = [...opening, ...triage, ...events].reduce(evolveFeedbackCase, initialFeedbackCaseState);

    expect(replayed).toEqual(state);
    expect(replayed.feedbackCase).toMatchObject({
      status: "closed",
      ownerId: "usr_owner",
      priority: "urgent",
      disposition: "support-resolved",
      followUpStatus: "completed",
      followUpOutcome: "resolved",
    });
    expect(JSON.stringify([...opening, ...triage, ...events])).not.toContain(submission.comment);
  });
});

describe("feedback case disposition transitions", () => {
  it("moves new to triaged to actioned to closed and explicitly reopens at triage", () => {
    const triaged = triagedState();
    const actioned = apply(triaged, {
      type: "SetFeedbackCaseDisposition",
      disposition: "product-change",
      actor: manager,
      actedAt: "2026-07-13T12:03:00.000Z",
    });
    const closed = apply(actioned, {
      type: "CloseFeedbackCase",
      actor: manager,
      actedAt: "2026-07-13T12:04:00.000Z",
    });
    const reopened = apply(closed, {
      type: "ReopenFeedbackCase",
      actor: manager,
      actedAt: "2026-07-13T12:05:00.000Z",
    });

    expect(actioned.feedbackCase).toMatchObject({ status: "actioned", disposition: "product-change" });
    expect(closed.feedbackCase?.status).toBe("closed");
    expect(reopened.feedbackCase).toMatchObject({ status: "triaged", disposition: null, closedAt: null });
  });

  it("keeps duplicate responses in their own case and links the primary case", () => {
    const triaged = triagedState();
    const actioned = apply(triaged, {
      type: "SetFeedbackCaseDisposition",
      disposition: "duplicate",
      duplicateOfCaseId: "fbcase_primary" as never,
      actor: manager,
      actedAt: "2026-07-13T12:03:00.000Z",
    });

    expect(actioned.feedbackCase).toMatchObject({
      status: "actioned",
      duplicateOfCaseId: "fbcase_primary",
      sourceResponse: { invitationId: "csatinv_01" },
    });
  });

  it("rejects invalid predecessors and malformed duplicate merges", () => {
    const opened = openState();
    expect(() =>
      decideFeedbackCase(opened, {
        type: "SetFeedbackCaseDisposition",
        disposition: "spam",
        actor: manager,
        actedAt: "2026-07-13T12:03:00.000Z",
      }),
    ).toThrow("must be triaged");

    const triaged = triagedState();
    expect(() =>
      decideFeedbackCase(triaged, {
        type: "SetFeedbackCaseDisposition",
        disposition: "duplicate",
        duplicateOfCaseId: "fbcase_01" as never,
        actor: manager,
        actedAt: "2026-07-13T12:03:00.000Z",
      }),
    ).toThrow("different primary feedback case");
  });
});

describe("feedback case consent gating", () => {
  it("requires affirmative version-matched consent for every follow-up step", () => {
    const withoutConsent = triagedState({ followUpConsent: false, followUpConsentAt: null });
    expect(() =>
      decideFeedbackCase(withoutConsent, {
        type: "RequestFeedbackCaseFollowUp",
        consentVersion: "feedback-follow-up-v1",
        actor: manager,
        actedAt: "2026-07-13T12:03:00.000Z",
      }),
    ).toThrow("requires applicable affirmative consent");

    const consented = triagedState();
    expect(() =>
      decideFeedbackCase(consented, {
        type: "RequestFeedbackCaseFollowUp",
        consentVersion: "different-version",
        actor: manager,
        actedAt: "2026-07-13T12:03:00.000Z",
      }),
    ).toThrow("requires applicable affirmative consent");
  });

  it("cancels pending follow-up when consent is withdrawn and blocks sending", () => {
    const requested = apply(triagedState(), {
      type: "RequestFeedbackCaseFollowUp",
      consentVersion: "feedback-follow-up-v1",
      actor: manager,
      actedAt: "2026-07-13T12:03:00.000Z",
    });
    const withdrawn = apply(requested, {
      type: "WithdrawFeedbackCaseFollowUpConsent",
      consentVersion: "feedback-follow-up-v1",
      actor: manager,
      actedAt: "2026-07-13T12:04:00.000Z",
    });

    expect(withdrawn.feedbackCase).toMatchObject({
      consent: { status: "withdrawn" },
      followUpStatus: "cancelled",
    });
    expect(() =>
      decideFeedbackCase(withdrawn, {
        type: "MarkFeedbackCaseFollowUpSent",
        deliveryReference: "notification_01",
        actor: manager,
        actedAt: "2026-07-13T12:05:00.000Z",
      }),
    ).toThrow("requires applicable affirmative consent");
  });

  it("does not treat consent as permission to contact duplicate, spam, or redacted cases", () => {
    const triaged = triagedState();
    const spam = apply(triaged, {
      type: "SetFeedbackCaseDisposition",
      disposition: "spam",
      actor: manager,
      actedAt: "2026-07-13T12:03:00.000Z",
    });
    expect(() =>
      decideFeedbackCase(spam, {
        type: "RequestFeedbackCaseFollowUp",
        consentVersion: "feedback-follow-up-v1",
        actor: manager,
        actedAt: "2026-07-13T12:04:00.000Z",
      }),
    ).toThrow("does not allow customer follow-up");
  });

  it("cancels pending follow-up when a special disposition is recorded", () => {
    const requested = apply(triagedState(), {
      type: "RequestFeedbackCaseFollowUp",
      consentVersion: "feedback-follow-up-v1",
      actor: manager,
      actedAt: "2026-07-13T12:03:00.000Z",
    });
    const duplicate = apply(requested, {
      type: "SetFeedbackCaseDisposition",
      disposition: "duplicate",
      duplicateOfCaseId: "fbcase_primary" as never,
      actor: manager,
      actedAt: "2026-07-13T12:04:00.000Z",
    });

    expect(duplicate.feedbackCase?.followUpStatus).toBe("cancelled");
    expect(() =>
      decideFeedbackCase(duplicate, {
        type: "MarkFeedbackCaseFollowUpSent",
        deliveryReference: "notification_01",
        actor: manager,
        actedAt: "2026-07-13T12:05:00.000Z",
      }),
    ).toThrow("does not allow customer follow-up");
  });
});

describe("feedback case command safeguards", () => {
  it("opens only low scores automatically while allowing explicit flags", () => {
    expect(() => openState({ rating: 4 })).toThrow("rating of 1 through 3");
    const flagged = apply(initialFeedbackCaseState, {
      type: "OpenFeedbackCase",
      caseId: "fbcase_flagged" as never,
      submission: { ...submission, rating: 5 },
      openReason: "flagged",
      actor: manager,
      actedAt: "2026-07-13T12:01:00.000Z",
    });
    expect(flagged.feedbackCase).toMatchObject({ openReason: "flagged", priority: "normal" });
  });

  it("rejects view-only mutation attempts and makes exact state retries no-ops", () => {
    const triaged = triagedState();
    expect(() =>
      decideFeedbackCase(triaged, {
        type: "AssignFeedbackCase",
        ownerId: "usr_owner",
        actor: viewOnly,
        actedAt: "2026-07-13T12:03:00.000Z",
      }),
    ).toThrow("requires manager authority");

    const assigned = apply(triaged, {
      type: "AssignFeedbackCase",
      ownerId: "usr_owner",
      actor: manager,
      actedAt: "2026-07-13T12:03:00.000Z",
    });
    expect(
      decideFeedbackCase(assigned, {
        type: "AssignFeedbackCase",
        ownerId: "usr_owner",
        actor: manager,
        actedAt: "2026-07-13T12:04:00.000Z",
      }),
    ).toEqual([]);
  });
});
