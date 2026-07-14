import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createCsatInvitationRuntime, csatCooldownStreamId, csatInvitationStreamId } from "./runtime";
import type { CsatOutcomeFactV1 } from "../domain/outcome-fact";
import type { CsatSamplingPolicyV1 } from "../domain/sampling";
import { transactionalCsatV1 } from "../domain/survey";

const fact: CsatOutcomeFactV1 = {
  factSchemaVersion: 1,
  outcomeCode: "checkout.completed",
  sourceContext: "checkout",
  subjectAccountId: "acc_subject",
  subjectKind: "buyer",
  subject: { entityType: "checkout-session", entityId: "chk_source" },
  outcomeOccurredAt: "2026-07-13T10:00:00.000Z",
  idempotencyKey: "checkout.completed:chk_source",
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
const context = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: "usr_system" as never, forAccountId: "acc_subject" as never },
};

describe("CSAT invitation runtime", () => {
  it("collapses concurrent at-least-once outcome delivery onto one invitation stream", async () => {
    const store = createInMemoryEventStore();
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const runtime = createCsatInvitationRuntime({ eventStore: store.eventStore, db: db as never });
    const params = {
      fact,
      policy,
      subjectEligible: true,
      consentAllowed: true,
      trafficKind: "customer" as const,
      evaluatedAt: "2026-07-13T12:00:00.000Z",
    };

    const [first, raced] = await Promise.all([
      runtime.issueFromOutcomeFact(params, context),
      runtime.issueFromOutcomeFact(params, context),
    ]);

    expect(raced).toEqual(first);
    expect(first.publicReference).toMatch(/^csatref_[0-9a-f-]{36}$/);
    const stored = await store.eventStore.readStream({
      streamId: csatInvitationStreamId(fact.sourceContext, fact.idempotencyKey),
    });
    expect(stored.map((event) => event.eventType)).toEqual([
      "customer-feedback.invitation.eligible",
      "customer-feedback.invitation.issued",
    ]);
  });

  it("derives a stable internal stream without exposing the source idempotency key", () => {
    const streamId = csatInvitationStreamId(fact.sourceContext, fact.idempotencyKey);
    expect(streamId).toMatch(/^customer-feedback\.csat-invitation-[0-9a-f]{64}$/);
    expect(streamId).not.toContain(fact.idempotencyKey);
  });

  it("serializes different outcome facts for one subject and suppresses the cooldown loser", async () => {
    const store = createInMemoryEventStore();
    const runtime = createCsatInvitationRuntime({
      eventStore: store.eventStore,
      db: { query: vi.fn(async () => ({ rows: [] })) } as never,
    });
    const secondFact = {
      ...fact,
      subject: { ...fact.subject, entityId: "chk_second" },
      idempotencyKey: "checkout.completed:chk_second",
    };
    const base = {
      policy,
      subjectEligible: true,
      consentAllowed: true,
      trafficKind: "customer" as const,
      evaluatedAt: "2026-07-13T12:00:00.000Z",
    };

    const results = await Promise.all([
      runtime.issueFromOutcomeFact({ ...base, fact }, context),
      runtime.issueFromOutcomeFact({ ...base, fact: secondFact }, context),
    ]);

    expect(results.map((result) => result.state).sort()).toEqual(["issued", "suppressed"]);
    expect(results.find((result) => result.state === "suppressed")?.suppressionDiagnostic?.reason).toBe(
      "subject-cooldown",
    );
    const claims = await store.eventStore.readStream({
      streamId: csatCooldownStreamId(fact.subjectAccountId, fact.outcomeCode),
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]?.eventType).toBe("customer-feedback.sampling.cooldown-claimed");
  });

  it("routes public-reference commands through the account-scoped projection lookup", async () => {
    const store = createInMemoryEventStore();
    const db = { query: vi.fn(async () => ({ rows: [] as Array<{ stream_id: string }> })) };
    const runtime = createCsatInvitationRuntime({ eventStore: store.eventStore, db: db as never });
    const issued = await runtime.issueFromOutcomeFact(
      {
        fact,
        policy,
        subjectEligible: true,
        consentAllowed: true,
        trafficKind: "customer",
        evaluatedAt: "2026-07-13T12:00:00.000Z",
      },
      context,
    );
    db.query.mockResolvedValueOnce({
      rows: [{ stream_id: csatInvitationStreamId(fact.sourceContext, fact.idempotencyKey) }],
    });

    const presented = await runtime.executeByPublicReference(
      {
        type: "PresentCsatInvitation",
        publicReference: issued.publicReference!,
        subjectAccountId: fact.subjectAccountId,
        surveyVersion: transactionalCsatV1.id,
        actedAt: "2026-07-14T00:00:00.000Z",
      },
      context,
    );

    expect(presented.state).toBe("presented");
    expect(db.query).toHaveBeenLastCalledWith(expect.stringContaining("subject_account_id = $2"), [
      issued.publicReference,
      fact.subjectAccountId,
    ]);
  });
});
