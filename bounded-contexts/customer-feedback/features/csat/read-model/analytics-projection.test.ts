import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { transactionalCsatV1 } from "../domain/survey";
import {
  buildCsatAnalyticsProjectionHandlers,
  csatAnalyticsFactPatch,
  mergeCsatAnalyticsFact,
  type CsatAnalyticsFact,
} from "./analytics-projection";

function event(type: string, data: Record<string, unknown>, streamVersion: number): TransportEvent {
  return buildTransportEvent(
    type,
    { eventSchemaVersion: 1, invitationId: "csatinv_01", ...data },
    {
      id: `evt_${streamVersion}`,
      streamId: "customer-feedback.csat-invitation-test",
      streamVersion,
      globalPosition: String(streamVersion),
      tenantId: "tnt_test",
      audit: { performedByUserId: "usr_system", forAccountId: "acc_subject" },
      timing: {
        occurredAt: `2026-07-13T12:0${streamVersion}:00.000Z`,
        recordedAt: `2026-07-13T12:0${streamVersion}:00.000Z`,
      },
    },
  );
}

const events = [
  event(
    "customer-feedback.invitation.eligible",
    {
      surveyVersion: transactionalCsatV1.id,
      provenance: {
        outcomeCode: "checkout.completed",
        sourceContext: "checkout",
        subject: { entityType: "checkout-session", entityId: "chk_source" },
        outcomeOccurredAt: "2026-07-13T10:00:00.000Z",
        outcomeIdempotencyKey: "checkout.completed:chk_source",
        correlationId: null,
        samplingCohortKey: "checkout-completion",
      },
      subjectAccountId: "acc_subject",
      subjectKind: "buyer",
      eligibleAt: "2026-07-13T12:01:00.000Z",
    },
    1,
  ),
  event(
    "customer-feedback.invitation.issued",
    {
      surveyVersion: transactionalCsatV1.id,
      provenance: { outcomeCode: "checkout.completed" },
      subjectKind: "buyer",
      samplingDecision: { cohortKey: "checkout-completion" },
      issuedAt: "2026-07-13T12:02:00.000Z",
    },
    2,
  ),
  event("customer-feedback.invitation.presented", { presentedAt: "2026-07-13T12:03:00.000Z" }, 3),
  event("customer-feedback.invitation.dismissed", { dismissedAt: "2026-07-13T12:04:00.000Z" }, 4),
  event(
    "customer-feedback.survey.submitted",
    { surveyVersion: transactionalCsatV1.id, rating: 5, submittedAt: "2026-07-13T12:05:00.000Z" },
    5,
  ),
] as const;

function replay(input: readonly TransportEvent[]): CsatAnalyticsFact | null {
  return input.reduce<CsatAnalyticsFact | null>(
    (fact, item) => mergeCsatAnalyticsFact(fact, csatAnalyticsFactPatch(item), item),
    null,
  );
}

describe("CSAT analytics projection", () => {
  it("converges across replay, duplicates, and out-of-order lifecycle delivery", () => {
    const chronological = replay(events);
    const outOfOrder = replay([events[4], events[2], events[4], events[3], events[1], events[0], events[2]]);

    expect(outOfOrder).toEqual(chronological);
    expect(outOfOrder).toMatchObject({
      invitationId: "csatinv_01",
      outcomeCode: "checkout.completed",
      customerRole: "buyer",
      samplingCohort: "checkout-completion",
      presentedAt: "2026-07-13T12:03:00.000Z",
      dismissedAt: "2026-07-13T12:04:00.000Z",
      submittedAt: "2026-07-13T12:05:00.000Z",
      rating: 5,
      lastGlobalPosition: "5",
    });
  });

  it("uses invitation-unique upserts instead of incrementing counters", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [] };
      }),
    };
    const handlers = buildCsatAnalyticsProjectionHandlers(db as never);

    await handlers[events[2].type]?.(events[2]);
    await handlers[events[2].type]?.(events[2]);

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(calls[0]?.sql).toContain("ON CONFLICT (invitation_id) DO UPDATE");
    expect(calls[0]?.sql).toContain("presented_at = COALESCE");
    expect(calls[0]?.params).toContain("2026-07-13T12:03:00.000Z");
  });
});
