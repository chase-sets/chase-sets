import { describe, expect, it, vi } from "vitest";
import { createCustomerFeedbackPrivacyRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_privacy" as never, forAccountId: "acc_test" as never },
};

function retentionRuntime(input: {
  acquired?: boolean;
  rejectInvitationId?: string;
  candidates: readonly Readonly<{
    invitation_id: string;
    privacy_hold: { releasedAt?: string | null } | null;
  }>[];
}) {
  const executePrivacyByInvitationId = vi.fn(async (invitationId: string) => {
    if (invitationId === input.rejectInvitationId) throw new Error("append failed");
    return { invitationId: "csatinv_01" };
  });
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: input.acquired ?? true }] };
    if (sql.includes("SELECT cursor_invitation_id")) return { rows: [{ cursor_invitation_id: null }] };
    if (sql.includes("SELECT invitation_id, privacy_hold")) return { rows: [...input.candidates] };
    return { rows: [] };
  });
  const release = vi.fn();
  const pool = { query, connect: vi.fn(async () => ({ query, release })) };
  const runtime = createCustomerFeedbackPrivacyRuntime({
    pool: pool as never,
    db: pool as never,
    invitations: { executePrivacyByInvitationId } as never,
  });
  return { runtime, executePrivacyByInvitationId, query, release };
}

describe("Customer Feedback retention runtime", () => {
  it("previews a bounded batch, reports holds, and does not redact", async () => {
    const { runtime, executePrivacyByInvitationId } = retentionRuntime({
      candidates: [
        { invitation_id: "csatinv_01", privacy_hold: null },
        { invitation_id: "csatinv_02", privacy_hold: { releasedAt: null } },
      ],
    });
    const result = await runtime.runRetentionBatch(
      { runId: "run-preview", mode: "preview", batchLimit: 2, now: "2026-07-14T00:00:00.000Z" },
      context,
    );

    expect(result).toMatchObject({
      runId: "run-preview",
      mode: "preview",
      scannedCount: 2,
      eligibleCount: 1,
      redactedCount: 0,
      heldCount: 1,
      state: "running",
    });
    expect(executePrivacyByInvitationId).not.toHaveBeenCalled();
  });

  it("executes idempotent redaction commands and rejects a concurrent runner", async () => {
    const active = retentionRuntime({ candidates: [{ invitation_id: "csatinv_01", privacy_hold: null }] });
    const result = await active.runtime.runRetentionBatch(
      { runId: "run-execute", mode: "execute", batchLimit: 100, now: "2026-07-14T00:00:00.000Z" },
      context,
    );
    expect(result).toMatchObject({ redactedCount: 1, errorCount: 0, state: "completed" });
    expect(active.executePrivacyByInvitationId).toHaveBeenCalledWith(
      "csatinv_01",
      expect.objectContaining({
        type: "RedactCsatResponse",
        scope: "all-sensitive",
        idempotencyKey: "customer-feedback-privacy.v1:csatinv_01",
      }),
      context,
    );

    const concurrent = retentionRuntime({ acquired: false, candidates: [] });
    await expect(
      concurrent.runtime.runRetentionBatch({ mode: "preview", now: "2026-07-14T00:00:00.000Z" }, context),
    ).rejects.toThrow("already running");
    expect(concurrent.release).toHaveBeenCalledOnce();
  });

  it("records partial failures and advances the durable cursor for a bounded retry run", async () => {
    const { runtime } = retentionRuntime({
      rejectInvitationId: "csatinv_02",
      candidates: [
        { invitation_id: "csatinv_01", privacy_hold: null },
        { invitation_id: "csatinv_02", privacy_hold: null },
      ],
    });

    await expect(
      runtime.runRetentionBatch(
        { runId: "run-partial", mode: "execute", batchLimit: 2, now: "2026-07-14T00:00:00.000Z" },
        context,
      ),
    ).resolves.toMatchObject({
      redactedCount: 1,
      errorCount: 1,
      cursorInvitationId: "csatinv_02",
      state: "running",
    });
  });

  it("masks a lagging sensitive projection with authoritative redaction state", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM customer_feedback_csat_invitations")) {
        return {
          rows: [
            {
              invitation_id: "csatinv_01",
              comment: "projection has not caught up",
              follow_up_consent: true,
              follow_up_consent_version: "feedback-follow-up-v1",
              follow_up_consent_statement: "Chase Sets may contact me about this feedback response.",
              follow_up_consent_at: "2026-07-13T00:00:00.000Z",
              follow_up_consent_subject_account_id: "acc_subject",
              follow_up_consent_purpose: "case-specific-follow-up",
              follow_up_consent_applicability: "this-response-only",
            },
          ],
        };
      }
      return { rows: [] };
    });
    const runtime = createCustomerFeedbackPrivacyRuntime({
      pool: { connect: vi.fn() } as never,
      db: { query } as never,
      invitations: {
        readAuthoritativePrivacyByInvitationId: vi.fn(async () => ({
          redactedScopes: ["all-sensitive"],
          privacyHold: null,
        })),
      } as never,
    });

    const response = await runtime.readSensitiveResponse("csatinv_01", "usr_security", "2026-07-14T00:00:00.000Z");
    expect(response).toMatchObject({
      comment: null,
      follow_up_consent: false,
      follow_up_consent_at: null,
      follow_up_consent_subject_account_id: null,
    });
    expect(JSON.stringify(response)).not.toContain("projection has not caught up");
  });
});
