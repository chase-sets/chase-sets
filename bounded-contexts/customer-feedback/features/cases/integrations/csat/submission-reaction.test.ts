import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { describe, expect, it, vi } from "vitest";
import { transactionalCsatV1 } from "../../../csat/domain/survey";
import type { OpenFeedbackCaseFromSubmissionParams } from "../../api/runtime";
import { buildFeedbackCaseOpeningReactionHandlers } from "./submission-reaction";

function submitted(rating: 1 | 2 | 3 | 4 | 5) {
  return buildTransportEvent(
    "customer-feedback.survey.submitted",
    {
      eventSchemaVersion: 1,
      invitationId: `csatinv_0${rating}`,
      surveyVersion: transactionalCsatV1.id,
      rating,
      comment: null,
      followUpConsent: false,
      followUpConsentVersion: "feedback-follow-up-v1",
      followUpConsentStatement: "Chase Sets may contact me about this feedback response.",
      followUpConsentAt: null,
      followUpConsentSubjectAccountId: "acc_subject",
      followUpConsentPurpose: "case-specific-follow-up",
      followUpConsentApplicability: "this-response-only",
      submissionIdempotencyKey: `submission-0${rating}`,
      submittedAt: "2026-07-13T12:00:00.000Z",
    },
    {
      id: `evt_${rating}`,
      streamId: `customer-feedback.csat-invitation-${rating}`,
      streamVersion: 4,
      globalPosition: String(rating),
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_subject", forAccountId: "acc_subject" },
      timing: { occurredAt: "2026-07-13T12:00:00.000Z", recordedAt: "2026-07-13T12:00:01.000Z" },
    },
  );
}

describe("feedback case opening reaction", () => {
  it("consumes the CSAT submission event and opens only low-score cases", async () => {
    const open = vi.fn(async (_params: OpenFeedbackCaseFromSubmissionParams, _context: EventStoreContext) => undefined);
    const handler = buildFeedbackCaseOpeningReactionHandlers(open)["customer-feedback.survey.submitted"];

    await handler?.(submitted(3));
    await handler?.(submitted(4));

    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({
      openReason: "low-score",
      submission: { invitationId: "csatinv_03", rating: 3 },
      actor: { actorId: "customer-feedback.case-opening-policy", authority: "manage-feedback-cases" },
    });
  });
});
