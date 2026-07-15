import { describe, expect, it, vi } from "vitest";
import { getSubmittedCsatResponseForCase } from "./submitted-response-source";

describe("submitted CSAT response case source", () => {
  it("loads the existing invitation projection as the authority for explicit flags", async () => {
    const db = {
      query: vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
        rows: [
          {
            invitation_id: "csatinv_01",
            subject_account_id: "acc_customer",
            survey_kind: "transactional-csat",
            survey_version: "csat.v1",
            question_version: "csat.q.v1",
            rating: 5,
            comment: "Customer-controlled text stays in the response projection.",
            follow_up_consent: true,
            follow_up_consent_version: "feedback-follow-up-v1",
            follow_up_consent_statement: "Chase Sets may contact me about this feedback response.",
            follow_up_consent_at: "2026-07-13T12:00:00.000Z",
            follow_up_consent_subject_account_id: "acc_subject",
            follow_up_consent_purpose: "case-specific-follow-up",
            follow_up_consent_applicability: "this-response-only",
            submission_idempotency_key: "submission-01",
            submitted_at: "2026-07-13T12:00:00.000Z",
          },
        ],
      })),
    };

    const response = await getSubmittedCsatResponseForCase(db as never, "csatinv_01" as never);

    expect(response).toMatchObject({
      invitationId: "csatinv_01",
      subjectAccountId: "acc_customer",
      rating: 5,
      followUpConsentVersion: "feedback-follow-up-v1",
    });
    expect(db.query.mock.calls[0]?.[0]).toContain("customer_feedback_csat_invitations");
    expect(db.query.mock.calls[0]?.[1]).toEqual(["csatinv_01"]);
  });
});
