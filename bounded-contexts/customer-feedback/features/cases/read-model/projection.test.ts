import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { describe, expect, it, vi } from "vitest";
import { transactionalCsatV1 } from "../../csat/domain/survey";
import { buildFeedbackCaseProjectionHandlers } from "./projection";

function event(type: string, data: Record<string, unknown>, streamVersion: number): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${streamVersion}`,
    streamId: "customer-feedback.feedback-case-test",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_manager", forAccountId: "acc_subject" },
    timing: { occurredAt: "2026-07-13T12:00:00.000Z", recordedAt: "2026-07-13T12:00:01.000Z" },
  });
}

describe("feedback case projection replay", () => {
  it("uses stream-version guards for current state and idempotent timeline rows", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [] };
      }),
    };
    const handlers = buildFeedbackCaseProjectionHandlers(db as never);
    const common = { eventSchemaVersion: 1, caseId: "fbcase_01", actorId: "usr_manager" };

    await handlers["customer-feedback.case.opened"]?.(
      event(
        "customer-feedback.case.opened",
        {
          ...common,
          sourceResponse: {
            invitationId: "csatinv_01",
            surveyVersion: transactionalCsatV1.id,
            rating: 2,
            submissionIdempotencyKey: "submission-01",
            submittedAt: "2026-07-13T12:00:00.000Z",
          },
          openReason: "low-score",
          priority: "high",
          consent: {
            status: "granted",
            version: "feedback-follow-up-v1",
            grantedAt: "2026-07-13T12:00:00.000Z",
            withdrawnAt: null,
          },
          actedAt: "2026-07-13T12:00:00.000Z",
        },
        1,
      ),
    );
    await handlers["customer-feedback.case.disposition-set"]?.(
      event(
        "customer-feedback.case.disposition-set",
        {
          ...common,
          disposition: "duplicate",
          duplicateOfCaseId: "fbcase_primary",
          actedAt: "2026-07-13T12:02:00.000Z",
        },
        3,
      ),
    );

    expect(queries[0]?.sql).toContain("last_stream_version < EXCLUDED.last_stream_version");
    expect(queries[1]?.sql).toContain("ON CONFLICT (case_id, stream_version) DO NOTHING");
    expect(queries[2]?.sql).toContain("last_stream_version < $3");
    expect(queries[2]?.params).toContain("fbcase_primary");
    expect(queries[3]?.sql).toContain("ON CONFLICT (case_id, stream_version) DO NOTHING");
  });
});
