import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { describe, expect, it, vi } from "vitest";
import { transactionalCsatV1 } from "../../csat/domain/survey";
import { createFeedbackCaseRuntime, feedbackCaseStreamId } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_system" as never, forAccountId: "acc_subject" as never },
};
const submission = {
  eventSchemaVersion: 1 as const,
  invitationId: "csatinv_01" as never,
  subjectAccountId: "acc_subject",
  surveyVersion: transactionalCsatV1.id,
  rating: 1 as const,
  comment: "Sensitive customer text",
  followUpConsent: true,
  followUpConsentVersion: "feedback-follow-up-v1",
  followUpConsentAt: "2026-07-13T12:00:00.000Z",
  submissionIdempotencyKey: "submission-01",
  submittedAt: "2026-07-13T12:00:00.000Z",
};

describe("feedback case runtime", () => {
  it("collapses concurrent submission delivery onto one case without storing the comment", async () => {
    const store = createInMemoryEventStore();
    const runtime = createFeedbackCaseRuntime({
      eventStore: store.eventStore,
      db: { query: vi.fn(async () => ({ rows: [] })) } as never,
    });
    const params = {
      submission,
      openReason: "low-score" as const,
      actor: { actorId: "customer-feedback.case-opening-policy", authority: "manage-feedback-cases" as const },
    };

    const [first, raced] = await Promise.all([
      runtime.openFromSubmission(params, context),
      runtime.openFromSubmission(params, context),
    ]);

    expect(raced).toEqual(first);
    const stored = await store.eventStore.readStream({ streamId: feedbackCaseStreamId(submission.invitationId) });
    expect(stored).toHaveLength(2);
    expect(stored[0]?.eventType).toBe("customer-feedback.case.opened");
    expect(stored[1]?.eventType).toBe("customer-feedback.case.attention-requested");
    expect(JSON.stringify(stored[0]?.payload)).not.toContain(submission.comment);
  });

  it("uses a stable opaque stream per submitted invitation", () => {
    const streamId = feedbackCaseStreamId(submission.invitationId);
    expect(streamId).toMatch(/^customer-feedback\.feedback-case-[0-9a-f]{64}$/);
    expect(streamId).not.toContain(submission.invitationId);
  });

  it("lets optimistic concurrency choose one assignment race winner", async () => {
    const store = createInMemoryEventStore();
    const streamId = feedbackCaseStreamId(submission.invitationId);
    const runtime = createFeedbackCaseRuntime({
      eventStore: store.eventStore,
      db: { query: vi.fn(async () => ({ rows: [{ stream_id: streamId }] })) } as never,
    });
    const opened = await runtime.openFromSubmission(
      {
        submission,
        openReason: "low-score",
        actor: { actorId: "customer-feedback.case-opening-policy", authority: "manage-feedback-cases" },
      },
      context,
    );
    const assign = (ownerId: string) =>
      runtime.executeByCaseId(
        opened.caseId,
        {
          type: "AssignFeedbackCase",
          ownerId,
          actor: { actorId: "usr_manager", authority: "manage-feedback-cases" },
          actedAt: "2026-07-13T12:03:00.000Z",
        },
        context,
      );
    const results = await Promise.allSettled([assign("usr_owner_a"), assign("usr_owner_b")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
