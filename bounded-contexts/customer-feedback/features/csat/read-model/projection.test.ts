import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import { buildCsatInvitationProjectionHandlers } from "./projection";

function event(type: string, data: Record<string, unknown>, streamVersion = 1): TransportEvent {
  return buildTransportEvent(type, data, {
    id: `evt_${streamVersion}`,
    streamId: "customer-feedback.csat-invitation-test",
    streamVersion,
    globalPosition: String(streamVersion),
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_system", forAccountId: "acc_subject" },
    timing: { occurredAt: "2026-07-13T12:00:00.000Z", recordedAt: "2026-07-13T12:00:00.000Z" },
  });
}

describe("CSAT invitation projection", () => {
  it("projects authoritative eligibility and issuance with replay version guards", async () => {
    const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        queries.push({ sql, params });
        return { rows: [] };
      }),
    };
    const handlers = buildCsatInvitationProjectionHandlers(db as never);

    await handlers["customer-feedback.invitation.eligible"]?.(
      event("customer-feedback.invitation.eligible", {
        eventSchemaVersion: 1,
        invitationId: "csatinv_01",
        surveyVersion: {
          surveyKind: "transactional-csat",
          surveyVersion: "csat.v1",
          questionVersion: "csat.q.v1",
        },
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
        eligibleAt: "2026-07-13T12:00:00.000Z",
      }),
    );
    await handlers["customer-feedback.invitation.issued"]?.(
      event(
        "customer-feedback.invitation.issued",
        {
          eventSchemaVersion: 1,
          invitationId: "csatinv_01",
          publicReference: "csatref_123e4567-e89b-42d3-a456-426614174000",
          samplingDecision: {
            policySchemaVersion: 1,
            policyId: "checkout-csat.v1",
            algorithmVersion: "fnv1a-32.v1",
            included: true,
            cohortKey: "checkout-completion",
            bucket: 0.25,
            sampleRate: 0.5,
            reason: "included",
          },
          samplingPolicySchemaVersion: 1,
          issuedAt: "2026-07-13T12:00:00.000Z",
          expiresAt: "2026-07-20T12:00:00.000Z",
        },
        2,
      ),
    );

    expect(queries[0]?.params).toContain("checkout.completed:chk_source");
    expect(queries[0]?.params).toContain("customer-feedback.csat-invitation-test");
    expect(queries[0]?.sql).toContain("last_stream_version < $17");
    expect(queries[1]?.params).toContain("csatref_123e4567-e89b-42d3-a456-426614174000");
    expect(queries[1]?.sql).toContain("last_stream_version < $3");
  });

  it("projects every closure path and keeps suppression diagnostics structured", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const db = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [] };
      }),
    };
    const handlers = buildCsatInvitationProjectionHandlers(db as never);
    const lifecycle = [
      [
        "customer-feedback.invitation.presented",
        { invitationId: "csatinv_01", presentedAt: "2026-07-14T00:00:00.000Z" },
      ],
      [
        "customer-feedback.invitation.dismissed",
        { invitationId: "csatinv_01", dismissedAt: "2026-07-14T00:01:00.000Z" },
      ],
      ["customer-feedback.invitation.expired", { invitationId: "csatinv_01", expiredAt: "2026-07-20T12:00:00.000Z" }],
      [
        "customer-feedback.invitation.revoked",
        { invitationId: "csatinv_01", reason: "policy-revoked", revokedAt: "2026-07-14T00:02:00.000Z" },
      ],
    ] as const;
    for (const [type, data] of lifecycle) await handlers[type]?.(event(type, { eventSchemaVersion: 1, ...data }, 3));

    await handlers["customer-feedback.invitation.suppressed"]?.(
      event("customer-feedback.invitation.suppressed", {
        invitationId: "csatinv_01",
        samplingDecision: { policySchemaVersion: 1 },
        diagnostic: {
          reason: "subject-cooldown",
          outcomeCode: "checkout.completed",
          policyId: "checkout-csat.v1",
          policySchemaVersion: 1,
          cohortKey: "checkout-completion",
          cooldownUntil: "2026-07-31T00:00:00.000Z",
        },
        suppressedAt: "2026-07-14T00:00:00.000Z",
      }),
    );

    expect(calls.map((call) => call.sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("state = 'presented'"),
        expect.stringContaining("state = 'dismissed'"),
        expect.stringContaining("state = 'expired'"),
        expect.stringContaining("state = 'revoked'"),
        expect.stringContaining("suppression_diagnostic"),
      ]),
    );
    expect(JSON.stringify(calls.at(-1)?.params)).not.toContain("comment");
  });
});
