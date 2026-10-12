import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createEvidenceAccessAudit, parseEvidenceAccessAttempt } from "./evidence-access-audit";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";

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
        tenantId: "tnt_chase_sets",
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
