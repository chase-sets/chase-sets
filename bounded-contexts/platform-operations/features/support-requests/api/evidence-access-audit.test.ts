import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createEvidenceAccessAudit, parseEvidenceAccessAttempt } from "./evidence-access-audit";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";
import { createId } from "@chase-sets/primitives/typed-ids";
import { mintEvidenceActorThroughIdentity } from "../tests/evidence-access-identity";

describe("closed Evidence Access Attempt schema", () => {
  async function record() {
    const { eventStore, allEvents } = createInMemoryEventStore();
    await createEvidenceAccessAudit(eventStore, () => "2026-10-12T00:00:00.000Z").record(
      "sup_case",
      "download",
      evidenceActor("viewer", ["support.view"], true),
      {
        decision: "allowed",
        reason: "any-case-grant",
        status: 200,
        participation: "buyer",
        assignment: { key: "support.evidence.any-case", assignmentId: "acap_current", version: 3 },
      },
    );
    return allEvents[0].payload;
  }
  it("records a bounded closed authorization-only payload", async () => {
    const payload = await record();
    expect(parseEvidenceAccessAttempt(payload)).toEqual(payload);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(1024);
    expect(payload).toMatchObject({ decision: "allowed", assignmentId: "acap_current", assignmentVersion: 3 });
  });
  it("accepts every canonical actor and assignment id prefix minted by createId", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const actor = {
      ...evidenceActor("viewer", ["support.view"]),
      tenantId: createId("tnt"),
      userId: createId("usr"),
      accountId: createId("acc"),
      membershipId: createId("mbr"),
    };
    const assignmentId = createId("acap");
    await createEvidenceAccessAudit(eventStore, () => "2026-10-12T00:00:00.000Z").record(
      "sup_case",
      "download",
      actor,
      {
        decision: "allowed",
        reason: "any-case-grant",
        status: 200,
        participation: "unrelated",
        assignment: { key: "support.evidence.any-case", assignmentId, version: 1 },
      },
    );
    expect(allEvents).toHaveLength(1);
    expect(parseEvidenceAccessAttempt(allEvents[0].payload)).toMatchObject({
      tenantId: actor.tenantId,
      userId: actor.userId,
      accountId: actor.accountId,
      membershipId: actor.membershipId,
      assignmentId,
    });
  });
  it("records a parseable attempt with principals minted and persisted by the real Identity API", async () => {
    const actor = await mintEvidenceActorThroughIdentity();
    const { eventStore, allEvents } = createInMemoryEventStore();
    await createEvidenceAccessAudit(eventStore, () => "2026-10-12T00:00:00.000Z").record(
      "sup_case",
      "download",
      actor,
      { decision: "allowed", reason: "participant", status: 200, participation: "buyer", assignment: null },
    );
    expect(allEvents).toHaveLength(1);
    expect(parseEvidenceAccessAttempt(allEvents[0].payload)).toMatchObject({
      tenantId: actor.tenantId,
      userId: actor.userId,
      accountId: actor.accountId,
      membershipId: actor.membershipId,
    });
    expect(actor.membershipId).toMatch(/^mbr_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
  it.each([
    { filename: "PLANTED_SECRET" },
    { provider: { text: "PLANTED_SECRET" } },
    { action: { toString: () => "download" } },
    { reason: "PLANTED_SECRET" },
    { assignmentVersion: 0 },
    { assignmentVersion: Number.MAX_SAFE_INTEGER + 1 },
    { at: "2026-10-12" },
    { at: "2026-02-30T00:00:00.000Z" },
    { userId: "usr_" + "x".repeat(81) },
    { tenantId: { nested: "PLANTED_SECRET" } },
    { tenantId: "acc_wrong_prefix" },
    { userId: "acc_wrong_prefix" },
    { accountId: "usr_wrong_prefix" },
    { membershipId: "mem_wrong_prefix" },
    { assignmentId: "mbr_wrong_prefix" },
  ])("rejects unknown, nested, malformed and out-of-range fields %j", async (mutation) => {
    const payload = await record();
    expect(() => parseEvidenceAccessAttempt({ ...payload, ...mutation })).toThrow();
  });

  it("rejects malformed audit cursors and discontinuous pages", async () => {
    const { eventStore } = createInMemoryEventStore();
    const audit = createEvidenceAccessAudit(eventStore, () => "2026-10-12T00:00:00.000Z");
    for (const cursor of ["0", "-1", "1.5", "secret", "9007199254740992"]) {
      await expect(audit.page("sup_case", cursor)).rejects.toMatchObject({ status: 404 });
    }
    const payload = await record();
    await eventStore.appendToStream({
      streamId: "support.evidence-access-sup_case",
      expectedVersion: "any",
      context: {
        tenantId: "tnt_identity",
        audit: { performedByUserId: "usr_operator", forAccountId: "acc_buyer" },
      } as never,
      events: [{ eventType: "support.evidence-access-attempt-recorded", payload }],
    });
    const broken = createEvidenceAccessAudit(
      {
        ...eventStore,
        readStream: async (input) =>
          (await eventStore.readStream(input)).map((event) => ({ ...event, streamVersion: event.streamVersion + 1 })),
      },
      () => "2026-10-12T00:00:00.000Z",
    );
    await expect(broken.page("sup_case")).rejects.toMatchObject({ status: 503 });
  });
});
